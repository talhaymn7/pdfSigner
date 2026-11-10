// Copies pdf.js runtime resources (fonts, CMaps, wasm decoders) into public/
// so they are served next to the app. Without these, PDFs that use
// non-embedded or CJK fonts render with wrong glyphs, and JPEG2000/JBIG2 images fail.
import { cpSync, rmSync } from 'node:fs';

const src = 'node_modules/pdfjs-dist';
const dest = 'public/pdfjs';
rmSync(dest, { recursive: true, force: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(`${src}/${dir}`, `${dest}/${dir}`, { recursive: true });
}
