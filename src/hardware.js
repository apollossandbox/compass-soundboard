'use strict';
/* Dial Board tab: a desk-phone soundboard (12 keys, mixer, caller-ID screen). Drum Pad tab: 4x4 pads with a built-in kit or FL Studio samples. */

window.hardware = (() => {
  const PAD_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  const PAGE = 12, BANKS = ['A', 'B', 'C', 'D'];
  const DRUM_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyZ', 'KeyX', 'KeyC', 'KeyV'];
  const DRUM_LABELS = ['1', '2', '3', '4', 'Q', 'W', 'E', 'R', 'A', 'S', 'D', 'F', 'Z', 'X', 'C', 'V'];
  const KIT_COLORS = ['#e5383b', '#e5383b', '#f97316', '#f97316', '#eab308', '#eab308', '#22c55e', '#14b8a6', '#22d3ee', '#3b82f6', '#8b5cf6', '#ec4899', '#e5383b', '#14b8a6', '#8b5cf6', '#a3a3a3'];

  let built = false, bank = 0;
  const onDial = () => state.tab === 'dial';
  const onDrum = () => state.tab === 'drum';
  const kit = { name: 'Compass 808 (built-in)', synth: true, slots: new Array(16).fill(null), buffers: new Array(16).fill(null), names: [], choke: [] };
  const el = {}; // cached DOM nodes
  let hwBtns = [], drumEls = [], vuLevel = [0, 0];

  const s = () => state.settings;
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

  /* ---------------- built-in synthesized 808-ish kit ---------------- */
  function makeSynthKit() {
    const sr = mon.ctx.sampleRate;
    const mk = (len, fn) => {
      const b = mon.ctx.createBuffer(1, Math.floor(len * sr), sr);
      const d = b.getChannelData(0);
      let seed = 1234567;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
      const st = { ph: 0, lp: 0, lp2: 0 };
      for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, rnd, st, sr);
      let pk = 0; for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
      if (pk > 0) for (let i = 0; i < d.length; i++) d[i] = (d[i] / pk) * 0.92;
      const fade = Math.min(d.length, 200); for (let i = 0; i < fade; i++) d[d.length - 1 - i] *= i / fade;
      return b;
    };
    const hp = (st, x, a = 0.12) => { st.lp += a * (x - st.lp); return x - st.lp; };
    const sine = (st, f, sr) => { st.ph += (2 * Math.PI * f) / sr; return Math.sin(st.ph); };
    const kickFn = (f0, f1, k, dec) => (t, r, st, sr) => sine(st, f1 + (f0 - f1) * Math.exp(-t * k), sr) * Math.exp(-t * dec) + (t < 0.004 ? r() * 0.4 : 0);
    const tom = (f0, f1) => (t, r, st, sr) => sine(st, f1 + (f0 - f1) * Math.exp(-t * 14), sr) * Math.exp(-t * 7);
    const list = [
      ['Kick', 0.7, kickFn(170, 48, 30, 5.5)],
      ['Kick 2', 0.5, kickFn(240, 60, 45, 9)],
      ['Snare', 0.4, (t, r, st, sr) => r() * Math.exp(-t * 16) * 0.8 + sine(st, 185, sr) * Math.exp(-t * 24) * 0.7],
      ['Clap', 0.4, (t, r, st) => {
        const x = hp(st, r(), 0.3);
        const env = [0, 0.012, 0.024].reduce((a, o) => a + (t >= o ? Math.exp(-(t - o) * (o === 0.024 ? 22 : 90)) : 0), 0);
        return x * env;
      }],
      ['Hat', 0.09, (t, r, st) => hp(st, r(), 0.5) * Math.exp(-t * 55)],
      ['Open Hat', 0.5, (t, r, st) => hp(st, r(), 0.5) * Math.exp(-t * 9)],
      ['Rim', 0.12, (t, r, st, sr) => sine(st, 1650, sr) * Math.exp(-t * 70) + r() * Math.exp(-t * 90) * 0.5],
      ['Tom Hi', 0.4, tom(300, 200)],
      ['Perc', 0.25, (t, r, st, sr) => sine(st, 820 + Math.sin(t * 900) * 120, sr) * Math.exp(-t * 18)],
      ['Shaker', 0.2, (t, r, st) => hp(st, r(), 0.4) * Math.sin(Math.min(1, t / 0.18) * Math.PI) * Math.exp(-t * 6)],
      ['Cowbell', 0.4, (t, r, st, sr) => ((Math.sin((st.ph += (2 * Math.PI * 560) / sr)) > 0 ? 1 : -1) + (Math.sin((st.lp2 += (2 * Math.PI * 845) / sr)) > 0 ? 1 : -1)) * 0.5 * Math.exp(-t * 9)],
      ['Crash', 1.6, (t, r, st) => hp(st, r(), 0.35) * Math.exp(-t * 2.8)],
      ['808 Sub', 1.2, (t, r, st, sr) => sine(st, 52 + 40 * Math.exp(-t * 20), sr) * Math.exp(-t * 2.2)],
      ['Tom Lo', 0.55, tom(160, 95)],
      ['Conga', 0.3, (t, r, st, sr) => sine(st, 330 + 120 * Math.exp(-t * 40), sr) * Math.exp(-t * 12)],
      ['Riser FX', 0.9, (t, r, st) => hp(st, r(), 0.1 + t * 0.4) * Math.min(1, t * 2.2) * Math.exp(-Math.max(0, t - 0.6) * 12)],
    ];
    kit.names = list.map((x) => x[0]);
    kit.buffers = list.map(([, len, fn]) => mk(len, fn));
    kit.choke = list.map((x, i) => (i === 4 || i === 5 ? 'hat' : null));
  }

  /* ---------------- drum playing ---------------- */
  function hit(i, vel = 1) {
    const buf = kit.buffers[i];
    flash(i);
    if (!buf) return;
    const grp = kit.choke[i];
    if (grp) kit.choke.forEach((g, j) => { if (g === grp && j !== i) engine.stopSound('drum' + j); });
    engine.stopSound('drum' + i); // retrigger cuts its own tail so it stays punchy
    engine.play({ id: 'drum' + i, start: 0, end: buf.duration, volume: (s().drumVol ?? 100) * vel, rate: 2 ** ((s().drumTune ?? 0) / 12), loop: false, fade: 0 }, buf, { layer: true });
  }
  function flash(i) {
    const p = drumEls[i]; if (!p) return;
    p.classList.add('hit'); clearTimeout(p._t); p._t = setTimeout(() => p.classList.remove('hit'), 110);
  }

  async function loadKit(info, { silent = false } = {}) {
    if (!info) return;
    kit.synth = false; kit.name = info.name; kit.slots = info.slots; kit.names = info.slots.map((x) => x?.name || ''); kit.choke = [];
    kit.buffers = await Promise.all(info.slots.map(async (sl) => {
      if (!sl) return null;
      try { return await engine.decode(await drisKit.read(sl.path)); } catch { return null; }
    }));
    const n = kit.buffers.filter(Boolean).length;
    s().drumKit = { name: kit.name, synth: false, slots: kit.slots };
    save(); renderDrums();
    if (!silent) setStatus(`Loaded kit “${kit.name}” (${n}/16 pads).`);
  }
  function useSynth() {
    makeSynthKit(); kit.synth = true; kit.name = 'Compass 808 (built-in)'; kit.slots = new Array(16).fill(null);
    s().drumKit = { synth: true }; save(); renderDrums();
  }

  /* ---------------- DOM build ---------------- */
  function build() {
    const root = $('#hw');
    root.innerHTML = `
    <div class="hw-wrap">
      <div class="phone" id="hwPanel">
        <svg class="cord" id="cord" viewBox="0 0 60 420" aria-hidden="true"></svg>
        <div class="handset"><i class="ear"></i><i class="grip"></i><i class="mouth"></i></div>
        <div class="redbar"></div>
        <div class="plate">COMPASS-TEL <small>2500-D · TOUCH-TONE</small></div>
        <div class="kbsw"><button class="kb" id="kbNum" title="Top-row number keys 1-0"><i class="led"></i>KEYS 1-0</button><button class="kb" id="kbPad" title="Numpad keys"><i class="led"></i>NUMPAD</button></div>
        <div class="ph-body">
          <div class="ph-left">
            <div class="lcd">
              <div class="lcd-l0"><span id="lcd0"></span><span class="bars"><i></i><i></i><i></i><i></i></span></div>
              <div class="lcd-l1" id="lcd1"></div>
              <div class="lcd-l2" id="lcd2"></div>
            </div>
            <div class="banks" id="banks"></div>
            <div class="vus"><div class="vu" id="vuHp"><b>HP</b><div></div></div><div class="vu" id="vuSt"><b>STREAM</b><div></div></div></div>
          </div>
          <div class="keys" id="keys"></div>
          <div class="ph-right">
            <div class="faders" id="faders"></div>
            <div class="switches" id="switches"></div>
            <button class="hangup" id="hwStop"><span class="in">HANG UP</span></button>
          </div>
        </div>
      </div>

      <div class="lower">
        <div class="drum card" id="drumCard">
          <div class="card-h"><b>Drum pad</b><span class="muted" id="kitName"></span></div>
          <div class="dgrid" id="dgrid"></div>
          <div class="hint small">Keys 1-4 / Q-R / A-F / Z-V · click lower on a pad to hit harder · right-click or drop a sample to swap a pad</div>
        </div>
        <div class="kitbox card">
          <div class="card-h"><b>Kit</b></div>
          <div class="kit-btns">
            <button class="btn sm" id="kitSynth">Built-in 808</button>
            <button class="btn sm" id="kitFolder">Load folder…</button>
            <button class="btn sm" id="kitScan">Find FL Studio kits</button>
            <button class="btn sm" id="kitRandom">Random FL kit</button>
          </div>
          <select id="flSel" class="hidden"></select>
          <div class="hint small" id="flMsg">FL Studio sample packs live in <code>…\\Image-Line\\FL Studio\\Data\\Patches\\Packs</code>. Use “Load folder…” on any pack folder or a drum folder of your own.</div>
          <label class="sl">Pad volume <input id="drumVol" type="range" min="0" max="150"><span id="drumVolV"></span></label>
          <label class="sl">Tune <input id="drumTune" type="range" min="-12" max="12" step="1"><span id="drumTuneV"></span></label>
        </div>
      </div>
    </div>`;
    const drumWrap = h('<div class="hw-wrap"></div>');
    drumWrap.appendChild(root.querySelector('.lower'));
    $('#drum').appendChild(drumWrap);
    // banks
    BANKS.forEach((b, i) => {
      const x = h(`<button class="bank" data-b="${i}">LINE ${i + 1}</button>`);
      x.addEventListener('click', () => { bank = i; renderKeys(); });
      $('#banks').appendChild(x);
    });
    // faders
    const faders = [['MASTER', 'master', 100], ['HP', 'monVol', 100], ['STREAM', 'strVol', 100], ['MIC', 'micVol', 150]];
    faders.forEach(([label, key, max]) => {
      const f = h(`<div class="fader"><input type="range" min="0" max="${max}" data-k="${key}"><b>${label}</b><i></i></div>`);
      const inp = f.querySelector('input');
      inp.addEventListener('input', () => {
        s()[key] = +inp.value; engine.applyVolumes(); save(); syncMixer();
        if (key === 'master') { $('#master').value = inp.value; $('#masterVal').textContent = inp.value + '%'; }
      });
      $('#faders').appendChild(f);
    });
    // switches
    [['HP', 'monOn'], ['STREAM', 'strOn'], ['MIC', 'micOn']].forEach(([label, key]) => {
      const b = h(`<button class="sw" data-k="${key}"><span class="led"></span>${label}</button>`);
      b.addEventListener('click', () => { s()[key] = !s()[key]; save(); engine.applyDevices(); syncMixer(); });
      $('#switches').appendChild(b);
    });
    $('#hwStop').addEventListener('click', () => engine.stopAll());

    // drum controls
    $('#kitSynth').addEventListener('click', () => { useSynth(); setStatus('Built-in 808 kit loaded.'); });
    $('#kitFolder').addEventListener('click', async () => { const k = await drisKit.pickFolder(); if (k) loadKit(k); });
    $('#kitScan').addEventListener('click', scanFL);
    $('#kitRandom').addEventListener('click', async () => {
      const k = await drisKit.auto();
      if (!k) return setStatus('No FL Studio sample packs found here. Use “Load folder…” and pick your Packs folder.');
      loadKit(k);
    });
    $('#flSel').addEventListener('change', async (e) => { if (e.target.value) loadKit(await drisKit.folder(e.target.value)); });
    $('#drumVol').addEventListener('input', (e) => { s().drumVol = +e.target.value; $('#drumVolV').textContent = e.target.value + '%'; save(); });
    $('#drumTune').addEventListener('input', (e) => { s().drumTune = +e.target.value; $('#drumTuneV').textContent = (e.target.value > 0 ? '+' : '') + e.target.value + ' st'; save(); });

    window.addEventListener('keydown', (e) => {
      if (!onDrum() || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
      const i = DRUM_KEYS.indexOf(e.code);
      if (i >= 0) { e.preventDefault(); hit(i); }
    });
    window.addEventListener('keydown', (e) => { // Space = panic on this tab
      if ((onDial() || onDrum()) && e.code === 'Space' && !/INPUT|SELECT|BUTTON/.test(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) { e.preventDefault(); engine.stopAll(); }
    });
    // number keys / numpad drive the dial keys, each source can be switched off
    const DIAL = {};
    for (let n = 1; n <= 9; n++) { DIAL['Digit' + n] = [n - 1, 'num']; DIAL['Numpad' + n] = [n - 1, 'pad']; }
    Object.assign(DIAL, { Digit0: [10, 'num'], Numpad0: [10, 'pad'], NumpadMultiply: [9, 'pad'], NumpadDecimal: [11, 'pad'] });
    window.addEventListener('keydown', (e) => {
      if (!onDial() || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (document.querySelector('dialog[open]') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
      let m = DIAL[e.code];
      if (!m) return;
      if (m[1] === 'num' && e.shiftKey) { // shift+8 = *, shift+3 = #
        if (e.code === 'Digit8') m = [9, 'num']; else if (e.code === 'Digit3') m = [11, 'num']; else return;
      }
      if (!s()[m[1] === 'num' ? 'dialNum' : 'dialPad']) return;
      e.preventDefault();
      pressKey(m[0]);
    });
    [['kbNum', 'dialNum'], ['kbPad', 'dialPad']].forEach(([id, key]) => {
      $('#' + id).addEventListener('click', () => { s()[key] = !s()[key]; save(); syncMixer(); setStatus(`${key === 'dialNum' ? 'Number row' : 'Numpad'} keys ${s()[key] ? 'on' : 'off'}.`); });
    });
    let d = 'M30 0';
    for (let i = 0; i < 26; i++) { const y = 14 + i * 15; d += ' C 6 ' + (y - 2) + ', 6 ' + (y + 12) + ', 30 ' + (y + 8) + ' C 54 ' + (y + 4) + ', 54 ' + (y + 18) + ', 30 ' + (y + 15); }
    $('#cord').innerHTML = '<path d="' + d + '" fill="none" stroke="#a39b83" stroke-width="5" stroke-linecap="round"/><path d="' + d + '" fill="none" stroke="#d6cfb8" stroke-width="1.6" stroke-linecap="round" transform="translate(-1 -1)"/>';
    built = true;
  }

  function pressKey(i) {
    const b = hwBtns[i];
    if (!b) return;
    b.cap.classList.add('press');
    setTimeout(() => b.cap.classList.remove('press'), 130);
    if (b.snd) trigger(b.snd);
  }

  function renderKeys() {
    const keys = $('#keys');
    keys.innerHTML = '';
    hwBtns = [];
    document.querySelectorAll('#banks .bank').forEach((b) => b.classList.toggle('on', +b.dataset.b === bank));
    for (let n = 0; n < PAGE; n++) {
      const snd = state.sounds[bank * PAGE + n];
      const k = h(`<div class="key"><button class="cap ${snd ? '' : 'vacant'}"><span class="in"><span class="dot"></span><span class="num">${PAD_LABELS[n]}</span></span></button><div class="strip"></div></div>`);
      const cap = k.querySelector('.cap');
      k.querySelector('.strip').textContent = snd ? snd.name : '—';
      if (snd) {
        cap.style.setProperty('--c', snd.color || '#8b5cf6');
        cap.addEventListener('pointerdown', (e) => { if (e.button === 0) trigger(snd, { stop: e.shiftKey }); });
        k.addEventListener('contextmenu', (e) => showSoundMenu(e, snd));
      }
      keys.appendChild(k);
      hwBtns.push({ cap, snd });
    }
  }

  function renderDrums() {
    $('#kitName').textContent = kit.name;
    const g = $('#dgrid');
    g.innerHTML = ''; drumEls = [];
    for (let i = 0; i < 16; i++) {
      const p = h(`<div class="dpad"><span class="dk">${DRUM_LABELS[i]}</span><span class="dn"></span></div>`);
      p.style.setProperty('--c', KIT_COLORS[i]);
      p.querySelector('.dn').textContent = kit.names[i] || (kit.buffers[i] ? '' : 'empty');
      if (!kit.buffers[i]) p.classList.add('off');
      p.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        try { p.setPointerCapture(e.pointerId); } catch {}
        const r = p.getBoundingClientRect();
        hit(i, 0.55 + 0.45 * Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
      });
      p.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        const f = await drisKit.pickFile(); if (f) assignPad(i, f);
      });
      p.addEventListener('dragover', (e) => e.preventDefault());
      p.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation();
        document.getElementById('dropHint').classList.add('hidden');
        const f = e.dataTransfer.files[0]; if (!f) return;
        const pth = dris.pathForFile(f);
        if (pth) assignPad(i, { path: pth, name: f.name.replace(/\.[^.]+$/, '') });
      });
      g.appendChild(p); drumEls.push(p);
    }
    $('#drumVol').value = s().drumVol ?? 100; $('#drumVolV').textContent = (s().drumVol ?? 100) + '%';
    $('#drumTune').value = s().drumTune ?? 0; $('#drumTuneV').textContent = ((s().drumTune ?? 0) > 0 ? '+' : '') + (s().drumTune ?? 0) + ' st';
  }

  async function assignPad(i, file) {
    try {
      kit.buffers[i] = await engine.decode(await drisKit.read(file.path));
    } catch { return setStatus('That file could not be decoded.'); }
    if (kit.synth) { // switching a synth pad to a sample turns this into a custom kit
      kit.synth = false; kit.name = 'Custom kit';
      kit.slots = kit.slots.map(() => null);
    }
    kit.choke[i] = null;
    kit.slots[i] = file; kit.names[i] = file.name;
    s().drumKit = { name: kit.name, synth: false, slots: kit.slots };
    save(); renderDrums(); hit(i);
  }

  async function scanFL() {
    $('#flMsg').textContent = 'Scanning for FL Studio sample packs…';
    const r = await drisKit.scan();
    const sel = $('#flSel');
    if (!r.folders.length) {
      sel.classList.add('hidden');
      $('#flMsg').textContent = 'No FL Studio sample packs found on this PC. Use “Load folder…” and point it at your Packs folder (usually …\\Image-Line\\FL Studio\\Data\\Patches\\Packs) or any folder of drum samples.';
      return;
    }
    sel.innerHTML = '<option value="">Choose a pack folder…</option>';
    r.folders.forEach((f) => sel.add(new Option(`${f.name}  (${f.count})`, f.path)));
    sel.classList.remove('hidden');
    $('#flMsg').textContent = `Found ${r.folders.length} sample folders in FL Studio. The first 16 samples of the folder you pick fill the pads.`;
  }

  /* ---------------- mixer sync + animation loop ---------------- */
  function syncMixer() {
    if (!built) return;
    document.querySelectorAll('#faders input').forEach((i) => { i.value = s()[i.dataset.k]; i.nextElementSibling.nextElementSibling.textContent = i.value; });
    document.querySelectorAll('#switches .sw').forEach((b) => b.classList.toggle('on', !!s()[b.dataset.k]));
    $('#kbNum').classList.toggle('on', s().dialNum !== false);
    $('#kbPad').classList.toggle('on', s().dialPad !== false);
  }

  const meter = (an) => {
    const d = new Uint8Array(an.fftSize); an.getByteTimeDomainData(d);
    let pk = 0; for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i] - 128));
    return pk / 128;
  };
  function setVu(node, v) {
    const n = 12, lit = Math.round(Math.min(1, v * 1.4) * n);
    if (!node._segs) { node.innerHTML = '<i></i>'.repeat(n); node._segs = [...node.children]; }
    node._segs.forEach((sg, i) => { sg.className = i < lit ? (i > 9 ? 'r' : i > 7 ? 'y' : 'g') : ''; });
  }

  let loopOn = false;
  function loop() {
    if (!onDial()) { loopOn = false; return; }
    // VU
    [[mon, 0, '#vuHp'], [str, 1, '#vuSt']].forEach(([o, i, sel]) => {
      const v = o.enabled ? meter(o.an) : 0;
      vuLevel[i] = Math.max(v, vuLevel[i] * 0.9);
      setVu($(sel + ' div'), vuLevel[i]);
    });
    // key LEDs + LCD
    let nowName = null;
    for (const v of voices.values()) if (!v.preview && !String(v.soundId).startsWith('drum')) { nowName = state.sounds.find((x) => x.id === v.soundId)?.name; break; }
    hwBtns.forEach((b) => b.cap.classList.toggle('lit', !!b.snd && engine.isPlaying(b.snd.id)));
    const call = [...voices.values()].find((v) => !v.preview && !String(v.soundId).startsWith('drum'));
    $('#hwPanel').classList.toggle('onair', !!call);
    const outs = [s().monOn ? 'HP' : null, s().strOn ? 'STREAM' : null, s().micOn ? 'MIC' : null].filter(Boolean).join('+') || 'NO OUTPUT';
    const mm = (n) => String(Math.floor(n)).padStart(2, '0');
    if (call) {
      const el = (performance.now() - call.t0) / 1000;
      $('#lcd0').textContent = 'CONNECTED   LINE ' + (bank + 1);
      $('#lcd1').textContent = (nowName || 'UNKNOWN').toUpperCase().slice(0, 18);
      $('#lcd2').textContent = mm(el / 60) + ':' + mm(el % 60) + '   ' + outs;
    } else {
      const d = new Date();
      $('#lcd0').textContent = (Math.floor(Date.now() / 700) % 2 ? '* ' : '  ') + 'READY   LINE ' + (bank + 1);
      $('#lcd1').textContent = 'UNKNOWN CALLER';
      $('#lcd2').textContent = mm(d.getHours()) + ':' + mm(d.getMinutes()) + '   ' + outs;
    }
    requestAnimationFrame(loop);
  }

  async function show(tab) {
    if (!built) build();
    if (tab === 'dial') {
      syncMixer(); renderKeys();
      if (!loopOn) { loopOn = true; requestAnimationFrame(loop); }
      return;
    }
    if (!kit.buffers[0] && !kit.slots.some(Boolean)) {
      const saved = s().drumKit;
      if (saved && !saved.synth && saved.slots) await loadKit({ name: saved.name, slots: saved.slots }, { silent: true });
      else useSynth();
    } else renderDrums();
  }

  return {
    show, syncMixer,
    refresh() { if (built && onDial()) { renderKeys(); syncMixer(); } },
  };
})();
