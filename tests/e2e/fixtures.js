import fs from 'node:fs';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Simple test PDF: one page per label, optionally rotated. */
export async function makePdf(specs) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const s of specs) {
    const page = doc.addPage([595, 842]);
    if (s.rotation) page.setRotation(degrees(s.rotation));
    if (s.label) page.drawText(s.label, { x: 80, y: 760, size: 16, font });
  }
  return Buffer.from(await doc.save());
}

/** A realistic-looking Turkish contract, used for README screenshots. */
export async function makeContract() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const dir = 'node_modules/@expo-google-fonts/noto-sans';
  const regular = await doc.embedFont(fs.readFileSync(`${dir}/400Regular/NotoSans_400Regular.ttf`), { subset: false });
  const bold = await doc.embedFont(fs.readFileSync(`${dir}/700Bold/NotoSans_700Bold.ttf`), { subset: false });
  const gray = rgb(0.35, 0.35, 0.4);

  const paragraphs = [
    ['1. TARAFLAR', 'İşbu sözleşme, bir tarafta Örnek Yazılım A.Ş. (bundan sonra “Hizmet Veren”) ile diğer tarafta Deneme Ticaret Ltd. Şti. (bundan sonra “Müşteri”) arasında aşağıdaki şartlarla akdedilmiştir.'],
    ['2. KONU', 'Sözleşmenin konusu, Hizmet Veren tarafından Müşteri’ye sunulacak yazılım geliştirme, bakım ve teknik destek hizmetlerinin kapsamı ile tarafların karşılıklı hak ve yükümlülüklerinin belirlenmesidir.'],
    ['3. SÜRE', 'Sözleşme imza tarihinden itibaren bir (1) yıl süreyle geçerlidir. Taraflardan biri süre bitiminden otuz (30) gün önce yazılı bildirimde bulunmadıkça aynı şartlarla birer yıl uzar.'],
    ['4. ÜCRET VE ÖDEME', 'Hizmet bedeli aylık olarak faturalandırılır ve fatura tarihinden itibaren on beş (15) gün içinde Hizmet Veren’in banka hesabına ödenir. Geciken ödemeler için yasal faiz uygulanır.'],
    ['5. GİZLİLİK', 'Taraflar, sözleşme kapsamında öğrendikleri ticari sırları ve kişisel verileri üçüncü kişilerle paylaşmamayı, bu yükümlülüğün sözleşme sona erdikten sonra da devam edeceğini kabul eder.'],
  ];

  const wrap = (text, font, size, width) => {
    const lines = [];
    let line = '';
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };

  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([595, 842]);
    let y = 770;
    if (p === 0) {
      page.drawText('HİZMET SÖZLEŞMESİ', { x: 595 / 2 - bold.widthOfTextAtSize('HİZMET SÖZLEŞMESİ', 18) / 2, y, size: 18, font: bold });
      y -= 22;
      page.drawText('Sözleşme No: 2026/0147', { x: 595 / 2 - regular.widthOfTextAtSize('Sözleşme No: 2026/0147', 10) / 2, y, size: 10, font: regular, color: gray });
      y -= 40;
    }
    const items = p === 0 ? paragraphs.slice(0, 4) : paragraphs.slice(4);
    for (const [title, body] of items) {
      page.drawText(title, { x: 70, y, size: 11.5, font: bold });
      y -= 18;
      for (const line of wrap(body, regular, 10.5, 455)) {
        page.drawText(line, { x: 70, y, size: 10.5, font: regular });
        y -= 15.5;
      }
      y -= 14;
    }
    if (p === 1) {
      y -= 30;
      for (const [x, label] of [[70, 'HİZMET VEREN'], [340, 'MÜŞTERİ']]) {
        page.drawText(label, { x, y, size: 11, font: bold });
        page.drawText('Ad Soyad / Unvan:', { x, y: y - 20, size: 9.5, font: regular, color: gray });
        page.drawText('Tarih:', { x, y: y - 36, size: 9.5, font: regular, color: gray });
        page.drawText('İmza:', { x, y: y - 52, size: 9.5, font: regular, color: gray });
        page.drawLine({ start: { x, y: y - 110 }, end: { x: x + 180, y: y - 110 }, thickness: 0.7, color: gray });
      }
    }
    const footer = `Sayfa ${p + 1} / 2`;
    page.drawText(footer, { x: 595 / 2 - regular.widthOfTextAtSize(footer, 9) / 2, y: 40, size: 9, font: regular, color: gray });
  }
  return Buffer.from(await doc.save());
}

// ---------- Inspecting saved PDFs ----------

async function open(bytes) {
  return pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
}

export async function pageTexts(bytes) {
  const pdf = await open(bytes);
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    out.push(tc.items.map((i) => i.str).filter((s) => s.trim()).join(' '));
  }
  return out;
}

/** Text items on page n with baseline-left position as fractions of the displayed page. */
export async function textItems(bytes, n) {
  const page = await (await open(bytes)).getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return tc.items
    .filter((it) => it.str.trim())
    .map((it) => {
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      return { str: it.str, x: t[4] / vp.width, y: t[5] / vp.height };
    });
}

/** Bounding boxes of images drawn on page n, as fractions of the displayed page. */
export async function imageBoxes(bytes, n) {
  const page = await (await open(bytes)).getPage(n);
  const vp = page.getViewport({ scale: 1 });
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
