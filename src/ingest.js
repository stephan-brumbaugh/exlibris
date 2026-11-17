import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { config, BOOK_EXTENSIONS } from './config.js';
import { getDb } from './db.js';
import { createBook, updateBook, getBook, findExactMatch } from './books.js';
import { saveCover } from './covers.js';

const run = promisify(execFile);
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, textNodeName: '#text', parseTagValue: false });

const arr = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = v => (v === undefined || v === null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();

function stripHtml(s) {
  return String(s || '').replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Parse an OPF package document (from an EPUB or a Calibre metadata.opf). */
export function parseOpf(opfXml) {
  const doc = xml.parse(opfXml);
  const pkg = doc.package || doc.Package || {};
  const md = pkg.metadata || {};
  const metas = arr(md.meta);
  const metaByName = name => metas.find(m => m['@name'] === name)?.['@content'];
  const out = {};
  out.title = text(arr(md.title)[0]);
  const creators = arr(md.creator);
  const authors = creators.filter(c => !c['@role'] || c['@role'] === 'aut').map(text).filter(Boolean);
  out.authors = (authors.length ? authors : creators.map(text).filter(Boolean)).join('; ');
  out.description = stripHtml(text(arr(md.description)[0]));
  out.publisher = text(arr(md.publisher)[0]);
  const date = text(arr(md.date)[0]);
  out.published = date && !date.startsWith('0101') ? date.slice(0, 10) : '';
  out.language = text(arr(md.language)[0]);
  const ids = arr(md.identifier);
  const isbn = ids.map(i => ({ scheme: (i['@scheme'] || '').toLowerCase(), v: text(i) }))
    .find(i => i.scheme === 'isbn' || /^(urn:isbn:)?97[89]\d{10}$|^(urn:isbn:)?\d{9}[\dx]$/i.test(i.v.replace(/-/g, '')));
  if (isbn) out.isbn = isbn.v.replace(/^urn:isbn:/i, '').replace(/-/g, '');
  out.tags = arr(md.subject).map(text).filter(Boolean).slice(0, 12).join(', ');
  out.series = metaByName('calibre:series') || '';
  out.series_index = metaByName('calibre:series_index') ? Number(metaByName('calibre:series_index')) : null;
  if (!out.series) {
    const coll = metas.find(m => m['@property'] === 'belongs-to-collection');
    if (coll) {
      out.series = text(coll);
      const idx = metas.find(m => m['@property'] === 'group-position' && m['@refines'] === `#${coll['@id']}`);
      if (idx) out.series_index = Number(text(idx));
    }
  }
  // cover lookup
  const manifest = arr(pkg.manifest?.item);
  const coverId = metaByName('cover');
  let coverItem = manifest.find(i => (i['@properties'] || '').split(/\s+/).includes('cover-image'))
    || (coverId && manifest.find(i => i['@id'] === coverId))
    || manifest.find(i => /cover/i.test(i['@id'] || '') && /^image\//.test(i['@media-type'] || ''))
    || manifest.find(i => /cover/i.test(i['@href'] || '') && /^image\//.test(i['@media-type'] || ''));
  out.coverHref = coverItem ? decodeURIComponent(coverItem['@href']) : null;
  for (const k of Object.keys(out)) if (out[k] === '' || Number.isNaN(out[k])) delete out[k];
  return out;
}

export function parseEpub(file) {
  const zip = new AdmZip(file);
  const container = zip.readAsText('META-INF/container.xml');
  if (!container) throw new Error('Not an EPUB (no container.xml)');
  const c = xml.parse(container);
  const rootPath = arr(c.container?.rootfiles?.rootfile)[0]?.['@full-path'];
  if (!rootPath) throw new Error('EPUB has no rootfile');
  const meta = parseOpf(zip.readAsText(rootPath));
  if (meta.coverHref) {
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(rootPath), meta.coverHref));
    const entry = zip.getEntry(p) || zip.getEntries().find(e => e.entryName.toLowerCase() === p.toLowerCase());
    if (entry) meta.coverBuffer = entry.getData();
  }
  delete meta.coverHref;
  return meta;
}

export async function parsePdf(file) {
  const meta = {};
  try {
    const { stdout } = await run('pdfinfo', [file], { timeout: 20000, maxBuffer: 1 << 20 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([^:]+):\s*(.*)$/); if (!m) continue;
      const [, k, v] = m;
      if (k === 'Title' && v.trim()) meta.title = v.trim();
      if (k === 'Author' && v.trim()) meta.authors = v.trim();
      if (k === 'Pages') meta.pages = Number(v) || null;
      if (k === 'Subject' && v.trim()) meta.description = v.trim();
    }
  } catch (e) { console.warn('pdfinfo failed:', e.message); }
  try {
    const prefix = path.join(config.tmpDir, `pdfcover-${process.pid}-${Date.now()}`);
    await run('pdftoppm', ['-jpeg', '-f', '1', '-l', '1', '-scale-to', '900', '-singlefile', file, prefix], { timeout: 30000 });
    const out = `${prefix}.jpg`;
    if (fs.existsSync(out)) { meta.coverBuffer = fs.readFileSync(out); fs.rmSync(out, { force: true }); }
  } catch (e) { console.warn('pdftoppm failed:', e.message); }
  // PDF titles are frequently junk ("Microsoft Word - draft3.doc"); prefer the filename then.
  if (meta.title && /(microsoft word|untitled|\.docx?$|\.indd$)/i.test(meta.title)) delete meta.title;
  return meta;
}

/** Guess title/author from a file path: "Author - Title.ext", Calibre "Author/Title (12)/Title - Author.ext". */
export function metaFromPath(file) {
  const base = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
  const dir = path.basename(path.dirname(file));
  const parent = path.basename(path.dirname(path.dirname(file)));
  const calibreDir = dir.match(/^(.*) \((\d+)\)$/);
  if (calibreDir) return { title: calibreDir[1].trim(), authors: parent };
  const m = base.match(/^(.+?)\s+-\s+(.+)$/);
  if (m) return { title: m[2].trim(), authors: m[1].trim() };
  return { title: base };
}

async function extractMeta(file, ext) {
  let meta = {};
  try {
    if (ext === 'epub') meta = parseEpub(file);
    else if (ext === 'pdf') meta = await parsePdf(file);
  } catch (e) { console.warn(`metadata failed for ${file}: ${e.message}`); }
  // Calibre library folders carry a metadata.opf and cover.jpg next to the book.
  const dir = path.dirname(file);
  const opf = path.join(dir, 'metadata.opf');
  if (fs.existsSync(opf)) {
    try { const m = parseOpf(fs.readFileSync(opf, 'utf8')); delete m.coverHref; meta = { ...meta, ...Object.fromEntries(Object.entries(m).filter(([, v]) => v)) }; } catch { /* ignore */ }
  }
  if (!meta.coverBuffer) {
    for (const name of ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) { meta.coverBuffer = fs.readFileSync(p); break; }
    }
  }
  const fromPath = metaFromPath(file);
  if (!meta.title) meta.title = fromPath.title;
  if (!meta.authors && fromPath.authors) meta.authors = fromPath.authors;
  return meta;
}

/**
 * Register one file. Returns { status: 'unchanged'|'added'|'attached'|'updated', bookId }.
 * forceBookId attaches the file to a specific book (used by the "add file to this book" upload).
 */
export async function ingestFile(file, origin, { forceBookId = null } = {}) {
  const db = getDb();
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!BOOK_EXTENSIONS.includes(ext)) return { status: 'skipped' };
  const st = fs.statSync(file);
  const existing = db.prepare('SELECT * FROM book_files WHERE path = ?').get(file);
  if (existing && existing.size === st.size && existing.mtime === Math.floor(st.mtimeMs) && !existing.missing) {
    return { status: 'unchanged', bookId: existing.book_id };
  }
  if (existing) {
    db.prepare('UPDATE book_files SET size = ?, mtime = ?, missing = 0 WHERE id = ?').run(st.size, Math.floor(st.mtimeMs), existing.id);
    return { status: 'updated', bookId: existing.book_id };
  }
  const meta = await extractMeta(file, ext);
  let bookId = forceBookId;
  let status = 'attached';
  if (!bookId) {
    // Another format of the same book in the same folder with the same base name (Calibre style).
    const base = path.join(path.dirname(file), path.basename(file, path.extname(file)));
    const sibling = db.prepare("SELECT book_id FROM book_files WHERE path LIKE ? ESCAPE '\\'").all(base.replace(/[\\%_]/g, m => '\\' + m) + '.%')[0];
    if (sibling) bookId = sibling.book_id;
  }
  if (!bookId) {
    const match = findExactMatch(meta.title, meta.authors);
    if (match) bookId = match.id;
  }
  if (!bookId) {
    status = 'added';
    bookId = createBook({
      title: meta.title, authors: meta.authors, series: meta.series, series_index: meta.series_index,
      description: meta.description, publisher: meta.publisher, published: meta.published, isbn: meta.isbn,
      language: meta.language, pages: meta.pages, tags: meta.tags, binding: ext === 'm4b' || ext === 'mp3' ? 'Audiobook' : 'Ebook', source: origin,
    });
  } else {
    // Fill blanks on the existing record without overwriting anything an admin typed.
    const b = getBook(bookId);
    const fill = {};
    for (const k of ['description', 'publisher', 'published', 'isbn', 'language', 'pages', 'series', 'series_index', 'tags', 'authors']) {
      if ((b[k] === null || b[k] === '') && meta[k]) fill[k] = meta[k];
    }
    if (Object.keys(fill).length) updateBook(bookId, fill);
  }
  const book = getBook(bookId);
  if (!book.cover && meta.coverBuffer) {
    const c = await saveCover(meta.coverBuffer);
    if (c) updateBook(bookId, { cover: c.file, cover_color: c.color });
  }
  db.prepare('INSERT INTO book_files (book_id, path, origin, format, size, mtime) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bookId, file, origin, ext, st.size, Math.floor(st.mtimeMs));
  return { status, bookId };
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '@eaDir' || e.name === '#recycle') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && BOOK_EXTENSIONS.includes(path.extname(e.name).slice(1).toLowerCase())) yield p;
  }
}

export async function scanLibrary(job) {
  const db = getDb();
  const dirs = config.libraryDirs.filter(d => fs.existsSync(d));
  const files = [];
  for (const d of dirs) for (const f of walk(d)) files.push(f);
  job?.total(files.length);
  const counts = { added: 0, attached: 0, updated: 0, unchanged: 0, missing: 0, failed: 0 };
  for (const f of files) {
    if (job?.cancelled()) break;
    try {
      const r = await ingestFile(f, 'scan');
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.status === 'added' || r.status === 'attached') job?.log(`${r.status}: ${path.relative(dirs.find(d => f.startsWith(d)) || '/', f)}`);
    } catch (e) {
      counts.failed++; job?.log(`failed: ${f} — ${e.message}`);
    }
    job?.tick(path.basename(f));
  }
  // Files under a scanned root that are gone are flagged, never deleted, so shelf placement survives a NAS hiccup.
  const known = new Set(files);
  for (const row of db.prepare("SELECT id, path FROM book_files WHERE origin = 'scan' AND missing = 0").all()) {
    if (dirs.some(d => row.path.startsWith(d + path.sep)) && !known.has(row.path) && !fs.existsSync(row.path)) {
      db.prepare('UPDATE book_files SET missing = 1 WHERE id = ?').run(row.id); counts.missing++;
    }
  }
  return { dirs, files: files.length, ...counts };
}
