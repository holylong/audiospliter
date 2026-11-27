// Render ClearerVoice demo frames with headless Chromium (Playwright).
// usage:
//   node scripts/render_frames.mjs still 4.2 out.png [portrait]
//   node scripts/render_frames.mjs frames 16:9 outdir 30
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = '/home/skyer/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const ROOT = resolve(import.meta.dirname, '..');
const URL = 'file://' + resolve(ROOT, 'web/index.html');

const mode = process.argv[2] || 'still';
const sizes = { '16:9': [1920, 1080], '9:16': [1080, 1920] };

async function open(size) {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none',
      '--disable-lcd-text', '--disable-gpu-vsync', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', null, { timeout: 30000 });
  return { browser, page, errors };
}

if (mode === 'still') {
  const t = parseFloat(process.argv[3] || '0');
  const out = process.argv[4] || 'still.png';
  const portrait = process.argv[5] === 'portrait';
  const size = portrait ? sizes['9:16'] : sizes['16:9'];
  const { browser, page, errors } = await open(size);
  const probe = await page.evaluate((tt) => {
    window.renderAt(tt);
    return {
      stage: [document.getElementById('stage').clientWidth, document.getElementById('stage').clientHeight],
      on: [...document.querySelectorAll('.scene.on')].map((e) => e.id),
      canvases: [...document.querySelectorAll('canvas')].map((c) => c.width + 'x' + c.height),
    };
  }, t);
  await page.waitForTimeout(160);
  await page.screenshot({ path: out });
  console.log(JSON.stringify({ out, t, probe, errors }, null, 1));
  await browser.close();
}

if (mode === 'frames') {
  const ratio = process.argv[3] || '16:9';
  const outdir = process.argv[4] || 'build/frames';
  const fps = parseInt(process.argv[5] || '30', 10);
  const start = parseInt(process.argv[6] || '0', 10);
  const size = sizes[ratio] || sizes['16:9'];
  mkdirSync(outdir, { recursive: true });
  const { browser, page, errors } = await open(size);
  const dur = await page.evaluate(() => window.DEMO.meta.duration);
  const total = Math.round(dur * fps);
  let bad = 0;
  for (let i = start; i < total; i++) {
    const t = i / fps;
    await page.evaluate((tt) => window.renderAt(tt), t);
    await page.screenshot({ path: `${outdir}/f${String(i).padStart(5, '0')}.png` });
    if (i % 60 === 0) process.stdout.write(`  ${i}/${total} (${(t).toFixed(1)}s)\n`);
  }
  console.log(JSON.stringify({ frames: total, dir: outdir, fps, size, errors: errors.slice(0, 8), bad }));
  await browser.close();
}
