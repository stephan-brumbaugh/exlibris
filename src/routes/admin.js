import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { config, BOOK_EXTENSIONS } from '../config.js';
import { getDb, getSetting, setSetting, siteSettings, DEFAULT_SITE } from '../db.js';
import { requireAdmin, isAuthed, hasPassword, setPassword, verifyPassword, issueSession, clearSession, loginAllowed, loginSucceeded } from '../auth.js';
import { adminPage, loginPage } from '../views.js';
import { createBook, updateBook, getBook, deleteBook, bookFiles, publicBook, queryBooks, withFiles } from '../books.js';
import { listShelves, getShelf, createShelf, updateShelf, deleteShelf, reorderShelves, shelfItems, saveShelfItems, addBooksToShelf } from '../shelves.js';
import { ingestFile, scanLibrary } from '../ingest.js';
import { saveCover, fetchImage, removeCoverIfUnused } from '../covers.js';
import { searchCandidates, applyCandidate, enrichMany, booksNeedingMetadata } from '../metadata.js';
import { startJob, getJob, listJobs, cancelJob } from '../jobs.js';
import { inspect as inspectSheet, runImport } from '../importer.js';
import { refreshCandidates, listCandidates, applyCandidates } from '../integrations.js';
import { queueAutoEnrich, autoMetadataEnabled } from '../auto.js';
import { listSeries, setSeriesColor, renameSeries, createSeriesShelves } from '../series.js';
import * as reorg from '../reorg.js';
import { findCopyPairs, mergeBooks, ignorePair } from '../copies.js';
import { importFromServer, importFromBackup } from '../shelfhaven.js';
import { rebuildCaseShelvesFromDb } from '../importer.js';
import { PRESETS, FONTS } from '../../public/js/themes.js';
import { safeFilename, token } from '../util.js';

export const adminRouter = express.Router();

const upload = multer({ dest: config.tmpDir, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 200 } });
const imageUpload = multer({ dest: config.tmpDir, limits: { fileSize: 40 * 1024 * 1024, files: 50 } });
const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ───────────── Sign in ─────────────
adminRouter.get('/login', (req, res) => {
  if (!hasPassword()) return res.send(loginPage({ setup: true, next: req.query.next || '/admin' }));
  if (isAuthed(req)) return res.redirect('/admin');
  res.send(loginPage({ next: req.query.next || '/admin' }));
});

const safeNext = n => (typeof n === 'string' && n.startsWith('/admin') && !n.startsWith('//') ? n : '/admin');

adminRouter.post('/setup', express.urlencoded({ extended: false }), (req, res) => {
  if (hasPassword()) return res.redirect('/admin/login');
  const { password = '', confirm = '' } = req.body;
  if (password.length < 8) return res.send(loginPage({ setup: true, error: 'Use at least 8 characters.' }));
  if (password !== confirm) return res.send(loginPage({ setup: true, error: 'The passwords do not match.' }));
  setPassword(password);
  issueSession(res);
  res.redirect('/admin');
});

adminRouter.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (!loginAllowed(req.ip)) return res.status(429).send(loginPage({ error: 'Too many attempts. Wait a few minutes and try again.' }));
  if (!verifyPassword(String(req.body.password || ''), getSetting('admin_password'))) {
    return res.status(401).send(loginPage({ error: 'That password is not right.', next: req.body.next }));
  }
  loginSucceeded(req.ip);
  issueSession(res);
  res.redirect(safeNext(req.body.next));
});

adminRouter.post('/logout', (req, res) => { clearSession(res); res.redirect('/'); });

adminRouter.use((req, res, next) => (hasPassword() ? next() : res.redirect('/admin/login')));
adminRouter.use(requireAdmin);

// ───────────── Pages ─────────────
const page = (title, active, script, body = '<div id="app" class="loading">Loading…</div>', data = {}) =>
  (req, res) => res.send(adminPage({ title, active, script, body, data: typeof data === 'function' ? data(req) : data }));

adminRouter.get('/', page('Dashboard', 'dash', 'dashboard.js'));
adminRouter.get('/books', page('Books', 'books', 'books.js'));
adminRouter.get('/books/:id', page('Edit book', 'books', 'book-edit.js', undefined, req => ({ id: Number(req.params.id) })));
adminRouter.get('/shelves', page('Shelves', 'shelves', 'shelves.js'));
adminRouter.get('/shelves/:id', page('Shelf builder', 'shelves', 'builder.js', undefined, req => ({ id: Number(req.params.id), presets: PRESETS, fonts: Object.keys(FONTS) })));
adminRouter.get('/add', page('Add books', 'add', 'add.js', undefined, () => ({ libraryDirs: config.libraryDirs, extensions: BOOK_EXTENSIONS })));
adminRouter.get('/media', page('Decorations', 'media', 'media.js'));
adminRouter.get('/import', page('Import a spreadsheet', 'import', 'import.js'));
adminRouter.get('/integrations', page('Audiobook links', 'integrations', 'integrations.js'));
adminRouter.get('/copies', page('Match print & digital copies', 'copies', 'copies.js'));
adminRouter.get('/series', page('Series', 'series', 'series.js'));
adminRouter.get('/reorganise', page('Reorganise your shelves', 'reorg', 'reorganise.js'));
adminRouter.get('/reorganise/print', (req, res) => res.send(printMoves(req.query.by === 'source' ? 'source' : 'dest')));
adminRouter.get('/settings', page('Settings', 'settings', 'settings.js', undefined, () => ({ presets: PRESETS, fonts: Object.keys(FONTS) })));

// ───────────── API ─────────────
const api = express.Router();
adminRouter.use('/api', api);
api.use(express.json({ limit: '5mb' }));

api.get('/stats', (req, res) => {
  const db = getDb();
  res.json({
    books: db.prepare('SELECT COUNT(*) n FROM books').get().n,
    hidden: db.prepare('SELECT COUNT(*) n FROM books WHERE hidden = 1').get().n,
    files: db.prepare('SELECT COUNT(*) n FROM book_files WHERE missing = 0').get().n,
    missingFiles: db.prepare('SELECT COUNT(*) n FROM book_files WHERE missing = 1').get().n,
    noCover: db.prepare("SELECT COUNT(*) n FROM books WHERE COALESCE(cover,'') = ''").get().n,
    physical: db.prepare("SELECT COUNT(*) n FROM books WHERE COALESCE(location,'') <> ''").get().n,
    audio: db.prepare("SELECT COUNT(*) n FROM books WHERE COALESCE(abs_url,'') <> '' OR COALESCE(plex_url,'') <> '' OR COALESCE(audible_url,'') <> ''").get().n,
    shelves: db.prepare('SELECT COUNT(*) n FROM shelves').get().n,
    unshelved: db.prepare("SELECT COUNT(*) n FROM books b WHERE NOT EXISTS (SELECT 1 FROM shelf_items i WHERE i.book_id = b.id)").get().n,
    libraryDirs: config.libraryDirs.map(d => ({ path: d, exists: fs.existsSync(d) })),
    jobs: listJobs().slice(0, 5),
  });
});

// Books
api.get('/books', (req, res) => {
  const { q, sort = 'author', filter, page = 1, per = 100 } = req.query;
  const rules = { q: q || undefined };
  if (['files', 'audio', 'physical', 'nocover'].includes(filter)) rules.has = filter;
  if (filter === 'hidden') rules.hiddenOnly = true;
  let rows = queryBooks(rules, { sort, includeHidden: true });
  if (filter === 'hidden') rows = rows.filter(b => b.hidden);
  if (filter === 'unshelved') {
    const shelved = new Set(getDb().prepare("SELECT DISTINCT book_id FROM shelf_items WHERE kind = 'book'").all().map(r => r.book_id));
    rows = rows.filter(b => !shelved.has(b.id));
  }
  const total = rows.length;
  const p = Math.max(1, Number(page)), n = Math.min(500, Math.max(10, Number(per)));
  const slice = rows.slice((p - 1) * n, p * n);
  const files = new Map();
  if (slice.length) {
    for (const f of getDb().prepare(`SELECT book_id, format FROM book_files WHERE missing = 0 AND book_id IN (${slice.map(b => b.id).join(',')})`).all()) {
      if (!files.has(f.book_id)) files.set(f.book_id, []);
      files.get(f.book_id).push(f.format);
    }
  }
  res.json({ total, page: p, per: n, books: slice.map(b => ({
    id: b.id, title: b.title, authors: b.authors, series: b.series, series_index: b.series_index, binding: b.binding,
    location: b.location, location_position: b.location_position, cover: b.cover ? `/covers/${b.cover}` : null, hidden: !!b.hidden,
    formats: files.get(b.id) || [], audio: !!(b.abs_url || b.plex_url || b.audible_url), created_at: b.created_at,
  })) });
});

api.get('/books/lite', (req, res) => {
  const q = String(req.query.q || '').trim();
  const rules = q ? { q } : {};
  if (['physical', 'digital'].includes(req.query.collection)) rules.collection = req.query.collection;
  const rows = queryBooks(rules, { sort: req.query.sort || 'author', includeHidden: true, limit: Number(req.query.limit) || 60 });
  res.json(withFiles(rows));
});

api.post('/books', (req, res) => {
  const id = createBook({ ...req.body, source: 'manual' });
  res.json({ id });
});

api.get('/books/:id', (req, res) => {
  const b = getBook(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  const shelves = getDb().prepare("SELECT DISTINCT s.id, s.name, s.slug FROM shelves s JOIN shelf_items i ON i.shelf_id = s.id WHERE i.book_id = ?").all(b.id);
  res.json({ book: b, files: bookFiles(b.id), preview: publicBook(b, bookFiles(b.id)), shelves });
});

api.patch('/books/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getBook(id)) return res.status(404).json({ error: 'Not found' });
  const body = { ...req.body };
  delete body.cover; delete body.source_key; delete body.source;
  const before = getBook(id);
  if (body.pages !== undefined && String(body.pages) !== String(before.pages ?? '')) body.pages_source = body.pages ? 'manual' : null;
  updateBook(id, body);
  res.json({ ok: true, book: getBook(id) });
});

function removeUploadedFiles(bookId) {
  for (const f of bookFiles(bookId)) if (f.origin === 'upload' && f.path.startsWith(config.uploadsDir)) fs.rm(f.path, { force: true }, () => {});
}

api.delete('/books/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = getBook(id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (req.query.deleteFiles === '1') removeUploadedFiles(id);
  deleteBook(id);
  removeCoverIfUnused(getDb(), b.cover);
  res.json({ ok: true });
});

api.post('/books/bulk', (req, res) => {
  const { ids = [], action, value } = req.body;
  const list = ids.map(Number).filter(Number.isFinite);
  const db = getDb();
  let n = 0;
  if (action === 'delete') {
    for (const id of list) { const b = getBook(id); if (!b) continue; if (value === 'files') removeUploadedFiles(id); deleteBook(id); removeCoverIfUnused(db, b.cover); n++; }
  } else if (action === 'hide' || action === 'unhide') {
    db.transaction(() => list.forEach(id => { updateBook(id, { hidden: action === 'hide' ? 1 : 0 }); n++; }))();
  } else if (action === 'set' && value && typeof value === 'object') {
    const allowed = ['binding', 'room', 'location', 'series', 'tags', 'spine_color', 'language', 'authors'];
    const data = Object.fromEntries(Object.entries(value).filter(([k]) => allowed.includes(k)));
    db.transaction(() => list.forEach(id => { updateBook(id, data); n++; }))();
  } else if (action === 'addToShelf') {
    n = addBooksToShelf(Number(value), list);
  } else if (action === 'enrich') {
    const job = startJob('enrich', `Fetch details for ${list.length} books`, j => enrichMany(list, j, { replaceCover: !!value?.replaceCover }));
    return res.json({ job });
  } else return res.status(400).json({ error: 'Unknown action' });
  res.json({ ok: true, count: n });
});

// Spreadsheet-style quick edit: [{id, field: value, ...}]
api.post('/books/quick-edit', (req, res) => {
  const allowed = new Set(['title', 'authors', 'series', 'series_index', 'binding', 'location', 'location_position', 'room']);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  getDb().transaction(() => {
    for (const r of rows) {
      const data = Object.fromEntries(Object.entries(r).filter(([k]) => allowed.has(k)));
      if (Number(r.id) && Object.keys(data).length) updateBook(Number(r.id), data);
    }
  })();
  res.json({ ok: true, count: rows.length });
});

api.post('/books/:id/cover', imageUpload.single('cover'), asyncH(async (req, res) => {
  const id = Number(req.params.id);
  const b = getBook(id);
  if (!b) return res.status(404).json({ error: 'Not found' });
  let buf;
  try {
    if (req.file) { buf = fs.readFileSync(req.file.path); fs.rm(req.file.path, { force: true }, () => {}); }
    else if (req.body?.url) buf = await fetchImage(String(req.body.url));
    else return res.status(400).json({ error: 'Send an image file or url' });
  } catch (e) { return res.status(400).json({ error: `Could not get that image: ${e.message}` }); }
  const saved = await saveCover(buf);
  if (!saved) return res.status(400).json({ error: 'That image could not be read' });
  updateBook(id, { cover: saved.file, cover_color: saved.color });
  removeCoverIfUnused(getDb(), b.cover !== saved.file ? b.cover : null);
  res.json({ ok: true, cover: `/covers/${saved.file}`, color: saved.color });
}));

api.delete('/books/:id/cover', (req, res) => {
  const b = getBook(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  updateBook(b.id, { cover: null, cover_color: null });
  removeCoverIfUnused(getDb(), b.cover);
  res.json({ ok: true });
});

api.get('/books/:id/lookup', asyncH(async (req, res) => {
  const b = getBook(Number(req.params.id));
  if (!b) return res.status(404).json({ error: 'Not found' });
  const q = { title: req.query.title || b.title, authors: req.query.authors ?? b.authors, isbn: req.query.isbn || null };
  res.json(await searchCandidates(q));
}));

api.post('/books/:id/apply', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (!getBook(id)) return res.status(404).json({ error: 'Not found' });
  const { candidate, replaceCover = false, overwrite = false } = req.body;
  const r = await applyCandidate(id, candidate, { replaceCover, onlyBlank: !overwrite });
  res.json({ ...r, book: getBook(id) });
}));

function storeUpload(file) {
  const dir = path.join(config.uploadsDir, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file.originalname).toLowerCase();
  const base = safeFilename(path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8'), ext));
  let dest = path.join(dir, base + ext), n = 2;
  while (fs.existsSync(dest)) dest = path.join(dir, `${base} (${n++})${ext}`);
  fs.renameSync(file.path, dest);
  return dest;
}

api.post('/books/:id/files', upload.array('files'), asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (!getBook(id)) return res.status(404).json({ error: 'Not found' });
  const out = [];
  for (const f of req.files || []) {
    const ext = path.extname(f.originalname).slice(1).toLowerCase();
    if (!BOOK_EXTENSIONS.includes(ext)) { fs.rm(f.path, { force: true }, () => {}); out.push({ name: f.originalname, error: 'unsupported type' }); continue; }
    const dest = storeUpload(f);
    out.push({ name: f.originalname, ...(await ingestFile(dest, 'upload', { forceBookId: id })) });
  }
  res.json({ results: out, files: bookFiles(id) });
}));

api.delete('/files/:id', (req, res) => {
  const f = getDb().prepare('SELECT * FROM book_files WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (f.origin === 'upload' && f.path.startsWith(config.uploadsDir)) fs.rm(f.path, { force: true }, () => {});
  getDb().prepare('DELETE FROM book_files WHERE id = ?').run(f.id);
  res.json({ ok: true, note: f.origin === 'scan' ? 'Removed from the library. The file is still in your library folder and will come back on the next scan unless you move it.' : null });
});

api.post('/upload', upload.array('files'), asyncH(async (req, res) => {
  const out = [];
  for (const f of req.files || []) {
    const ext = path.extname(f.originalname).slice(1).toLowerCase();
    if (!BOOK_EXTENSIONS.includes(ext)) { fs.rm(f.path, { force: true }, () => {}); out.push({ name: f.originalname, status: 'skipped', error: `.${ext} is not a supported book format` }); continue; }
    try {
      const dest = storeUpload(f);
      const r = await ingestFile(dest, 'upload');
      const b = getBook(r.bookId);
      out.push({ name: f.originalname, ...r, title: b?.title, authors: b?.authors, cover: b?.cover ? `/covers/${b.cover}` : null });
    } catch (e) { out.push({ name: f.originalname, status: 'failed', error: e.message }); }
  }
  const shelfId = Number(req.body.shelfId);
  if (shelfId) addBooksToShelf(shelfId, out.filter(o => o.bookId).map(o => o.bookId));
  queueAutoEnrich('upload');
  res.json({ results: out });
}));

api.post('/scan', (req, res) => res.json({ job: startJob('scan', 'Scan library folders', async j => { const r = await scanLibrary(j); setTimeout(() => queueAutoEnrich('library scan'), 500); return r; }) }));
api.post('/enrich-missing', (req, res) => {
  const ids = booksNeedingMetadata();
  res.json({ job: startJob('enrich', `Fetch covers & details for ${ids.length} books`, j => enrichMany(ids, j, {})) });
});
api.get('/jobs', (req, res) => res.json(listJobs()));
api.get('/jobs/:id', (req, res) => { const j = getJob(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
api.post('/jobs/:id/cancel', (req, res) => res.json(cancelJob(req.params.id)));

// Shelves
api.get('/shelves', (req, res) => res.json(listShelves()));
api.post('/shelves', (req, res) => {
  const id = createShelf(req.body || {});
  if (Array.isArray(req.body?.bookIds)) addBooksToShelf(id, req.body.bookIds);
  res.json({ id, shelf: getShelf(id) });
});
api.post('/shelves/reorder', (req, res) => { reorderShelves((req.body.ids || []).map(Number)); res.json({ ok: true }); });
api.get('/shelves/:id', (req, res) => {
  const s = getShelf(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ shelf: s, items: shelfItems(s, { includeHidden: true }), site: siteSettings() });
});
api.patch('/shelves/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getShelf(id)) return res.status(404).json({ error: 'Not found' });
  updateShelf(id, req.body || {});
  res.json({ shelf: getShelf(id) });
});
api.delete('/shelves/:id', (req, res) => { deleteShelf(Number(req.params.id)); res.json({ ok: true }); });
api.put('/shelves/:id/items', (req, res) => {
  const id = Number(req.params.id);
  const s = getShelf(id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.kind !== 'manual') return res.status(400).json({ error: 'Smart shelves arrange themselves — convert it to a manual shelf first.' });
  saveShelfItems(id, Array.isArray(req.body.items) ? req.body.items : []);
  res.json({ ok: true, items: shelfItems(getShelf(id), { includeHidden: true }) });
});
api.post('/shelves/:id/books', (req, res) => res.json({ added: addBooksToShelf(Number(req.params.id), (req.body.ids || []).map(Number)) }));
api.post('/shelves/:id/freeze', (req, res) => {
  // Turn a smart shelf into a manual one with its current contents, so it can be hand-arranged.
  const s = getShelf(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  const items = shelfItems(s, { includeHidden: true }).map(i => i.kind === 'book' ? { kind: 'book', book_id: i.book.id, display: 'inherit' } : { kind: i.kind, text: i.text });
  updateShelf(s.id, { kind: 'manual' });
  saveShelfItems(s.id, items);
  res.json({ shelf: getShelf(s.id) });
});

// Media (decorations, backgrounds, spine images)
api.get('/media', (req, res) => res.json(getDb().prepare('SELECT * FROM media ORDER BY id DESC').all().map(m => ({ ...m, url: `/media/${m.id}` }))));
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
api.post('/media', imageUpload.array('files'), asyncH(async (req, res) => {
  const out = [];
  for (const f of req.files || []) {
    const ext = IMAGE_TYPES[f.mimetype];
    if (!ext) { fs.rm(f.path, { force: true }, () => {}); out.push({ name: f.originalname, error: 'Not a supported image type' }); continue; }
    let width = null, height = null, animated = 0;
    try {
      if (ext !== 'svg') { const m = await sharp(f.path, { animated: true }).metadata(); width = m.width; height = m.pageHeight || m.height; animated = (m.pages || 1) > 1 ? 1 : 0; }
    } catch { fs.rm(f.path, { force: true }, () => {}); out.push({ name: f.originalname, error: 'Could not read that image' }); continue; }
    const filename = `${token(10)}.${ext}`;
    fs.renameSync(f.path, path.join(config.mediaDir, filename));
    const info = getDb().prepare('INSERT INTO media (filename, original_name, mime, width, height, animated) VALUES (?, ?, ?, ?, ?, ?)')
      .run(filename, f.originalname, f.mimetype, width, height, animated);
    out.push({ id: Number(info.lastInsertRowid), url: `/media/${info.lastInsertRowid}`, original_name: f.originalname, width, height, animated });
  }
  res.json({ results: out });
}));
api.delete('/media/:id', (req, res) => {
  const m = getDb().prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'Not found' });
  getDb().prepare('DELETE FROM media WHERE id = ?').run(m.id); // decorations using it are removed by cascade
  getDb().prepare('UPDATE books SET spine_image = NULL WHERE spine_image = ?').run(m.id);
  fs.rm(path.join(config.mediaDir, m.filename), { force: true }, () => {});
  res.json({ ok: true });
});

// Spreadsheet import — upload once, inspect, then run with options.
const pendingImports = new Map();
api.post('/import/inspect', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file' });
  try {
    const buf = fs.readFileSync(req.file.path);
    fs.rm(req.file.path, { force: true }, () => {});
    const info = inspectSheet(buf, req.file.originalname);
    const key = token(8);
    pendingImports.set(key, { buf, name: req.file.originalname, at: Date.now() });
    for (const [k, v] of pendingImports) if (Date.now() - v.at > 3600e3) pendingImports.delete(k);
    res.json({ key, name: req.file.originalname, ...info });
  } catch (e) { res.status(400).json({ error: `Could not read that spreadsheet: ${e.message}` }); }
});
api.post('/import/run', (req, res) => {
  const p = pendingImports.get(req.body.key);
  if (!p) return res.status(400).json({ error: 'That upload has expired — choose the file again.' });
  try {
    const result = runImport(p.buf, p.name, req.body.options || {});
    result.job = queueAutoEnrich('spreadsheet import');
    res.json(result);
  }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Integrations
api.get('/integrations', (req, res) => {
  const mask = c => (c ? { ...c, token: c.token ? '••••••••' : '' } : {});
  const counts = getDb().prepare('SELECT provider, status, COUNT(*) n FROM match_candidates GROUP BY provider, status').all();
  res.json({ abs: mask(getSetting('abs')), plex: mask(getSetting('plex')), counts });
});
api.put('/integrations/:provider', (req, res) => {
  const p = req.params.provider;
  if (!['abs', 'plex'].includes(p)) return res.status(404).json({ error: 'Unknown provider' });
  const cur = getSetting(p) || {};
  const next = { ...cur, ...req.body };
  if (!req.body.token || /^•+$/.test(req.body.token)) next.token = cur.token || '';
  setSetting(p, next);
  res.json({ ok: true });
});
api.post('/integrations/:provider/refresh', (req, res) => {
  const p = req.params.provider;
  if (!['abs', 'plex'].includes(p)) return res.status(404).json({ error: 'Unknown provider' });
  res.json({ job: startJob(`sync-${p}`, `Read ${p === 'abs' ? 'Audiobookshelf' : 'Plex'} catalogue`, () => refreshCandidates(p)) });
});
api.get('/integrations/:provider/candidates', (req, res) => res.json(listCandidates(req.params.provider, req.query.status || 'pending')));
api.post('/integrations/:provider/apply', asyncH(async (req, res) => res.json(await applyCandidates(req.params.provider, req.body.actions || []))));

// Print & digital copies of the same book
api.get('/copies', (req, res) => res.json(findCopyPairs({ min: Number(req.query.min) || 0.7 })));
api.post('/copies/merge', (req, res) => {
  const out = { merged: 0, errors: [] };
  for (const p of req.body.pairs || []) {
    try { mergeBooks(p.keep, p.drop); out.merged++; } catch (e) { out.errors.push(e.message); }
  }
  res.json(out);
});
api.post('/copies/ignore', (req, res) => { ignorePair(Number(req.body.keep), Number(req.body.drop)); res.json({ ok: true }); });
api.post('/books/:id/merge', (req, res) => {
  try { res.json({ book: mergeBooks(Number(req.params.id), Number(req.body.otherId)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ShelfHaven
api.post('/shelfhaven/server', (req, res) => {
  const { url, email, password, absUrl } = req.body || {};
  res.json({ job: startJob('shelfhaven', 'Import from ShelfHaven', async j => { const r = await importFromServer({ url, email, password, absUrl }, j); queueAutoEnrich('ShelfHaven import'); return r; }) });
});
api.post('/shelfhaven/backup', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose the backup .zip' });
  const file = req.file.path;
  res.json({ job: startJob('shelfhaven', 'Import ShelfHaven backup', async j => {
    try { const r = await importFromBackup(file, { absUrl: req.body.absUrl }, j); queueAutoEnrich('ShelfHaven import'); return r; }
    finally { fs.rm(file, { force: true }, () => {}); }
  }) });
});

// Series
api.get('/series', (req, res) => res.json(listSeries()));
api.put('/series', (req, res) => {
  const { name, color, text_color } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  setSeriesColor(String(name), color, text_color);
  res.json({ ok: true });
});
api.post('/series/rename', (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !String(to || '').trim()) return res.status(400).json({ error: 'Both names are required' });
  res.json({ changed: renameSeries(String(from), String(to)) });
});
api.post('/series/shelves', (req, res) => res.json({ created: createSeriesShelves(req.body || {}) }));

// Physical reorganisation
api.get('/reorg', (req, res) => res.json({ ...reorg.listPhysicalShelves(), active: reorg.reorgActive(), moves: reorg.reorgActive() ? reorg.moves() : [] }));
api.put('/reorg/shelves/:code', (req, res) => { reorg.updatePhysicalShelf(req.params.code, req.body || {}); res.json({ ok: true }); });
api.post('/reorg/shelves/bulk', (req, res) => {
  const { codes = [], data = {} } = req.body || {};
  for (const c of codes) reorg.updatePhysicalShelf(String(c), data);
  res.json({ ok: true });
});
api.delete('/reorg/shelves/:code', (req, res) => {
  try { reorg.deletePhysicalShelf(req.params.code); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
api.post('/reorg/plan', (req, res) => res.json(reorg.makePlan(req.body || {})));
api.post('/reorg/apply', (req, res) => {
  const plan = reorg.makePlan(req.body || {});
  res.json({ shelves: reorg.applyPlan(plan), moving: plan.moving });
});
api.post('/reorg/done', (req, res) => { reorg.markDone(req.body.ids || [], req.body.done !== false); res.json({ ok: true }); });
api.post('/reorg/finish', (req, res) => { reorg.finishReorg(); res.json({ ok: true }); });
api.post('/reorg/cancel', (req, res) => res.json({ shelves: reorg.cancelReorg() }));
api.post('/reorg/rebuild', (req, res) => res.json({ shelves: rebuildCaseShelvesFromDb() }));
api.post('/shelves/:id/save-locations', (req, res) => {
  const r = reorg.locationsFromShelf(Number(req.params.id));
  res.json(r);
});

// Settings
api.get('/settings', (req, res) => res.json({ site: siteSettings(), defaults: DEFAULT_SITE, autoMetadata: autoMetadataEnabled() }));
api.put('/settings', (req, res) => {
  const cur = siteSettings();
  const { title, tagline, homeIntro, theme, autoMetadata } = req.body || {};
  if (autoMetadata !== undefined) setSetting('autoMetadata', !!autoMetadata);
  setSetting('site', { ...cur, ...(title !== undefined && { title: String(title).slice(0, 80) || DEFAULT_SITE.title }),
    ...(tagline !== undefined && { tagline: String(tagline).slice(0, 160) }), ...(homeIntro !== undefined && { homeIntro: String(homeIntro).slice(0, 2000) }),
    ...(theme && typeof theme === 'object' && { theme }) });
  res.json({ site: siteSettings() });
});
api.post('/password', (req, res) => {
  const { current = '', next = '' } = req.body || {};
  if (!verifyPassword(current, getSetting('admin_password'))) return res.status(400).json({ error: 'Current password is not right' });
  if (String(next).length < 8) return res.status(400).json({ error: 'Use at least 8 characters' });
  setPassword(next);
  issueSession(res);
  res.json({ ok: true });
});

api.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: err.message || 'Server error' });
});

function printMoves(by) {
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const list = reorg.moves();
  const key = by === 'source' ? 'from_code' : 'code';
  const groups = new Map();
  for (const m of list) { const k = m[key] || 'Loose'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  for (const [, g] of sorted) g.sort((a, b) => by === 'source' ? (a.from_pos ?? 1e9) - (b.from_pos ?? 1e9) : (a.pos ?? 1e9) - (b.pos ?? 1e9));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Move list</title><style>
  body{font:12px/1.35 Georgia,serif;margin:24px;color:#111} h1{font-size:20px;margin:0 0 4px} p{margin:0 0 14px;color:#555}
  h2{font-size:15px;margin:18px 0 4px;border-bottom:2px solid #111;padding-bottom:2px;break-after:avoid}
  table{width:100%;border-collapse:collapse} td{padding:3px 6px;border-bottom:1px solid #ddd;vertical-align:top} td.box{width:14px}
  td.box span{display:inline-block;width:11px;height:11px;border:1px solid #333} td.n{width:28px;text-align:right;color:#555}
  td.w{white-space:nowrap;width:120px} .done{color:#999;text-decoration:line-through} @media print{.noprint{display:none}}
  </style></head><body><button class="noprint" onclick="print()">Print</button>
  <h1>${by === 'source' ? 'Take these books off each shelf' : 'Put these books on each shelf'}</h1>
  <p>${list.length} books to move. ${by === 'source' ? 'Grouped by where each book is now, left to right.' : 'Grouped by where each book goes, in left-to-right order.'}</p>
  ${sorted.map(([code, g]) => `<h2>${esc(code)} <small>(${g.length})</small></h2><table>${g.map(m => `<tr class="${m.done ? 'done' : ''}">
    <td class="box"><span></span></td><td class="n">${esc(by === 'source' ? m.from_pos : m.pos)}</td>
    <td><b>${esc(m.title)}</b>${m.authors ? ' — ' + esc(m.authors) : ''}${m.series ? ` <i>(${esc(m.series)}${m.series_index ? ' #' + esc(m.series_index) : ''})</i>` : ''}</td>
    <td class="w">${by === 'source' ? '→ ' + esc(m.code) + (m.pos ? ' #' + esc(m.pos) : '') : 'from ' + esc(m.from_code || '?') + (m.from_pos ? ' #' + esc(m.from_pos) : '')}</td></tr>`).join('')}</table>`).join('')}
  </body></html>`;
}
