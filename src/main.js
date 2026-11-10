import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { buildPdf, TEXT_LINE_HEIGHT } from './export.js';
import sansRegularUrl from './fonts/NotoSans-Regular.ttf?url';
import sansBoldUrl from './fonts/NotoSans-Bold.ttf?url';
import serifRegularUrl from './fonts/NotoSerif-Regular.ttf?url';
import serifBoldUrl from './fonts/NotoSerif-Bold.ttf?url';
import '@fontsource/great-vibes';
import '@fontsource/dancing-script';
import '@fontsource/caveat';
import './style.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// pdf.js runtime resources, copied into public/pdfjs by scripts/copy-pdfjs.mjs.
const PDFJS_BASE = `${import.meta.env.BASE_URL}pdfjs/`;
const PDFJS_OPTIONS = {
  cMapUrl: `${PDFJS_BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
  wasmUrl: `${PDFJS_BASE}wasm/`,
  iccUrl: `${PDFJS_BASE}iccs/`,
};

// Text box fonts. The same TTF is used on screen and embedded in the PDF, so
// what you see is what gets saved (and Turkish characters work).
const TEXT_FONTS = {
  sans: { label: 'Sans', css: 'Doc Sans', 400: sansRegularUrl, 700: sansBoldUrl },
  serif: { label: 'Serif', css: 'Doc Serif', 400: serifRegularUrl, 700: serifBoldUrl },
};
for (const f of Object.values(TEXT_FONTS)) {
  for (const weight of [400, 700]) {
    const face = new FontFace(f.css, `url(${f[weight]})`, { weight: String(weight) });
    document.fonts.add(face);
    face.load().catch(() => {});
  }
}

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Default placement widths, in PDF points (1/72 inch).
const DEFAULT_WIDTH_PT = { signature: 150, initials: 55 };
const THUMB_WIDTH = 180;
const LIBRARY_KEY = 'pdfimza.library';
const PREFS_KEY = 'pdfimza.prefs';

const state = {
  sources: new Map(), // srcId -> { name, bytes, pdf }
  pages: [], // { id, srcId, index, pdfPage, vp, el, canvas, overlay, thumbEl, renderedZoom, renderTask }
  // Image: { type: 'image', id, pageId, dataUrl, aspect, x, y, w, h }
  // Text:  { type: 'text', id, pageId, x, y, text, size, color, family, bold }
  // x/y/w/h are fractions of the displayed page; text size is in points.
  placements: [],
  selectedPages: new Set(),
  selectedPlacement: null,
  armed: null, // { kind: 'signature' | 'initials', item } or { kind: 'text' }
  zoom: 1,
  library: loadLibrary(),
  prefs: loadPrefs(),
};

// ---------- Persistence ----------

function loadLibrary() {
  try {
    const data = JSON.parse(localStorage.getItem(LIBRARY_KEY));
    if (data?.signature && data?.initials) return data;
  } catch {
    /* fall through */
  }
  return { signature: [], initials: [] };
}

function saveLibrary() {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(state.library));
  } catch {
    showStatus('İmza kalıcı olarak kaydedilemedi (tarayıcı depolaması kapalı olabilir).', 4000);
  }
}

function loadPrefs() {
  const defaults = { sigColor: '#111111', penWidth: 7, text: { size: 12, color: '#111111', family: 'sans', bold: false } };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    return { ...defaults, ...p, text: { ...defaults.text, ...p?.text } };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    /* not critical */
  }
}

// ---------- Status ----------

let statusTimer;
function showStatus(msg, ms = 2500) {
  const el = $('#status');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- Loading PDFs ----------

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) return showStatus('Lütfen PDF dosyası seçin.');
  const wasEmpty = state.pages.length === 0;

  for (const file of files) {
    showStatus(`Yükleniyor: ${file.name}`, 0);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let pdf;
    try {
      // pdf.js takes ownership of the buffer it is given, so hand it a copy.
      pdf = await pdfjsLib.getDocument({ ...PDFJS_OPTIONS, data: bytes.slice() }).promise;
    } catch (err) {
      const msg = err?.name === 'PasswordException'
        ? `${file.name} şifreli, şifreli dosyalar desteklenmiyor.`
        : `${file.name} açılamadı: ${err?.message ?? err}`;
      showStatus(msg, 5000);
      continue;
    }
    const srcId = uid();
    state.sources.set(srcId, { name: file.name, bytes, pdf });
    for (let i = 0; i < pdf.numPages; i++) {
      const pdfPage = await pdf.getPage(i + 1);
      const page = { id: uid(), srcId, index: i, pdfPage, vp: pdfPage.getViewport({ scale: 1 }) };
      createPageElements(page);
      state.pages.push(page);
    }
  }
  $('#status').hidden = true;
  refreshPages();
  if (wasEmpty && state.pages.length) fitWidth();
}

// ---------- Page elements ----------

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) renderPage(entry.target._page);
    }
  },
  { root: $('#viewer'), rootMargin: '800px 0px' },
);

function createPageElements(page) {
  const el = document.createElement('div');
  el.className = 'page';
  el._page = page;
  const canvas = document.createElement('canvas');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const num = document.createElement('div');
  num.className = 'page-num';
  el.append(canvas, overlay, num);
  overlay.addEventListener('pointerdown', (e) => onOverlayPointerDown(e, page));
  page.el = el;
  page.canvas = canvas;
  page.overlay = overlay;
  page.numEl = num;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.draggable = true;
  const tCanvas = document.createElement('canvas');
  const bar = document.createElement('div');
  bar.className = 'thumb-bar';
  const check = document.createElement('input');
  check.type = 'checkbox';
  const name = document.createElement('span');
  name.className = 'name';
  const del = document.createElement('button');
  del.className = 'thumb-del';
  del.title = 'Sayfayı sil';
  del.textContent = '×';
  bar.append(check, name, del);
  thumb.append(tCanvas, bar);
  page.thumbEl = thumb;
  page.thumbName = name;

  check.addEventListener('click', (e) => e.stopPropagation());
  check.addEventListener('change', () => {
    check.checked ? state.selectedPages.add(page.id) : state.selectedPages.delete(page.id);
    thumb.classList.toggle('selected', check.checked);
    updateToolbar();
  });
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    deletePages([page.id]);
  });
  thumb.addEventListener('click', () => page.el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  setupThumbDrag(page);

  enqueueThumb(page, tCanvas);
}

let thumbQueue = Promise.resolve();
function enqueueThumb(page, canvas) {
  thumbQueue = thumbQueue.then(async () => {
    const dpr = window.devicePixelRatio || 1;
    const scale = (THUMB_WIDTH / page.vp.width) * dpr;
    const vp = page.pdfPage.getViewport({ scale });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    try {
      await page.pdfPage.render({ canvas, viewport: vp }).promise;
    } catch {
      /* ignore thumbnail failures */
    }
  });
}

// Page boxes use whole CSS pixels so the canvas maps 1:1 onto device pixels
// (fractional sizes make the browser resample the bitmap, which blurs text).
function cssSize(page) {
  return [Math.round(page.vp.width * state.zoom), Math.round(page.vp.height * state.zoom)];
}

function sizePage(page) {
  const [w, h] = cssSize(page);
  page.el.style.width = `${w}px`;
  page.el.style.height = `${h}px`;
}

async function renderPage(page) {
  if (page.renderedZoom === state.zoom) return;
  page.renderTask?.cancel();
  const zoom = state.zoom;
  const dpr = window.devicePixelRatio || 1;
  const [cssW, cssH] = cssSize(page);
  const vp = page.pdfPage.getViewport({ scale: zoom });
  // Render into an offscreen canvas so the old image stays visible until the new one is ready.
  const off = document.createElement('canvas');
  off.width = Math.round(cssW * dpr);
  off.height = Math.round(cssH * dpr);
  const task = page.pdfPage.render({
    canvas: off,
    viewport: vp,
    transform: [off.width / vp.width, 0, 0, off.height / vp.height, 0, 0],
  });
  page.renderTask = task;
  try {
    await task.promise;
  } catch {
    return; // cancelled
  }
  if (page.renderTask !== task) return;
  page.renderTask = null;
  page.canvas.width = off.width;
  page.canvas.height = off.height;
  page.canvas.getContext('2d').drawImage(off, 0, 0);
  page.renderedZoom = zoom;
}

function refreshPages() {
  const pagesEl = $('#pages');
  const thumbsEl = $('#thumbs');
  const total = state.pages.length;
  state.pages.forEach((page, i) => {
    sizePage(page);
    pagesEl.appendChild(page.el);
    thumbsEl.appendChild(page.thumbEl);
    observer.observe(page.el);
    page.numEl.textContent = `${i + 1} / ${total}`;
    const multi = state.sources.size > 1;
    page.thumbName.textContent = multi
      ? `${i + 1} · ${state.sources.get(page.srcId).name}`
      : `Sayfa ${i + 1}`;
    page.thumbName.title = state.sources.get(page.srcId).name;
  });
  $('#empty').hidden = total > 0;
  $('#pageCount').textContent = total ? `(${total})` : '';
  renderPlacements();
  updateToolbar();
}

function updateToolbar() {
  const none = state.pages.length === 0;
  $('#btnSave').disabled = none;
  $('#btnText').disabled = none;
  $('#btnText').classList.toggle('active', state.armed?.kind === 'text');
  $('#btnDelSelected').disabled = state.selectedPages.size === 0;
  $('#zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
}

function deletePages(ids) {
  const set = new Set(ids);
  if (set.size >= state.pages.length && state.pages.length > 0) {
    if (!confirm('Tüm sayfalar silinecek. Emin misiniz?')) return;
  }
  for (const page of state.pages.filter((p) => set.has(p.id))) {
    observer.unobserve(page.el);
    page.renderTask?.cancel();
    page.el.remove();
    page.thumbEl.remove();
    state.selectedPages.delete(page.id);
  }
  state.pages = state.pages.filter((p) => !set.has(p.id));
  state.placements = state.placements.filter((pl) => !set.has(pl.pageId));
  // Drop sources that no longer have any pages.
  for (const srcId of [...state.sources.keys()]) {
    if (!state.pages.some((p) => p.srcId === srcId)) {
      closeSource(state.sources.get(srcId));
      state.sources.delete(srcId);
    }
  }
  refreshPages();
}

// Frees pdf.js resources of a file that is no longer shown.
function closeSource(src) {
  src.pdf.loadingTask.destroy().catch(() => {});
}

function clearAll() {
  if (state.pages.length && !confirm('Açık tüm dosyalar kapatılacak. Kaydedilmemiş değişiklikler kaybolur. Devam edilsin mi?')) return;
  for (const page of state.pages) {
    observer.unobserve(page.el);
    page.el.remove();
    page.thumbEl.remove();
  }
  for (const src of state.sources.values()) closeSource(src);
  state.sources.clear();
  state.pages = [];
  state.placements = [];
  state.selectedPages.clear();
  disarm();
  refreshPages();
}

// ---------- Thumbnail drag reorder ----------

let dragPageId = null;

function setupThumbDrag(page) {
  const el = page.thumbEl;
  el.addEventListener('dragstart', (e) => {
    dragPageId = page.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', page.id);
  });
  el.addEventListener('dragend', () => {
    dragPageId = null;
    clearDropMarks();
  });
  el.addEventListener('dragover', (e) => {
    if (!dragPageId) return;
    e.preventDefault();
    const after = isAfter(e, el);
    clearDropMarks();
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    if (!dragPageId) return;
    e.preventDefault();
    e.stopPropagation();
    const after = isAfter(e, el);
    clearDropMarks();
    if (dragPageId === page.id) return;
    const moving = state.pages.find((p) => p.id === dragPageId);
    state.pages = state.pages.filter((p) => p !== moving);
    let target = state.pages.indexOf(page);
    if (after) target++;
    state.pages.splice(target, 0, moving);
    refreshPages();
  });
}

function isAfter(e, el) {
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
}

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

// ---------- Placements ----------

function onOverlayPointerDown(e, page) {
  if (e.target !== page.overlay) return;
  if (!state.armed) {
    selectPlacement(null);
    document.activeElement?.blur();
    return;
  }
  e.preventDefault();
  $('#status').hidden = true;
  const rect = page.overlay.getBoundingClientRect();
  const cx = (e.clientX - rect.left) / rect.width;
  const cy = (e.clientY - rect.top) / rect.height;

  if (state.armed.kind === 'text') {
    const t = state.prefs.text;
    // Put the middle of the first line where the user clicked.
    const lineFrac = (t.size * TEXT_LINE_HEIGHT) / page.vp.height;
    const pl = {
      type: 'text',
      id: uid(),
      pageId: page.id,
      x: clamp(cx, 0, 0.98),
      y: clamp(cy - lineFrac / 2, 0, 1 - lineFrac),
      text: '',
      ...t,
    };
    state.placements.push(pl);
    disarm();
    renderPlacements();
    selectPlacement(pl.id);
    requestAnimationFrame(() => editText(pl.id));
    return;
  }

  const { kind, item } = state.armed;
  const w = Math.min(DEFAULT_WIDTH_PT[kind] / page.vp.width, 0.9);
  const h = (w * page.vp.width) / item.aspect / page.vp.height;
  const pl = {
    type: 'image',
    id: uid(),
    pageId: page.id,
    dataUrl: item.dataUrl,
    aspect: item.aspect,
    w,
    h,
    x: clamp(cx - w / 2, 0, 1 - w),
    y: clamp(cy - h / 2, 0, 1 - h),
  };
  state.placements.push(pl);
  disarm();
  renderPlacements();
  selectPlacement(pl.id);
}

function renderPlacements() {
  for (const page of state.pages) page.overlay.replaceChildren();
  for (const pl of state.placements) {
    const page = state.pages.find((p) => p.id === pl.pageId);
    if (!page) continue;
    const el = pl.type === 'text' ? buildTextItem(pl, page) : buildImageItem(pl, page);
    el.dataset.id = pl.id;
    if (pl.id === state.selectedPlacement) el.classList.add('selected');
    positionPlaced(el, pl);
    page.overlay.appendChild(el);
  }
}

function buildImageItem(pl, page) {
  const el = document.createElement('div');
  el.className = 'placed image';
  const img = document.createElement('img');
  img.src = pl.dataUrl;
  img.draggable = false;
  const handle = document.createElement('div');
  handle.className = 'handle';

  const tools = makeTools();
  const color = colorInput('Rengi değiştir', '#111111');
  color.addEventListener('change', async () => {
    pl.dataUrl = await tintDataUrl(pl.dataUrl, color.value);
    img.src = pl.dataUrl;
  });
  tools.append(color, toolButton('Tüm sayfalara uygula', () => applyToAllPages(pl)), toolButton('Sil', () => removePlacement(pl.id), 'del'));
  el.append(img, handle, tools);

  el.addEventListener('pointerdown', (e) => startMove(e, el, pl, page));
  handle.addEventListener('pointerdown', (e) => startResize(e, el, pl, page));
  return el;
}

function buildTextItem(pl, page) {
  const el = document.createElement('div');
  el.className = 'placed text';
  const editor = document.createElement('div');
  editor.className = 'text-edit';
  editor.spellcheck = false;
  editor.textContent = pl.text;
  applyTextStyle(editor, pl);

  editor.addEventListener('input', () => {
    pl.text = readEditorText(editor);
  });
  editor.addEventListener('blur', () => {
    editor.contentEditable = 'false';
    el.classList.remove('editing');
    if (!pl.text.trim()) removePlacement(pl.id);
  });

  const tools = makeTools();
  const family = document.createElement('select');
  family.title = 'Yazı tipi';
  for (const [key, f] of Object.entries(TEXT_FONTS)) family.add(new Option(f.label, key, false, key === pl.family));
  family.addEventListener('change', () => updateText(pl, editor, { family: family.value }));

  const size = document.createElement('input');
  size.type = 'number';
  size.min = 4;
  size.max = 200;
  size.value = pl.size;
  size.title = 'Punto';
  size.className = 'size';
  size.addEventListener('input', () => {
    const v = Number(size.value);
    if (v >= 4 && v <= 200) updateText(pl, editor, { size: v });
  });

  const bold = toolButton('K', () => {
    updateText(pl, editor, { bold: !pl.bold });
    bold.classList.toggle('on', pl.bold);
  });
  bold.title = 'Kalın';
  bold.classList.add('bold');
  bold.classList.toggle('on', pl.bold);

  const color = colorInput('Yazı rengi', pl.color);
  color.addEventListener('input', () => updateText(pl, editor, { color: color.value }));

  tools.append(family, size, bold, color, toolButton('Tüm sayfalara', () => applyToAllPages(pl)), toolButton('Sil', () => removePlacement(pl.id), 'del'));
  el.append(editor, tools);

  el.addEventListener('pointerdown', (e) => {
    // While editing, clicks inside the text move the caret instead of the box.
    if (editor.isContentEditable && editor.contains(e.target)) {
      e.stopPropagation();
      return;
    }
    startMove(e, el, pl, page, () => editText(pl.id));
  });
  return el;
}

function readEditorText(editor) {
  // innerText of a contenteditable can end with a phantom newline.
  return editor.innerText.replace(/\n$/, '').replace(/\t/g, '    ');
}

function applyTextStyle(editor, pl) {
  editor.style.setProperty('--fs', pl.size);
  editor.style.fontFamily = `"${TEXT_FONTS[pl.family].css}"`;
  editor.style.fontWeight = pl.bold ? '700' : '400';
  editor.style.color = pl.color;
}

function updateText(pl, editor, changes) {
  Object.assign(pl, changes);
  applyTextStyle(editor, pl);
  // New text boxes start with the last used style.
  const { size, color, family, bold } = pl;
  state.prefs.text = { size, color, family, bold };
  savePrefs();
}

function editText(id) {
  const el = document.querySelector(`.placed[data-id="${id}"]`);
  const editor = el?.querySelector('.text-edit');
  if (!editor) return;
  selectPlacement(id);
  el.classList.add('editing');
  editor.contentEditable = 'plaintext-only';
  editor.focus();
  // Caret at the end.
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function makeTools() {
  const tools = document.createElement('div');
  tools.className = 'tools';
  // Keep clicks on the toolbar from starting a drag or deselecting the item.
  tools.addEventListener('pointerdown', (e) => e.stopPropagation());
  return tools;
}

function toolButton(label, onClick, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  // Don't steal focus from a text box being edited.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

function colorInput(title, value) {
  const c = document.createElement('input');
  c.type = 'color';
  c.title = title;
  c.value = value;
  return c;
}

function positionPlaced(el, pl) {
  el.style.left = `${pl.x * 100}%`;
  el.style.top = `${pl.y * 100}%`;
  if (pl.type !== 'text') {
    el.style.width = `${pl.w * 100}%`;
    el.style.height = `${pl.h * 100}%`;
  }
}

function selectPlacement(id) {
  state.selectedPlacement = id;
  document.querySelectorAll('.placed').forEach((n) => n.classList.toggle('selected', n.dataset.id === id));
}

function removePlacement(id) {
  state.placements = state.placements.filter((p) => p.id !== id);
  if (state.selectedPlacement === id) state.selectedPlacement = null;
  document.querySelector(`.placed[data-id="${id}"]`)?.remove();
}

function applyToAllPages(src) {
  const srcPage = state.pages.find((p) => p.id === src.pageId);
  let added = 0;
  for (const page of state.pages) {
    if (page.id === src.pageId) continue;
    let copy;
    if (src.type === 'text') {
      copy = { ...src, x: clamp(src.x, 0, 0.98), y: clamp(src.y, 0, 0.98) };
    } else {
      const widthPt = src.w * srcPage.vp.width;
      const w = Math.min(widthPt / page.vp.width, 1);
      const h = Math.min((w * page.vp.width) / src.aspect / page.vp.height, 1);
      copy = { ...src, w, h, x: clamp(src.x, 0, 1 - w), y: clamp(src.y, 0, 1 - h) };
    }
    state.placements.push({ ...copy, id: uid(), pageId: page.id });
    added++;
  }
  renderPlacements();
  showStatus(`${added} sayfaya daha eklendi.`);
}

// Drag a placed item. `onClick` runs instead if the pointer barely moved.
function startMove(e, el, pl, page, onClick) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  selectPlacement(pl.id);
  const rect = page.overlay.getBoundingClientRect();
  const wFrac = el.offsetWidth / rect.width;
  const hFrac = el.offsetHeight / rect.height;
  const sx = e.clientX, sy = e.clientY, ox = pl.x, oy = pl.y;
  let moved = false;
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    pl.x = clamp(ox + (ev.clientX - sx) / rect.width, 0, Math.max(0, 1 - wFrac));
    pl.y = clamp(oy + (ev.clientY - sy) / rect.height, 0, Math.max(0, 1 - hFrac));
    positionPlaced(el, pl);
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    if (!moved) onClick?.();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function startResize(e, el, pl, page) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  const rect = page.overlay.getBoundingClientRect();
  const sx = e.clientX, ow = pl.w;
  const ratio = page.vp.width / page.vp.height; // converts width-fraction to height-fraction
  handle.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const maxW = Math.min(1 - pl.x, ((1 - pl.y) * pl.aspect) / ratio);
    pl.w = clamp(ow + (ev.clientX - sx) / rect.width, 0.02, maxW);
    pl.h = (pl.w * ratio) / pl.aspect;
    positionPlaced(el, pl);
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

// ---------- Colors ----------

// Paint every visible pixel of a canvas with `color`, keeping its alpha (anti-aliasing).
function tintCanvas(canvas, color) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

async function tintDataUrl(dataUrl, color) {
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  tintCanvas(c, color);
  return c.toDataURL('image/png');
}

// ---------- Signature library ----------

function renderLibrary() {
  for (const [kind, listId, emptyText] of [
    ['signature', '#sigList', 'Henüz imza yok. “İmza Oluştur” ile ekleyin.'],
    ['initials', '#initList', 'Henüz paraf yok. “Paraf Oluştur” ile ekleyin.'],
  ]) {
    const list = $(listId);
    list.replaceChildren();
    if (!state.library[kind].length) {
      const p = document.createElement('div');
      p.className = 'sig-empty';
      p.textContent = emptyText;
      list.appendChild(p);
    }
    for (const item of state.library[kind]) {
      const el = document.createElement('div');
      el.className = 'sig-item';
      el.title = 'Yerleştirmek için tıklayın';
      if (state.armed?.item?.id === item.id) el.classList.add('armed');
      const img = document.createElement('img');
      img.src = item.dataUrl;
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.title = 'Sil';
      rm.textContent = '×';
      el.append(img, rm);
      list.appendChild(el);
      el.addEventListener('click', () => {
        if (state.armed?.item?.id === item.id) return disarm();
        if (!state.pages.length) return showStatus('Önce bir PDF açın.');
        arm({ kind, item }, 'Sayfada yerleştirmek istediğiniz yere tıklayın. (Esc: iptal)');
      });
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Bu kayıt kütüphaneden silinsin mi?')) return;
        state.library[kind] = state.library[kind].filter((i) => i.id !== item.id);
        if (state.armed?.item?.id === item.id) state.armed = null;
        saveLibrary();
        renderLibrary();
      });
    }
  }
}

function arm(armed, msg) {
  state.armed = armed;
  $('#viewer').classList.add('placing');
  renderLibrary();
  updateToolbar();
  if (msg) showStatus(msg, 3500);
}

function disarm() {
  state.armed = null;
  $('#viewer').classList.remove('placing');
  renderLibrary();
  updateToolbar();
}

// ---------- Signature creation dialog ----------

const dialog = $('#sigDialog');
let dialogKind = 'signature';
let activeTab = 'draw';
let uploadCanvas = null;

function openSigDialog(kind) {
  dialogKind = kind;
  $('#sigDialogTitle').textContent = kind === 'signature' ? 'İmza Oluştur' : 'Paraf Oluştur';
  $('#typeText').placeholder = kind === 'signature' ? 'Adınız Soyadınız' : 'Baş harfleriniz (ör. A.Y.)';
  clearDrawPad();
  $('#typeText').value = '';
  drawTypePreview();
  $('#uploadInput').value = '';
  uploadCanvas = null;
  drawUploadPreview();
  dialog.showModal();
}

document.querySelectorAll('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== activeTab));
    if (activeTab === 'type') $('#typeText').focus();
  }),
);

// Color picker shared by all tabs.
function setSigColor(color) {
  state.prefs.sigColor = color;
  savePrefs();
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === color));
  $('#sigColorCustom').value = color;
  if (padHasInk) tintCanvas(pad, color);
  drawTypePreview();
  drawUploadPreview();
}
document.querySelectorAll('.swatch').forEach((s) => {
  s.style.background = s.dataset.color;
  s.addEventListener('click', () => setSigColor(s.dataset.color));
});
$('#sigColorCustom').addEventListener('input', (e) => setSigColor(e.target.value));

// Draw pad
const pad = $('#drawPad');
const padCtx = pad.getContext('2d');
let padHasInk = false;

function clearDrawPad() {
  padCtx.clearRect(0, 0, pad.width, pad.height);
  padHasInk = false;
}

$('#penWidth').addEventListener('input', (e) => {
  state.prefs.penWidth = Number(e.target.value);
  savePrefs();
});

pad.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  pad.setPointerCapture(e.pointerId);
  const r = pad.getBoundingClientRect();
  const toPad = (ev) => [((ev.clientX - r.left) * pad.width) / r.width, ((ev.clientY - r.top) * pad.height) / r.height];
  let pts = [toPad(e)];
  padCtx.strokeStyle = padCtx.fillStyle = state.prefs.sigColor;
  padCtx.lineWidth = state.prefs.penWidth;
  padCtx.lineCap = padCtx.lineJoin = 'round';
  padCtx.beginPath();
  padCtx.arc(pts[0][0], pts[0][1], padCtx.lineWidth / 2, 0, Math.PI * 2);
  padCtx.fill();
  padHasInk = true;

  const move = (ev) => {
    const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    for (const ce of events.length ? events : [ev]) {
      pts.push(toPad(ce));
      const n = pts.length;
      if (n < 3) continue;
      // Smooth stroke: quadratic curve through midpoints.
      const [p0, p1, p2] = [pts[n - 3], pts[n - 2], pts[n - 1]];
      padCtx.beginPath();
      padCtx.moveTo((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
      padCtx.quadraticCurveTo(p1[0], p1[1], (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2);
      padCtx.stroke();
    }
  };
  const up = () => {
    pad.removeEventListener('pointermove', move);
    pad.removeEventListener('pointerup', up);
    pad.removeEventListener('pointercancel', up);
    pts = [];
  };
  pad.addEventListener('pointermove', move);
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
});
$('#drawClear').addEventListener('click', clearDrawPad);

// Typed signature
const typeCanvas = $('#typePreview');
async function drawTypePreview() {
  const ctx = typeCanvas.getContext('2d');
  const text = $('#typeText').value.trim();
  const font = $('#typeFont').value;
  if (text) await document.fonts.load(`100px "${font}"`, text);
  ctx.clearRect(0, 0, typeCanvas.width, typeCanvas.height);
  if (!text) return;
  let size = 220;
  ctx.font = `${size}px "${font}"`;
  while (ctx.measureText(text).width > typeCanvas.width - 80 && size > 20) {
    size -= 6;
    ctx.font = `${size}px "${font}"`;
  }
  ctx.fillStyle = state.prefs.sigColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, typeCanvas.width / 2, typeCanvas.height / 2);
}
for (const id of ['#typeText', '#typeFont']) $(id).addEventListener('input', drawTypePreview);

// Uploaded image
$('#uploadInput').addEventListener('change', async () => {
  const file = $('#uploadInput').files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  URL.revokeObjectURL(url);
  const scale = Math.min(1, 1600 / img.width);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  uploadCanvas = c;
  drawUploadPreview();
});
$('#removeBg').addEventListener('change', drawUploadPreview);
$('#recolorUpload').addEventListener('change', drawUploadPreview);

function processedUpload() {
  if (!uploadCanvas) return null;
  const c = document.createElement('canvas');
  c.width = uploadCanvas.width;
  c.height = uploadCanvas.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(uploadCanvas, 0, 0);
  if ($('#removeBg').checked) {
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Fade from opaque (lum <= 170) to fully transparent (lum >= 225).
      const a = clamp((225 - lum) / 55, 0, 1);
      d[i + 3] = Math.round(d[i + 3] * a);
    }
    ctx.putImageData(data, 0, 0);
  }
  if ($('#recolorUpload').checked) tintCanvas(c, state.prefs.sigColor);
  return c;
}

function drawUploadPreview() {
  const prev = $('#uploadPreview');
  const ctx = prev.getContext('2d');
  ctx.clearRect(0, 0, prev.width, prev.height);
  const c = processedUpload();
  if (!c) return;
  const s = Math.min((prev.width - 40) / c.width, (prev.height - 40) / c.height);
  const w = c.width * s, h = c.height * s;
  ctx.drawImage(c, (prev.width - w) / 2, (prev.height - h) / 2, w, h);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Crop a canvas to its non-transparent content.
function trimCanvas(src) {
  const { width, height } = src;
  const d = src.getContext('2d').getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (d[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

$('#sigSave').addEventListener('click', async () => {
  let source;
  if (activeTab === 'draw') source = padHasInk ? pad : null;
  else if (activeTab === 'type') {
    await drawTypePreview();
    source = typeCanvas;
  } else source = processedUpload();

  const trimmed = source && trimCanvas(source);
  if (!trimmed) return showStatus('Önce bir imza çizin, yazın veya resim seçin.');
  const item = { id: uid(), dataUrl: trimmed.toDataURL('image/png'), aspect: trimmed.width / trimmed.height };
  state.library[dialogKind].push(item);
  saveLibrary();
  dialog.close();
  // Arm the new item right away so the next click places it.
  if (state.pages.length) {
    arm({ kind: dialogKind, item }, 'Kaydedildi. Şimdi sayfada yerleştirmek istediğiniz yere tıklayın.');
  } else {
    renderLibrary();
    showStatus('Kaydedildi.');
  }
});

// ---------- Export ----------

// Ascent/descent as the browser lays the font out, so saved text sits exactly where it was on screen.
const metricsCache = new Map();
function fontMetrics(family, bold) {
  const key = `${family}-${bold}`;
  if (!metricsCache.has(key)) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${bold ? 700 : 400} 100px "${TEXT_FONTS[family].css}"`;
    const m = ctx.measureText('Hg');
    metricsCache.set(key, { ascent: m.fontBoundingBoxAscent / 100, descent: m.fontBoundingBoxDescent / 100 });
  }
  return metricsCache.get(key);
}

function exportPdf() {
  return buildPdf({
    pages: state.pages,
    sourceBytes: new Map([...state.sources].map(([id, src]) => [id, src.bytes])),
    placements: state.placements,
    loadFont: async (family, bold) => (await fetch(TEXT_FONTS[family][bold ? 700 : 400])).arrayBuffer(),
    fontMetrics,
  });
}

function suggestedName() {
  const first = state.sources.get(state.pages[0].srcId).name.replace(/\.pdf$/i, '');
  return `${first}_duzenlenmis.pdf`;
}

async function save() {
  if (!state.pages.length) return;
  document.activeElement?.blur(); // commit a text box being edited
  const name = suggestedName();
  let handle = null;
  if (window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      handle = null;
    }
  }
  showStatus('PDF hazırlanıyor…', 0);
  let bytes;
  try {
    await document.fonts.ready;
    bytes = await exportPdf();
  } catch (err) {
    console.error(err);
    return showStatus(`Kaydedilemedi: ${err?.message ?? err}`, 6000);
  }
  if (handle) {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    showStatus(`Kaydedildi: ${handle.name}`);
  } else {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showStatus('İndirildi.');
  }
}

// ---------- Zoom ----------

function renderVisible() {
  const vr = $('#viewer').getBoundingClientRect();
  for (const page of state.pages) {
    if (page.renderedZoom === state.zoom) continue;
    const r = page.el.getBoundingClientRect();
    if (r.bottom > vr.top - 800 && r.top < vr.bottom + 800) renderPage(page);
  }
}

function setZoom(z) {
  state.zoom = clamp(Math.round(z * 100) / 100, 0.4, 3);
  $('#pages').style.setProperty('--zoom', state.zoom);
  for (const page of state.pages) sizePage(page);
  renderVisible();
  updateToolbar();
}

function fitWidth() {
  if (!state.pages.length) return;
  const avail = $('#viewer').clientWidth - 48;
  const widest = Math.max(...state.pages.map((p) => p.vp.width));
  setZoom(Math.min(avail / widest, 2));
}

// ---------- Wiring ----------

$('#fileInput').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
$('#btnNewSig').addEventListener('click', () => openSigDialog('signature'));
$('#btnNewInit').addEventListener('click', () => openSigDialog('initials'));
$('#btnText').addEventListener('click', () => {
  if (state.armed?.kind === 'text') return disarm();
  arm({ kind: 'text' }, 'Metin eklemek istediğiniz yere tıklayın. (Esc: iptal)');
});
$('#btnSave').addEventListener('click', save);
$('#btnClear').addEventListener('click', clearAll);
$('#btnDelSelected').addEventListener('click', () => deletePages([...state.selectedPages]));
$('#zoomIn').addEventListener('click', () => setZoom(state.zoom + 0.1));
$('#zoomOut').addEventListener('click', () => setZoom(state.zoom - 0.1));
$('#zoomFit').addEventListener('click', fitWidth);

$('#viewer').addEventListener('scroll', renderVisible, { passive: true });
window.addEventListener('resize', () => {
  // Device pixel ratio changes (moving the window to another monitor, browser zoom) need a re-render.
  for (const page of state.pages) page.renderedZoom = null;
  renderVisible();
});

// Dropping PDF files anywhere in the window.
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.add('dragover');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragover');
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  document.body.classList.remove('dragover');
  addFiles(e.dataTransfer.files);
});

document.addEventListener('keydown', (e) => {
  if (dialog.open) return;
  if (e.target.isContentEditable) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') {
    if (state.armed) disarm();
    selectPlacement(null);
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedPlacement) {
    e.preventDefault();
    removePlacement(state.selectedPlacement);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.pages.length) e.preventDefault();
});

// Initial UI state from saved preferences.
$('#penWidth').value = state.prefs.penWidth;
$('#pages').style.setProperty('--zoom', state.zoom);
setSigColor(state.prefs.sigColor);
renderLibrary();
updateToolbar();
