// Generates the screenshots used in README.md into /e2e/screenshots (docs/images).
//   docker compose -f docker-compose.test.yml run --rm --build e2e node screenshots.js
import { chromium } from '@playwright/test';
import { makeContract, makePdf } from './fixtures.js';
import { loadPdfs, clickPage } from './helpers.js';

const OUT = '/e2e/screenshots';
const BASE = process.env.BASE_URL ?? 'http://web';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1.5 });
const page = await context.newPage();
await page.goto(BASE);
await page.evaluate(() => document.fonts.ready);
const shot = async (name, opts = {}) => {
  await page.evaluate(() => { document.querySelector('#status').hidden = true; });
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
};
const idle = () => page.waitForTimeout(600);

// --- Signature dialog: drawn signature ---
await page.click('#btnNewSig');
await page.click('.swatch[data-color="#1a3fb0"]');
const pad = await page.locator('#drawPad').boundingBox();
const cx = pad.x + pad.width * 0.18, cy = pad.y + pad.height * 0.6;
await page.mouse.move(cx, cy);
await page.mouse.down();
// A loopy, handwriting-like stroke.
for (let t = 0; t <= 1; t += 0.004) {
  const x = cx + t * pad.width * 0.62 + Math.sin(t * 28) * 18;
  const y = cy - Math.sin(t * 14) * 45 * (1 - t * 0.6) - Math.cos(t * 28) * 22;
  await page.mouse.move(x, y);
}
await page.mouse.up();
await page.mouse.move(cx + pad.width * 0.1, cy + 40);
await page.mouse.down();
await page.mouse.move(cx + pad.width * 0.72, cy + 25, { steps: 25 });
await page.mouse.up();
await idle();
await shot('dialog-draw', { clip: await page.locator('#sigDialog').boundingBox() });
await page.click('#sigDialog button[value=cancel]');

// --- Signature dialog: typed signature (this one is saved and used) ---
await page.click('#btnNewSig');
await page.click('.swatch[data-color="#0b1f5c"]');
await page.click('.tab[data-tab="type"]');
await page.fill('#typeText', 'Ayşe Yılmaz');
await page.selectOption('#typeFont', 'Great Vibes');
await page.dispatchEvent('#typeFont', 'input');
await idle();
await shot('dialog-type', { clip: await page.locator('#sigDialog').boundingBox() });
await page.click('#sigSave');

// Initials
await page.click('#btnNewInit');
await page.click('.tab[data-tab="type"]');
await page.fill('#typeText', 'A.Y.');
await page.selectOption('#typeFont', 'Dancing Script');
await page.dispatchEvent('#typeFont', 'input');
await page.click('#sigSave');

// --- Load the contract ---
await loadPdfs(page, [['hizmet-sozlesmesi.pdf', await makeContract()]]);
await page.locator('.page').nth(1).waitFor();
await page.waitForTimeout(1200);

// Initials bottom-right on every page.
await page.locator('#initList .sig-item').first().click();
await clickPage(page, 0, 0.86, 0.93);
await page.locator('.placed.image .tools button', { hasText: 'Tüm sayfalara uygula' }).click();

// Fill the "MÜŞTERİ" block on page 2.
const fill = async (fx, fy, text) => {
  await page.click('#btnText');
  await clickPage(page, 1, fx, fy);
  await page.locator('.text-edit:focus').waitFor();
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
};
// Positions follow the layout in fixtures.js (label baselines at 641.5pt and 625.5pt).
await fill(0.714, 0.233, 'Ayşe Yılmaz');
await fill(0.625, 0.252, '10.11.2026');

// Signature between "İmza:" and the signature line.
await page.locator('#sigList .sig-item').first().click();
await clickPage(page, 1, 0.723, 0.311);

// Hero: page 2 with everything filled in, signature selected.
await page.evaluate(() => {
  const viewer = document.querySelector('#viewer');
  const p2 = document.querySelectorAll('.page')[1];
  viewer.scrollTop += p2.getBoundingClientRect().top - viewer.getBoundingClientRect().top - 12;
});
await idle();
await shot('app-signed');

// --- Text box editing with its toolbar ---
await page.locator('.placed.text').first().click();
await page.keyboard.press('End');
await idle();
const tb = await page.locator('.placed.text').first().boundingBox();
await shot('text-box', { clip: { x: tb.x - 200, y: tb.y - 90, width: 640, height: 300 } });
await page.keyboard.press('Escape');

// --- Merge: two files, thumbnails panel ---
page.once('dialog', (d) => d.accept());
await page.click('#btnClear');
await loadPdfs(page, [
  ['teklif.pdf', await makePdf([{ label: 'Teklif - Sayfa 1' }, { label: 'Teklif - Sayfa 2' }])],
  ['ek-protokol.pdf', await makePdf([{ label: 'Ek Protokol' }])],
]);
await page.waitForTimeout(1200);
await page.locator('.thumb input[type=checkbox]').nth(1).check();
await idle();
await page.setViewportSize({ width: 1360, height: 1200 });
await idle();
const left = await page.locator('.sidebar.left').boundingBox();
const last = await page.locator('.thumb').last().boundingBox();
await shot('pages-panel', { clip: { x: left.x, y: left.y, width: left.width, height: last.y + last.height + 12 - left.y } });

await browser.close();
console.log('screenshots written to', OUT);
