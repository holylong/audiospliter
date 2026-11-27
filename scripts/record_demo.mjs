#!/usr/bin/env node
/* Records the real app session as a video and audits the layout while doing it.
 *
 *   node scripts/record_demo.mjs
 *
 * Outputs:
 *   build/video/session.webm   raw browser recording (1920x1080)
 *   build/video/events.json    wall-clock marks for every beat of the demo
 *   build/shots/*.png          stills for the layout audit
 *
 * The flash mark right after the title card lets the muxer line up the audio
 * bed with the picture exactly, without trusting the recorder's start offset.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BASE = 'http://127.0.0.1:8010';
const VIDEO_DIR = path.join(ROOT, 'build/video');
const SHOT_DIR = path.join(ROOT, 'build/shots');
const CHROME = process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const W = 1920, H = 1080;

fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const consoleErrors = [];
const event = {};
let t0 = Date.now();
const mark = (name) => { event[name] = Date.now() - t0; };

/* ------------------------------------------------------------------ audit */
async function audit(page, label) {
  return page.evaluate(() => {
    const issues = [];
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0';
    };
    /* text overflow */
    document.querySelectorAll('h1,h2,.tname,.fname,.sname,.cap,.num,b,span,div').forEach((el) => {
      if (el.children.length) return;
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        issues.push(`overflow: ${el.className || el.tagName} "${(el.textContent || '').trim().slice(0, 24)}"`);
      }
    });
    /* offscreen blocks */
    document.querySelectorAll('.card,.track,.step,.pill,.cell').forEach((el) => {
      if (!vis(el)) return;
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.top < -1 || r.right > window.innerWidth + 1 || r.bottom > window.innerHeight + 1) {
        issues.push(`offscreen: ${el.className} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    });
    /* canvases must actually have ink */
    const canvases = [...document.querySelectorAll('canvas')].filter(vis);
    const ink = canvases.map((cv) => {
      try {
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let lit = 0;
        for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) lit++;
        return { id: cv.id, pct: Math.round((lit / (d.length / (4 * 37))) * 100) };
      } catch (e) { return { id: cv.id, pct: -1 }; }
    });
    ink.forEach((c) => { if (c.pct >= 0 && c.pct < 3) issues.push(`blank canvas: ${c.id} ${c.pct}%`); });
    return { issues, ink };
  });
}

/* ------------------------------------------------------------------- main */
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
         '--force-device-scale-factor=1', '--disable-lcd-text'],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: VIDEO_DIR, size: { width: W, height: H } },
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

const reports = [];

/* 1. title card ---------------------------------------------------------- */
await page.goto(`${BASE}/title.html`, { waitUntil: 'load' });
await sleep(1100);
mark('flash');
await page.evaluate(() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99999;pointer-events:none';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 90);
});
await sleep(4200);
reports.push({ scene: 'title', ...(await audit(page, 'title')) });
await page.screenshot({ path: path.join(SHOT_DIR, '01_title.png') });

/* 2. app session --------------------------------------------------------- */
await page.goto(`${BASE}/`, { waitUntil: 'load' });
await sleep(1500);
reports.push({ scene: 'idle', ...(await audit(page, 'idle')) });
await page.screenshot({ path: path.join(SHOT_DIR, '02_idle.png') });

mark('upload');
await page.click('#sampleBtn');

let ready = false;
for (let i = 0; i < 400; i++) {
  ready = await page.evaluate(() => !!(window.demo && window.demo.ready()));
  if (ready) break;
  await sleep(150);
}
mark('ready');
if (!ready) consoleErrors.push('job never finished');

await sleep(1100);
reports.push({ scene: 'results', ...(await audit(page, 'results')) });
await page.screenshot({ path: path.join(SHOT_DIR, '03_results.png') });

/* 3. listen to speaker 1 ------------------------------------------------- */
mark('play0');
await page.click('[data-play="0"]');
await sleep(5200);
await page.screenshot({ path: path.join(SHOT_DIR, '04_play0.png') });
await page.click('[data-play="0"]');
await sleep(500);

/* 4. listen to speaker 2 ------------------------------------------------- */
mark('play1');
await page.click('[data-play="1"]');
await sleep(5200);
await page.screenshot({ path: path.join(SHOT_DIR, '05_play1.png') });
await page.click('[data-play="1"]');
await sleep(400);

/* 5. export -------------------------------------------------------------- */
mark('download');
await page.click('[data-dl="0"]');
await sleep(1500);
await page.screenshot({ path: path.join(SHOT_DIR, '06_download.png') });
await sleep(600);

/* 6. outro --------------------------------------------------------------- */
mark('outro');
await page.goto(`${BASE}/outro.html`, { waitUntil: 'load' });
await sleep(5200);
reports.push({ scene: 'outro', ...(await audit(page, 'outro')) });
await page.screenshot({ path: path.join(SHOT_DIR, '07_outro.png') });

const videoPath = await page.video().path();
await context.close();
await browser.close();

const out = {
  video: videoPath,
  recordStart: t0,
  events: event,
  consoleErrors,
  reports,
};
fs.writeFileSync(path.join(VIDEO_DIR, 'events.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
