// Layout audit: catches text overflow, off-stage elements, invisible blocks,
// overlapping regions and canvas coverage at a list of timestamps.
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const CHROME = '/home/skyer/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const ROOT = resolve(import.meta.dirname, '..');
const URL = 'file://' + resolve(ROOT, 'web/index.html');
const portrait = process.argv.includes('--portrait');
const times = (process.argv[2] || '1.2,4.2,8.6,11.6,14.6,23.2,27.2,33.4,39.2,45').split(',').map(Number);

const browser = await chromium.launch({ executablePath: CHROME, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({
  viewport: portrait ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true');

const report = [];
for (const t of times) {
  const r = await page.evaluate((tt) => {
    window.renderAt(tt);
    const stage = document.getElementById('stage');
    const sr = stage.getBoundingClientRect();
    const active = [...document.querySelectorAll('.scene.on')];
    const issues = [];
    const boxes = [];
    const walk = (root, depth) => {
      for (const el of root.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (parseFloat(cs.opacity) < 0.04) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const rel = {
          x: (rect.left - sr.left), y: (rect.top - sr.top),
          w: rect.width, h: rect.height,
        };
        const cls = (el.className || '') + '#' + (el.id || '');
        if (rel.x < -2 || rel.y < -2 || rel.x + rel.w > sr.width + 2 || rel.y + rel.h > sr.height + 2) {
          issues.push(`offstage ${cls} [${rel.x | 0},${rel.y | 0} ${rel.w | 0}x${rel.h | 0}]`);
        }
        if (el.scrollWidth > el.clientWidth + 3 && cs.overflow !== 'hidden' && el.children.length === 0) {
          issues.push(`h-overflow ${cls} ${el.scrollWidth}>${el.clientWidth}`);
        }
        if (el.tagName !== 'CANVAS') boxes.push({ cls, ...rel });
      }
    };
    active.forEach((a) => walk(a, 0));
    // canvas coverage: how much of each canvas is non-background
    const canv = [...document.querySelectorAll('.scene.on canvas')].map((c) => {
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 17) {
        if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
      }
      return `${c.className || c.id}=${(lit / (d.length / (4 * 17)) * 100).toFixed(0)}%`;
    });
    // pairwise overlap of major blocks
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.w * a.h < 4000 || b.w * b.h < 4000) continue;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 6 && oy > 6) overlaps.push(`${a.cls} ∩ ${b.cls} ${ox | 0}x${oy | 0}`);
      }
    }
    return { t: tt, scenes: active.map((a) => a.id), canv, issues: issues.slice(0, 14), overlaps: overlaps.slice(0, 8) };
  }, t);
  report.push(r);
}
console.log(JSON.stringify({ portrait, errors: errs, report }, null, 1));
await browser.close();
