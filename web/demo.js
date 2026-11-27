/* ClearerVoice — deterministic demo timeline renderer.
   Everything is a pure function of the video time t (seconds), so frames can be
   rendered offline in any order and always look identical. */
(function () {
  'use strict';

  const D = window.DEMO, TL = D.timeline, M = D.meta;
  const DUR = M.duration;
  const STAGE_W = 1920, STAGE_H = 1080;
  const stageEl = document.getElementById('stage');

  /* ---------------------------------------------------------------- utils */
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const inv = (a, b, v) => (b > a ? clamp((v - a) / (b - a)) : 0);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeBack = (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const smooth = (a, b, v) => { const t = inv(a, b, v); return t * t * (3 - 2 * t); };
  const fmt = (v, d = 1) => v.toFixed(d);

  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function mixHex(a, b, t) {
    const pa = [1, 3, 5].map((i) => parseInt(a.replace('#', '').slice(i - 1, i + 1), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.replace('#', '').slice(i - 1, i + 1), 16));
    const p = pa.map((v, i) => Math.round(lerp(v, pb[i], t)));
    return `rgb(${p[0]},${p[1]},${p[2]})`;
  }

  /* --------------------------------------------------------------- decode */
  function dec(o) {
    const bin = atob(o.b64), n = bin.length, u8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    const h = o.shape.length === 2 ? o.shape[0] : 1;
    const w = o.shape.length === 2 ? o.shape[1] : o.shape[0];
    return { data: u8, w, h };
  }
  const PK = {};
  for (const k in D.peaks) PK[k] = dec(D.peaks[k]).data;
  const SPEC = dec(D.spec_mix);
  const SPEC_FPS = D.spec_mix.fps;
  const STB = {};
  for (const s of M.stems) STB[s.id] = dec(D.stem_bands[s.id]);
  const PPS = M.pps;

  /* ------------------------------------------------------------ colormaps */
  function buildLUT(stops) {
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let a = stops[0], b = stops[stops.length - 1];
      for (let k = 0; k < stops.length - 1; k++) {
        if (t >= stops[k][0] && t <= stops[k + 1][0]) { a = stops[k]; b = stops[k + 1]; break; }
      }
      const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(lerp(a[1][c], b[1][c], clamp(f)));
    }
    return lut;
  }
  const LUT = buildLUT([
    [0.00, [5, 8, 16]],
    [0.14, [11, 32, 56]],
    [0.30, [22, 82, 118]],
    [0.46, [30, 150, 190]],
    [0.60, [53, 224, 255]],
    [0.74, [139, 124, 255]],
    [0.87, [255, 111, 181]],
    [1.00, [255, 244, 252]],
  ]);
  const LUT_TINT = {};
  for (const s of M.stems) {
    LUT_TINT[s.id] = buildLUT([
      [0.00, [4, 6, 12]],
      [0.22, [12, 20, 34]],
      [0.55, [30, 46, 72]],
      [0.82, [90, 110, 150]],
      [1.00, [255, 255, 255]],
    ]);
  }

  /* --------------------------------------------------------------- canvases */
  const IMG = new WeakMap();
  function cv(el) {
    const w = Math.max(2, el.clientWidth), h = Math.max(2, el.clientHeight);
    if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
    return el.getContext('2d');
  }
  function imgData(c, w, h) {
    let rec = IMG.get(c.canvas);
    if (!rec || rec.w !== w || rec.h !== h) {
      rec = { w, h, img: c.createImageData(w, h) };
      IMG.set(c.canvas, rec);
    }
    return rec.img;
  }

  /* ------------------------------------------------------------- song time */
  const BLOCKS = TL.audio_blocks;
  function blockIndex(t) {
    for (let i = 0; i < BLOCKS.length; i++) {
      const b = BLOCKS[i];
      if (t >= b.t0 && t < b.t0 + b.dur) return i;
    }
    return t < BLOCKS[0].t0 ? 0 : BLOCKS.length - 1;
  }
  function songPos(t) {
    const i = blockIndex(t), b = BLOCKS[i];
    const raw = b.song_off + (t - b.t0);
    if (i > 0) {
      const prev = BLOCKS[i - 1];
      const prevEnd = prev.song_off + prev.dur;
      const el = t - b.t0, J = 0.2;
      if (el < J) return raw + (b.song_off - prevEnd) * (1 - easeInOut(el / J));
    }
    return raw;
  }
  function songPosFor(t, blockT0) {
    // song position inside a specific block (used when a scene shows another section)
    const bi = BLOCKS.findIndex((b) => Math.abs(b.t0 - blockT0) < 1e-3);
    const b = BLOCKS[bi < 0 ? 0 : bi];
    return b.song_off + Math.max(0, t - b.t0);
  }

  /* ------------------------------------------------------------- draw prims */
  function drawSpec(el, pos, spec, lut, o) {
    o = o || {};
    const c = cv(el), w = el.width, h = el.height;
    const span = o.span || 8, push = o.push == null ? 0.72 : o.push;
    const bands = spec.h, frames = spec.w, fps = SPEC_FPS;
    const img = imgData(c, w, h), dat = img.data;
    const fadeIn = o.alpha == null ? 1 : o.alpha;
    const bright = o.gain == null ? 1 : o.gain;
    for (let x = 0; x < w; x++) {
      const sec = pos + (x / w - push) * span;
      let f = Math.round(sec * fps);
      f = f < 0 ? 0 : f >= frames ? frames - 1 : f;
      for (let y = 0; y < h; y++) {
        const bf = (1 - (y + 0.5) / h) * (bands - 1);
        const b = bf < 0 ? 0 : bf > bands - 1 ? bands - 1 : Math.floor(bf);
        let v = spec.data[b * frames + f] / 255;
        v = Math.pow(v * bright, 1.05);
        if (v > 1) v = 1;
        const l = (v * 255) | 0;
        const o4 = (y * w + x) * 4;
        dat[o4] = lut[l * 3];
        dat[o4 + 1] = lut[l * 3 + 1];
        dat[o4 + 2] = lut[l * 3 + 2];
        dat[o4 + 3] = fadeIn * 255;
      }
    }
    c.putImageData(img, 0, 0);
  }

  function drawWaveShape(c, px, py, pw, ph, peaks, pos, o) {
    const span = o.span || 6, push = o.push == null ? 0.45 : o.push;
    const color = o.color || '#35E0FF', amp = o.amp == null ? 1 : o.amp;
    const midY = py + ph / 2;
    const half = (ph / 2 - 1) * amp;
    const n = peaks.length;
    const N = Math.max(2, Math.round(pw));
    const top = new Float32Array(N), bot = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const sec = pos + (i / N - push) * span;
      let idx = Math.round(sec * PPS);
      idx = idx < 0 ? 0 : idx >= n ? n - 1 : idx;
      const v = Math.pow(peaks[idx], 0.72);
      top[i] = midY - v * half;
      bot[i] = midY + v * half * 0.86;
    }
    c.save();
    c.beginPath();
    c.moveTo(px, top[0]);
    for (let i = 1; i < N; i++) c.lineTo(px + i, top[i]);
    for (let i = N - 1; i >= 0; i--) c.lineTo(px + i, bot[i]);
    c.closePath();
    const g = c.createLinearGradient(0, py, 0, py + ph);
    g.addColorStop(0, hexA(color, 0.92));
    g.addColorStop(0.42, hexA(color, 0.72));
    g.addColorStop(0.58, hexA(color, 0.36));
    g.addColorStop(1, hexA(color, 0.78));
    c.fillStyle = g;
    c.fill();
    // crisp crest line
    c.beginPath();
    c.moveTo(px, top[0]);
    for (let i = 1; i < N; i++) {
      const y = i % 2 ? top[i] : (top[i] + top[i - 1]) / 2;
      c.lineTo(px + i, y);
    }
    c.strokeStyle = hexA(color, 0.85);
    c.lineWidth = 1.1;
    c.shadowColor = hexA(color, 0.55);
    c.shadowBlur = 12;
    c.stroke();
    c.restore();

    if (o.playhead !== false) {
      const x = px + pw * push;
      c.save();
      const lg = c.createLinearGradient(x - 14, 0, x + 2, 0);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(1, hexA(color, 0.18));
      c.fillStyle = lg;
      c.fillRect(x - 14, py, 16, ph);
      c.strokeStyle = 'rgba(255,255,255,.92)';
      c.lineWidth = 1.4;
      c.shadowColor = 'rgba(255,255,255,.8)';
      c.shadowBlur = 10;
      c.beginPath();
      c.moveTo(x, py + 1);
      c.lineTo(x, py + ph - 1);
      c.stroke();
      c.restore();
    }
    if (o.baseline !== false) {
      c.save();
      c.strokeStyle = 'rgba(255,255,255,.07)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(px, midY);
      c.lineTo(px + pw, midY);
      c.stroke();
      c.restore();
    }
  }

  function ellipsisDots(c, x, y, ph, color, n, phase) {
    for (let i = 0; i < n; i++) {
      const a = 0.25 + 0.75 * Math.max(0, Math.sin(phase * 4 - i * 0.9));
      c.fillStyle = hexA(color, a);
      c.beginPath();
      c.arc(x + i * 9, y + ph / 2, 2.1, 0, Math.PI * 2);
      c.fill();
    }
  }

  function drawMark(el, pos, phase) {
    const c = cv(el), w = el.width, h = el.height;
    c.clearRect(0, 0, w, h);
    const s = Math.min(w, h);
    const r = s * 0.24;
    c.save();
    const bg = c.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, 'rgba(53,224,255,.20)');
    bg.addColorStop(0.55, 'rgba(139,124,255,.20)');
    bg.addColorStop(1, 'rgba(255,111,181,.16)');
    c.fillStyle = bg;
    c.beginPath();
    if (c.roundRect) c.roundRect(1, 1, w - 2, h - 2, r);
    else c.rect(1, 1, w - 2, h - 2);
    c.fill();
    const stroke = c.createLinearGradient(0, 0, w, h);
    stroke.addColorStop(0, 'rgba(124,240,255,.75)');
    stroke.addColorStop(0.5, 'rgba(200,190,255,.55)');
    stroke.addColorStop(1, 'rgba(255,183,222,.55)');
    c.strokeStyle = stroke;
    c.lineWidth = Math.max(1.2, s * 0.022);
    c.beginPath();
    if (c.roundRect) c.roundRect(1, 1, w - 2, h - 2, r);
    else c.rect(1, 1, w - 2, h - 2);
    c.stroke();

    // 4 bars taken from the live mixture envelope
    const bars = 4, pad = s * 0.26, span = s - pad * 2, bw = span / (bars * 1.9);
    const base = songPos(phase);
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      const off = (i - 1.5) * 0.06;
      for (let k = -3; k <= 3; k++) {
        const idx = Math.round((base + off) * PPS + k * 3);
        if (idx >= 0 && idx < PK.mix.length) peak = Math.max(peak, PK.mix[idx]);
      }
      const v = Math.max(0.18, Math.pow(peak, 0.7));
      const bh = span * 0.42 * v + s * 0.05;
      const x = pad + i * (bw * 1.9) + (span - bars * bw * 1.9) / 2;
      const g = c.createLinearGradient(x, 0, x + bw, 0);
      g.addColorStop(0, '#7CF0FF');
      g.addColorStop(0.55, '#B9AEFF');
      g.addColorStop(1, '#FFB7DE');
      c.fillStyle = g;
      c.beginPath();
      if (c.roundRect) c.roundRect(x, (h - bh) / 2, bw, bh, bw / 2);
      else c.rect(x, (h - bh) / 2, bw, bh);
      c.fill();
    }
    c.restore();
  }

  /* ---------------------------------------------------------------- DOM refs */
  const $ = (id) => document.getElementById(id);
  const lanesEl = $('lanes');
  const laneRefs = [];
  M.stems.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'lane';
    el.dataset.id = s.id;
    el.innerHTML =
      `<div class="glowline" style="background:${s.color};opacity:.55"></div>
       <div class="lhead"><span class="dot" style="background:${s.color};box-shadow:0 0 14px ${s.color}"></span>
         <div class="lnames"><b>${s.label}</b><span>${s.en}</span></div></div>
       <canvas class="lwave"></canvas>
       <div class="lctl">
         <div class="pills"><div class="pill solo">SOLO</div><div class="pill mute">MUTE</div></div>
         <div class="meter">${'<i><u></u></i>'.repeat(14)}</div>
       </div>`;
    lanesEl.appendChild(el);
    laneRefs.push({
      el, color: s.color, id: s.id,
      wave: el.querySelector('.lwave'),
      solo: el.querySelector('.solo'),
      mute: el.querySelector('.mute'),
      bars: [...el.querySelectorAll('.meter u')],
    });
  });

  const ecardsEl = $('ecards');
  const EXPORTS = [
    { icon: 'WAV', name: '人声 · 鼓 · 贝斯 · 其他', sub: '24 bit / 48 kHz · 无损 PCM', file: 'stems/*.wav',
      lines: ['4 条独立分轨', '与原始混音逐帧对齐', '可直接拖进 DAW'] },
    { icon: 'MIX', name: '伴奏 / 卡拉 OK', sub: '16 bit / 48 kHz · 立体声', file: 'instrumental.wav',
      lines: ['人声轨已静音', '鼓 · 贝斯 · 其他保留', 'K 歌、翻唱、配乐'] },
    { icon: 'MP3', name: '快速分享', sub: '320 kbps · 带元数据', file: 'preview.mp3',
      lines: ['分轨试听预览', '体积小、即时分享', '保留分轨标签'] },
  ];
  EXPORTS.forEach((x) => {
    const el = document.createElement('div');
    el.className = 'ecard';
    el.innerHTML =
      `<div class="eicon">${x.icon}</div>
       <div class="ready badge" style="opacity:0"><span class="tick">✓</span>就绪</div>
       <h3>${x.name}</h3>
       <div class="sub">${x.sub} · ${x.file}</div>
       <ul>${x.lines.map((l) => `<li><i></i>${l}</li>`).join('')}</ul>`;
    ecardsEl.appendChild(el);
  });
  const ecards = [...ecardsEl.children];

  const LOGS = [
    'decode → mix_48k.wav · 6.4 MB',
    'load htdemucs · 4 sources · 80 MB',
    'stft + 4 × mask · frames 1697',
    'istft → 4 stems · 48 kHz / 24 bit',
  ];
  const logsEl = $('logs');
  const logRefs = LOGS.map((txt) => {
    const el = document.createElement('div');
    el.className = 'logline';
    el.innerHTML = `<span class="box"></span><span>${txt}</span>`;
    logsEl.appendChild(el);
    return { el, box: el.querySelector('.box') };
  });

  const CURSOR = $('cursor'), RIPPLE = $('ripple');
  const fadeEl = document.createElement('div');
  fadeEl.style.cssText = 'position:absolute;inset:0;background:#03050A;z-index:120;pointer-events:none;opacity:0';
  stageEl.appendChild(fadeEl);

  /* --------------------------------------------------------------- layout */
  const refs = {
    aurora: $('aurora'), mark: $('mark'), ribbon: $('ribbon'),
    heroSpec: $('heroSpec'), heroWave: $('heroWave'), heroCard: $('heroCard'),
    heroFoot: $('heroFoot'), heroLabel: $('heroLabel'),
    drop: $('drop'), filecard: $('filecard'), fileWave: $('fileWave'),
    sepBtn: $('sepBtn'), progFill: $('progFill'), progText: $('progText'), progPct: $('progPct'),
    doneBadge: $('doneBadge'), etaHint: $('etaHint'), optBtn: $('optBtn'),
    fcard: $('fcard'), fnum: $('fnum'), fen: $('fen'), fcn: $('fcn'), fdesc: $('fdesc'),
    fspec: $('fspec'), fst1: $('fst1'), fst2: $('fst2'), fcaption: $('fcaption'),
    toggle: $('modeToggle'), tgKeep: $('tgKeep'), tgDrop: $('tgDrop'),
    outroMark: $('outroMark'), watermark: $('watermark'),
    rail: [...document.querySelectorAll('#rail .rdot')],
    sections: [...document.querySelectorAll('.scene')],
    io: [...document.querySelectorAll('[data-io]')],
  };

  // hero footer stem legend
  refs.heroFoot.innerHTML = M.stems.map((s) =>
    `<div class="tag"><i style="background:${s.color};box-shadow:0 0 10px ${s.color}"></i>${s.label}</div>`).join('');

  let SCALE = 1;
  function layout() {
    const html = document.documentElement;
    const portrait = window.innerHeight > window.innerWidth * 1.15;
    html.classList.toggle('portrait', portrait);
    html.classList.toggle('landscape', !portrait);
    const w = portrait ? 1080 : 1920, h = portrait ? 1920 : 1080;
    window.STAGE_W = w; window.STAGE_H = h;
    SCALE = Math.min(window.innerWidth / w, window.innerHeight / h);
    stageEl.style.transform = `scale(${SCALE})`;
    stageEl.style.width = w + 'px';
    stageEl.style.height = h + 'px';
  }
  function stageRect(el) {
    const sr = stageEl.getBoundingClientRect(), r = el.getBoundingClientRect();
    const s = sr.width / window.STAGE_W;
    return { x: (r.left - sr.left) / s, y: (r.top - sr.top) / s, w: r.width / s, h: r.height / s };
  }

  /* ---------------------------------------------------------- scene plumbing */
  const SC = {};
  TL.scenes.forEach((s) => (SC[s.id] = s));
  const sEl = {};
  refs.sections.forEach((el) => (sEl[el.id.replace('s-', '')] = el));

  // the analysis stage (stems -> together -> karaoke) shares one layout
  const VIEW = [
    { id: 'hook', el: 's-hook', t0: SC.hook.t0, t1: SC.hook.t1 },
    { id: 'upload', el: 's-upload', t0: SC.upload.t0, t1: SC.upload.t1 },
    { id: 'analysis', el: 's-stems', t0: SC.stems.t0, t1: SC.karaoke.t1 },
    { id: 'export', el: 's-export', t0: SC.export.t0, t1: SC.export.t1 },
    { id: 'outro', el: 's-outro', t0: SC.outro.t0, t1: SC.outro.t1 },
  ];

  function vis(v, t) {
    const a = smooth(v.t0 - 0.02, v.t0 + 0.5, t) * (1 - smooth(v.t1 - 0.3, v.t1 + 0.10, t));
    return { a, p: easeOut(clamp(inv(v.t0, v.t1, t))) };
  }
  function setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }

  /* ------------------------------------------------------------------ HOOK */
  const ioDelays = [0.12, 0.26, 0.42, 0.66, 0.94];
  function renderHook(t, local) {
    refs.io.forEach((el, i) => {
      const k = easeOut(inv(ioDelays[i] || 1, (ioDelays[i] || 1) + 0.55, local));
      el.style.opacity = k;
      el.style.transform = `translateY(${(1 - k) * 26}px)`;
    });
    const hc = easeOut(inv(0.3, 1.1, local));
    refs.heroCard.style.opacity = hc;
    refs.heroCard.style.transform = `translateY(${(1 - hc) * 34}px) scale(${lerp(0.965, 1, hc)})`;

    const pos = songPos(t);
    drawSpec(refs.heroSpec, pos, SPEC, LUT, { span: 12, push: 0.74, gain: 1.02 });

    const c = cv(refs.heroWave), w = refs.heroWave.width, h = refs.heroWave.height;
    c.clearRect(0, 0, w, h);
    const p = smooth(3.0, 4.5, local);
    if (p < 0.995) {
      c.globalAlpha = 1 - p;
      drawWaveShape(c, 0, 0, w, h, PK.mix, pos, { span: 9, push: 0.62, color: '#8FA3CC', amp: 0.95 });
      c.globalAlpha = 1;
    }
    if (p > 0.005) {
      const rowH = h / 4;
      M.stems.forEach((s, i) => {
        c.globalAlpha = p;
        const rowP = clamp((p - i * 0.09) / 0.7);
        drawWaveShape(c, 0, i * rowH, w, rowH, PK[s.id], pos,
          { span: 9, push: 0.62, color: s.color, amp: 1.5 * rowP, playhead: i === 0, baseline: true });
        c.globalAlpha = 1;
      });
    }
    refs.heroFoot.style.opacity = smooth(3.5, 4.6, local);
    setText(refs.heroLabel, p > 0.55 ? '4 STEMS · 48 kHz' : 'MIXTURE · 48 kHz');
  }

  /* ---------------------------------------------------------------- UPLOAD */
  let btnRect = null;
  function renderUpload(t, local) {
    const pos = songPos(t);
    const fc = easeOut(inv(0.5, 0.95, local));
    refs.drop.style.borderColor = fc > 0.5 ? 'rgba(53,224,255,.42)' : 'rgba(255,255,255,.16)';
    refs.drop.style.background = fc > 0.5 ? 'rgba(53,224,255,.035)' : 'rgba(255,255,255,.018)';
    refs.filecard.style.display = fc > 0.01 ? 'flex' : 'none';
    refs.filecard.style.opacity = fc;
    refs.filecard.style.transform = `translateY(${(1 - fc) * 10}px)`;
    refs.drop.querySelector('.ic').style.opacity = 1 - fc;
    refs.drop.querySelector('.txt').style.opacity = 1 - fc;
    if (fc > 0.2) {
      const cc = cv(refs.fileWave), w = refs.fileWave.width, h = refs.fileWave.height;
      cc.clearRect(0, 0, w, h);
      drawWaveShape(cc, 0, 0, w, h, PK.mix, pos, { span: 42, push: 0.5, color: '#9DB4FF', amp: 0.86, playhead: false });
    }

    if (!btnRect) btnRect = stageRect(refs.sepBtn);
    const cp = inv(0.85, 1.72, local);
    const start = { x: btnRect.x + 210, y: btnRect.y + 230 };
    const end = { x: btnRect.x + btnRect.w * 0.42, y: btnRect.y + btnRect.h * 0.62 };
    const cIn = smooth(0.8, 1.05, local);
    CURSOR.style.display = cIn > 0.02 ? 'block' : 'none';
    CURSOR.style.opacity = cIn;
    const e = easeInOut(cp);
    CURSOR.style.transform = `translate(${lerp(start.x, end.x, e) - 6}px,${lerp(start.y, end.y, e) - 4}px) scale(${0.92 + 0.08 * Math.sin(clamp(cp) * Math.PI)})`;

    const clickT = 1.8;
    const rp = inv(clickT, clickT + 0.55, local);
    RIPPLE.style.display = rp > 0.01 && rp < 1 ? 'block' : 'none';
    RIPPLE.style.left = end.x + 'px';
    RIPPLE.style.top = end.y + 'px';
    RIPPLE.style.opacity = rp > 0 ? (1 - rp) * 0.9 : 0;
    RIPPLE.style.transform = `translate(-50%,-50%) scale(${0.3 + rp * 1.5})`;

    const p = easeInOut(inv(1.9, 5.3, local));
    refs.progFill.style.width = (p * 100).toFixed(2) + '%';
    setText(refs.progPct, Math.round(p * 100) + '%');
    setText(refs.progText, p <= 0 ? (local < 1.9 ? '等待开始' : '准备中') :
      p < 0.34 ? '解析音频 · 载入模型' : p < 0.72 ? '时频掩码推理中' : p < 1 ? '波形重建 · 写盘' : '分离完成');
    const btnLabel = p > 0 && p < 1 ? '分离中' : p >= 1 ? '再次分离' : '开始分离';
    if (refs.sepBtn.dataset.l !== btnLabel) {
      refs.sepBtn.dataset.l = btnLabel;
      refs.sepBtn.lastChild.textContent = btnLabel;
    }
    setText(refs.etaHint, p >= 1 ? '已用 11.6 s · 3.7× 实时' :
      p > 0 ? `预计剩余 ${Math.max(1, Math.round((1 - p) * 12))} 秒` : '预计 12 秒');

    const times = [2.05, 2.75, 3.45, 4.15];
    logRefs.forEach((lg, i) => {
      const k = easeOut(inv(times[i], times[i] + 0.4, local));
      lg.el.style.opacity = 0.25 + 0.75 * k;
      lg.box.style.borderColor = k > 0.5 ? 'rgba(124,231,192,.7)' : 'rgba(255,255,255,.22)';
      lg.box.textContent = k > 0.5 ? '✓' : '';
    });
    const dk = easeOut(inv(5.45, 5.9, local));
    refs.doneBadge.style.opacity = dk;
    refs.doneBadge.style.transform = `translateY(${(1 - dk) * 8}px)`;

    setText($('chip3'), p >= 1 ? '分离完成 · 11.6 s' : p > 0 ? '分离中 · 4 轨推理' : '本地处理 · 零上传');
    const c3 = $('chip3').parentElement;
    c3.classList.toggle('good', p >= 1 || p <= 0);
    c3.classList.toggle('warn', p > 0 && p < 1);
  }

  /* ------------------------------------------------------- ANALYSIS STAGE */
  const DESC = {
    vocals: '唇齿、气声、尾音都留住了 —— 可以直接用于配音、字幕对齐与 AI 声音克隆。',
    drums: '底鼓、军鼓、踩镲分层干净，方便替换鼓组，或单独导出做节奏采样。',
    bass: '低频结实不浑浊，可以单独混音、重新编曲，也能拿去做低频分析。',
    other: '钢琴、吉他、弦乐与合成器都在这一轨，用于伴奏重制与二次编曲。',
    mix: '四条分轨与原始混音逐帧对齐：分离是可逆的工程处理，不是滤镜。',
  };
  const CAPTION = {
    vocals: '人声单独试听 —— 只剩一条干净的人声。',
    drums: '鼓单独试听 —— 节拍骨架被完整抽了出来。',
    bass: '贝斯单独试听 —— 低频线条不再被埋。',
    other: '其他乐器单独试听 —— 和声与旋律铺底。',
    mix: '分离结果：4 条分轨，全部与原始混音对齐。',
  };
  const STEM_STATS = {};
  M.stems.forEach((s, i) => {
    const a = PK[s.id];
    let peak = 0, act = 0;
    for (let k = 0; k < a.length; k++) { if (a[k] > peak) peak = a[k]; if (a[k] > 0.03) act++; }
    STEM_STATS[s.id] = { peak: 20 * Math.log10(peak + 1e-9), act: (act / a.length) * 100, index: i + 1 };
  });
  STEM_STATS.mix = { peak: 0, act: 100, index: 0 };

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function drawSpecRect(c, px, py, pw, ph, pos, spec, lut) {
    const span = 7, push = 0.72;
    const bands = spec.h, frames = spec.w, fps = SPEC_FPS;
    const img = c.createImageData(pw, ph), dat = img.data;
    for (let x = 0; x < pw; x++) {
      const sec = pos + (x / pw - push) * span;
      let f = Math.round(sec * fps);
      f = f < 0 ? 0 : f >= frames ? frames - 1 : f;
      for (let y = 0; y < ph; y++) {
        const bf = (1 - (y + 0.5) / ph) * (bands - 1);
        const b = bf < 0 ? 0 : bf > bands - 1 ? bands - 1 : Math.floor(bf);
        const v = spec.data[b * frames + f];
        const o4 = (y * pw + x) * 4;
        dat[o4] = lut[v * 3]; dat[o4 + 1] = lut[v * 3 + 1]; dat[o4 + 2] = lut[v * 3 + 2]; dat[o4 + 3] = 255;
      }
    }
    c.putImageData(img, px, py);
  }

  const HEAD = {
    stems: ['四条无损分轨', '同一段音频，四种声音被完整拆开 —— 单独试听、单独导出。', 'htdemucs · 4 stems · 48 kHz'],
    together: ['四条相加 = 原曲', '分离不是滤镜：4 条分轨逐帧对齐，可以原样还原混音。', '可逆 · 逐帧对齐'],
    karaoke: ['伴奏模式 · 人声静音', '人声轨一键静音，鼓 / 贝斯 / 其他乐器仍然完整对齐。', '可直接用于 K 歌与翻唱'],
  };

  function renderAnalysis(t, local) {
    const mode = t < SC.stems.t1 ? 'stems' : t < SC.karaoke.t0 ? 'together' : 'karaoke';
    const pos = songPos(t);
    const cue = currentCue(t);
    let focus, mixP;
    if (mode === 'karaoke') { focus = 'vocals'; mixP = 1; }
    else if (mode === 'together') { focus = 'mix'; mixP = 0; }
    else { focus = cue.stem; mixP = smooth(cue.t0, cue.t0 + 0.28, t); }

    laneRefs.forEach((L, i) => {
      const enter = easeOut(inv(0.06 + i * 0.075, 0.6 + i * 0.075, local));
      const isFocus = L.id === focus;
      const target = mode === 'karaoke'
        ? (L.id === 'vocals' ? 0.32 : 1)
        : focus === 'mix' ? 1 : (isFocus ? 1 : 0.34);
      const a = lerp(1, target, mode === 'together' ? 0 : mixP);
      L.el.style.opacity = enter;
      L.el.style.transform = `translateX(${(1 - enter) * -26}px)`;
      const lit = isFocus && mode === 'stems';
      L.el.style.borderColor = lit ? hexA(L.color, 0.48) : 'rgba(255,255,255,.10)';
      L.el.style.background = lit
        ? `linear-gradient(100deg,${hexA(L.color, 0.13)},rgba(255,255,255,.025) 62%)`
        : 'rgba(255,255,255,.032)';
      L.el.style.boxShadow = lit ? `0 18px 50px -34px ${hexA(L.color, 0.95)}` : 'none';

      const muted = mode === 'karaoke' && L.id === 'vocals';
      const wc = cv(L.wave), w = L.wave.width, h = L.wave.height;
      wc.clearRect(0, 0, w, h);
      wc.globalAlpha = (muted ? 0.3 : a) * enter;
      drawWaveShape(wc, 0, 0, w, h, PK[L.id], pos,
        { span: 6.5, push: 0.42, color: L.color, amp: isFocus || mode === 'together' ? 1.22 : 0.9 });
      if (muted) {
        wc.globalAlpha = 1;
        wc.strokeStyle = 'rgba(255,255,255,.26)';
        wc.lineWidth = 1.2;
        wc.setLineDash([5, 6]);
        wc.beginPath(); wc.moveTo(0, h / 2); wc.lineTo(w, h / 2); wc.stroke();
        wc.setLineDash([]);
        wc.fillStyle = 'rgba(255,255,255,.44)';
        wc.font = '13px "Noto Sans CJK SC"';
        wc.fillText('人声轨已静音 · 保留鼓 / 贝斯 / 其他乐器', 14, h / 2 - 12);
      }
      wc.globalAlpha = 1;

      const soloOn = lit;
      L.solo.style.background = soloOn ? hexA(L.color, 0.2) : 'transparent';
      L.solo.style.color = soloOn ? L.color : 'rgba(234,240,248,.45)';
      L.solo.style.borderColor = soloOn ? hexA(L.color, 0.55) : 'rgba(255,255,255,.1)';
      L.solo.style.boxShadow = soloOn ? `0 0 18px -6px ${hexA(L.color, 0.8)}` : 'none';
      const muteOn = mode === 'karaoke' && L.id === 'vocals';
      L.mute.style.background = muteOn ? 'rgba(255,90,120,.22)' : 'transparent';
      L.mute.style.color = muteOn ? '#FF8FA8' : 'rgba(234,240,248,.45)';
      L.mute.style.borderColor = muteOn ? 'rgba(255,120,150,.6)' : 'rgba(255,255,255,.1)';

      const sb = STB[L.id];
      const fr = Math.min(sb.w - 1, Math.round(pos * (sb.w / M.song_duration)));
      let level = 0;
      for (let b = 0; b < sb.h; b++) level += sb.data[b * sb.w + fr];
      level = (level / sb.h) / 255;
      if (muted) level = 0;
      const nLit = Math.round(clamp(level * 1.6) * L.bars.length);
      L.bars.forEach((u, bi) => {
        const on = bi < nLit;
        u.style.background = on ? mixHex(L.color, '#FFF6FF', (bi / L.bars.length) * 0.45) : 'rgba(255,255,255,.07)';
        u.style.opacity = on ? 1 : 0.5;
      });
    });

    // headline
    const head = HEAD[mode];
    setText($('sTitle'), head[0]);
    setText($('sSub'), head[1]);
    setText($('stemChipText'), head[2]);

    // focus card
    const st = STEM_STATS[focus];
    const k = mode === 'stems' ? easeOut(inv(cue.t0, cue.t0 + 0.34, t)) : 1;
    [refs.fen, refs.fcn, refs.fdesc].forEach((el) => {
      el.style.opacity = 0.4 + 0.6 * k;
      el.style.transform = `translateY(${(1 - k) * 9}px)`;
    });
    const info = focus === 'mix' ? null : M.stems.find((s) => s.id === focus);
    const meta = mode === 'karaoke'
      ? { en: 'INSTRUMENTAL', cn: '伴奏', num: 'VOCALS MUTED' }
      : focus === 'mix'
        ? { en: 'MIXTURE', cn: '全轨混合', num: '4 STEMS → MIX' }
        : { en: info.en, cn: info.label, num: `STEM 0${st.index} / 04` };
    setText(refs.fen, meta.en);
    setText(refs.fcn, meta.cn);
    setText(refs.fnum, meta.num);
    setText(refs.fdesc, mode === 'karaoke'
      ? '人声轨已静音，鼓、贝斯与其他乐器仍然逐帧对齐 —— 直接拿去 K 歌、翻唱、剪辑配乐。'
      : DESC[focus]);
    setText(refs.fcaption, mode === 'karaoke' ? '去掉人声 ≠ 拆掉伴奏：被静音的只有人声这一条。' :
      mode === 'together' ? `四条相加 ≈ 原曲 · 相对重建误差 ${(D.stats ? D.stats.recon_db.toFixed(1) : -17.9)} dB` :
      CAPTION[focus]);

    const color = info ? info.color : '#8B7CFF';
    if (mode === 'karaoke') {
      const c2 = cv(refs.fspec), w = refs.fspec.width, h = refs.fspec.height;
      c2.clearRect(0, 0, w, h);
      const ids = ['drums', 'bass', 'other'], rowH = Math.floor((h - 16) / 3);
      ids.forEach((id, i) => {
        const col = M.stems.find((s) => s.id === id).color;
        const rgb = hexToRgb(col);
        const lut = buildLUT([[0, [4, 6, 12]], [0.35, [14, 24, 38]], [0.72, [rgb[0] * 0.6 | 0, rgb[1] * 0.6 | 0, rgb[2] * 0.6 | 0]], [1, rgb]]);
        const y = i * (rowH + 8);
        c2.save();
        c2.beginPath(); c2.rect(0, y, w, rowH); c2.clip();
        drawSpecRect(c2, 0, y, w, rowH, pos, STB[id], lut);
        c2.restore();
        c2.fillStyle = 'rgba(255,255,255,.66)';
        c2.font = '11px "Noto Sans CJK SC"';
        c2.fillText(M.stems.find((s) => s.id === id).label, 8, y + 15);
      });
      setText(refs.fst1, '3 轨');
      setText(refs.fst2, '人声 0%');
    } else {
      drawSpec(refs.fspec, pos, focus === 'mix' ? SPEC : STB[focus],
        focus === 'mix' ? LUT : LUT_TINT[focus],
        { span: 7, push: 0.72, gain: focus === 'mix' ? 1 : 1.55 });
      setText(refs.fst1, (st.peak >= 0 ? '0.0' : st.peak.toFixed(1)) + ' dB');
      setText(refs.fst2, st.act.toFixed(0) + '%');
    }
    refs.fcard.style.borderColor = hexA(color, 0.3);
    refs.fcard.style.boxShadow = `0 30px 80px -52px ${hexA(color, 0.6)}, inset 0 1px 0 rgba(255,255,255,.06)`;
    refs.fen.style.color = color;

    // karaoke toggle
    const kp = mode === 'karaoke' ? easeOut(inv(SC.karaoke.t0 + 0.6, SC.karaoke.t0 + 1.3, t)) : 0;
    refs.toggle.style.display = kp > 0.01 ? 'flex' : 'none';
    refs.toggle.style.opacity = kp;
    refs.toggle.style.transform = `translateY(${(1 - kp) * 10}px)`;
    refs.tgKeep.classList.toggle('on', false);
    refs.tgDrop.classList.toggle('on', true);
  }

  /* ----------------------------------------------------------------- EXPORT */
  function renderExport(t, local) {
    ecards.forEach((el, i) => {
      const k = easeOut(inv(0.1 + i * 0.13, 0.75 + i * 0.13, local));
      el.style.opacity = k;
      el.style.transform = `translateY(${(1 - k) * 36}px)`;
      el.style.borderColor = k > 0.8 ? 'rgba(139,124,255,.26)' : 'rgba(255,255,255,.10)';
      const ready = el.querySelector('.ready');
      const rk = easeOut(inv(0.85 + i * 0.16, 1.2 + i * 0.16, local));
      ready.style.opacity = rk;
      ready.style.transform = `translateY(${(1 - rk) * 6}px)`;
    });
    const nums = [40, 11.6, 4, 0];
    const sp = easeOutExpo(inv(0.9, 2.2, local));
    document.querySelectorAll('.estat b').forEach((el, i) => {
      const v = nums[i] * sp;
      const unit = i === 2 || i === 3 ? '' : '<small style="font-size:18px"> s</small>';
      el.innerHTML = (i === 1 ? v.toFixed(1) : Math.round(v)) + unit;
    });
  }

  /* ------------------------------------------------------------------ OUTRO */
  function renderOutro(t, local) {
    const pos = songPos(t);
    const mk = smooth(0.05, 0.95, local);
    refs.outroMark.style.transform = `scale(${0.7 + 0.3 * easeBack(clamp(mk))})`;
    refs.outroMark.style.opacity = mk;
    drawMark(refs.outroMark, pos, t);
    const wrap = refs.outroMark.parentElement;
    const nameEl = wrap.querySelector('.oname'), tagEl = wrap.querySelector('.otag'),
      ctaEl = wrap.querySelector('.octa'), footEl = wrap.querySelector('.ofoot');
    const nk = easeOut(inv(0.25, 0.95, local));
    nameEl.style.opacity = nk;
    nameEl.style.transform = `translateY(${(1 - nk) * 18}px)`;
    nameEl.style.letterSpacing = lerp(7, -2, nk) + 'px';
    const tk = easeOut(inv(0.55, 1.2, local));
    tagEl.style.opacity = tk;
    tagEl.style.transform = `translateY(${(1 - tk) * 14}px)`;
    const ck = easeOut(inv(1.0, 1.7, local));
    ctaEl.style.opacity = ck;
    ctaEl.style.transform = `translateY(${(1 - ck) * 20}px) scale(${lerp(0.94, 1, easeBack(clamp(ck))) * (1 + 0.01 * Math.sin(t * 3.2))})`;
    footEl.style.opacity = easeOut(inv(1.3, 1.9, local)) * 0.9;
  }

  /* ---------------------------------------------------------------- RIBBON */
  const RIB = [
    { id: 'mix', color: '#8B7CFF', base: 1.06, amp: 0.95, alpha: 0.16 },
    { id: 'drums', color: '#FFAE5C', base: 1.00, amp: 0.52, alpha: 0.20 },
    { id: 'bass', color: '#6E9BFF', base: 0.94, amp: 0.46, alpha: 0.22 },
    { id: 'other', color: '#4FE3C1', base: 0.86, amp: 0.44, alpha: 0.20 },
    { id: 'vocals', color: '#FF6FB5', base: 0.80, amp: 0.56, alpha: 0.24 },
  ];
  function drawRibbon(t) {
    const el = refs.ribbon;
    const c = cv(el), w = el.width, h = el.height;
    c.clearRect(0, 0, w, h);
    if (!w) return;
    const pos = songPos(t);
    const span = 15, push = 0.5;
    const N = Math.max(2, Math.round(w / 2));
    for (const L of RIB) {
      const peaks = PK[L.id];
      const n = peaks.length;
      const env = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const sec = pos + (i / N - push) * span;
        let idx = Math.round(sec * PPS);
        idx = idx < 0 ? 0 : idx >= n ? n - 1 : idx;
        env[i] = Math.pow(peaks[idx], 0.62);
      }
      // smooth so it reads as a hillside, not a barcode
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < N - 1; i++) env[i] = (env[i - 1] + env[i] * 2 + env[i + 1]) / 4;
      }
      const baseY = h * L.base;
      c.save();
      c.beginPath();
      c.moveTo(0, baseY - env[0] * h * L.amp);
      for (let i = 1; i < N; i++) c.lineTo(i * 2, baseY - env[i] * h * L.amp);
      c.lineTo(w, h + 24);
      c.lineTo(0, h + 24);
      c.closePath();
      const g = c.createLinearGradient(0, baseY - h * 0.6, 0, h);
      g.addColorStop(0, hexA(L.color, L.alpha * 1.5));
      g.addColorStop(0.55, hexA(L.color, L.alpha * 0.7));
      g.addColorStop(1, hexA(L.color, 0));
      c.fillStyle = g;
      c.fill();
      c.beginPath();
      c.moveTo(0, baseY - env[0] * h * L.amp);
      for (let i = 1; i < N; i++) c.lineTo(i * 2, baseY - env[i] * h * L.amp);
      c.strokeStyle = hexA(L.color, 0.55);
      c.lineWidth = 1.4;
      c.shadowColor = hexA(L.color, 0.55);
      c.shadowBlur = 16;
      c.stroke();
      c.restore();
    }
    // horizon line + bloom
    c.save();
    const hz = c.createLinearGradient(0, 0, w, 0);
    hz.addColorStop(0, 'rgba(124,240,255,0)');
    hz.addColorStop(0.3, 'rgba(124,240,255,.32)');
    hz.addColorStop(0.6, 'rgba(200,180,255,.3)');
    hz.addColorStop(1, 'rgba(255,183,222,0)');
    c.strokeStyle = hz;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, h * 0.72);
    c.lineTo(w, h * 0.72);
    c.stroke();
    c.restore();
  }

  /* ------------------------------------------------------------------ main */
  function renderAt(t) {
    t = clamp(t, 0, DUR);
    const pos = songPos(t);
    refs.aurora.style.transform =
      `rotate(${Math.sin(t * 0.16) * 3.2}deg) translate(${Math.sin(t * 0.21) * 26}px,${Math.cos(t * 0.17) * 20}px) scale(${1.02 + Math.sin(t * 0.13) * 0.02})`;
    drawMark(refs.mark, pos, t);
    drawRibbon(t);

    for (const v of VIEW) {
      const el = sEl[v.el.replace('s-', '')];
      const r = vis(v, t);
      if (r.a <= 0.004) { el.classList.remove('on'); el.style.opacity = 0; continue; }
      el.classList.add('on');
      el.style.opacity = r.a;
      el.style.transform = `translateY(${(1 - r.p) * 26}px)`;
    }
    if (sEl.hook.classList.contains('on')) renderHook(t, t - SC.hook.t0);
    if (sEl.upload.classList.contains('on')) renderUpload(t, t - SC.upload.t0);
    if (sEl.stems.classList.contains('on')) renderAnalysis(t, t - SC.stems.t0);
    if (sEl.export.classList.contains('on')) renderExport(t, t - SC.export.t0);
    if (sEl.outro.classList.contains('on')) renderOutro(t, t - SC.outro.t0);

    // scene rail
    let cur = 0;
    VIEW.forEach((v, i) => { if (t >= v.t0 - 0.1) cur = i; });
    refs.rail.forEach((d, i) => d.classList.toggle('on', i === cur));

    refs.watermark.style.opacity = 1 - smooth(SC.outro.t0 - 0.35, SC.outro.t0 + 0.25, t);
    fadeEl.style.opacity = (1 - smooth(0.0, 0.55, t)) + smooth(DUR - 0.75, DUR, t);
  }

  /* ------------------------------------------------------------------ boot */
  function currentCue(t) {
    const cues = TL.stem_cues;
    for (const c of cues) if (t >= c.t0 && t < c.t1) return c;
    return cues[cues.length - 1];
  }

  layout();
  window.addEventListener('resize', () => { layout(); btnRect = stageRect(refs.sepBtn); });
  btnRect = stageRect(refs.sepBtn);
  window.renderAt = renderAt;
  window.__ready = true;
  const q = (location.search + location.hash).match(/[?#&]t=([\d.]+)/);
  renderAt(q ? parseFloat(q[1]) : 0);
})();
