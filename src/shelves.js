import { getDb } from './db.js';
import { queryBooks, withFiles } from './books.js';
import { slugify } from './util.js';

export const COLLECTIONS = ['physical', 'digital', 'any'];

function parseJson(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

export function listShelves({ publicOnly = false } = {}) {
  const rows = getDb().prepare(`SELECT s.*, (SELECT COUNT(*) FROM shelf_items i WHERE i.shelf_id = s.id AND i.kind = 'book') AS book_count
    FROM shelves s ${publicOnly ? 'WHERE is_public = 1' : ''} ORDER BY position, name`).all();
  return rows.map(shapeShelf);
}

function shapeShelf(s) {
  return { ...s, rules: parseJson(s.rules, {}), theme: parseJson(s.theme, {}), is_public: !!s.is_public };
}

export function getShelf(idOrSlug) {
  const db = getDb();
  const s = typeof idOrSlug === 'number' || /^\d+$/.test(String(idOrSlug))
    ? db.prepare('SELECT * FROM shelves WHERE id = ?').get(Number(idOrSlug))
    : db.prepare('SELECT * FROM shelves WHERE slug = ?').get(String(idOrSlug));
  return s ? shapeShelf(s) : null;
}

export function uniqueSlug(name, exceptId = null) {
  const base = slugify(name);
  let slug = base, n = 2;
  const db = getDb();
  while (db.prepare('SELECT id FROM shelves WHERE slug = ? AND id IS NOT ?').get(slug, exceptId)) slug = `${base}-${n++}`;
  return slug;
}

export function createShelf(data) {
  const db = getDb();
  const pos = (db.prepare('SELECT MAX(position) AS m FROM shelves').get().m ?? -1) + 1;
  const info = db.prepare(`INSERT INTO shelves (slug, name, description, kind, rules, sort, display, theme, position, is_public, generated_by, collection)
    VALUES (@slug, @name, @description, @kind, @rules, @sort, @display, @theme, @position, @is_public, @generated_by, @collection)`).run({
    collection: COLLECTIONS.includes(data.collection) ? data.collection : 'any',
    slug: data.slug || uniqueSlug(data.name || 'Shelf'),
    name: data.name || 'New shelf',
    description: data.description || null,
    kind: data.kind === 'smart' ? 'smart' : 'manual',
    rules: JSON.stringify(data.rules || {}),
    sort: data.sort || 'author',
    display: ['spine', 'cover', 'mixed'].includes(data.display) ? data.display : 'mixed',
    theme: JSON.stringify(data.theme || {}),
    position: data.position ?? pos,
    is_public: data.is_public === false ? 0 : 1,
    generated_by: data.generated_by || null,
  });
  return Number(info.lastInsertRowid);
}

export function updateShelf(id, data) {
  const cur = getShelf(id);
  if (!cur) return;
  const next = {
    name: data.name ?? cur.name,
    description: data.description !== undefined ? data.description : cur.description,
    kind: data.kind ?? cur.kind,
    rules: JSON.stringify(data.rules ?? cur.rules),
    sort: data.sort ?? cur.sort,
    display: data.display ?? cur.display,
    theme: JSON.stringify(data.theme ?? cur.theme),
    is_public: data.is_public === undefined ? (cur.is_public ? 1 : 0) : (data.is_public ? 1 : 0),
    collection: COLLECTIONS.includes(data.collection) ? data.collection : cur.collection,
    slug: data.slug ? uniqueSlug(data.slug, id) : cur.slug,
  };
  getDb().prepare(`UPDATE shelves SET name=@name, description=@description, kind=@kind, rules=@rules, sort=@sort,
    display=@display, theme=@theme, is_public=@is_public, slug=@slug, collection=@collection, updated_at=datetime('now') WHERE id=@id`).run({ ...next, id });
}

export function deleteShelf(id) { getDb().prepare('DELETE FROM shelves WHERE id = ?').run(id); }

export function reorderShelves(ids) {
  const db = getDb();
  const st = db.prepare('UPDATE shelves SET position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => st.run(i, id)))();
}

/** Items in display order. Smart shelves are computed from their rules. */
export function shelfItems(shelf, { includeHidden = false } = {}) {
  const db = getDb();
  if (shelf.kind === 'smart') {
    const books = withFiles(queryBooks({ ...(shelf.rules || {}), collection: shelf.collection }, { sort: shelf.sort, includeHidden }));
    const items = [];
    let lastGroup;
    const groupBy = shelf.rules?.groupBy; // 'author' | 'series' | 'location' | undefined
    books.forEach((b, i) => {
      if (groupBy) {
        const g = groupBy === 'author' ? (b.authors || '').split(/;|&/)[0].trim()
          : groupBy === 'series' ? (b.series || '') : (b.location || '');
        if (g !== lastGroup) {
          if (i > 0) items.push({ id: `brk-${i}`, kind: 'break' });
          if (g) items.push({ id: `lbl-${i}`, kind: 'label', text: g });
          lastGroup = g;
        }
      }
      items.push({ id: `b-${b.id}`, kind: 'book', display: 'inherit', book: b });
    });
    return items;
  }
  const rows = db.prepare(`SELECT i.*, m.filename AS media_file, m.width AS media_w, m.height AS media_h, m.animated AS media_animated
    FROM shelf_items i LEFT JOIN media m ON m.id = i.media_id WHERE i.shelf_id = ? ORDER BY i.position, i.id`).all(shelf.id);
  const bookIds = rows.filter(r => r.kind === 'book').map(r => r.book_id);
  // Books that don't belong to this shelf's collection (e.g. an e-book-only title on a physical bookcase) are not shown.
  const books = new Map(withFiles(queryBooks({ ids: bookIds, collection: shelf.collection }, { includeHidden })).map(b => [b.id, b]));
  const out = [];
  for (const r of rows) {
    if (r.kind === 'book') {
      const b = books.get(r.book_id);
      if (b) out.push({ id: r.id, kind: 'book', display: r.display, book: b });
    } else if (r.kind === 'decor') {
      if (r.media_id) out.push({ id: r.id, kind: 'decor', size: r.size || 'm', text: r.text, link: r.link, raise: r.raise || 0,
        media: { id: r.media_id, url: `/media/${r.media_id}`, w: r.media_w, h: r.media_h, animated: !!r.media_animated } });
    } else {
      out.push({ id: r.id, kind: r.kind, text: r.text, size: r.size, width: r.width });
    }
  }
  return out;
}

/**
 * Replace a manual shelf's items with the given list (in order).
 * Each item: { id?, kind, book_id?, media_id?, display?, size?, text?, link? }
 */
export function saveShelfItems(shelfId, items) {
  const db = getDb();
  const ins = db.prepare(`INSERT INTO shelf_items (shelf_id, position, kind, book_id, media_id, display, size, text, link, width, raise)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const int = (v, lo, hi) => (v === null || v === undefined || v === '' ? null : Math.max(lo, Math.min(hi, Math.round(Number(v)) || 0)));
  db.transaction(() => {
    db.prepare('DELETE FROM shelf_items WHERE shelf_id = ?').run(shelfId);
    items.forEach((it, i) => {
      const kind = ['book', 'decor', 'break', 'label', 'space'].includes(it.kind) ? it.kind : null;
      if (!kind) return;
      if (kind === 'book' && !it.book_id) return;
      if (kind === 'decor' && !it.media_id) return;
      ins.run(shelfId, i, kind, kind === 'book' ? Number(it.book_id) : null, kind === 'decor' ? Number(it.media_id) : null,
        ['spine', 'cover'].includes(it.display) ? it.display : 'inherit', it.size || null, it.text || null, it.link || null,
        kind === 'space' ? (int(it.width, 4, 600) ?? 40) : null, kind === 'decor' ? int(it.raise, 0, 100) : null);
    });
    db.prepare("UPDATE shelves SET updated_at = datetime('now') WHERE id = ?").run(shelfId);
  })();
}

export function addBooksToShelf(shelfId, bookIds, display = 'inherit') {
  const db = getDb();
  const shelf = getShelf(shelfId);
  if (shelf && shelf.collection !== 'any') {
    const ok = new Set(queryBooks({ ids: bookIds, collection: shelf.collection }, { includeHidden: true }).map(b => b.id));
    bookIds = bookIds.filter(id => ok.has(Number(id)));
  }
  const max = db.prepare('SELECT MAX(position) AS m FROM shelf_items WHERE shelf_id = ?').get(shelfId).m ?? -1;
  const existing = new Set(db.prepare("SELECT book_id FROM shelf_items WHERE shelf_id = ? AND kind = 'book'").all(shelfId).map(r => r.book_id));
  const ins = db.prepare("INSERT INTO shelf_items (shelf_id, position, kind, book_id, display) VALUES (?, ?, 'book', ?, ?)");
  let p = max + 1, added = 0;
  db.transaction(() => { for (const id of bookIds) if (!existing.has(Number(id))) { ins.run(shelfId, p++, Number(id), display); added++; } })();
  return added;
}

/** Shelves (public) that hold a given book — used on the book page. */
export function shelvesForBook(bookId) {
  return getDb().prepare(`SELECT DISTINCT s.slug, s.name FROM shelves s JOIN shelf_items i ON i.shelf_id = s.id
    WHERE i.book_id = ? AND s.is_public = 1 ORDER BY s.position`).all(bookId);
}

/** The first time any digital book exists, give it a home: a "Digital Library" smart bookcase. */
export function ensureDigitalShelf() {
  const db = getDb();
  if (db.prepare("SELECT value FROM settings WHERE key = 'digitalShelfCreated'").get()) return null;
  if (db.prepare("SELECT id FROM shelves WHERE collection = 'digital'").get()) { markDigital(db); return null; }
  if (!queryBooks({ collection: 'digital' }, { limit: 1 }).length) return null;
  const id = createShelf({ name: 'Digital Library', description: 'E-books, PDFs and audiobooks', kind: 'smart', sort: 'author', display: 'mixed', collection: 'digital', rules: {} });
  markDigital(db);
  return id;
}
function markDigital(db) { db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('digitalShelfCreated', 'true')").run(); }
