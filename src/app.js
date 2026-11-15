'use strict';
/* Compass Soundboard renderer: library, audio engine, pad grid, trim editor, hotkeys. */

const $ = (s) => document.querySelector(s);
const COLORS = ['#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#22d3ee', '#3b82f6', '#a3a3a3'];
const EMOJIS = ['🔊', '😂', '🎺', '💥', '👏', '🥁', '🐔', '🚨', '😱', '🎉', '🔥', '💀'];
const MIN_SEL = 0.02;

const DEFAULTS = {
  master: 80,
  monOn: true, monDev: 'default', monVol: 100,
  strOn: false, strDev: 'default', strVol: 100,
  micOn: false, micDev: 'default', micVol: 100,
  stopKeyOn: false, stopKey: 'Ctrl+Shift+S',
  dialNum: true, dialPad: true,
};

const state = { sounds: [], settings: { ...DEFAULTS }, tab: 'all', query: '', failedKeys: new Set() };
const buffers = new Map(); // sound id -> AudioBuffer
const padEls = new Map(); // sound id -> pad element

function setStatus(msg) { $('#status').textContent = msg; }
function fmt(n) { return (Math.round(n * 100) / 100).toFixed(2); }
function uid() { return crypto.randomUUID(); }

/* =========================== persistence =========================== */
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => dris.saveLibrary({ sounds: state.sounds, settings: state.settings }), 250);
}

/* =========================== audio engine =========================== */
class Output {
  constructor(name) {
    this.name = name;
    // 'interactive' asks Windows for the smallest buffer and crackles under load; 'balanced' is still snappy
    this.ctx = new AudioContext({ latencyHint: 'balanced' });
    this.sounds = this.ctx.createGain(); // master x device volume, sounds only
    this.sounds.connect(this.ctx.destination);
    this.an = this.ctx.createAnalyser(); // feeds the VU meters on the Dial Board tab
    this.an.fftSize = 512;
    this.sounds.connect(this.an);
    this.mic = this.ctx.createGain(); // mic bypasses master volume
    this.mic.connect(this.ctx.destination);
    this.enabled = true;
  }
  async setDevice(id) {
    if (!this.ctx.setSinkId) return;
    try { await this.ctx.setSinkId(!id || id === 'default' ? '' : id); }
    catch (e) { console.warn(this.name, 'setSinkId failed', e); }
  }
}

const mon = new Output('monitor');
const str = new Output('stream');
const outputs = [mon, str];
const voices = new Map(); // voiceId -> voice
let micStream = null, micSource = null;

const pauser = { paused: false, at: 0 };
function setPauseLabel() { const b = $('#pauseBtn'); b.textContent = pauser.paused ? 'Resume' : 'Pause'; b.classList.toggle('hot', pauser.paused); }
function unpauseSync() {
  pauser.paused = false;
  const d = performance.now() - pauser.at;
  for (const v of voices.values()) v.t0 += d;
  outputs.forEach((o) => o.ctx.resume());
  setPauseLabel();
}
async function togglePause() {
  if (pauser.paused) { unpauseSync(); return; }
  if (!voices.size) { setStatus('Nothing is playing.'); return; }
  pauser.paused = true; pauser.at = performance.now();
  setPauseLabel();
  await Promise.all(outputs.map((o) => o.ctx.suspend()));
  setStatus(state.settings.micOn ? 'Paused. Your mic pass-through is paused too until you resume.' : 'Paused. Click Resume to continue.');
}

const engine = {
  async decode(u8) {
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    return mon.ctx.decodeAudioData(ab);
  },
  applyVolumes() {
    const m = state.settings.master / 100;
    mon.sounds.gain.value = m * (state.settings.monVol / 100);
    str.sounds.gain.value = m * (state.settings.strVol / 100);
    str.mic.gain.value = state.settings.micVol / 100;
  },
  play(sound, buffer, opts = {}) {
    const s = state.settings;
    const targets = opts.monitorOnly ? [mon] : outputs.filter((o) => o.enabled && !(o === str && mon.enabled && (state.settings.strDev || 'default') === (state.settings.monDev || 'default')));
    if (!targets.length) { setStatus('Both outputs are off. Open ⚙ Audio to turn one on.'); return null; }
    if (pauser.paused) unpauseSync();
    // sounds never overlap: starting one cuts whatever else is playing (drum hits are the one exception)
    if (!opts.preview && !opts.layer) for (const v of [...voices.values()]) if (!v.preview && !String(v.soundId).startsWith('drum')) engine.stopVoice(v);

    const start = Math.max(0, sound.start || 0);
    const end = Math.min(buffer.duration, sound.end || buffer.duration);
    const dur = Math.max(MIN_SEL, end - start);
    const vol = (sound.volume ?? 100) / 100;
    const fade = (sound.fade || 0) / 1000;
    const voice = { id: uid(), soundId: sound.id, nodes: [], t0: performance.now(), dur, loop: !!sound.loop, start, preview: !!opts.preview };

    for (const o of targets) {
      if (o.ctx.state !== 'running') o.ctx.resume();
      // schedule slightly ahead so the first samples don't land mid-buffer (start pops)
      const src = o.ctx.createBufferSource();
      src.buffer = buffer;
      if (sound.rate && sound.rate !== 1) src.playbackRate.value = sound.rate;
      const g = o.ctx.createGain();
      g.gain.value = vol;
      src.connect(g).connect(o.sounds);
      const now = o.ctx.currentTime + 0.02;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(vol, now + 0.004); // tiny fade-in kills the click
      if (sound.loop) {
        src.loop = true; src.loopStart = start; src.loopEnd = end;
        src.start(now, start);
      } else {
        src.start(now, start, dur);
        if (fade > 0) {
          const f = Math.min(fade, dur);
          g.gain.setValueAtTime(vol, now + dur - f);
          g.gain.linearRampToValueAtTime(0, now + dur);
        }
      }
      voice.nodes.push({ src, g, ctx: o.ctx });
    }
    voice.nodes[0].src.onended = () => engine.finish(voice.id);
    voices.set(voice.id, voice);
    ui.voiceStarted(voice);
    return voice;
  },
  stopVoice(voice, quick = true) {
    for (const n of voice.nodes) {
      try {
        const t = n.ctx.currentTime;
        n.g.gain.cancelScheduledValues(t);
        n.g.gain.setValueAtTime(n.g.gain.value, t);
        n.g.gain.linearRampToValueAtTime(0, t + (quick ? 0.03 : 0.1));
        n.src.stop(t + (quick ? 0.04 : 0.11));
      } catch {}
    }
  },
  finish(id) {
    const v = voices.get(id);
    if (!v) return;
    voices.delete(id);
    ui.voiceEnded(v);
  },
  stopSound(soundId) { for (const v of [...voices.values()]) if (v.soundId === soundId) engine.stopVoice(v); },
  stopAll(includePreview = true) {
    for (const v of [...voices.values()]) if (includePreview || !v.preview) engine.stopVoice(v);
  },
  isPlaying(soundId) { return [...voices.values()].some((v) => v.soundId === soundId); },

  async setMic() {
    const s = state.settings;
    if (micSource) { try { micSource.disconnect(); } catch {} micSource = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (!s.micOn) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: s.micDev && s.micDev !== 'default' ? { exact: s.micDev } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      micSource = str.ctx.createMediaStreamSource(micStream);
      micSource.connect(str.mic);
    } catch (e) {
      console.warn('mic failed', e);
      setStatus('Could not open the microphone: ' + e.message);
    }
  },

  async applyDevices() {
    const s = state.settings;
    mon.enabled = s.monOn; str.enabled = s.strOn;
    await Promise.all([mon.setDevice(s.monDev), str.setDevice(s.strDev)]);
    await engine.setMic();
    // an idle stream context still runs a second audio thread; park it when unused
    if (!s.strOn && !s.micOn) str.ctx.suspend(); else str.ctx.resume();
    engine.applyVolumes();
    updateRouting();
  },
};

async function getBuffer(sound) {
  if (buffers.has(sound.id)) return buffers.get(sound.id);
  const u8 = await dris.readSound(sound.file);
  const buf = await engine.decode(u8);
  buffers.set(sound.id, buf);
  return buf;
}

// press = (re)start from the top, shift+click = stop this sound
async function trigger(sound, { stop = false } = {}) {
  try {
    if (stop) { engine.stopSound(sound.id); return; }
    const buf = await getBuffer(sound);
    if (sound.end == null || sound.end > buf.duration) sound.end = buf.duration;
    engine.play(sound, buf);
  } catch (e) {
    console.error(e);
    setStatus(`Couldn't play “${sound.name}”: ${e.message}`);
  }
}

/* =========================== UI: pads =========================== */
const ui = {
  voiceStarted(v) {
    if (v.preview) return editor.previewStarted(v);
    padEls.get(v.soundId)?.classList.add('playing');
    startRaf();
  },
  voiceEnded(v) {
    if (v.preview) return editor.previewEnded();
    if (!engine.isPlaying(v.soundId)) {
      const el = padEls.get(v.soundId);
      if (el) { el.classList.remove('playing'); el.querySelector('.prog').style.setProperty('--p', 0); }
    }
  },
};

let rafOn = false;
function startRaf() {
  if (rafOn) return;
  rafOn = true;
  const tick = () => {
    const now = performance.now();
    let any = false;
    for (const v of voices.values()) {
      any = true;
      const p = (now - v.t0) / 1000 / v.dur;
      const frac = v.loop ? p % 1 : Math.min(1, p);
      if (v.preview) editor.movePlayhead(v, frac);
      else {
        const bar = padEls.get(v.soundId)?.querySelector('.prog');
        if (bar) bar.style.setProperty('--p', frac * 100);
      }
    }
    if (any) requestAnimationFrame(tick); else rafOn = false;
  };
  requestAnimationFrame(tick);
}

function visibleSounds() {
  const q = state.query.trim().toLowerCase();
  return state.sounds.filter((s) => (state.tab === 'fav' ? s.fav : true) && (!q || s.name.toLowerCase().includes(q)));
}

function render() {
  const grid = $('#grid');
  grid.innerHTML = '';
  padEls.clear();
  const list = visibleSounds();
  for (const s of list) {
    const el = document.createElement('div');
    el.className = 'pad' + (engine.isPlaying(s.id) ? ' playing' : '');
    el.style.setProperty('--c', s.color || COLORS[0]);
    const keyBad = s.hotkey && state.failedKeys.has(s.id);
    el.innerHTML = `
      ${s.loop ? '<span class="loopbadge" title="Loops">LOOP</span>' : ''}
      <div class="pname"></div>
      <div class="meta"><span class="key"></span></div>
      <div class="prog"></div>`;
    el.querySelector('.pname').textContent = s.name;
    const key = el.querySelector('.key');
    if (s.hotkey) {
      key.textContent = s.hotkey.replace('num', 'Num');
      if (keyBad) { key.style.textDecoration = 'line-through'; key.title = 'Another app is using this hotkey'; }
    } else key.remove();
    el.addEventListener('click', (e) => { if (!e.target.closest('.tools')) trigger(s, { stop: e.shiftKey }); });
    el.addEventListener('contextmenu', (e) => showSoundMenu(e, s));
    grid.appendChild(el);
    padEls.set(s.id, el);
  }
  if (state.tab === 'all' && !state.query) {
    const add = document.createElement('div');
    add.className = 'pad add';
    add.innerHTML = '<div class="plus">＋</div><div>Add sounds</div>';
    add.addEventListener('click', addSounds);
    grid.appendChild(add);
  }
  $('#empty').classList.toggle('hidden', state.tab === 'dial' || state.tab === 'drum' || state.sounds.length > 0);
  if (state.sounds.length) startRaf();
  window.hardware?.refresh();
}

function showView() {
  const dial = state.tab === 'dial', drum = state.tab === 'drum', other = dial || drum;
  $('#grid').classList.toggle('hidden', other);
  $('#hw').classList.toggle('hidden', !dial);
  $('#drum').classList.toggle('hidden', !drum);
  $('.search').classList.toggle('hidden', other);
  $('#empty').classList.toggle('hidden', other || state.sounds.length > 0);
  if (other) window.hardware?.show(state.tab);
}

function updateRouting() {
  const s = state.settings;
  const parts = [];
  if (s.monOn) parts.push('headphones');
  if (s.strOn) parts.push('stream' + (s.micOn ? ' + mic' : ''));
  $('#routing').textContent = parts.length ? 'Output: ' + parts.join('  ·  ') : 'Output: none';
}

async function addSounds() {
  const added = await dris.pickSounds();
  await ingest(added);
}

async function ingest(added) {
  if (!added || !added.length) return;
  for (const a of added) {
    const sound = {
      id: a.id, file: a.file, name: a.name, color: '#ff0000',
      emoji: '', hotkey: '', volume: 100, start: 0, end: null, loop: false, fade: 0, fav: false,
    };
    try {
      const buf = await getBuffer(sound);
      sound.end = buf.duration;
    } catch (e) {
      setStatus(`“${a.name}” couldn't be decoded, skipping.`);
      dris.deleteSound(a.file);
      continue;
    }
    state.sounds.push(sound);
  }
  save(); render();
  setStatus(`Added ${added.length} sound${added.length > 1 ? 's' : ''}. Hover a pad and hit the pencil to trim it.`);
}

/* =========================== hotkeys =========================== */
function accelFromEvent(e) {
  const code = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad\d$/.test(code)) key = 'num' + code.slice(6);
  else {
    key = {
      Space: 'Space', Enter: 'Return', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
      NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
    }[code] || null;
  }
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}

function captureHotkey(input, getVal, setVal) {
  input.value = getVal() ? getVal().replace('num', 'Num') : '';
  input.addEventListener('click', async () => {
    input.classList.add('capturing');
    input.value = 'Press keys… (Esc cancel, Backspace clear)';
    await dris.pauseHotkeys();
    const done = () => {
      window.removeEventListener('keydown', onKey, true);
      input.removeEventListener('blur', onBlur);
      input.classList.remove('capturing');
      input.value = getVal() ? getVal().replace('num', 'Num') : '';
      syncHotkeys();
    };
    const onBlur = () => done();
    const onKey = (e) => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') return done();
      if (e.key === 'Backspace' || e.key === 'Delete') { setVal(''); return done(); }
      const a = accelFromEvent(e);
      if (!a) return;
      setVal(a);
      done();
    };
    window.addEventListener('keydown', onKey, true);
    input.addEventListener('blur', onBlur);
  });
}

let hotkeyBusy = null;
async function syncHotkeys() {
  const list = state.sounds.filter((s) => s.hotkey).map((s) => ({ id: s.id, accel: s.hotkey }));
  if (state.settings.stopKeyOn && state.settings.stopKey) list.push({ id: '__stop', accel: state.settings.stopKey });
  const failed = await dris.setHotkeys(list);
  state.failedKeys = new Set(failed);
  if (failed.length) {
    const names = failed.map((id) => (id === '__stop' ? 'Panic key' : state.sounds.find((s) => s.id === id)?.name)).filter(Boolean);
    setStatus(`Hotkey unavailable (used by another app or duplicated): ${names.join(', ')}`);
  }
  render();
}

dris.onHotkey((id) => {
  if (id === '__stop') return engine.stopAll();
  const s = state.sounds.find((x) => x.id === id);
  if (s) trigger(s);
});

/* =========================== trim editor =========================== */
const editor = (() => {
  const dlg = $('#editor');
  const canvas = $('#wave');
  let sound = null, draft = null, buf = null, peaks = null, previewVoice = null, drag = null;
  const dpr = () => window.devicePixelRatio || 1;

  function computePeaks() {
    const W = Math.max(50, Math.floor(canvas.clientWidth * dpr()));
    canvas.width = W; canvas.height = Math.floor(canvas.clientHeight * dpr());
    const data = [];
    for (let c = 0; c < buf.numberOfChannels; c++) data.push(buf.getChannelData(c));
    const step = buf.length / W;
    peaks = new Float32Array(W * 2);
    for (let x = 0; x < W; x++) {
      let mn = 1, mx = -1;
      const a = Math.floor(x * step), b = Math.min(buf.length, Math.floor((x + 1) * step) + 1);
      const stride = Math.max(1, Math.floor((b - a) / 64));
      for (const d of data) for (let i = a; i < b; i += stride) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      peaks[x * 2] = mn > mx ? 0 : mn; peaks[x * 2 + 1] = mn > mx ? 0 : mx;
    }
  }

  function draw() {
    if (!peaks) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, mid = H / 2;
    ctx.clearRect(0, 0, W, H);
    const sx = (draft.start / buf.duration) * W, ex = (draft.end / buf.duration) * W;
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--ink').trim(), dim = css.getPropertyValue('--panel3').trim(), red = css.getPropertyValue('--red').trim();
    for (let x = 0; x < W; x++) {
      const inside = x >= sx && x <= ex;
      ctx.fillStyle = inside ? ink : dim;
      const top = mid - peaks[x * 2 + 1] * mid * 0.95, bot = mid - peaks[x * 2] * mid * 0.95;
      ctx.fillRect(x, top, 1, Math.max(1, bot - top));
    }
    const hw = 3 * dpr();
    ctx.fillStyle = red;
    ctx.fillRect(sx - hw / 2, 0, hw, H); ctx.fillRect(ex - hw / 2, 0, hw, H);
    ctx.fillRect(sx - hw / 2, 0, 10 * dpr(), 14 * dpr()); ctx.fillRect(ex - 10 * dpr() + hw / 2, H - 14 * dpr(), 10 * dpr(), 14 * dpr());
  }

  function syncFields() {
    $('#edStart').value = fmt(draft.start); $('#edEnd').value = fmt(draft.end);
    $('#edLen').textContent = fmt(draft.end - draft.start);
    draw();
  }

  const xToT = (clientX) => {
    const r = canvas.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * buf.duration;
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!buf) return;
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const px = (t) => (t / buf.duration) * r.width;
    const x = e.clientX - r.left;
    if (Math.abs(x - px(draft.start)) < 9) drag = { mode: 'start' };
    else if (Math.abs(x - px(draft.end)) < 9) drag = { mode: 'end' };
    else drag = { mode: 'new', anchor: xToT(e.clientX), moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!buf) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const near = Math.abs(x - (draft.start / buf.duration) * r.width) < 9 || Math.abs(x - (draft.end / buf.duration) * r.width) < 9;
    canvas.style.cursor = near ? 'ew-resize' : 'crosshair';
    if (!drag) return;
    const t = xToT(e.clientX);
    if (drag.mode === 'start') draft.start = Math.min(t, draft.end - MIN_SEL);
    else if (drag.mode === 'end') draft.end = Math.max(t, draft.start + MIN_SEL);
    else {
      if (Math.abs(t - drag.anchor) < buf.duration * 0.004 && !drag.moved) return;
      drag.moved = true;
      draft.start = Math.min(t, drag.anchor); draft.end = Math.max(t, drag.anchor + 0);
      if (draft.end - draft.start < MIN_SEL) draft.end = Math.min(buf.duration, draft.start + MIN_SEL);
    }
    syncFields();
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);

  function clampField(which) {
    let v = parseFloat($(which === 'start' ? '#edStart' : '#edEnd').value);
    if (Number.isNaN(v)) return syncFields();
    if (which === 'start') draft.start = Math.max(0, Math.min(v, draft.end - MIN_SEL));
    else draft.end = Math.min(buf.duration, Math.max(v, draft.start + MIN_SEL));
    syncFields();
  }
  $('#edStart').addEventListener('change', () => clampField('start'));
  $('#edEnd').addEventListener('change', () => clampField('end'));
  $('#edReset').addEventListener('click', () => { draft.start = 0; draft.end = buf.duration; syncFields(); });

  $('#edVol').addEventListener('input', (e) => { draft.volume = +e.target.value; $('#edVolVal').textContent = draft.volume + '%'; });
  $('#edFade').addEventListener('input', (e) => { draft.fade = +e.target.value; $('#edFadeVal').textContent = draft.fade + ' ms'; });
  $('#edLoop').addEventListener('change', (e) => { draft.loop = e.target.checked; });
  $('#edName').addEventListener('input', (e) => { draft.name = e.target.value; });
  $('#edEmoji').addEventListener('input', (e) => { draft.emoji = e.target.value; });
  $('#edFav').addEventListener('click', () => { draft.fav = !draft.fav; $('#edFav').textContent = draft.fav ? '★' : '☆'; });
  captureHotkey($('#edKey'), () => draft?.hotkey || '', (v) => { draft.hotkey = v; });
  $('#edKeyClear').addEventListener('click', () => { draft.hotkey = ''; $('#edKey').value = ''; });
  $('#editorForm').addEventListener('submit', (e) => e.preventDefault());

  const sw = $('#edColors');
  COLORS.forEach((c) => {
    const i = document.createElement('i');
    i.style.background = c; i.style.color = c; i.dataset.c = c;
    i.addEventListener('click', () => { draft.color = c; markColor(); });
    sw.appendChild(i);
  });
  const markColor = () => sw.querySelectorAll('i').forEach((i) => i.classList.toggle('sel', i.dataset.c === draft.color));

  $('#edPlay').addEventListener('click', () => {
    if (previewVoice) return engine.stopVoice(previewVoice);
    engine.play({ ...draft, loop: false }, buf, { preview: true, monitorOnly: true });
  });

  function stopPreview() { if (previewVoice) engine.stopVoice(previewVoice); }

  $('#edCancel').addEventListener('click', () => { stopPreview(); dlg.close(); });
  dlg.addEventListener('close', () => { stopPreview(); buf = null; sound = null; draft = null; peaks = null; syncHotkeys(); });
  $('#edSave').addEventListener('click', () => {
    Object.assign(sound, draft, { name: (draft.name || '').trim() || 'Untitled' });
    stopPreview();
    save(); dlg.close(); syncHotkeys();
    setStatus(`Saved “${sound.name}”.`);
  });
  $('#edDelete').addEventListener('click', async () => {
    if (!confirm(`Delete “${sound.name}” from Compass Soundboard?`)) return;
    const s = sound;
    stopPreview(); engine.stopSound(s.id);
    state.sounds = state.sounds.filter((x) => x.id !== s.id);
    buffers.delete(s.id);
    await dris.deleteSound(s.file);
    save(); dlg.close(); syncHotkeys();
  });

  window.addEventListener('resize', () => { if (buf && dlg.open) { computePeaks(); draw(); } });

  return {
    async open(s) {
      sound = s;
      draft = { ...s };
      dlg.showModal();
      $('#waveMsg').textContent = 'Loading waveform…';
      try { buf = await getBuffer(s); } catch (e) { $('#waveMsg').textContent = 'Could not load audio: ' + e.message; return; }
      if (draft.end == null || draft.end > buf.duration) draft.end = buf.duration;
      if (draft.start == null) draft.start = 0;
      $('#waveMsg').textContent = '';
      $('#edName').value = draft.name;
      $('#edVol').value = draft.volume; $('#edVolVal').textContent = draft.volume + '%';
      $('#edFade').value = draft.fade || 0; $('#edFadeVal').textContent = (draft.fade || 0) + ' ms';
      $('#edLoop').checked = !!draft.loop;
      $('#edEmoji').value = draft.emoji || '';
      $('#edFav').textContent = draft.fav ? '★' : '☆';
      $('#edKey').value = (draft.hotkey || '').replace('num', 'Num');
      $('#edTotal').textContent = fmt(buf.duration);
      markColor();
      computePeaks(); syncFields();
    },
    previewStarted(v) { previewVoice = v; $('#edPlay').textContent = '■ Stop'; $('#playhead').style.display = 'block'; startRaf(); },
    previewEnded() { previewVoice = null; $('#edPlay').textContent = '▶ Preview'; $('#playhead').style.display = 'none'; },
    movePlayhead(v, frac) {
      const sx = (v.start / buf.duration), len = v.dur / buf.duration;
      $('#playhead').style.left = (sx + frac * len) * 100 + '%';
    },
  };
})();

/* =========================== settings dialog =========================== */
const settingsDlg = $('#settings');
async function fillDevices() {
  try { // briefly open the mic so Chromium reveals real device names
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch {}
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, cur) => {
    sel.innerHTML = '';
    const def = new Option('System default', 'default'); sel.add(def);
    devs.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .forEach((d) => sel.add(new Option(d.label || `${kind} ${sel.length}`, d.deviceId)));
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : 'default';
  };
  const s = state.settings;
  fill($('#monDev'), 'audiooutput', s.monDev);
  fill($('#strDev'), 'audiooutput', s.strDev);
  fill($('#micDev'), 'audioinput', s.micDev);
}

function bindSetting(id, key, kind = 'check', after = () => {}) {
  const el = $('#' + id);
  const read = () => (kind === 'check' ? el.checked : kind === 'num' ? +el.value : el.value);
  const write = () => { if (kind === 'check') el.checked = state.settings[key]; else el.value = state.settings[key]; };
  write();
  el.addEventListener(kind === 'check' || el.tagName === 'SELECT' ? 'change' : 'input', () => { state.settings[key] = read(); save(); after(); });
  return write;
}

const settingWriters = [];
function initSettings() {
  const dev = () => engine.applyDevices();
  const vol = () => engine.applyVolumes();
  settingWriters.push(
    bindSetting('monOn', 'monOn', 'check', dev), bindSetting('monDev', 'monDev', 'val', dev),
    bindSetting('strOn', 'strOn', 'check', dev), bindSetting('strDev', 'strDev', 'val', dev),
    bindSetting('micOn', 'micOn', 'check', dev), bindSetting('micDev', 'micDev', 'val', dev),
    bindSetting('monVol', 'monVol', 'num', vol), bindSetting('strVol', 'strVol', 'num', vol), bindSetting('micVol', 'micVol', 'num', vol),
    bindSetting('stopKeyOn', 'stopKeyOn', 'check', syncHotkeys),
  );
  captureHotkey($('#stopKey'), () => state.settings.stopKey, (v) => { state.settings.stopKey = v; save(); });
  $('#settingsBtn').addEventListener('click', async () => {
    await fillDevices();
    settingWriters.forEach((w) => w());
    $('#stopKey').value = state.settings.stopKey;
    settingsDlg.showModal();
  });
  $('#openFolder').addEventListener('click', () => dris.openSoundsFolder());
}

/* =========================== right-click menu, rebind, replace audio =========================== */
const ctxMenu = $('#ctx');
function closeMenu() { ctxMenu.classList.add('hidden'); }
function showSoundMenu(e, s) {
  e.preventDefault(); e.stopPropagation();
  const items = [
    ['Play', '', () => trigger(s)],
    ['Trim / edit…', '', () => editor.open(s)],
    ['Rebind key…', s.hotkey ? s.hotkey.replace('num', 'Num') : 'none', () => rebindSound(s)],
    ...(s.hotkey ? [['Clear key', '', () => { s.hotkey = ''; save(); syncHotkeys(); setStatus('Cleared the key for “' + s.name + '”.'); }]] : []),
    ['Replace audio…', '', () => replaceAudio(s)],
    ['Duplicate', '', () => duplicateSound(s)],
    [s.fav ? 'Remove from favorites' : 'Add to favorites', '', () => { s.fav = !s.fav; save(); render(); }],
    null,
    ['Delete', '', () => deleteSoundWithConfirm(s), 'danger'],
  ];
  ctxMenu.innerHTML = '';
  for (const it of items) {
    if (!it) { ctxMenu.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.className = it[3] || '';
    const label = document.createElement('span'); label.textContent = it[0]; b.appendChild(label);
    if (it[1]) { const sm = document.createElement('small'); sm.textContent = it[1]; b.appendChild(sm); }
    b.addEventListener('click', () => { closeMenu(); it[2](); });
    ctxMenu.appendChild(b);
  }
  ctxMenu.classList.remove('hidden');
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(6, Math.min(e.clientX, innerWidth - r.width - 6)) + 'px';
  ctxMenu.style.top = Math.max(6, Math.min(e.clientY, innerHeight - r.height - 6)) + 'px';
}
window.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctx')) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);

async function duplicateSound(s) {
  const copy = await dris.copySound(s.file);
  if (!copy) return setStatus('Could not duplicate that sound.');
  const dup = { ...s, id: copy.id, file: copy.file, name: s.name + ' copy', hotkey: '' };
  state.sounds.splice(state.sounds.indexOf(s) + 1, 0, dup);
  if (buffers.has(s.id)) buffers.set(dup.id, buffers.get(s.id));
  save(); render(); setStatus('Duplicated “' + s.name + '”.');
}

async function replaceAudio(s) {
  const a = await dris.pickOne();
  if (!a) return;
  const oldFile = s.file;
  try {
    engine.stopSound(s.id);
    s.file = a.file;
    buffers.delete(s.id);
    const buf = await getBuffer(s);
    s.start = 0; s.end = buf.duration;
    dris.deleteSound(oldFile);
    save(); render();
    setStatus('Replaced the audio on “' + s.name + '”. Name, key and color stayed the same.');
  } catch (err) {
    s.file = oldFile; buffers.delete(s.id);
    dris.deleteSound(a.file);
    setStatus('That file could not be decoded, so nothing changed.');
  }
}

async function deleteSoundWithConfirm(s) {
  if (!confirm('Delete “' + s.name + '” from Compass Soundboard?')) return;
  engine.stopSound(s.id);
  state.sounds = state.sounds.filter((x) => x.id !== s.id);
  buffers.delete(s.id);
  await dris.deleteSound(s.file);
  save(); syncHotkeys();
}

function rebindSound(s) {
  const dlg = $('#bindDlg'), box = $('#bindKey');
  $('#bindTitle').textContent = 'Rebind “' + s.name + '”';
  box.textContent = s.hotkey ? 'Now: ' + s.hotkey.replace('num', 'Num') : 'Press the new key…';
  box.classList.remove('got');
  dris.pauseHotkeys();
  dlg.showModal();
  const finish = () => { window.removeEventListener('keydown', onKey, true); dlg.removeEventListener('close', finish); if (dlg.open) dlg.close(); syncHotkeys(); };
  const onKey = (e) => {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') return finish();
    if (e.key === 'Backspace' || e.key === 'Delete') { s.hotkey = ''; save(); setStatus('Cleared the key for “' + s.name + '”.'); return finish(); }
    const accel = accelFromEvent(e);
    if (!accel) return;
    const other = state.sounds.find((x) => x !== s && x.hotkey === accel);
    if (other) other.hotkey = '';
    s.hotkey = accel; save();
    box.textContent = accel.replace('num', 'Num'); box.classList.add('got');
    setStatus(other ? accel + ' now plays “' + s.name + '” (taken from “' + other.name + '”).' : 'Bound ' + accel + ' to “' + s.name + '”.');
    setTimeout(finish, 350);
  };
  window.addEventListener('keydown', onKey, true);
  dlg.addEventListener('close', finish);
}

/* =========================== wiring =========================== */
function initTopbar() {
  $('#addBtn').addEventListener('click', addSounds);
  $('#emptyAdd').addEventListener('click', addSounds);
  $('#stopAll').addEventListener('click', () => { if (pauser.paused) unpauseSync(); engine.stopAll(); });
  $('#pauseBtn').addEventListener('click', togglePause);
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    render();
    showView();
  });
  const master = $('#master');
  master.addEventListener('input', () => {
    state.settings.master = +master.value; $('#masterVal').textContent = master.value + '%';
    engine.applyVolumes(); save();
    window.hardware?.syncMixer();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]') && !/INPUT|SELECT/.test(document.activeElement?.tagName)) engine.stopAll();
  });

  // drag & drop import
  let depth = 0;
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (isFiles(e)) { depth++; $('#dropHint').classList.remove('hidden'); } });
  window.addEventListener('dragleave', (e) => { if (isFiles(e) && --depth <= 0) { depth = 0; $('#dropHint').classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; $('#dropHint').classList.add('hidden');
    const paths = [...e.dataTransfer.files].map((f) => dris.pathForFile(f)).filter(Boolean);
    if (paths.length) await ingest(await dris.importPaths(paths));
  });
}

async function init() {
  const lib = await dris.loadLibrary();
  if (lib) {
    state.sounds = lib.sounds || [];
    state.settings = { ...DEFAULTS, ...(lib.settings || {}) };
  }
  $('#master').value = state.settings.master; $('#masterVal').textContent = state.settings.master + '%';
  initTopbar();
  initSettings();
  await engine.applyDevices();
  render();
  await syncHotkeys();
  setStatus(state.sounds.length ? 'Ready. Click a pad to play it. Esc stops everything.' : 'Welcome to Compass Soundboard!');
}
init();

/* =========================== updates =========================== */
(() => {
  const btn = $('#updBtn');
  let mode = 'check', silent = true;
  drisUpdate.version().then((v) => { btn.dataset.v = v; btn.textContent = 'v' + v + ' · Check for updates'; });
  const label = (t, hot = false) => { btn.textContent = t; btn.classList.toggle('hot', hot); };
  drisUpdate.onStatus((m) => {
    const quiet = silent && ['checking', 'none', 'dev', 'portable', 'error'].includes(m.state);
    if (m.state === 'checking') { mode = 'busy'; if (!quiet) label('Checking…'); }
    else if (m.state === 'none') { mode = 'check'; label('v' + btn.dataset.v + ' · Up to date'); if (!quiet) setStatus('You have the latest version.'); }
    else if (m.state === 'available') { mode = 'download'; label('Update to v' + m.version, true); setStatus('Version ' + m.version + ' is available. Click the update link at the bottom to download it.'); }
    else if (m.state === 'downloading') { mode = 'busy'; label('Downloading ' + m.percent + '%', true); }
    else if (m.state === 'ready') { mode = 'install'; label('Restart to install v' + m.version, true); setStatus('Update downloaded. Restart to finish installing.'); }
    else if (m.state === 'portable') { mode = 'releases'; label('Portable build: open downloads page'); if (!quiet) setStatus('The portable version cannot self-update. Download the new one from the releases page.'); }
    else if (m.state === 'dev') { mode = 'check'; if (!quiet) setStatus('Updates only work in the installed app.'); }
    else if (m.state === 'error') { mode = 'check'; label('v' + btn.dataset.v + ' · Check for updates'); if (!quiet) setStatus('Update check failed: ' + m.message); }
    if (m.state !== 'checking' && m.state !== 'available') silent = true; // only clicks are loud
  });
  btn.addEventListener('click', () => {
    silent = false;
    if (mode === 'check') drisUpdate.check();
    else if (mode === 'download') drisUpdate.download();
    else if (mode === 'install') drisUpdate.install();
    else if (mode === 'releases') drisUpdate.openReleases();
  });
  setTimeout(() => drisUpdate.check(), 6000); // quiet check shortly after launch
})();
