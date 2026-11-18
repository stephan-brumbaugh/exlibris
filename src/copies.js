// Physical and digital copies of the same book live on one record, so each side can see the other
// (download from the home bookcase, find the shelf from the digital one). These helpers find pairs that
// didn't join up automatically and merge them on request.
import { getDb } from './db.js';
import { getBook, updateBook, PHYSICAL_SQL, DIGITAL_SQL } from './books.js';
import { normAuthor } from './util.js';
import { titleScore } from './metadata.js';
import { removeCoverIfUnused } from './covers.js';

function authorsCompatible(a, b) {
  if (!a || !b) return true; // unknown author on one side: let the title decide
  const x = new Set(normAuthor(a).split(' ').filter(t => t.length > 2));
  return normAuthor(b).split(' ').some(t => x.has(t));
}

/** Print-only records paired with digital-only records that look like the same book. */
export function findCopyPairs({ min = 0.7 } = {}) {
  const db = getDb();
  const print = db.prepare(`SELECT id, title, authors, series, series_index, binding, location, location_position, cover FROM books WHERE ${PHYSICAL_SQL} AND NOT ${DIGITAL_SQL}`).all();
  const digital = db.prepare(`SELECT id, title, authors, series, series_index, binding, cover,
      (SELECT GROUP_CONCAT(format) FROM book_files f WHERE f.book_id = books.id AND f.missing = 0) AS formats,
      abs_url, plex_url, audible_url FROM books WHERE ${DIGITAL_SQL} AND NOT ${PHYSICAL_SQL}`).all();
  const ignored = new Set(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'copyPairsIgnored'").get()?.value || '[]'));
  const pairs = [];
  for (const d of digital) {
    let best = null;
    for (const p of print) {
      if (!authorsCompatible(p.authors, d.authors)) continue;
      const score = titleScore(p.title, d.title);
      if (score >= min && (!best || score > best.score)) best = { p, score };
    }
    if (best && !ignored.has(`${best.p.id}:${d.id}`)) {
      pairs.push({ print: best.p, digital: { ...d, audio: !!(d.abs_url || d.plex_url || d.audible_url) }, score: Math.round(best.score * 100) / 100 });
    }
  }
  return pairs.sort((a, b) => b.score - a.score);
}

export function ignorePair(printId, digitalId) {
  const db = getDb();
  const list = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'copyPairsIgnored'").get()?.value || '[]');
  list.push(`${printId}:${digitalId}`);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('copyPairsIgnored', ?)").run(JSON.stringify([...new Set(list)]));
}

const FILL = ['subtitle', 'authors', 'series', 'series_index', 'description', 'publisher', 'published', 'isbn', 'language', 'pages', 'pages_source',
  'tags', 'abs_url', 'abs_id', 'plex_url', 'plex_key', 'audible_url', 'spine_color', 'spine_text_color', 'spine_image'];

/**
 * Merge `dropId` into `keepId`: files, audio links, shelf places and any blank details move over, then the
 * emptied record is removed. Returns the kept book.
 */
export function mergeBooks(keepId, dropId) {
  const db = getDb();
  keepId = Number(keepId); dropId = Number(dropId);
  if (keepId === dropId) throw new Error('Pick two different books');
  const keep = getBook(keepId), drop = getBook(dropId);
  if (!keep || !drop) throw new Error('Book not found');
  let oldCover = null;
  db.transaction(() => {
    db.prepare('UPDATE book_files SET book_id = ? WHERE book_id = ?').run(keepId, dropId);
    const fill = {};
    for (const f of FILL) if ((keep[f] === null || keep[f] === '') && drop[f] !== null && drop[f] !== '') fill[f] = drop[f];
    if (!keep.cover && drop.cover) { fill.cover = drop.cover; fill.cover_color = drop.cover_color; } else oldCover = drop.cover;
    let links = []; try { links = [...JSON.parse(keep.other_links || '[]'), ...JSON.parse(drop.other_links || '[]')]; } catch { /* */ }
    if (links.length) fill.other_links = JSON.stringify(links.filter((l, i, a) => a.findIndex(x => x.url === l.url) === i));
    if (Object.keys(fill).length) updateBook(keepId, fill);
    // Shelf places: keep the existing one where both are on a shelf, otherwise take over the dropped record's spot.
    for (const it of db.prepare("SELECT id, shelf_id FROM shelf_items WHERE book_id = ? AND kind = 'book'").all(dropId)) {
      const already = db.prepare("SELECT 1 FROM shelf_items WHERE shelf_id = ? AND book_id = ? AND kind = 'book'").get(it.shelf_id, keepId);
      if (already) db.prepare('DELETE FROM shelf_items WHERE id = ?').run(it.id);
      else db.prepare('UPDATE shelf_items SET book_id = ? WHERE id = ?').run(keepId, it.id);
    }
    db.prepare('UPDATE match_candidates SET suggested_book_id = ? WHERE suggested_book_id = ?').run(keepId, dropId);
    db.prepare('DELETE FROM books WHERE id = ?').run(dropId);
  })();
  if (oldCover) removeCoverIfUnused(db, oldCover);
  return getBook(keepId);
}
