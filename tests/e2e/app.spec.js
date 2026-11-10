import { test, expect } from '@playwright/test';
import { makePdf, pageTexts, textItems, imageBoxes } from './fixtures.js';
import { openApp, loadPdfs, drawSignature, clickPage, placedBox, save, expectNoErrors } from './helpers.js';

test('opens a PDF and shows pages and thumbnails', async ({ page }) => {
  const errors = await openApp(page);
  await expect(page.locator('#empty')).toBeVisible();
  await loadPdfs(page, [['a.pdf', await makePdf([{ label: 'One' }, { label: 'Two' }, { label: 'Three' }])]]);
  await expect(page.locator('.page')).toHaveCount(3);
  await expect(page.locator('.thumb')).toHaveCount(3);
  await expect(page.locator('#empty')).toBeHidden();
  await expect(page.locator('#pageCount')).toHaveText('(3)');
  await expect(page.locator('#btnSave')).toBeEnabled();
  expectNoErrors(errors);
});

test('merges files, reorders and deletes pages', async ({ page }) => {
  const errors = await openApp(page);
  await loadPdfs(page, [
    ['a.pdf', await makePdf([{ label: 'A1' }, { label: 'A2' }])],
    ['b.pdf', await makePdf([{ label: 'B1' }])],
  ]);
  await expect(page.locator('.thumb')).toHaveCount(3);

  // Drag B1 (last) above A1 (first).
  await page.locator('.thumb').nth(2).dragTo(page.locator('.thumb').nth(0), { targetPosition: { x: 20, y: 5 } });
  // Delete A2 (now last) with its × button.
  await page.locator('.thumb').nth(2).locator('.thumb-del').click();
  await expect(page.locator('.thumb')).toHaveCount(2);

  expect(await pageTexts(await save(page))).toEqual(['B1', 'A1']);
  expectNoErrors(errors);
});

test('deleting the only page of a merged file removes that file', async ({ page }) => {
  const errors = await openApp(page);
  await loadPdfs(page, [
    ['a.pdf', await makePdf([{ label: 'A1' }, { label: 'A2' }])],
    ['b.pdf', await makePdf([{ label: 'B1' }])],
  ]);
  await page.locator('.thumb').nth(2).locator('.thumb-del').click();
  await expect(page.locator('.thumb')).toHaveCount(2);
  await expect(page.locator('#pageCount')).toHaveText('(2)');
  // With one file left, thumbnails go back to plain page labels.
  await expect(page.locator('.thumb .name')).toHaveText(['Sayfa 1', 'Sayfa 2']);
  expect(await pageTexts(await save(page))).toEqual(['A1', 'A2']);
  expectNoErrors(errors);
});

test('"Temizle" closes everything and the next file starts fresh', async ({ page }) => {
  const errors = await openApp(page);
  page.on('dialog', (d) => d.accept());
  await loadPdfs(page, [['old.pdf', await makePdf([{ label: 'Old' }])]]);
  await expect(page.locator('.page')).toHaveCount(1);
  await page.click('#btnClear');
  await expect(page.locator('.page')).toHaveCount(0);
  await expect(page.locator('#empty')).toBeVisible();
  await loadPdfs(page, [['new.pdf', await makePdf([{ label: 'New' }])]]);
  await expect(page.locator('.page')).toHaveCount(1);
  expect(await pageTexts(await save(page))).toEqual(['New']);
  expectNoErrors(errors);
});

test('deletes several selected pages at once', async ({ page }) => {
  const errors = await openApp(page);
  await loadPdfs(page, [['a.pdf', await makePdf([{ label: 'P1' }, { label: 'P2' }, { label: 'P3' }, { label: 'P4' }])]]);
  await page.locator('.thumb input[type=checkbox]').nth(1).check();
  await page.locator('.thumb input[type=checkbox]').nth(3).check();
  await page.click('#btnDelSelected');
  await expect(page.locator('.thumb')).toHaveCount(2);
  expect(await pageTexts(await save(page))).toEqual(['P1', 'P3']);
  expectNoErrors(errors);
});

test('places a colored signature exactly where it appears on screen', async ({ page }) => {
  const errors = await openApp(page);
  await loadPdfs(page, [['a.pdf', await makePdf([{ label: 'Contract' }])]]);
  await drawSignature(page, { color: '#1a3fb0' });
  await expect(page.locator('#sigList .sig-item')).toHaveCount(1);
  await clickPage(page, 0, 0.3, 0.6);
  await expect(page.locator('.placed.image')).toHaveCount(1);

  // Move it by dragging, then save.
  const item = await page.locator('.placed.image').boundingBox();
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
  await page.mouse.down();
  await page.mouse.move(item.x + item.width / 2 + 80, item.y + item.height / 2 + 40, { steps: 5 });
  await page.mouse.up();

  const onScreen = await placedBox(page, '.placed.image');
  const [inPdf] = await imageBoxes(await save(page), 1);
  for (const k of ['x0', 'x1', 'y0', 'y1']) expect(inPdf[k]).toBeCloseTo(onScreen[k], 2);
  expectNoErrors(errors);
});

test('copies initials to every page', async ({ page }) => {
  const errors = await openApp(page);
  await loadPdfs(page, [['a.pdf', await makePdf([{ label: '1' }, { label: '2' }, { label: '3' }])]]);
  await drawSignature(page, { kind: 'initials' });
  await clickPage(page, 0, 0.85, 0.92);
  await page.locator('.placed.image .tools button', { hasText: 'Tüm sayfalara uygula' }).click();
  await expect(page.locator('.placed.image')).toHaveCount(3);

  const pdf = await save(page);
  for (let n = 1; n <= 3; n++) {
    const boxes = await imageBoxes(pdf, n);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].x0).toBeGreaterThan(0.75);
    expect(boxes[0].y0).toBeGreaterThan(0.85);
  }
  expectNoErrors(errors);
});

test('adds a Turkish multi-line text box on a rotated page', async ({ page }) => {
  const errors = await openApp(page);
  await loadPdfs(page, [['a.pdf', await makePdf([{ label: 'Rotated', rotation: 90 }])]]);
  await page.click('#btnText');
  await clickPage(page, 0, 0.4, 0.5);
  await expect(page.locator('.text-edit')).toBeFocused();
  await page.keyboard.type('Şişli İğne ışık');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Çağrı Öztürk');
  await page.keyboard.press('Escape');

  const onScreen = await placedBox(page, '.placed.text');
  const items = await textItems(await save(page), 1);
  const first = items.find((t) => t.str === 'Şişli İğne ışık');
  const second = items.find((t) => t.str === 'Çağrı Öztürk');
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(first.x).toBeCloseTo(onScreen.x0, 2);
  // Both baselines fall inside the box, the first in its upper half.
  const mid = (onScreen.y0 + onScreen.y1) / 2;
  expect(first.y).toBeGreaterThan(onScreen.y0);
  expect(first.y).toBeLessThan(mid);
  expect(second.y).toBeGreaterThan(mid);
  expect(second.y).toBeLessThan(onScreen.y1);
  expectNoErrors(errors);
});

// Text extraction only proves the ToUnicode map is right. This re-opens the saved
// file and checks the glyphs are actually drawn: a broken embedded font renders
// most letters as nothing in the browser.
test('saved text renders with all its glyphs when reopened', async ({ page }) => {
  const errors = await openApp(page);
  page.on('dialog', (d) => d.accept());
  await loadPdfs(page, [['blank.pdf', await makePdf([{ label: '' }])]]);
  const text = 'Hizmet Sözleşmesi İşbu ğüşıöç ÇĞİÖŞÜ 0123 ₺€';

  for (const [i, [family, bold]] of [['sans', false], ['sans', true], ['serif', false], ['serif', true]].entries()) {
    await page.click('#btnText');
    await clickPage(page, 0, 0.08, 0.1 + i * 0.1);
    await expect(page.locator('.text-edit:focus')).toBeVisible();
    await page.keyboard.type(text);
    const tools = page.locator('.placed.text.selected .tools');
    await tools.locator('select').selectOption(family);
    // New boxes inherit the last style, so set boldness explicitly.
    const boldBtn = tools.locator('button.bold');
    if (bold !== (await boldBtn.evaluate((b) => b.classList.contains('on')))) await boldBtn.click();
    await page.keyboard.press('Escape');
  }
  const saved = await save(page);

  await page.click('#btnClear');

  await loadPdfs(page, [['saved.pdf', saved]]);
  await expect(page.locator('.page')).toHaveCount(1);
  await page.waitForTimeout(1500);

  const ratios = await page.evaluate(async (text) => {
    const pageCanvas = document.querySelector('.page canvas');
    const pageEl = document.querySelector('.page');
    const darkness = (ctx, x, y, w, h) => {
      const d = ctx.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) n += (1 - (d[i] + d[i + 1] + d[i + 2]) / 765) * (d[i + 3] / 255);
      return n;
    };
    const scale = pageCanvas.width / pageEl.clientWidth; // canvas px per CSS px
    const zoom = pageEl.clientWidth / 595; // CSS px per pt
    const px = 12 * zoom * scale;
    const out = [];
    for (const [i, [family, weight]] of [['Doc Sans', 400], ['Doc Sans', 700], ['Doc Serif', 400], ['Doc Serif', 700]].entries()) {
      // Ink of this line on the rendered page (each line sits in its own band).
      const top = Math.round(pageCanvas.height * (0.1 + i * 0.1) - px);
      const rendered = darkness(pageCanvas.getContext('2d'), 0, top, pageCanvas.width, Math.round(px * 2.5));
      // The same text drawn straight from the same font file.
      await document.fonts.load(`${weight} ${px}px "${family}"`);
      const ref = document.createElement('canvas');
      ref.width = pageCanvas.width;
      ref.height = Math.round(px * 3);
      const ctx = ref.getContext('2d');
      ctx.font = `${weight} ${px}px "${family}"`;
      ctx.fillText(text, 10, px * 2);
      out.push(rendered / darkness(ctx, 0, 0, ref.width, ref.height));
    }
    return out;
  }, text);

  console.log('glyph ink ratios (rendered / reference):', ratios.map((r) => r.toFixed(2)).join(', '));
  for (const r of ratios) {
    expect(r).toBeGreaterThan(0.8);
    expect(r).toBeLessThan(1.25);
  }
  expectNoErrors(errors);
});

test('styles a text box (bold, size, color) and removes an empty one', async ({ page }) => {
  const errors = await openApp(page);
  await loadPdfs(page, [['a.pdf', await makePdf([{ label: 'x' }])]]);

  // An empty text box disappears when you leave it.
  await page.click('#btnText');
  await clickPage(page, 0, 0.2, 0.2);
  await expect(page.locator('.text-edit')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.placed.text')).toHaveCount(0);

  await page.click('#btnText');
  await clickPage(page, 0, 0.2, 0.3);
  await expect(page.locator('.text-edit')).toBeFocused();
  await page.keyboard.type('Kalın yazı');
  const tools = page.locator('.placed.text .tools');
  await tools.locator('input.size').fill('20');
  await tools.locator('button.bold').click();
  const editor = page.locator('.text-edit');
  await expect(editor).toHaveCSS('font-weight', '700');
  await expect(editor).toHaveAttribute('style', /--fs:\s*20/);
  await page.keyboard.press('Escape');

  expect(await pageTexts(await save(page))).toEqual(['x Kalın yazı']);
  expectNoErrors(errors);
});

test('removes a placed item with the Delete key', async ({ page }) => {
  const errors = await openApp(page);
  await loadPdfs(page, [['a.pdf', await makePdf([{ label: 'x' }])]]);
  await drawSignature(page);
  await clickPage(page, 0, 0.5, 0.5);
  await expect(page.locator('.placed.image')).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect(page.locator('.placed.image')).toHaveCount(0);
  expect(await imageBoxes(await save(page), 1)).toHaveLength(0);
  expectNoErrors(errors);
});

test('shows only the active tab in the signature dialog', async ({ page }) => {
  const errors = await openApp(page);
  await page.click('#btnNewSig');
  const panels = page.locator('.tab-panel');
  await expect(panels.locator('visible=true')).toHaveCount(1);
  await expect(page.locator('[data-panel="draw"]')).toBeVisible();
  await page.click('.tab[data-tab="upload"]');
  await expect(page.locator('[data-panel="upload"]')).toBeVisible();
  await expect(page.locator('[data-panel="draw"]')).toBeHidden();
  await expect(page.locator('[data-panel="type"]')).toBeHidden();
  expectNoErrors(errors);
});

test('keeps saved signatures after a reload', async ({ page }) => {
  const errors = await openApp(page);
  await page.click('#btnNewSig');
  await page.click('.tab[data-tab="type"]');
  await page.fill('#typeText', 'Ayşe Yılmaz');
  await page.click('#sigSave');
  await expect(page.locator('#sigList .sig-item')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#sigList .sig-item')).toHaveCount(1);
  expectNoErrors(errors);
});
