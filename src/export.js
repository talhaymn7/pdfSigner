import { PDFDocument, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export const TEXT_LINE_HEIGHT = 1.2;

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * Builds the output PDF: copies the given pages (in order, possibly from several
 * source files) and draws signatures and text boxes on them.
 *
 * @param {object} args
 * @param {Array<{id, srcId, index, vp}>} args.pages  vp: pdf.js viewport at scale 1
 * @param {Map<string, Uint8Array>} args.sourceBytes  srcId -> original PDF bytes
 * @param {Array<object>} args.placements  see state.placements in main.js
 * @param {(family: string, bold: boolean) => Promise<ArrayBuffer|Uint8Array>} args.loadFont
 * @param {(family: string, bold: boolean) => {ascent: number, descent: number}} args.fontMetrics
 *        Ascent/descent as a fraction of font size, as the browser lays the font out.
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf({ pages, sourceBytes, placements, loadFont, fontMetrics }) {
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  const loaded = new Map();
  const images = new Map();
  const fonts = new Map();

  const getFont = async (family, bold) => {
    const key = `${family}-${bold}`;
    // Embedded whole: pdf-lib's subsetting drops glyph outlines from these fonts.
    // The font files are already cut down to Latin + Turkish (scripts/subset-fonts.py).
    if (!fonts.has(key)) fonts.set(key, await out.embedFont(await loadFont(family, bold)));
    return fonts.get(key);
  };

  for (const page of pages) {
    let src = loaded.get(page.srcId);
    if (!src) {
      src = await PDFDocument.load(sourceBytes.get(page.srcId), { ignoreEncryption: true });
      loaded.set(page.srcId, src);
    }
    const [copied] = await out.copyPages(src, [page.index]);
    out.addPage(copied);
    const { vp } = page;

    // Placements are stored in displayed (rotated, cropped) coordinates; each
    // anchor is mapped back into PDF user space and the content counter-rotated.
    for (const pl of placements.filter((p) => p.pageId === page.id)) {
      if (pl.type === 'text') {
        if (!pl.text.trim()) continue;
        const font = await getFont(pl.family, pl.bold);
        const { ascent, descent } = fontMetrics(pl.family, pl.bold);
        const lineH = pl.size * TEXT_LINE_HEIGHT;
        const baseline = (lineH - (ascent + descent) * pl.size) / 2 + ascent * pl.size;
        pl.text.split('\n').forEach((line, i) => {
          if (!line) return;
          const [x, y] = vp.convertToPdfPoint(pl.x * vp.width, pl.y * vp.height + i * lineH + baseline);
          copied.drawText(line, { x, y, size: pl.size, font, color: hexToRgb(pl.color), rotate: degrees(vp.rotation) });
        });
        continue;
      }
      let img = images.get(pl.dataUrl);
      if (!img) {
        img = await out.embedPng(pl.dataUrl);
        images.set(pl.dataUrl, img);
      }
      const [x, y] = vp.convertToPdfPoint(pl.x * vp.width, (pl.y + pl.h) * vp.height);
      copied.drawImage(img, {
        x,
        y,
        width: pl.w * vp.width,
        height: pl.h * vp.height,
        rotate: degrees(vp.rotation),
      });
    }
  }
  return out.save();
}
