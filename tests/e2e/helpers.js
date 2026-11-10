import fs from 'node:fs';
import { expect } from '@playwright/test';

/** Opens the app and fails the test on any page error or console error. */
export async function openApp(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  // Force the download fallback; the native save dialog can't be driven headless.
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  return errors;
}

export async function loadPdfs(page, files) {
  await page.setInputFiles('#fileInput', files.map(([name, buffer]) => ({ name, mimeType: 'application/pdf', buffer })));
}

export async function drawSignature(page, { kind = 'signature', color } = {}) {
  await page.click(kind === 'signature' ? '#btnNewSig' : '#btnNewInit');
  if (color) await page.click(`.swatch[data-color="${color}"]`);
  const pad = await page.locator('#drawPad').boundingBox();
  await page.mouse.move(pad.x + 60, pad.y + pad.height / 2);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    await page.mouse.move(pad.x + 60 + i * (pad.width - 120) / 40, pad.y + pad.height / 2 + Math.sin(i / 3) * pad.height / 4);
  }
  await page.mouse.up();
  await page.click('#sigSave');
}

/** Clicks the given point of page `index`, expressed as fractions of the page. */
export async function clickPage(page, index, fx, fy) {
  const el = page.locator('.page').nth(index);
  // Scroll the viewer so the target point is in the middle of the screen.
  await el.evaluate((node, f) => {
    const viewer = document.querySelector('#viewer');
    const r = node.getBoundingClientRect();
    const vr = viewer.getBoundingClientRect();
    viewer.scrollTop += r.top + r.height * f - (vr.top + vr.height / 2);
  }, fy);
  const box = await el.boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

/** Bounding box of a placed item's content relative to its page, as fractions. */
export async function placedBox(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const pg = el.closest('.page').getBoundingClientRect();
    const r = (el.querySelector('.text-edit') ?? el.querySelector('img')).getBoundingClientRect();
    return {
      x0: (r.left - pg.left) / pg.width,
      x1: (r.right - pg.left) / pg.width,
      y0: (r.top - pg.top) / pg.height,
      y1: (r.bottom - pg.top) / pg.height,
    };
  }, selector);
}

export async function save(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btnSave')]);
  return fs.readFileSync(await download.path());
}

export function expectNoErrors(errors) {
  expect(errors, 'browser console errors').toEqual([]);
}
