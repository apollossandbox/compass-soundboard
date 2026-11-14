const { app, BrowserWindow, ipcMain, dialog, globalShortcut, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'webm', 'wma'];

let win = null;

// userData now lives in "Compass Soundboard"; carry over a library saved under the old name.
{
  const fresh = path.join(app.getPath('appData'), 'Compass Soundboard');
  app.setPath('userData', fresh);
  if (!fs.existsSync(fresh)) {
    for (const old of ['Dris Board', 'dris-board']) {
      const p = path.join(app.getPath('appData'), old);
      if (fs.existsSync(path.join(p, 'library.json'))) { try { fs.cpSync(p, fresh, { recursive: true }); } catch {} break; }
    }
  }
}
const userDir = () => app.getPath('userData');
const soundsDir = () => path.join(userDir(), 'sounds');
const libFile = () => path.join(userDir(), 'library.json');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0b0b0c',
    title: 'Compass Soundboard',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b0c', symbolColor: '#f4f4f2', height: 40 },
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // keep audio + hotkeys snappy when minimized / behind a game
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  fs.mkdirSync(soundsDir(), { recursive: true });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

// ---------- library persistence ----------
// First launch: no library yet, so start with the bundled starter sound(s).
function seedLibrary() {
  const sounds = [];
  const dir = path.join(__dirname, 'defaults');
  try {
    for (const f of fs.readdirSync(dir).filter(isAudioName)) {
      const id = crypto.randomUUID();
      const file = id + path.extname(f).toLowerCase();
      fs.copyFileSync(path.join(dir, f), path.join(soundsDir(), file));
      const name = path.basename(f, path.extname(f)).replace(/[-_]+/g, ' ').replace(/w/g, (c) => c.toUpperCase());
      sounds.push({ id, file, name, color: '#e5383b', emoji: '', hotkey: '', volume: 100, start: 0, end: null, loop: false, fade: 0, fav: false });
    }
  } catch (e) { console.error('seed failed', e); }
  return { sounds, settings: {} };
}
const isAudioName = (n) => AUDIO_EXT.includes(path.extname(n).slice(1).toLowerCase());

ipcMain.handle('lib:load', () => {
  try {
    return JSON.parse(fs.readFileSync(libFile(), 'utf8'));
  } catch {
    const lib = seedLibrary();
    try { fs.writeFileSync(libFile(), JSON.stringify(lib, null, 2)); } catch {}
    return lib;
  }
});

ipcMain.handle('lib:save', (_e, data) => {
  const tmp = libFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, libFile());
  return true;
});

// ---------- importing sounds ----------
function importFiles(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const ext = path.extname(p).slice(1).toLowerCase();
      if (!AUDIO_EXT.includes(ext)) continue;
      const id = crypto.randomUUID();
      const file = `${id}.${ext}`;
      fs.copyFileSync(p, path.join(soundsDir(), file));
      out.push({ id, file, name: path.basename(p, path.extname(p)).replace(/[_]+/g, ' ') });
    } catch (err) {
      console.error('import failed', p, err);
    }
  }
  return out;
}

ipcMain.handle('sounds:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Add sounds to Compass Soundboard',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXT }],
  });
  if (res.canceled) return [];
  return importFiles(res.filePaths);
});

ipcMain.handle('sounds:pickOne', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Pick the new audio for this button',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXT }],
  });
  if (res.canceled) return null;
  return importFiles(res.filePaths)[0] || null;
});

ipcMain.handle('sounds:importPaths', (_e, paths) => importFiles(paths));

ipcMain.handle('sounds:read', (_e, file) => {
  const buf = fs.readFileSync(path.join(soundsDir(), path.basename(file)));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});

ipcMain.handle('sounds:delete', (_e, file) => {
  try {
    fs.unlinkSync(path.join(soundsDir(), path.basename(file)));
  } catch {}
  return true;
});

ipcMain.handle('sounds:openFolder', () => shell.openPath(soundsDir()));

// ---------- global hotkeys (work while you're in a game / OBS) ----------
ipcMain.handle('hotkeys:set', (_e, list) => {
  globalShortcut.unregisterAll();
  const failed = [];
  const seen = new Set();
  for (const { id, accel } of list) {
    if (!accel) continue;
    if (seen.has(accel)) {
      failed.push(id);
      continue;
    }
    seen.add(accel);
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => {
        if (win) win.webContents.send('hotkey', id);
      });
    } catch {}
    if (!ok) failed.push(id);
  }
  return failed;
});

ipcMain.handle('hotkeys:pause', () => globalShortcut.unregisterAll());

// ---------- drum pad kits (incl. FL Studio sample packs) ----------
const walk = (dir, depth, cb) => {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  cb(dir, ents);
  if (depth <= 0) return;
  for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name), depth - 1, cb);
};
const isAudio = (n) => AUDIO_EXT.includes(path.extname(n).slice(1).toLowerCase());

function flRoots() {
  const roots = [];
  const bases = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], 'D:/Program Files', 'D:/', 'E:/']
    .filter(Boolean).map((b) => path.join(b, 'Image-Line'));
  bases.push(path.join(app.getPath('documents'), 'Image-Line'));
  for (const b of bases) {
    if (!fs.existsSync(b)) continue;
    let kids = [];
    try { kids = fs.readdirSync(b, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
    for (const k of kids) {
      for (const sub of [path.join('Data', 'Patches', 'Packs'), path.join('Presets', 'Packs'), path.join('Data', 'FL Studio', 'Presets', 'Packs'), path.join('Data', 'Patches', 'Packs')]) {
        const p = path.join(b, k.name, sub);
        if (fs.existsSync(p) && !roots.includes(p)) roots.push(p);
      }
    }
    for (const sub of [path.join('FL Studio', 'Presets', 'Packs'), path.join('Data', 'FL Studio', 'Presets', 'Packs')]) {
      const p = path.join(b, sub);
      if (fs.existsSync(p) && !roots.includes(p)) roots.push(p);
    }
  }
  return roots;
}

ipcMain.handle('kit:scan', () => {
  const roots = flRoots();
  const folders = [];
  for (const root of roots) {
    walk(root, 5, (dir, ents) => {
      const n = ents.filter((e) => e.isFile() && isAudio(e.name)).length;
      if (n && folders.length < 800) folders.push({ name: path.relative(root, dir) || path.basename(root), path: dir, count: n });
    });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return { roots, folders };
});

function folderSlots(dir) {
  let files = [];
  walk(dir, 0, (d, ents) => { files = ents.filter((e) => e.isFile() && isAudio(e.name)).map((e) => path.join(d, e.name)); });
  if (!files.length) walk(dir, 3, (d, ents) => { for (const e of ents) if (e.isFile() && isAudio(e.name)) files.push(path.join(d, e.name)); });
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return Array.from({ length: 16 }, (_, i) => (files[i] ? { path: files[i], name: path.basename(files[i], path.extname(files[i])) } : null));
}

ipcMain.handle('kit:folder', (_e, dir) => ({ name: path.basename(dir), slots: folderSlots(dir) }));

ipcMain.handle('kit:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Choose a folder of drum samples (e.g. an FL Studio pack)', properties: ['openDirectory'], defaultPath: flRoots()[0] });
  if (res.canceled) return null;
  return { name: path.basename(res.filePaths[0]), slots: folderSlots(res.filePaths[0]) };
});

ipcMain.handle('kit:pickFile', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Choose a sample for this pad', properties: ['openFile'], filters: [{ name: 'Audio', extensions: AUDIO_EXT }], defaultPath: flRoots()[0] });
  if (res.canceled) return null;
  const p = res.filePaths[0];
  return { path: p, name: path.basename(p, path.extname(p)) };
});

const CATS = [
  ['kick', /kick|(^|[\/_\- ])bd([\/_\- \d]|$)/], ['snare', /snare|snr/], ['clap', /clap/],
  ['chat', /(closed|chh|c[ _\-.]?hat)/], ['ohat', /(open|ohh|o[ _\-.]?hat)/], ['rim', /rim|snap|stick/],
  ['tom', /tom/], ['perc', /perc|conga|bongo|clave|block/], ['shaker', /shaker|tamb|egg/], ['bell', /cowbell|bell/],
  ['crash', /crash|cymbal|ride/], ['sub', /808|sub|bass/], ['fx', /fx|riser|impact|sweep|hit/], ['hat', /hat/],
];
const LAYOUT = ['kick', 'kick', 'snare', 'clap', 'chat', 'ohat', 'rim', 'tom', 'perc', 'shaker', 'bell', 'crash', 'sub', 'tom', 'perc', 'fx'];

ipcMain.handle('kit:auto', () => {
  const roots = flRoots();
  if (!roots.length) return null;
  const buckets = {};
  let total = 0;
  for (const root of roots) {
    const start = fs.existsSync(path.join(root, 'Drums')) ? path.join(root, 'Drums') : root;
    walk(start, 6, (dir, ents) => {
      for (const e of ents) {
        if (!e.isFile() || !isAudio(e.name) || total > 6000) continue;
        const full = path.join(dir, e.name);
        const low = full.toLowerCase();
        const cat = CATS.find(([, re]) => re.test(low));
        if (cat) { (buckets[cat[0]] ||= []).push(full); total++; }
      }
    });
  }
  if (!total) return null;
  const used = new Set();
  const slots = LAYOUT.map((cat) => {
    const pool = (buckets[cat] || []).concat(cat === 'chat' || cat === 'ohat' ? buckets.hat || [] : []).filter((f) => !used.has(f));
    if (!pool.length) return null;
    const f = pool[Math.floor(Math.random() * pool.length)];
    used.add(f);
    return { path: f, name: path.basename(f, path.extname(f)) };
  });
  return { name: 'FL Studio · random kit', slots };
});

ipcMain.handle('kit:read', (_e, p) => {
  if (!isAudio(p)) throw new Error('Not an audio file');
  const buf = fs.readFileSync(p);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});

// ---------- updates (GitHub Releases: apollossandbox/compass-soundboard) ----------
const RELEASES_URL = 'https://github.com/apollossandbox/compass-soundboard/releases';
let updater = null;
const sendUpdate = (msg) => { if (win) win.webContents.send('update', msg); };
function getUpdater() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', () => sendUpdate({ state: 'none' }));
  autoUpdater.on('download-progress', (p) => sendUpdate({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => sendUpdate({ state: 'error', message: String(e && e.message || e).split('\n')[0].slice(0, 140) }));
  return (updater = autoUpdater);
}
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return sendUpdate({ state: 'portable' });
  if (!app.isPackaged) return sendUpdate({ state: 'dev' });
  sendUpdate({ state: 'checking' });
  try { await getUpdater().checkForUpdates(); } catch (e) { sendUpdate({ state: 'error', message: String(e.message || e).split('\n')[0].slice(0, 140) }); }
});
ipcMain.handle('update:download', async () => { try { await getUpdater().downloadUpdate(); } catch {} });
ipcMain.handle('update:install', () => getUpdater().quitAndInstall());
ipcMain.handle('update:openReleases', () => shell.openExternal(RELEASES_URL));
