/* Speaker Split — front end. Talks to the FastAPI backend, renders the real
   pipeline, and exposes window.demo so the video recorder can drive it. */

const STEPS = [
  ['upload', '读取上传文件'],
  ['decode', '解码 / 重采样 16 kHz'],
  ['load', '加载声纹模型'],
  ['vad', '语音活动检测'],
  ['embed', '提取声纹嵌入'],
  ['cluster', '双人聚类'],
  ['mask', '生成两路掩码'],
  ['write', '导出两条音轨'],
];

const $ = (id) => document.getElementById(id);
const state = {
  jobId: null, meta: null, timer: null,
  audio: [null, null], playing: -1, raf: 0, progress: [0, 0],
  orig: null, origPlaying: false,
  startedAt: 0,
};

/* ---------------------------------------------------------------- helpers */
function fmtTime(s) {
  const m = Math.floor(s / 60), r = (s % 60);
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

function setStatus(text, busy) {
  $('statusText').textContent = text;
  $('statusDot').classList.toggle('busy', !!busy);
}

function setupCanvas(cv) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  /* CSS owns the box size (74px wave / 44px lane); the height attribute is only a fallback.
     Never feed the pixel-buffer height back in: playing redraws ~4x/s and it would double each time. */
  const w = cv.clientWidth || 600;
  const h = cv.clientHeight || parseInt(cv.getAttribute('height'), 10) || 74;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/* ------------------------------------------------------------------ steps */
function renderSteps() {
  $('steps').innerHTML = STEPS.map(
    ([k, name]) => `<div class="step" data-k="${k}">
      <span class="sico"></span><span class="sname">${name}</span>
      <span class="sval">—</span></div>`).join('');
}

function markStep(stage, progress, detail) {
  const idx = STEPS.findIndex(([k]) => k === stage);
  document.querySelectorAll('.step').forEach((el, i) => {
    const k = STEPS[i][0];
    const known = STEPS.findIndex(([kk]) => kk === stage);
    el.classList.toggle('done', known > i);
    el.classList.toggle('on', known === i);
    if (known === i) el.querySelector('.sval').textContent = `${Math.round(progress * 100)}%`;
    if (known > i && !el.querySelector('.sval').textContent.replace('—', '').trim()) {
      el.querySelector('.sval').textContent = '✓';
    }
    if (known > i && el.querySelector('.sval').textContent.endsWith('%')) {
      el.querySelector('.sval').textContent = '✓';
    }
  });
  $('progressBar').style.width = Math.round(progress * 100) + '%';
  $('pctText').textContent = Math.round(progress * 100) + '%';
  const label = (STEPS.find(([k]) => k === stage) || ['', stage])[1];
  $('stageText').textContent = detail ? `${label} · ${detail}` : label;
}

function logLine(log) {
  const el = document.createElement('div');
  el.innerHTML = `<span class="t">${log.t.toFixed(1)}s</span>${log.label}` +
    (log.detail ? ` <b>${log.detail}</b>` : '');
  $('log').appendChild(el);
  while ($('log').children.length > 6) $('log').firstChild.remove();
}

/* --------------------------------------------------------------- pipeline */
async function startWith(blob, name) {
  resetResults();
  $('dropWrap').classList.add('hidden');
  $('fileChip').classList.remove('hidden');
  $('fileName').textContent = name;
  $('fileInfo').textContent = `${(blob.size / 1024 / 1024).toFixed(2)} MB · 上传中`;
  $('inMeta').textContent = '已选择';
  $('resMeta').textContent = '处理中…';
  setStatus('处理中', true);
  state.startedAt = Date.now();

  const fd = new FormData();
  fd.append('file', blob, name);
  let job;
  try {
    job = await (await fetch('/api/jobs', { method: 'POST', body: fd })).json();
  } catch (e) {
    setStatus('上传失败', false);
    return;
  }
  state.jobId = job.id;
  poll();
}

async function poll() {
  const r = await fetch(`/api/jobs/${state.jobId}`);
  const job = await r.json();
  /* replay logs we have not drawn yet */
  const shown = $('log').childElementCount;
  job.logs.slice(shown).forEach(logLine);
  markStep(job.stage, job.progress, job.detail);

  if (job.status === 'done') {
    state.meta = job.meta;
    onDone(job.meta, job.elapsed);
    return;
  }
  if (job.status === 'error') {
    setStatus('失败', false);
    $('stageText').textContent = job.error;
    return;
  }
  state.timer = setTimeout(poll, 180);
}

function onDone(meta, elapsed) {
  setStatus('就绪', false);
  $('results').classList.remove('hidden');
  $('emptyState').classList.add('hidden');
  $('resMeta').textContent = `${meta.duration.toFixed(1)}s → 2 条音轨`;
  $('pipeMeta').textContent = `${elapsed.toFixed(1)}s 完成`;
  $('inMeta').textContent = `${meta.duration.toFixed(1)}s · 16 kHz`;
  $('tlMeta').textContent = `混叠 ${meta.overlap_seconds}s`;
  $('fileInfo').textContent =
    `${meta.duration.toFixed(1)}s · 16 kHz · 单声道 · ${meta.pipeline}`;
  $('footStats').innerHTML =
    `处理 ${meta.infer_seconds}s · ${meta.realtime_factor}× 实时 · 聚类裕度 ${meta.cluster_margin}`;

  meta.tracks.forEach((t, i) => {
    $(`sub${i}`).textContent =
      `语音 ${t.speech_seconds.toFixed(1)}s · ${t.segments.length} 段 · ` +
      `试听片段 ${t.preview_seconds}s · 峰值 ${t.peak_dbfs}dBFS`;
    /* the turns sit seconds apart, so 试听 plays the stitched excerpt */
    const a = new Audio(`/api/jobs/${state.jobId}/audio/${t.preview || t.file}`);
    a.preload = 'auto';
    a.addEventListener('timeupdate', () => { if (state.playing === i) drawWave(i); });
    a.addEventListener('ended', () => { state.playing = -1; syncPlayButtons(); drawWave(i); });
    state.audio[i] = a;
  });

  /* the untouched upload, so the raw mix can be auditioned and A/B'd */
  const o = new Audio(`/api/jobs/${state.jobId}/audio/${meta.input || 'input.wav'}`);
  o.preload = 'auto';
  o.addEventListener('timeupdate', () => { if (state.origPlaying) drawTimeline(); });
  o.addEventListener('ended', () => {
    state.origPlaying = false;
    syncPlayButtons();
    drawTimeline();
  });
  state.orig = o;
  $('origPlay').disabled = false;

  drawWave(0); drawWave(1);
  drawTimeline();
  document.querySelectorAll('[data-play]').forEach((b) => { b.disabled = false; });
}

function resetResults() {
  state.audio.forEach((a) => a && a.pause());
  if (state.orig) state.orig.pause();
  state.orig = null;
  state.origPlaying = false;
  $('origPlay').disabled = true;
  state.audio = [null, null];
  state.playing = -1;
  state.progress = [0, 0];
  state.meta = null;
  $('results').classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  $('resMeta').textContent = '尚未分离';
  $('tlMeta').textContent = '—';
  document.querySelectorAll('.step').forEach((el) => {
    el.classList.remove('done', 'on');
    el.querySelector('.sval').textContent = '—';
  });
  $('progressBar').style.width = '0%';
  $('pctText').textContent = '0%';
  $('log').innerHTML = '';
  $('footStats').textContent = '—';
  ['tl0', 'tl1', 'tlmix'].forEach((id) => {
    const { ctx, w, h } = setupCanvas($(id));
    ctx.clearRect(0, 0, w, h);
  });
}

/* ------------------------------------------------------------ waveforms */
const COLORS = [
  { line: '#6EE7F9', fill: 'rgba(110,231,249,.30)', head: 'rgba(110,231,249,.9)' },
  { line: '#A78BFA', fill: 'rgba(167,139,250,.30)', head: 'rgba(167,139,250,.9)' },
];

function drawWave(i) {
  const meta = state.meta;
  if (!meta) return;
  const env = meta.tracks[i].preview_envelope || meta.tracks[i].envelope;
  const cv = $(`wave${i}`);
  const { ctx, w, h } = setupCanvas(cv);
  const c = COLORS[i];
  const mid = h / 2;
  const n = env.length;
  const bw = w / n;
  const a = state.audio[i];
  const frac = a && a.duration ? a.currentTime / a.duration : 0;

  ctx.clearRect(0, 0, w, h);
  /* zero line */
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

  for (let k = 0; k < n; k++) {
    const v = Math.max(0.012, env[k]);
    const hh = v * (h * 0.46);
    const x = k * bw;
    const played = frac > 0 && k / n <= frac;
    ctx.fillStyle = played ? c.head : c.fill;
    ctx.fillRect(x, mid - hh, Math.max(1, bw * 0.72), hh * 2);
  }
  /* played-past tint */
  if (frac > 0) {
    ctx.fillStyle = 'rgba(0,0,0,.36)';
    ctx.fillRect(frac * w, 0, w - frac * w, h);
    ctx.fillStyle = c.head;
    ctx.fillRect(frac * w - 1, 0, 2, h);
  }
}

function drawTimeline() {
  const meta = state.meta;
  if (!meta) return;
  const dur = meta.duration;
  const lanes = [
    ['tl0', meta.tracks[0].segments, 'rgba(110,231,249,.30)', '#6EE7F9'],
    ['tl1', meta.tracks[1].segments, 'rgba(167,139,250,.30)', '#A78BFA'],
    ['tlmix', null, 'rgba(255,255,255,.10)', 'rgba(234,240,248,.55)'],
  ];
  lanes.forEach(([id, segs, fill, stroke]) => {
    const { ctx, w, h } = setupCanvas($(id));
    ctx.clearRect(0, 0, w, h);
    /* grid */
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    for (let s = 0; s <= Math.ceil(dur); s += 5) {
      const x = (s / dur) * w;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    if (segs) {
      segs.forEach(([s, e]) => {
        const x0 = (s / dur) * w, x1 = (e / dur) * w;
        const bw = Math.max(3, x1 - x0);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(x0, h * 0.22, bw, h * 0.56, 4);
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.stroke();
      });
    } else {
      const env = meta.mix_envelope;
      const n = env.length;
      for (let k = 0; k < n; k++) {
        const v = Math.max(0.02, env[k]);
        const hh = v * h * 0.42;
        ctx.fillStyle = fill;
        ctx.fillRect((k / n) * w, h / 2 - hh, Math.max(1, w / n - 0.6), hh * 2);
      }
      /* playhead while the raw upload is auditioning */
      if (state.origPlaying && state.orig) {
        const frac = Math.min(1, Math.max(0, state.orig.currentTime / dur));
        ctx.fillStyle = 'rgba(110,231,249,.95)';
        ctx.fillRect(frac * w - 1, 0, 2, h);
      }
    }
  });
  $('ticks').innerHTML = [0, 5, 10, 15, 20, 25, 30]
    .filter((s) => s <= dur + 0.01)
    .map((s) => `<span>${fmtTime(s)}</span>`).join('');
}

/* -------------------------------------------------------------- playback */
function syncPlayButtons() {
  document.querySelectorAll('[data-play]').forEach((b) => {
    const i = +b.dataset.play;
    b.textContent = state.playing === i ? '■ 停止' : '▶ 试听';
  });
  const ob = $('origPlay');
  if (ob) ob.textContent = state.origPlaying ? '■ 停止原音频' : '▶ 试听原音频';
  $('mixRow').classList.toggle('playing', state.origPlaying);
}

/* the untouched upload: same length as the timelines, so one playhead serves both */
function toggleOrig() {
  if (!state.orig) return;
  if (state.origPlaying) {
    state.orig.pause();
    state.origPlaying = false;
    syncPlayButtons();
    drawTimeline();
    return;
  }
  state.audio.forEach((a) => a && a.pause());
  state.playing = -1;
  state.orig.currentTime = 0;
  state.origPlaying = true;
  state.orig.play();
  syncPlayButtons();
  drawWave(0); drawWave(1);
  drawTimeline();
}

function play(i, from = 0) {
  if (!state.audio[i]) return;
  state.audio.forEach((a, j) => { if (j !== i && a) a.pause(); });
  if (state.origPlaying) {
    state.orig.pause();
    state.origPlaying = false;
    drawTimeline();
  }
  const a = state.audio[i];
  /* the element holds the stitched excerpt, which already starts on the first word */
  a.currentTime = from;
  state.playing = i;
  a.play();
  syncPlayButtons();
  drawWave(i);
}

function stopAll() {
  state.audio.forEach((a) => a && a.pause());
  if (state.orig) { state.orig.pause(); state.origPlaying = false; }
  state.playing = -1;
  syncPlayButtons();
  drawTimeline();
  drawWave(0); drawWave(1);
}

/* ------------------------------------------------------------------ wire */
function boot() {
  renderSteps();
  document.querySelectorAll('[data-play]').forEach((b) => b.disabled = true);

  $('pickBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    const f = e.target.files[0];
    if (f) startWith(f, f.name);
  };
  $('sampleBtn').onclick = useSample;

  /* real drag & drop — the copy above the drop zone promises it */
  const dz = $('dropWrap');
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => {
    stop(e);
    dz.classList.add('over');
  }));
  ['dragleave', 'dragend'].forEach((t) => dz.addEventListener(t, (e) => {
    stop(e);
    if (e.target === dz || !dz.contains(e.relatedTarget)) dz.classList.remove('over');
  }));
  dz.addEventListener('drop', (e) => {
    stop(e);
    dz.classList.remove('over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) startWith(f, f.name);
  });
  /* dropping on the page elsewhere should not navigate away */
  window.addEventListener('dragover', stop);
  window.addEventListener('drop', stop);
  $('resetBtn').onclick = () => {
    resetResults();
    $('dropWrap').classList.remove('hidden');
    $('fileChip').classList.add('hidden');
    $('inMeta').textContent = '等待选择';
    document.querySelectorAll('.step').forEach((el) => {
      el.classList.remove('done', 'on');
      el.querySelector('.sval').textContent = '—';
    });
    $('progressBar').style.width = '0%';
    $('pctText').textContent = '0%';
    $('stageText').textContent = '等待音频';
  };
  document.querySelectorAll('[data-play]').forEach((b) => {
    b.onclick = () => {
      const i = +b.dataset.play;
      if (state.playing === i) stopAll(); else play(i);
    };
  });
  $('origPlay').onclick = toggleOrig;
  $('mixRow').onclick = toggleOrig;
  document.querySelectorAll('[data-dl]').forEach((b) => {
    b.onclick = () => {
      const i = +b.dataset.dl;
      const t = state.meta && state.meta.tracks[i];
      if (!t) return;
      const a = document.createElement('a');
      a.href = `/api/jobs/${state.jobId}/audio/${t.file}`;
      a.download = `${t.id}.wav`;
      a.click();
      const old = b.textContent;
      b.textContent = '✓ 已保存';
      setTimeout(() => { b.textContent = old; }, 1400);
    };
  });

  const ro = new ResizeObserver(() => {
    if (state.meta) { drawWave(0); drawWave(1); drawTimeline(); }
  });
  ro.observe(document.body);

  window.demo = {
    useSample,
    upload: (blob, name) => startWith(blob, name),
    play,
    stop: stopAll,
    ready: () => !!state.meta,
    status: () => ({ jobId: state.jobId, meta: state.meta, playing: state.playing }),
    times: () => state.audio.map((a) => (a ? +a.currentTime.toFixed(2) : null)),
    durations: () => state.audio.map((a) => (a ? +a.duration.toFixed(2) : null)),
    toggleOrig,
    orig: () => (state.orig
      ? { playing: state.origPlaying, t: +state.orig.currentTime.toFixed(2),
          duration: +(state.orig.duration || 0).toFixed(2), paused: state.orig.paused }
      : null),
  };
}

async function useSample() {
  const r = await fetch('/api/sample');
  const blob = await r.blob();
  startWith(blob, 'dialog_2speakers.wav');
}

document.addEventListener('DOMContentLoaded', boot);
