// Series overview: colours, gaps in numbering, and where a series is spread around the house.
import { getDb } from './db.js';
import { invalidateSeriesColors, seriesColorMap, defaultSeriesColor } from './books.js';
import { readableTextOn } from './util.js';
import { createShelf } from './shelves.js';
import { codeCompare } from './importer.js';

export function listSeries() {
  const rows = getDb().prepare("SELECT id, title, authors, series, series_index, binding, location, location_position, cover, cover_color, hidden FROM books WHERE COALESCE(series,'') <> ''").all();
  const by = new Map();
  for (const b of rows) {
    const k = b.series.toLowerCase().trim();
    if (!by.has(k)) by.set(k, { name: b.series.trim(), books: [] });
    by.get(k).books.push(b);
  }
  const colors = seriesColorMap();
  const shelves = new Map(getDb().prepare("SELECT generated_by, id, slug FROM shelves WHERE generated_by LIKE 'series:%'").all().map(s => [s.generated_by.slice(7).toLowerCase(), s]));
  return [...by.entries()].map(([k, s]) => {
    s.books.sort((a, b) => (a.series_index ?? 1e9) - (b.series_index ?? 1e9));
    const nums = s.books.map(b => b.series_index).filter(n => Number.isInteger(n) && n > 0);
    const max = nums.length ? Math.max(...nums) : 0;
    const have = new Set(nums);
    const missing = []; for (let i = 1; i <= max && missing.length < 30; i++) if (!have.has(i)) missing.push(i);
    const locations = [...new Set(s.books.map(b => b.location).filter(Boolean))].sort(codeCompare);
    const custom = colors.get(k);
    const color = custom?.color || defaultSeriesColor(s.name);
    const first = s.books.find(b => b.cover_color);
    return {
      name: s.name, count: s.books.length, color, text_color: custom?.text_color || readableTextOn(color), custom: !!custom?.color,
      authors: [...new Set(s.books.map(b => b.authors).filter(Boolean))].slice(0, 3).join(' · '),
      missing, locations, scattered: locations.filter(l => !/^loose$/i.test(l)).length > 1,
      firstCoverColor: first?.cover_color || null,
      shelf: shelves.get(k) || null,
      books: s.books.map(b => ({ id: b.id, title: b.title, series_index: b.series_index, cover: b.cover ? `/covers/${b.cover}` : null, location: b.location, location_position: b.location_position })),
    };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function setSeriesColor(name, color, textColor) {
  const valid = c => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : null);
  getDb().prepare(`INSERT INTO series_info (name, color, text_color) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET color = excluded.color, text_color = excluded.text_color`).run(name.trim(), valid(color), valid(textColor));
  invalidateSeriesColors();
}

/** Rename a series on every book (also fixes "Dirk Pitt" vs "Dirk Pitt Adventures" style duplicates). */
export function renameSeries(from, to) {
  const n = getDb().prepare("UPDATE books SET series = ?, updated_at = datetime('now') WHERE series = ? COLLATE NOCASE").run(to.trim(), from.trim()).changes;
  invalidateSeriesColors();
  return n;
}

/**
 * mode 'combined': one smart bookcase holding every series of at least `minBooks`, each series on its own shelf.
 * mode 'each': one smart bookcase per series of at least `minBooks`.
 */
export function createSeriesShelves({ mode = 'combined', minBooks = 3, names = null } = {}) {
  if (mode === 'combined') {
    const id = createShelf({ name: minBooks > 1 ? `Series (${minBooks}+ books)` : 'Series', description: 'Every series, each on its own shelf, in reading order',
      kind: 'smart', sort: 'series', display: 'mixed', rules: { inSeries: true, minSeries: minBooks, groupBy: 'series' } });
    return [{ id }];
  }
  const out = [];
  const list = listSeries().filter(s => (names ? names.includes(s.name) : s.count >= minBooks) && !s.shelf);
  for (const s of list) {
    const id = createShelf({ name: s.name, description: s.authors || null, kind: 'smart', sort: 'series', display: 'mixed',
      rules: { seriesExact: s.name }, generated_by: `series:${s.name}` });
    out.push({ id, name: s.name });
  }
  return out;
}
