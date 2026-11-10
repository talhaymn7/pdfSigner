import fs from 'node:fs';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export const FONT_FILES = {
  'sans-false': 'src/fonts/NotoSans-Regular.ttf',
  'sans-true': 'src/fonts/NotoSans-Bold.ttf',
  'serif-false': 'src/fonts/NotoSerif-Regular.ttf',
  'serif-true': 'src/fonts/NotoSerif-Bold.ttf',
};

export const loadFont = async (family, bold) => fs.readFileSync(FONT_FILES[`${family}-${bold}`]);

// Node stand-in for the browser's canvas measurement: hhea ascent/descent.
export function fontMetrics(family, bold) {
  const f = fontkit.create(fs.readFileSync(FONT_FILES[`${family}-${bold}`]));
  return { ascent: f.ascent / f.unitsPerEm, descent: -f.descent / f.unitsPerEm };
}

// 1x1 opaque PNG.
export const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Creates a PDF; each spec: { label, size?, rotation?, cropBox?: [x, y, w, h] }. */
export async function makePdf(specs) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const s of specs) {
    const page = doc.addPage(s.size ?? [595, 842]);
    if (s.rotation) page.setRotation(degrees(s.rotation));
    if (s.cropBox) page.setCropBox(...s.cropBox);
    page.drawText(s.label, { x: 100, y: 400, size: 12, font });
  }
  return doc.save();
}

/** Loads a PDF the way the app does and returns its page models. */
export async function loadPages(bytes, srcId) {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const p = await pdf.getPage(i + 1);
    pages.push({ id: `${srcId}-${i}`, srcId, index: i, vp: p.getViewport({ scale: 1 }) });
  }
  return pages;
}

async function openPage(bytes, n) {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await pdf.getPage(n);
  return { page, vp: page.getViewport({ scale: 1 }) };
}

export async function pageCount(bytes) {
  return (await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise).numPages;
}

/** Text items of page n with their baseline-left position as fractions of the displayed page. */
export async function textItems(bytes, n) {
  const { page, vp } = await openPage(bytes, n);
  const tc = await page.getTextContent();
  return tc.items
    .filter((it) => it.str.trim())
    .map((it) => {
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      return { str: it.str, x: t[4] / vp.width, y: t[5] / vp.height };
    });
}

/** Bounding boxes of the images drawn on page n, as fractions of the displayed page. */
export async function imageBoxes(bytes, n) {
  const { page, vp } = await openPage(bytes, n);
  const ops = await page.getOperatorList();
  const mul = (m, k) => [
    m[0] * k[0] + m[1] * k[2], m[0] * k[1] + m[1] * k[3],
    m[2] * k[0] + m[3] * k[2], m[2] * k[1] + m[3] * k[3],
    m[4] * k[0] + m[5] * k[2] + k[4], m[4] * k[1] + m[5] * k[3] + k[5],
  ];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const boxes = [];
  ops.fnArray.forEach((fn, i) => {
    if (fn === pdfjs.OPS.save) stack.push(ctm);
    else if (fn === pdfjs.OPS.restore) ctm = stack.pop();
    else if (fn === pdfjs.OPS.transform) ctm = mul(ops.argsArray[i], ctm);
    else if (fn === pdfjs.OPS.paintImageXObject) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) =>
        vp.convertToViewportPoint(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
      const xs = pts.map((p) => p[0] / vp.width);
      const ys = pts.map((p) => p[1] / vp.height);
      boxes.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
  });
  return boxes;
}

/** Number of image XObjects stored in the file (not counting their transparency masks). */
export async function imageObjectCount(bytes) {
  const doc = await PDFDocument.load(bytes);
  const images = [];
  const masks = new Set();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj.dict?.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    images.push(ref);
    const mask = obj.dict.get(PDFName.of('SMask'));
    if (mask) masks.add(mask);
  }
  return images.filter((ref) => !masks.has(ref)).length;
}

