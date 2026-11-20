import crypto from 'node:crypto';

export function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'shelf';
}

/** Normalise a title for matching: lowercase, no accents/punctuation, no leading article, no subtitle. */
export function normTitle(s, { keepSubtitle = false } = {}) {
  let t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’‘`]/g, '').toLowerCase(); // "Hitchhiker's" = "Hitchhikers"
  if (!keepSubtitle) t = t.split(/\s*[:(\[]\s*/)[0];
  t = t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  t = t.replace(/^(the|a|an) /, '');
  return t;
}

/** Normalise an author: surname-first or first-surname both reduce to sorted tokens of the first author. */
export function normAuthor(s) {
  const first = String(s || '').split(/;|&| and |\|/i)[0];
  let a = first.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’‘`]/g, '').toLowerCase();
  if (a.includes(',')) { const [last, rest] = a.split(',', 2); a = `${rest} ${last}`; }
  return a.replace(/[^a-z]+/g, ' ').trim().split(' ').filter(w => w.length > 1).sort().join(' ');
}

export function matchKey(title, author) {
  return `${normTitle(title)}|${normAuthor(author)}`;
}

/** Sort key for a title ("The Hobbit" -> "hobbit, the"). */
export function sortTitle(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(the|a|an)\s+(.*)$/i);
  return (m ? `${m[2]}, ${m[1]}` : t).toLowerCase();
}

export function authorSort(s) {
  const first = String(s || '').split(/;|&/)[0].trim();
  if (!first) return '';
  if (first.includes(',')) return first.toLowerCase();
  const parts = first.split(/\s+/);
  const last = parts.pop();
  return `${last}, ${parts.join(' ')}`.toLowerCase().trim();
}

/** Similarity 0..1 using token Dice coefficient; used only to *suggest* matches, never to auto-apply. */
export function similarity(a, b) {
  const ta = new Set(normTitle(a, { keepSubtitle: true }).split(' ').filter(Boolean));
  const tb = new Set(normTitle(b, { keepSubtitle: true }).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

export function hashString(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A pleasant book-cloth colour derived from a seed (series name keeps a series visually consistent). */
const CLOTH = ['#7b2d26', '#8c3b2b', '#5a2a27', '#2f4858', '#1f3a5f', '#284b63', '#3d5a40', '#2e4a35', '#4a5d23',
  '#6b4f2a', '#8a6a35', '#a07d3b', '#3b2f4a', '#4b2e5a', '#2b2b2b', '#5c5c5c', '#7a6852', '#9c4f2e', '#1e5b5b',
  '#6d1f3a', '#b38b59', '#d9c8a0', '#e8dcc0', '#c4b08a', '#33415c', '#5b3a29', '#2d6a4f', '#774936'];
export function clothColor(seed) { return CLOTH[hashString(seed) % CLOTH.length]; }

export function readableTextOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#f4ecd8';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#2a2118' : '#f4ecd8';
}

export function token(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function safeFilename(name) {
  return String(name || 'file').normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'file';
}

export function toInt(v, d = null) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
export function toNum(v, d = null) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** ISBN-10 or ISBN-13 (with or without dashes) -> ISBN-13 digits, or null. Lets both forms of one edition match. */
export function isbn13(v) {
  const d = String(v || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (d.length === 13 && /^97[89]\d{10}$/.test(d)) return d;
  if (d.length !== 10 || !/^\d{9}[\dX]$/.test(d)) return null;
  const core = '978' + d.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + ((10 - (sum % 10)) % 10);
}
