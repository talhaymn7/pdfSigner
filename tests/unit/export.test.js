import { describe, it, expect } from 'vitest';
import { buildPdf, hexToRgb, TEXT_LINE_HEIGHT } from '../../src/export.js';
import {
  makePdf, loadPages, loadFont, fontMetrics, PNG, textItems, pageCount, imageBoxes, imageObjectCount,
} from '../helpers.js';

const build = (pages, sources, placements = []) =>
  buildPdf({ pages, sourceBytes: new Map(sources), placements, loadFont, fontMetrics });

const labels = async (bytes) => {
  const out = [];
  for (let n = 1; n <= (await pageCount(bytes)); n++) {
    out.push((await textItems(bytes, n)).map((t) => t.str).join(' '));
  }
  return out;
};

describe('merging and page management', () => {
  it('merges pages from several files in the chosen order', async () => {
    const a = await makePdf([{ label: 'A1' }, { label: 'A2' }]);
    const b = await makePdf([{ label: 'B1' }]);
    const [pa, pb] = [await loadPages(a, 'a'), await loadPages(b, 'b')];
    const out = await build([pb[0], pa[1], pa[0]], [['a', a], ['b', b]]);
    expect(await labels(out)).toEqual(['B1', 'A2', 'A1']);
  });

  it('leaves out deleted pages', async () => {
    const a = await makePdf([{ label: 'P1' }, { label: 'P2' }, { label: 'P3' }]);
    const pages = await loadPages(a, 'a');
    const out = await build([pages[0], pages[2]], [['a', a]]);
    expect(await labels(out)).toEqual(['P1', 'P3']);
  });

  it('keeps page size and rotation', async () => {
    const a = await makePdf([{ label: 'L', size: [842, 595], rotation: 90 }]);
    const out = await build(await loadPages(a, 'a'), [['a', a]]);
    const [page] = await loadPages(out, 'o');
    expect(page.vp.rotation).toBe(90);
    expect([page.vp.width, page.vp.height]).toEqual([595, 842]);
  });
});

describe('signature placement', () => {
  const box = { x: 0.1, y: 0.05, w: 0.2, h: 0.05 };
  const image = (page) => ({ type: 'image', id: `i-${page.id}`, pageId: page.id, dataUrl: PNG, aspect: 1, ...box });

  it.each([0, 90, 180, 270])('lands where it was placed on a page rotated %i°', async (rotation) => {
    const src = await makePdf([{ label: 'x', rotation }]);
    const [page] = await loadPages(src, 's');
    const out = await build([page], [['s', src]], [image(page)]);
    const [b] = await imageBoxes(out, 1);
    expect(b.x0).toBeCloseTo(box.x, 3);
    expect(b.x1).toBeCloseTo(box.x + box.w, 3);
    expect(b.y0).toBeCloseTo(box.y, 3);
    expect(b.y1).toBeCloseTo(box.y + box.h, 3);
  });

  it('respects a crop box that does not start at the origin', async () => {
    const src = await makePdf([{ label: 'x', cropBox: [50, 100, 400, 500] }]);
    const [page] = await loadPages(src, 's');
    const out = await build([page], [['s', src]], [image(page)]);
    const [b] = await imageBoxes(out, 1);
    expect(b.x0).toBeCloseTo(box.x, 3);
    expect(b.y0).toBeCloseTo(box.y, 3);
  });

  it('embeds a signature used on many pages only once', async () => {
    const src = await makePdf([{ label: '1' }, { label: '2' }, { label: '3' }]);
    const pages = await loadPages(src, 's');
    const out = await build(pages, [['s', src]], pages.map(image));
    for (let n = 1; n <= 3; n++) expect(await imageBoxes(out, n)).toHaveLength(1);
    expect(await imageObjectCount(out)).toBe(1);
  });
});

describe('text boxes', () => {
  const text = (page, extra) => ({
    type: 'text', id: 't', pageId: page.id, x: 0.5, y: 0.5, size: 12, color: '#1a3fb0', family: 'sans', bold: false, ...extra,
  });

  it('writes Turkish characters as real, searchable text', async () => {
    const src = await makePdf([{ label: 'x' }]);
    const [page] = await loadPages(src, 's');
    const s = 'Şişli İğne ışık ÇÖÜ çöü — 10.11.2026';
    const out = await build([page], [['s', src]], [text(page, { text: s })]);
    expect((await textItems(out, 1)).map((t) => t.str)).toContain(s);
  });

  it.each([
    ['sans', false],
    ['sans', true],
    ['serif', false],
    ['serif', true],
  ])('embeds the %s font (bold: %s)', async (family, bold) => {
    const src = await makePdf([{ label: 'x' }]);
    const [page] = await loadPages(src, 's');
    const out = await build([page], [['s', src]], [text(page, { text: 'Ğğ', family, bold })]);
    expect((await textItems(out, 1)).map((t) => t.str)).toContain('Ğğ');
  });

  it.each([0, 90, 180, 270])('stacks lines from where the box was placed on a page rotated %i°', async (rotation) => {
    const src = await makePdf([{ label: 'x', rotation }]);
    const [page] = await loadPages(src, 's');
    const out = await build([page], [['s', src]], [text(page, { text: 'Bir\nİki' })]);
    const items = await textItems(out, 1);
    const one = items.find((t) => t.str === 'Bir');
    const two = items.find((t) => t.str === 'İki');
    const lineFrac = (12 * TEXT_LINE_HEIGHT) / page.vp.height;
    expect(one.x).toBeCloseTo(0.5, 3);
    expect(two.x).toBeCloseTo(0.5, 3);
    // Line 1's baseline sits inside the first line box; line 2 is exactly one line lower.
    expect(one.y).toBeGreaterThan(0.5);
    expect(one.y).toBeLessThan(0.5 + lineFrac);
    expect(two.y - one.y).toBeCloseTo(lineFrac, 4);
  });

  it('skips empty text boxes', async () => {
    const src = await makePdf([{ label: 'x' }]);
    const [page] = await loadPages(src, 's');
    const out = await build([page], [['s', src]], [text(page, { text: '   ' })]);
    expect((await textItems(out, 1)).map((t) => t.str)).toEqual(['x']);
  });
});

describe('hexToRgb', () => {
  it('converts hex colors to pdf-lib RGB', () => {
    expect(hexToRgb('#1a3fb0')).toMatchObject({ red: 0x1a / 255, green: 0x3f / 255, blue: 0xb0 / 255 });
    expect(hexToRgb('#000000')).toMatchObject({ red: 0, green: 0, blue: 0 });
  });
});
