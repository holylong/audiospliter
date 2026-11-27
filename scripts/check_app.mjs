/* End-to-end check of the demo app as a human would use it:
   click 使用示例对话 → wait for results → 试听 must actually load (200) and play →
   下载 must produce a file → drag & drop must start a job → layout must be clean.

   node scripts/check_app.mjs [http://127.0.0.1:8010] */
import { chromium } from 'playwright-core';

const URL = process.argv[2] || 'http://127.0.0.1:8010';
const W = +(process.env.W || 1600), H = +(process.env.H || 900);
const report = { url: URL, steps: [], errors: [], failed: [] };

function ok(name, extra = {}) {
  report.steps.push({ step: name, ok: true, ...extra });
  console.log('  ok  ', name, JSON.stringify(extra));
}

async function layoutIssues(page, scene) {
  const probes = await page.evaluate(() => {
    const out = [];
    /* on narrow screens the page scrolls (body owns the scroll box), so vertical
       overflow is allowed as long as it is reachable by scrolling */
    const maxY = Math.max(
      window.innerHeight,
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    );
    document.querySelectorAll('.card, .track, .step, .btn').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (r.right > window.innerWidth + 1 || r.bottom > maxY + 1 || r.left < -1) {
        out.push(`off-stage: ${el.className || el.tagName}`);
      }
      if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') {
        out.push(`overflow: ${el.className || el.tagName}`);
      }
    });
    return out;
  });
  if (probes.length) report.errors.push({ scene, probes });
  return probes;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME ||
    `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`,
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', (m) => { if (m.type() === 'error') report.errors.push({ console: m.text() }); });
page.on('requestfailed', (r) => report.failed.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.status() >= 400) report.failed.push(`${r.status()} ${r.url()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });
ok('page loaded', { title: await page.title() });
await layoutIssues(page, 'idle');

/* ---- 1. sample button, the path a person will actually use ---- */
await page.click('#sampleBtn');
await page.waitForSelector('#results:not(.hidden)', { timeout: 60000 });
const subs = await page.evaluate(() => [
  document.getElementById('sub0').textContent,
  document.getElementById('sub1').textContent,
]);
ok('使用示例对话 completed', { sub0: subs[0], sub1: subs[1] });

const ink = await page.evaluate(() => {
  const px = (id) => {
    const c = document.getElementById(id);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++;
    return +(100 * n / (d.length / 4)).toFixed(1);
  };
  return { wave0: px('wave0'), wave1: px('wave1'), tl0: px('tl0'), tl1: px('tl1'), tlmix: px('tlmix') };
});
if (Object.values(ink).some((v) => v < 5)) report.errors.push({ scene: 'results', blankCanvases: ink });
ok('canvases drawn', ink);

/* ---- 2. 试听 must load the preview (this used to 400) and advance ---- */
const status = await page.evaluate(async () => {
  const st = window.demo.status();
  const t = st.meta.tracks[0];
  const r = await fetch(`/api/jobs/${st.jobId}/audio/${t.preview}`);
  return { preview: t.preview, code: r.status, bytes: (await r.blob()).size };
});
if (status.code !== 200 && status.code !== 206) report.errors.push({ audio: status });
ok('preview audio served', status);

await page.click('[data-play="0"]');
await page.waitForTimeout(1500);
const playState = await page.evaluate(() => ({
  playing: window.demo.status().playing,
  times: window.demo.times(),
  durations: window.demo.durations(),
}));
const cur = playState.times[0];
if (playState.playing !== 0 || !(cur > 0.3)) report.errors.push({ playState });
ok('speaker 1 audition playing', { playing: playState.playing, currentTime: cur, duration: playState.durations[0] });

/* ---- 2a. canvases must not grow while playing ----
   setupCanvas used to feed the pixel-buffer height back in as the CSS height,
   so every timeupdate doubled the box and the waveform stretched. */
const geom = await page.evaluate(async () => {
  const ids = ['wave0', 'wave1', 'tl0', 'tl1', 'tlmix'];
  const snap = () => ids.map((id) => {
    const c = document.getElementById(id);
    return {
      id,
      css: Math.round(c.getBoundingClientRect().height),
      buf: c.height,
      dpr: window.devicePixelRatio || 1,
    };
  });
  const first = snap();
  await new Promise((r) => setTimeout(r, 2600));
  return { first, last: snap() };
});
const grew = geom.first.filter((f, k) => {
  const l = geom.last[k];
  return Math.abs(l.css - f.css) > 1 || l.buf > Math.round(f.css * f.dpr) + 2;
});
if (grew.length) report.errors.push({ canvasesGrew: { first: geom.first, last: geom.last } });
ok('canvas geometry stable during playback', {
  wave0: geom.last[0].css, tl0: geom.last[2].css, grew: grew.length,
});

await page.waitForTimeout(1200);
await page.click('[data-play="0"]');   // stop
await page.click('[data-play="1"]');
await page.waitForTimeout(1500);
const playing2 = await page.evaluate(() => window.demo.status().playing);
if (playing2 !== 1) report.errors.push({ speaker2: playing2 });
ok('speaker 2 audition started', { playing: playing2 });
await page.evaluate(() => window.demo.stop());

/* ---- 2b. the raw upload must be auditionable too ---- */
const origMeta = await page.evaluate(async () => {
  const st = window.demo.status();
  const r = await fetch(`/api/jobs/${st.jobId}/audio/${st.meta.input}`);
  return { file: st.meta.input, code: r.status, type: r.headers.get('content-type'), bytes: (await r.blob()).size };
});
if (origMeta.code !== 200 && origMeta.code !== 206) report.errors.push({ origMeta });
ok('original audio served', origMeta);

await page.click('#origPlay');
await page.waitForTimeout(1500);
const orig1 = await page.evaluate(() => window.demo.orig());
if (!orig1 || !orig1.playing || !(orig1.t > 0.3)) report.errors.push({ orig1 });
ok('original audio playing', orig1);

/* switching to a track must silence the raw mix */
await page.click('[data-play="1"]');
await page.waitForTimeout(700);
const afterSwitch = await page.evaluate(() => ({ orig: window.demo.orig(), playing: window.demo.status().playing }));
if (afterSwitch.orig && afterSwitch.orig.playing) report.errors.push({ afterSwitch });
ok('track audition takes over from original', afterSwitch);

/* clicking the 原始混音 lane is the second way in */
await page.evaluate(() => window.demo.stop());
await page.click('#mixRow');
await page.waitForTimeout(1200);
const orig2 = await page.evaluate(() => window.demo.orig());
if (!orig2 || !orig2.playing || !(orig2.t > 0.2)) report.errors.push({ orig2 });
ok('mix lane click plays original', orig2);
await page.click('#origPlay');
const stopped = await page.evaluate(() => window.demo.orig());
if (stopped.playing) report.errors.push({ stopped });
ok('original audio stops on second click', stopped);

/* ---- 3. download produces a real file ---- */
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  page.click('[data-dl="0"]'),
]);
const path = await dl.path();
const size = path ? (await import('node:fs')).statSync(path).size : 0;
if (!size) report.errors.push({ download: dl.suggestedFilename() });
ok('download', { name: dl.suggestedFilename(), size });

await page.screenshot({ path: 'build/check-app-results.png' });
await layoutIssues(page, 'results');

/* ---- 4. drag & drop (advertised in the UI copy) ---- */
await page.click('#resetBtn');
await page.waitForSelector('#dropWrap:not(.hidden)');
const dropped = await page.evaluate(async () => {
  const buf = await (await fetch('/api/sample')).arrayBuffer();
  const file = new File([buf], 'drag_test.wav', { type: 'audio/wav' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const dz = document.getElementById('dropWrap');
  dz.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
  const hot = dz.classList.contains('over');
  dz.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  return { hot };
});
await page.waitForSelector('#results:not(.hidden)', { timeout: 60000 });
const dropName = await page.textContent('#fileName');
ok('drag & drop started a job', { highlightOnDrag: dropped.hot, file: dropName.trim() });
await layoutIssues(page, 'results-after-drop');

await browser.close();
report.ok = report.errors.length === 0 && report.failed.length === 0;
console.log(JSON.stringify({ ok: report.ok, failed: report.failed, errors: report.errors }, null, 1));
process.exit(report.ok ? 0 : 1);
