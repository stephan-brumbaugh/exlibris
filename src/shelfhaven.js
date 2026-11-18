// Bring books over from the old ShelfHaven app — either straight from the running server
// (signing in like a browser would) or from a ShelfHaven backup .zip.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config, BOOK_EXTENSIONS } from './config.js';
import { getDb, getSetting } from './db.js';
import { getBook, updateBook, createBook, findExactMatch } from './books.js';
import { ingestFile } from './ingest.js';
import { saveCover, fetchImage } from './covers.js';
import { safeFilename, sleep } from './util.js';

const trim = s => String(s || '').replace(/\/+$/, '');

/* ───────── Record normalisation (works for upstream ShelfHaven and the customised fork) ───────── */
function pick(rec, ...names) {
  const keys = Object.keys(rec);
  for (const n of names) {
    const k = keys.find(x => x.toLowerCase() === n.toLowerCase());
    if (k && rec[k] !== null && rec[k] !== undefined && rec[k] !== '') return rec[k];
  }
  return null;
}

export function normaliseRecord(rec, absBase = '') {
  const out = {
    id: String(pick(rec, 'id')),
    title: pick(rec, 'title') || 'Untitled',
    authors: pick(rec, 'author', 'authors'),
    description: pick(rec, 'description'),
    coverUrl: pick(rec, 'coverUrl', 'cover'),
    fileUrl: pick(rec, 'fileUrl'),
    originalFileUrl: pick(rec, 'originalFileUrl'),
    format: String(pick(rec, 'originalFormat', 'format') || '').toLowerCase() || null,
    pages: Number(pick(rec, 'pageCount', 'pages')) || null,
    isbn: pick(rec, 'isbn'),
    language: pick(rec, 'language'),
    published: pick(rec, 'publishedYear', 'published') ? String(pick(rec, 'publishedYear', 'published')) : null,
    series: pick(rec, 'series', 'seriesName'),
    series_index: Number(pick(rec, 'seriesNumber', 'seriesIndex', 'series_number', 'seriesOrder')) || null,
    abs_url: null, abs_id: null,
  };
  if (typeof out.authors === 'object') out.authors = null;
  if (typeof out.series === 'object' && out.series) out.series = out.series.name || null;
  // Audiobookshelf link: any URL pointing at an ABS item, or an ABS item id we can turn into one.
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v !== 'string' || !v) continue;
    if (/audiobook|abs/i.test(k) && /^https?:\/\//.test(v)) out.abs_url = out.abs_url || v;
    else if (/^https?:\/\/.+\/item\/[\w-]+$/.test(v)) out.abs_url = out.abs_url || v;
    else if (/(audiobookshelf|^abs).*id$/i.test(k) && !/library|user/i.test(k)) out.abs_id = out.abs_id || v;
  }
  if (!out.abs_url && out.abs_id && absBase) out.abs_url = `${trim(absBase)}/item/${out.abs_id}`;
  // ShelfHaven used a placeholder fileUrl for audiobook-only records.
  if (out.fileUrl && !/\.\w{2,5}$/.test(String(out.fileUrl)) && !/\/download/.test(String(out.fileUrl))) out.fileUrl = null;
  return out;
}

/** "ebooks/u1/file.epub" or "http://minio:9000/ebooks/u1/file.epub" -> { bucket, key } */
export function parseRef(ref) {
  if (!ref) return null;
  let rest = String(ref);
  const m = /^https?:\/\/[^/]+\/(.+)$/i.exec(rest);
  if (m) rest = m[1];
  const i = rest.indexOf('/');
  if (i <= 0) return null;
  return { bucket: rest.slice(0, i), key: decodeURIComponent(rest.slice(i + 1).split('?')[0]) };
}

/* ───────── Shared import of one record ───────── */
function destFor(rec, ext) {
  const dir = path.join(config.uploadsDir, 'shelfhaven', safeFilename(rec.id));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeFilename(rec.title).slice(0, 100)}.${ext}`);
}

function fillBlanks(bookId, rec) {
  const b = getBook(bookId);
  const fill = {};
  for (const k of ['authors', 'description', 'isbn', 'language', 'published', 'series', 'series_index', 'abs_url', 'abs_id']) {
    if ((b[k] === null || b[k] === '') && rec[k]) fill[k] = rec[k];
  }
  if (!b.pages && rec.pages) { fill.pages = rec.pages; fill.pages_source = 'shelfhaven'; }
  if (Object.keys(fill).length) updateBook(bookId, fill);
  return Object.keys(fill);
}

/**
 * source: { files: async rec => [{ buf, ext }], cover: async rec => Buffer|null }
 * Returns 'new' | 'attached' | 'audio' | 'already' | 'skipped'
 */
async function importRecord(rec, source, job) {
  const db = getDb();
  const already = db.prepare("SELECT book_id FROM book_files WHERE path LIKE ?").get(path.join(config.uploadsDir, 'shelfhaven', safeFilename(rec.id)) + path.sep + '%');
  if (already) { fillBlanks(already.book_id, rec); return 'already'; }
  const files = await source.files(rec);
  let bookId = null, outcome = 'skipped';
  for (const f of files) {
    if (!BOOK_EXTENSIONS.includes(f.ext)) continue;
    const dest = destFor(rec, f.ext);
    fs.writeFileSync(dest, f.buf);
    const r = await ingestFile(dest, 'upload', { forceBookId: bookId });
    bookId = r.bookId;
    if (outcome === 'skipped') outcome = r.status === 'added' ? 'new' : 'attached';
  }
  if (!bookId) {
    // No file: an audiobook-only record. Link it to a matching book, or keep it as an audiobook entry.
    if (db.prepare('SELECT id FROM books WHERE source_key = ? OR (abs_url IS NOT NULL AND abs_url = ?)').get(`shelfhaven:${rec.id}`, rec.abs_url)) return 'already';
    if (!rec.abs_url) { job?.log(`– ${rec.title}: no file and no audiobook link${rec.abs_id ? ' (enter the Audiobookshelf address to rebuild it)' : ''}`); return 'skipped'; }
    const m = findExactMatch(rec.title, rec.authors);
    if (m) { bookId = m.id; outcome = 'audio'; }
    else {
      bookId = createBook({ title: rec.title, authors: rec.authors, binding: 'Audiobook', source: 'shelfhaven', source_key: `shelfhaven:${rec.id}` });
      outcome = 'new';
    }
  }
  fillBlanks(bookId, rec);
  if (!getBook(bookId).cover) {
    try {
      const buf = await source.cover(rec);
      const saved = buf && await saveCover(buf);
      if (saved) updateBook(bookId, { cover: saved.file, cover_color: saved.color });
    } catch (e) { job?.log(`  cover for ${rec.title}: ${e.message}`); }
  }
  return outcome;
}

async function runAll(records, source, job) {
  job.total(records.length);
  const res = { new: 0, 'added to an existing book': 0, 'audiobook linked': 0, 'already imported': 0, skipped: 0, failed: 0 };
  const label = { new: 'new', attached: 'added to an existing book', audio: 'audiobook linked', already: 'already imported', skipped: 'skipped' };
  for (const rec of records) {
    if (job.cancelled()) break;
    try {
      const r = await importRecord(rec, source, job);
      res[label[r]]++;
      if (r === 'new' || r === 'attached' || r === 'audio') job.log(`✓ ${rec.title} — ${label[r]}`);
    } catch (e) { res.failed++; job.log(`✗ ${rec.title}: ${e.message}`); }
    job.tick(rec.title);
  }
  return res;
}

/* ───────── From the running ShelfHaven server ───────── */
class Session {
  constructor(base) { this.base = trim(base); this.cookies = new Map(); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';'); const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  async fetch(url, opts = {}, tries = 4) {
    const full = /^https?:/.test(url) ? url : `${this.base}${url.startsWith('/') ? '' : '/'}${url}`;
    for (let i = 1; ; i++) {
      const res = await fetch(full, { ...opts, redirect: opts.redirect || 'follow', headers: { ...(opts.headers || {}), cookie: this.header(), 'User-Agent': 'ExLibris-import/1.0' }, signal: AbortSignal.timeout(120000) });
      this.store(res);
      if (res.status === 429 && i < tries) { await sleep((Number(res.headers.get('retry-after')) || 10 * i) * 1000); continue; }
      return res;
    }
  }
  async json(url) {
    const res = await this.fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }
}

export async function signIn({ url, email, password }) {
  if (!url || !email || !password) throw new Error('ShelfHaven address, email and password are all needed');
  const s = new Session(url);
  const { csrfToken } = await s.json('/api/auth/csrf');
  const body = new URLSearchParams({ csrfToken, email, username: email, password, callbackUrl: s.base, json: 'true' });
  await s.fetch('/api/auth/callback/credentials', { method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const sess = await s.json('/api/auth/session');
  if (!sess?.user) throw new Error('ShelfHaven did not accept that email and password');
  return s;
}

function listFrom(data) {
  if (Array.isArray(data)) return { list: data, total: data.length };
  const list = data.books || data.items || data.data || [];
  const total = data.total ?? data.pagination?.total ?? data.meta?.total ?? list.length;
  return { list, total };
}

async function listServerBooks(s) {
  const first = listFrom(await s.json('/api/books'));
  if (first.list.length >= first.total) return first.list;
  const all = [];
  for (let page = 1; page < 200; page++) {
    const { list } = listFrom(await s.json(`/api/books?limit=100&page=${page}&sort=title`));
    all.push(...list);
    if (list.length < 100) break;
  }
  return all;
}

function extFrom(res, fallback) {
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const fromName = m ? path.extname(decodeURIComponent(m[1])).slice(1).toLowerCase() : '';
  if (fromName) return fromName;
  const t = res.headers.get('content-type') || '';
  if (t.includes('epub')) return 'epub';
  if (t.includes('pdf')) return 'pdf';
  if (t.includes('mobipocket')) return 'mobi';
  return fallback || 'epub';
}

export async function importFromServer(opts, job) {
  job.msg('Signing in to ShelfHaven…');
  const s = await signIn(opts);
  job.msg('Reading the ShelfHaven library…');
  const raw = await listServerBooks(s);
  const absBase = opts.absUrl || getSetting('abs')?.publicUrl || getSetting('abs')?.url || '';
  const records = [];
  for (const r of raw) {
    // The list may leave out fields (series etc.); the single-book endpoint has the full record.
    let full = r;
    try { const d = await s.json(`/api/books/${r.id}`); full = { ...r, ...(d.book || d) }; } catch { /* list data is enough */ }
    records.push(normaliseRecord(full, absBase));
  }
  job.log(`Found ${records.length} books in ShelfHaven`);
  return runAll(records, {
    files: async rec => {
      if (!rec.fileUrl) return [];
      const out = [];
      const variants = rec.format && rec.format !== 'epub' ? ['?variant=original', ''] : [''];
      for (const v of variants) {
        const res = await s.fetch(`/api/books/${encodeURIComponent(rec.id)}/download${v}`);
        if (!res.ok) { if (res.status !== 404) job.log(`  ${rec.title}: download HTTP ${res.status}`); continue; }
        const ext = extFrom(res, v ? rec.format : 'epub');
        if (out.some(o => o.ext === ext)) continue;
        out.push({ ext, buf: Buffer.from(await res.arrayBuffer()) });
      }
      return out;
    },
    cover: async rec => {
      if (!rec.coverUrl) return null;
      const u = String(rec.coverUrl);
      const tries = /^https?:\/\//.test(u) ? [u] : u.startsWith('/') ? [u] : [`/api/books/${rec.id}/cover`];
      for (const t of tries) {
        const res = await s.fetch(t);
        if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) return Buffer.from(await res.arrayBuffer());
      }
      return /^https?:\/\//.test(u) ? null : fetchImage(`${s.base}/api/books/${rec.id}/cover`).catch(() => null);
    },
  }, job);
}

/* ───────── From a ShelfHaven backup .zip ───────── */
export async function importFromBackup(zipPath, opts, job) {
  const zip = new AdmZip(zipPath);
  const dbEntry = zip.getEntry('database.json');
  if (!dbEntry) throw new Error('This is not a ShelfHaven backup (no database.json inside)');
  const data = JSON.parse(dbEntry.getData().toString('utf8'));
  const absBase = opts.absUrl || getSetting('abs')?.publicUrl || getSetting('abs')?.url || '';
  const records = (data.books || []).map(b => normaliseRecord(b, absBase));
  const entry = ref => { const r = parseRef(ref); return r ? zip.getEntry(`files/${r.bucket}/${r.key}`) : null; };
  job.log(`Backup holds ${records.length} books`);
  return runAll(records, {
    files: async rec => {
      const out = [];
      for (const ref of [rec.originalFileUrl, rec.fileUrl]) {
        const e = entry(ref);
        if (!e) continue;
        const ext = path.extname(e.entryName).slice(1).toLowerCase();
        if (!out.some(o => o.ext === ext)) out.push({ ext, buf: e.getData() });
      }
      return out;
    },
    cover: async rec => entry(rec.coverUrl)?.getData() || null,
  }, job);
}
