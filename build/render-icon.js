// Builds build/icon.png + build/icon.ico: a glossy red arcade button with the Compass mark. Run with Electron.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const logo = fs.readFileSync(path.join(__dirname, 'logo-paths.txt'), 'utf8');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<defs>
  <linearGradient id="face" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff1a1a"/><stop offset=".55" stop-color="#ff0000"/><stop offset="1" stop-color="#8f0000"/></linearGradient>
  <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <linearGradient id="rimtop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e06a6e"/><stop offset=".5" stop-color="#000"/></linearGradient>
</defs>
<defs><filter id="glow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<circle cx="128" cy="128" r="86" fill="url(#face)"/>
<path d="M52 100 A80 80 0 0 1 204 100 A98 74 0 0 0 52 100Z" fill="url(#shine)" opacity=".6"/>
<g color="#fff" filter="url(#glow)" transform="translate(81 86) scale(0.0465)">${logo.replace(/stroke-width="125"/g, 'stroke-width="190"').replace(/rx="118" ry="82"/, 'rx="150" ry="114"')}</g>
<g color="#ff0303" transform="translate(81 86) scale(0.0465)">${logo}</g>
</svg>`;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 256, height: 256, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:transparent">' + svg + '</body>'));
  await new Promise((r) => setTimeout(r, 600));
  const png = (await w.webContents.capturePage()).resize({ width: 256, height: 256 }).toPNG();
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([ico, png]));
  app.quit();
});
