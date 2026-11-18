// Physical reorganisation planner: works out where every book at home should go, then produces a move list.
import { getDb } from './db.js';
import { thicknessInches } from './books.js';
import { codeCompare, rememberPhysicalShelves, rebuildCaseShelvesFromDb, casesFromDb } from './importer.js';

const isLoose = code => !code || /^loose$/i.test(code);

/** Make sure every shelf code books currently sit on is known. */
export function syncPhysicalShelves() {
  const db = getDb();
  const known = new Set(db.prepare('SELECT code FROM physical_shelves WHERE width_in > 0').all().map(r => r.code.toLowerCase()));
  const books = db.prepare("SELECT id, title, pages, binding, location FROM books WHERE COALESCE(location,'') <> ''").all();
  rememberPhysicalShelves(books.map(b => b.location), {});
  // A shelf seen for the first time gets a width that fits what is on it now (rounded up to 6"), until it is measured.
  const used = new Map();
  for (const b of books) { const k = b.location.toLowerCase(); used.set(k, (used.get(k) || 0) + thicknessInches(b)); }
  const st = db.prepare('UPDATE physical_shelves SET width_in = ? WHERE code = ? COLLATE NOCASE');
  for (const r of db.prepare('SELECT code FROM physical_shelves').all()) {
    const k = r.code.toLowerCase();
    if (!known.has(k)) st.run(used.has(k) ? Math.max(24, Math.ceil((used.get(k) * 1.15) / 6) * 6) : 30, r.code);
  }
}

export function listPhysicalShelves() {
  syncPhysicalShelves();
  casesFromDb();
  const db = getDb();
  const shelves = db.prepare('SELECT * FROM physical_shelves').all().sort((a, b) => codeCompare(a.code, b.code));
  const books = db.prepare("SELECT id, title, pages, binding, location FROM books WHERE COALESCE(location,'') <> ''").all();
  const by = new Map();
  for (const b of books) {
    const k = String(b.location).toLowerCase();
    const s = by.get(k) || { count: 0, inches: 0 };
    s.count++; s.inches += thicknessInches(b); by.set(k, s);
  }
  const loose = books.filter(b => isLoose(b.location));
  return {
    shelves: shelves.map(s => {
      const u = by.get(s.code.toLowerCase()) || { count: 0, inches: 0 };
      return { ...s, enabled: !!s.enabled, count: u.count, inches: Math.round(u.inches * 10) / 10, fill: s.width_in ? Math.round((u.inches / s.width_in) * 100) : null };
    }),
    loose: loose.length,
  };
}

export function updatePhysicalShelf(code, data) {
  const cur = getDb().prepare('SELECT * FROM physical_shelves WHERE code = ?').get(code);
  if (!cur) {
    getDb().prepare('INSERT INTO physical_shelves (code, room, note, width_in, enabled) VALUES (?, ?, ?, ?, ?)')
      .run(code, data.room || null, data.note || null, Number(data.width_in) || 30, data.enabled === false ? 0 : 1);
    return;
  }
  getDb().prepare('UPDATE physical_shelves SET room = ?, note = ?, width_in = ?, enabled = ? WHERE code = ?').run(
    data.room !== undefined ? data.room || null : cur.room, data.note !== undefined ? data.note || null : cur.note,
    data.width_in !== undefined ? Math.max(4, Number(data.width_in) || cur.width_in) : cur.width_in,
    data.enabled !== undefined ? (data.enabled ? 1 : 0) : cur.enabled, code);
}

export function deletePhysicalShelf(code) {
  const n = getDb().prepare('SELECT COUNT(*) n FROM books WHERE location = ? COLLATE NOCASE').get(code).n;
  if (n) throw new Error(`${n} books are still recorded on ${code}. Use it as "not for books" instead, or move them first.`);
  getDb().prepare('DELETE FROM physical_shelves WHERE code = ?').run(code);
}

/* ───────── Planning ───────── */

function firstAuthorSort(b) { return (b.author_sort || '~').toLowerCase(); }

/**
 * Turn books into ordered "blocks": a series is one block (kept together), every other book is its own block.
 * order: 'author' (A→Z by author, a series sits under its author) | 'series-first' (all series, then everything else by author)
 *        | 'title' | 'size' (tallest/biggest-first by binding then author)
 */
export function orderBlocks(books, order = 'author') {
  const seriesMap = new Map();
  const blocks = [];
  for (const b of books) {
    if (b.series) {
      const k = b.series.toLowerCase().trim();
      if (!seriesMap.has(k)) { const blk = { series: b.series, books: [] }; seriesMap.set(k, blk); blocks.push(blk); }
      seriesMap.get(k).books.push(b);
    } else blocks.push({ series: null, books: [b] });
  }
  for (const blk of blocks) {
    blk.books.sort((a, b) => (a.series_index ?? 1e9) - (b.series_index ?? 1e9) || (a.sort_title || '').localeCompare(b.sort_title || ''));
    const first = blk.books[0];
    blk.author = firstAuthorSort(first);
    blk.title = (blk.series || first.sort_title || '').toLowerCase();
    blk.binding = first.binding || '';
  }
  const cmp = {
    author: (a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title),
    'series-first': (a, b) => (a.series ? 0 : 1) - (b.series ? 0 : 1) || (a.series && b.series ? a.title.localeCompare(b.title) : 0) || a.author.localeCompare(b.author) || a.title.localeCompare(b.title),
    title: (a, b) => a.title.localeCompare(b.title),
    binding: (a, b) => (a.binding === 'Hardback' ? 0 : 1) - (b.binding === 'Hardback' ? 0 : 1) || a.author.localeCompare(b.author) || a.title.localeCompare(b.title),
  }[order] || ((a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title));
  return blocks.sort(cmp);
}

/**
 * opts: { order, fill (0.5–1), bigSeries (n: a series this size starts on a fresh shelf; 0 = off),
 *         keepTogether (don't split a series that would fit on one shelf), includeLoose, codes (limit to these shelves) }
 * Returns { placements: [{ book_id, code, pos, from_code, from_pos }], shelves: [{code, count, inches, width, fill, first, last}], overflow }
 */
export function makePlan(opts = {}) {
  const db = getDb();
  syncPhysicalShelves();
  const fill = Math.min(1, Math.max(0.5, Number(opts.fill) || 0.9));
  const bigSeries = Number(opts.bigSeries ?? 10) || 0;
  const keepTogether = opts.keepTogether !== false;
  let shelves = db.prepare('SELECT * FROM physical_shelves WHERE enabled = 1').all().sort((a, b) => codeCompare(a.code, b.code));
  if (Array.isArray(opts.codes) && opts.codes.length) { const want = new Set(opts.codes.map(c => c.toLowerCase())); shelves = shelves.filter(s => want.has(s.code.toLowerCase())); }
  const enabledCodes = new Set(shelves.map(s => s.code.toLowerCase()));
  const books = db.prepare("SELECT * FROM books WHERE COALESCE(location,'') <> ''").all()
    .filter(b => (opts.includeLoose !== false || !isLoose(b.location)))
    // Books on shelves left out of the plan stay where they are.
    .filter(b => isLoose(b.location) || enabledCodes.has(String(b.location).toLowerCase()) || !(Array.isArray(opts.codes) && opts.codes.length));
  const blocks = orderBlocks(books, opts.order);

  const placements = [];
  const stats = shelves.map(s => ({ code: s.code, room: s.room, note: s.note, width: s.width_in, cap: s.width_in * fill, used: 0, books: [] }));
  let si = 0;
  const cur = () => stats[si];
  const next = () => { si++; };
  const put = b => {
    const s = cur();
    const t = thicknessInches(b);
    if (s) { s.books.push(b); s.used += t; }
    placements.push({ book: b, code: s ? s.code : 'Overflow', pos: s ? s.books.length : null });
  };
  for (const blk of blocks) {
    const width = blk.books.reduce((n, b) => n + thicknessInches(b), 0);
    if (cur() && cur().books.length) {
      const c = cur();
      const free = c.cap - c.used;
      // Leaving a gap is fine, but never more than about a third of a shelf: shelf space at home is finite.
      const gapOk = free <= c.cap * 0.35;
      const isBig = bigSeries && blk.series && blk.books.length >= bigSeries;
      if (isBig && gapOk) next();
      else if (keepTogether && blk.series && width > free && width <= c.cap && gapOk) next();
    }
    for (const b of blk.books) {
      while (cur() && cur().books.length && cur().used + thicknessInches(b) > cur().cap) next();
      put(b);
    }
  }
  const out = placements.map(p => ({ book_id: p.book.id, title: p.book.title, authors: p.book.authors, series: p.book.series, series_index: p.book.series_index,
    code: p.code, pos: p.pos, from_code: p.book.location, from_pos: p.book.location_position }));
  return {
    placements: out,
    moving: out.filter(p => String(p.code).toLowerCase() !== String(p.from_code).toLowerCase() || p.pos !== p.from_pos).length,
    changingShelf: out.filter(p => String(p.code).toLowerCase() !== String(p.from_code).toLowerCase()).length,
    overflow: out.filter(p => p.code === 'Overflow').length,
    shelves: stats.map(s => ({ code: s.code, room: s.room, note: s.note, width: s.width, count: s.books.length, inches: Math.round(s.used * 10) / 10,
      fill: Math.round((s.used / s.width) * 100), first: s.books[0]?.title || null, last: s.books.at(-1)?.title || null })),
  };
}

/* ───────── Applying & tracking moves ───────── */

export function reorgActive() { return getDb().prepare('SELECT COUNT(*) n FROM reorg_snapshot').get().n > 0; }

function snapshotIfNeeded() {
  if (reorgActive()) return;
  getDb().prepare("INSERT INTO reorg_snapshot (book_id, code, pos) SELECT id, location, location_position FROM books WHERE COALESCE(location,'') <> ''").run();
}

export function applyPlan(plan) {
  const db = getDb();
  const rooms = new Map(db.prepare('SELECT code, room FROM physical_shelves').all().map(r => [r.code.toLowerCase(), r.room]));
  db.transaction(() => {
    snapshotIfNeeded();
    const up = db.prepare("UPDATE books SET location = ?, location_position = ?, room = COALESCE(?, room), updated_at = datetime('now') WHERE id = ?");
    for (const p of plan.placements) up.run(p.code, p.pos, rooms.get(String(p.code).toLowerCase()) ?? null, p.book_id);
    db.prepare('UPDATE reorg_snapshot SET done = 0').run();
  })();
  return rebuildCaseShelvesFromDb();
}

/**
 * Read a hand-arranged bookcase back into home locations: a label that starts with a shelf code (e.g. "B3 · Dresser")
 * begins that shelf; books after it get positions 1, 2, 3…
 */
export function locationsFromShelf(shelfId) {
  const db = getDb();
  const items = db.prepare('SELECT * FROM shelf_items WHERE shelf_id = ? ORDER BY position, id').all(shelfId);
  const rooms = new Map(db.prepare('SELECT code, room FROM physical_shelves').all().map(r => [r.code.toLowerCase(), r.room]));
  let code = null, pos = 0, changed = 0, skipped = 0;
  const updates = [];
  for (const it of items) {
    if (it.kind === 'label') {
      const m = String(it.text || '').trim().match(/^([A-Za-z]{1,3}\d{1,3}|Loose)\b/i);
      if (m) { code = m[1].toUpperCase() === 'LOOSE' ? 'Loose' : m[1].toUpperCase(); pos = 0; }
    } else if (it.kind === 'book') {
      if (!code) { skipped++; continue; }
      pos++;
      updates.push([code, code === 'Loose' ? null : pos, it.book_id]);
    }
  }
  db.transaction(() => {
    snapshotIfNeeded();
    const st = db.prepare("UPDATE books SET location = ?, location_position = ?, room = COALESCE(?, room), updated_at = datetime('now') WHERE id = ? AND (location IS NOT ? OR location_position IS NOT ?)");
    for (const [c, p, id] of updates) changed += st.run(c, p, rooms.get(c.toLowerCase()) ?? null, id, c, p).changes;
  })();
  rememberPhysicalShelves(updates.map(u => u[0]), {});
  return { changed, skipped, books: updates.length };
}

export function moves() {
  return getDb().prepare(`SELECT b.id, b.title, b.authors, b.series, b.series_index, b.binding, b.location AS code, b.location_position AS pos,
      s.code AS from_code, s.pos AS from_pos, s.done
    FROM reorg_snapshot s JOIN books b ON b.id = s.book_id
    WHERE COALESCE(b.location,'') <> COALESCE(s.code,'') COLLATE NOCASE OR COALESCE(b.location_position, -1) <> COALESCE(s.pos, -1)`).all()
    .sort((a, b) => codeCompare(a.code, b.code) || (a.pos ?? 1e9) - (b.pos ?? 1e9));
}

export function markDone(ids, done) {
  const st = getDb().prepare('UPDATE reorg_snapshot SET done = ? WHERE book_id = ?');
  getDb().transaction(() => ids.forEach(id => st.run(done ? 1 : 0, Number(id))))();
}

export function finishReorg() { getDb().prepare('DELETE FROM reorg_snapshot').run(); }

export function cancelReorg() {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`UPDATE books SET location = (SELECT code FROM reorg_snapshot s WHERE s.book_id = books.id),
      location_position = (SELECT pos FROM reorg_snapshot s WHERE s.book_id = books.id) WHERE id IN (SELECT book_id FROM reorg_snapshot)`).run();
    db.prepare('DELETE FROM reorg_snapshot').run();
  })();
  return rebuildCaseShelvesFromDb();
}
