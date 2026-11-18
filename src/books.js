import { getDb } from './db.js';
import { sortTitle, authorSort, clothColor, readableTextOn, hashString, matchKey, normTitle, normAuthor } from './util.js';

export const BOOK_FIELDS = ['title', 'subtitle', 'authors', 'series', 'series_index', 'description', 'publisher', 'published',
  'isbn', 'language', 'pages', 'tags', 'binding', 'room', 'location', 'location_position', 'cover', 'cover_color',
  'spine_color', 'spine_text_color', 'spine_image', 'abs_url', 'abs_id', 'plex_url', 'plex_key', 'audible_url',
  'other_links', 'notes', 'hidden', 'source', 'source_key', 'meta_checked_at', 'pages_source'];

const NUMERIC = new Set(['series_index', 'pages', 'location_position', 'spine_image', 'hidden']);

function clean(field, v) {
  if (v === undefined) return undefined;
  if (v === '' || v === null) return field === 'hidden' ? 0 : null;
  if (NUMERIC.has(field)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (field === 'other_links' && typeof v !== 'string') return JSON.stringify(v);
  return typeof v === 'string' ? v.trim() : v;
}

export function createBook(data) {
  const db = getDb();
  const row = {};
  for (const f of BOOK_FIELDS) { const v = clean(f, data[f]); if (v !== undefined) row[f] = v; }
  if (!row.title) row.title = 'Untitled';
  row.sort_title = sortTitle(row.title);
  row.author_sort = authorSort(row.authors);
  const cols = Object.keys(row);
  const info = db.prepare(`INSERT INTO books (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`).run(row);
  return Number(info.lastInsertRowid);
}

export function updateBook(id, data) {
  const db = getDb();
  const row = {};
  for (const f of BOOK_FIELDS) { const v = clean(f, data[f]); if (v !== undefined) row[f] = v; }
  if ('title' in row) { if (!row.title) row.title = 'Untitled'; row.sort_title = sortTitle(row.title); }
  if ('authors' in row) row.author_sort = authorSort(row.authors);
  const cols = Object.keys(row);
  if (!cols.length) return;
  db.prepare(`UPDATE books SET ${cols.map(c => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...row, id });
}

export function getBook(id) { return getDb().prepare('SELECT * FROM books WHERE id = ?').get(id); }

export function deleteBook(id) { getDb().prepare('DELETE FROM books WHERE id = ?').run(id); }

export function bookFiles(id) {
  return getDb().prepare('SELECT * FROM book_files WHERE book_id = ? ORDER BY format').all(id);
}

/**
 * Estimated physical thickness in inches. Paper is ~0.0028"/page for a typical trade/hardback
 * edition; boards add ~0.25" to a hardback, a paper cover ~0.06".
 */
export function thicknessInches(b) {
  const binding = (b.binding || '').toLowerCase();
  const hard = binding.startsWith('hard');
  if (b.pages > 0) return Math.round((b.pages * 0.0028 + (hard ? 0.25 : 0.06)) * 100) / 100;
  const r = (hashString(`${b.id}:${b.title}`) % 1000) / 1000;
  if (hard) return 1.0 + r * 0.6;
  if (binding.startsWith('paper')) return 0.65 + r * 0.5;
  return 0.8 + r * 0.5;
}

const PX_PER_INCH = 21; // at the 250px reference shelf, a ~9" book is ~190px tall

/**
 * Deterministic spine geometry, in px at a 250px reference row.
 * Width follows the page count. Books in a series share a height and spine style so they read as a set.
 */
export function spineGeometry(b) {
  const own = hashString(`${b.id}:${b.title}`);
  const set = b.series ? hashString(`series:${String(b.series).toLowerCase().trim()}`) : own;
  const r2 = ((set >> 10) % 1000) / 1000;
  const binding = (b.binding || '').toLowerCase();
  const w = Math.max(10, Math.min(80, Math.round(thicknessInches(b) * PX_PER_INCH)));
  let height;
  if (b.series) height = 0.76 + r2 * 0.18;
  else if (binding.startsWith('hard')) height = 0.82 + r2 * 0.14;
  else if (binding.startsWith('paper')) height = 0.68 + r2 * 0.12;
  else height = 0.74 + r2 * 0.18;
  return { w, h: Math.round(height * 1000) / 1000, style: binding.startsWith('hard') ? 'hard' : binding.startsWith('paper') ? 'paper' : 'plain', v: set % 4 };
}

// Series colours chosen in the admin, cached until changed.
let seriesCache = null;
export function seriesColorMap() {
  if (!seriesCache) {
    seriesCache = new Map(getDb().prepare('SELECT name, color, text_color FROM series_info').all()
      .map(r => [r.name.toLowerCase().trim(), r]));
  }
  return seriesCache;
}
export function invalidateSeriesColors() { seriesCache = null; }

/** Default colour a series gets when none has been chosen. */
export function defaultSeriesColor(name) { return clothColor(name); }

/** Spine colour: the book's own override, then its series colour (so a series always matches), then its cover. */
export function spineColors(b) {
  let color = b.spine_color, text = b.spine_text_color;
  if (!color && b.series) {
    const s = seriesColorMap().get(String(b.series).toLowerCase().trim());
    color = s?.color || defaultSeriesColor(b.series);
    text = text || s?.text_color;
  }
  color = color || b.cover_color || clothColor(b.title);
  return { color, text: text || readableTextOn(color) };
}

function linksFor(b) {
  const out = [];
  if (b.abs_url) out.push({ kind: 'abs', label: 'Listen on Audiobookshelf', url: b.abs_url });
  if (b.plex_url) out.push({ kind: 'plex', label: 'Listen on Plex', url: b.plex_url });
  if (b.audible_url) out.push({ kind: 'audible', label: 'Listen on Audible', url: b.audible_url });
  try { for (const l of JSON.parse(b.other_links || '[]')) if (l && l.url) out.push({ kind: 'link', label: l.label || 'Link', url: l.url }); } catch { /* ignore */ }
  return out;
}

/** Shape a DB row for the public site (no private notes, no file paths). */
export function publicBook(b, files) {
  const sc = spineColors(b);
  return {
    id: b.id, title: b.title, subtitle: b.subtitle, authors: b.authors, series: b.series, series_index: b.series_index,
    description: b.description, publisher: b.publisher, published: b.published, isbn: b.isbn, language: b.language,
    pages: b.pages, tags: b.tags ? b.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
    binding: b.binding, room: b.room, location: b.location, location_position: b.location_position,
    cover: b.cover ? `/covers/${b.cover}` : null,
    spine: { ...spineGeometry(b), ...sc, image: b.spine_image ? `/media/${b.spine_image}` : null },
    files: (files || []).filter(f => !f.missing).map(f => ({ id: f.id, format: f.format, size: f.size })),
    links: linksFor(b),
  };
}

/** Attach files to many books in one query. */
export function withFiles(books) {
  if (!books.length) return [];
  const ids = books.map(b => b.id);
  const files = getDb().prepare(`SELECT * FROM book_files WHERE book_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const by = new Map();
  for (const f of files) { if (!by.has(f.book_id)) by.set(f.book_id, []); by.get(f.book_id).push(f); }
  return books.map(b => publicBook(b, by.get(b.id)));
}

/** A book you own in print: it has a place at home, or a print binding. */
export const PHYSICAL_SQL = "(COALESCE(books.location,'') <> '' OR books.binding IN ('Hardback','Paperback','Other'))";
/** A book you own digitally: a file to download, or somewhere to listen to it. */
export const DIGITAL_SQL = "(EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = books.id AND f.missing = 0) OR COALESCE(books.abs_url,'') <> '' OR COALESCE(books.plex_url,'') <> '' OR COALESCE(books.audible_url,'') <> '')";

export const SORTS = {
  author: "CASE WHEN COALESCE(author_sort,'') = '' THEN 1 ELSE 0 END, author_sort, series, series_index, sort_title",
  title: 'sort_title',
  series: "CASE WHEN series IS NULL OR series = '' THEN 1 ELSE 0 END, series, series_index, sort_title",
  added: 'created_at DESC, id DESC',
  published: "CASE WHEN published IS NULL OR published = '' THEN 1 ELSE 0 END, published, sort_title",
  location: "CASE WHEN location IS NULL OR location = '' THEN 1 ELSE 0 END, location, location_position, sort_title",
};

/**
 * Query books with simple rules. Rules (all optional):
 *  q, author, series, tag, binding (comma list), format (has a file of this format), location (prefix),
 *  room, has: 'files'|'audio'|'physical'|'cover', ids
 */
export function queryBooks(rules = {}, { sort = 'author', includeHidden = false, limit = null, offset = 0 } = {}) {
  const where = [], args = {};
  if (!includeHidden) where.push('hidden = 0');
  if (rules.q) {
    where.push("(title LIKE @q OR subtitle LIKE @q OR authors LIKE @q OR series LIKE @q OR tags LIKE @q OR isbn LIKE @q)");
    args.q = `%${rules.q}%`;
  }
  if (rules.author) { where.push('authors LIKE @author'); args.author = `%${rules.author}%`; }
  if (rules.series) { where.push('series LIKE @series'); args.series = `%${rules.series}%`; }
  if (rules.seriesExact) { where.push('series = @seriesExact COLLATE NOCASE'); args.seriesExact = String(rules.seriesExact).trim(); }
  if (rules.inSeries) where.push("COALESCE(series, '') <> ''");
  if (Number(rules.minSeries) > 1) {
    where.push("(SELECT COUNT(*) FROM books s2 WHERE s2.series = books.series COLLATE NOCASE AND s2.hidden = 0) >= @minSeries");
    args.minSeries = Number(rules.minSeries);
  }
  if (rules.tag) { where.push("(',' || REPLACE(tags, ', ', ',') || ',') LIKE @tag"); args.tag = `%,${rules.tag},%`; }
  if (rules.room) { where.push('room = @room'); args.room = rules.room; }
  if (rules.location) { where.push('location LIKE @loc'); args.loc = `${rules.location}%`; }
  if (rules.binding) {
    const list = String(rules.binding).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) { where.push(`binding IN (${list.map((_, i) => '@b' + i).join(',')})`); list.forEach((b, i) => { args['b' + i] = b; }); }
  }
  if (rules.format) { where.push('EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = books.id AND f.format = @fmt AND f.missing = 0)'); args.fmt = String(rules.format).toLowerCase(); }
  if (rules.has === 'files') where.push('EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = books.id AND f.missing = 0)');
  if (rules.has === 'audio') where.push("(COALESCE(abs_url,'') <> '' OR COALESCE(plex_url,'') <> '' OR COALESCE(audible_url,'') <> '')");
  if (rules.has === 'physical') where.push("binding IN ('Hardback','Paperback','Other') AND COALESCE(location,'') <> ''");
  if (rules.collection === 'physical') where.push(PHYSICAL_SQL);
  if (rules.collection === 'digital') where.push(DIGITAL_SQL);
  if (rules.has === 'nocover') where.push("COALESCE(cover,'') = ''");
  if (rules.has === 'cover') where.push("COALESCE(cover,'') <> ''");
  if (Array.isArray(rules.ids)) { where.push(`id IN (${rules.ids.map(Number).filter(Number.isFinite).join(',') || 'NULL'})`); }
  const order = SORTS[sort] || SORTS.author;
  let sql = `SELECT * FROM books ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`;
  if (limit) sql += ` LIMIT ${Number(limit)} OFFSET ${Number(offset) || 0}`;
  return getDb().prepare(sql).all(args);
}

export function countBooks(rules = {}, opts = {}) {
  return queryBooks(rules, { ...opts, limit: null }).length;
}

/** Find an existing book that is clearly the same work (exact normalised title + first author). */
export function findExactMatch(title, authors) {
  const key = matchKey(title, authors);
  const t = normTitle(title);
  if (!t) return null;
  const candidates = getDb().prepare('SELECT * FROM books WHERE sort_title LIKE ?').all(`%${t.split(' ')[0]}%`);
  return candidates.find(b => matchKey(b.title, b.authors) === key && normAuthor(authors)) || null;
}
