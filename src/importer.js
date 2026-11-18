// Spreadsheet import (XLSX / CSV) — built around the "Bookcase Database" layout but tolerant of any sheet with a title column.
import XLSX from 'xlsx';
import { getDb } from './db.js';
import { createBook, updateBook, findExactMatch } from './books.js';
import { createShelf, getShelf, saveShelfItems, updateShelf } from './shelves.js';
import { normTitle, normAuthor } from './util.js';

const SYNONYMS = {
  title: ['book title', 'title', 'name'],
  authors: ['book author', 'author', 'authors', 'author(s)', 'writer'],
  location: ['shelf', 'location', 'shelf code', 'current shelf'],
  location_position: ['shelf position', 'position', 'shelf order'],
  plan_location: ['new shelf'],
  plan_position: ['new position'],
  series: ['series', 'series name'],
  series_index: ['series order', 'series index', 'series #', 'series number', 'book number', 'volume'],
  binding: ['binding', 'format', 'type'],
  disposition: ['disposition'],
  isbn: ['isbn', 'isbn13', 'isbn 13', 'isbn10'],
  description: ['description', 'summary', 'blurb'],
  tags: ['tags', 'genre', 'genres', 'categories', 'subjects'],
  publisher: ['publisher'],
  published: ['published', 'year', 'publication year', 'date published', 'publish date'],
  pages: ['pages', 'page count', 'number of pages'],
  notes: ['note', 'notes', 'comments'],
  room: ['room'],
  audible_url: ['audible', 'audible url', 'audible link'],
  plex_url: ['plex', 'plex url', 'plex link'],
  abs_url: ['audiobookshelf', 'audiobookshelf url', 'abs url', 'abs link'],
  cover_url: ['cover', 'cover url', 'image', 'cover image'],
  bookcase: ['bookcase', 'case'],
};

export function detectColumns(headers) {
  const map = {};
  const norm = headers.map(h => String(h ?? '').trim().toLowerCase());
  for (const [field, names] of Object.entries(SYNONYMS)) {
    const i = norm.findIndex(h => names.includes(h));
    if (i >= 0) map[field] = i;
  }
  return map;
}

export function readWorkbook(buffer, filename = '') {
  const isCsv = /\.(csv|tsv|txt)$/i.test(filename);
  return isCsv ? XLSX.read(buffer.toString('utf8'), { type: 'string' }) : XLSX.read(buffer, { type: 'buffer' });
}

function sheetRows(wb, name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
}

/** Map of shelf code -> { room, note } from a "Case Identifier" sheet, if the workbook has one. */
function readCases(wb) {
  for (const name of wb.SheetNames) {
    const rows = sheetRows(wb, name);
    if (!rows.length || !/case identifier/i.test(String(rows[0][0] || ''))) continue;
    const cases = {};
    for (const r of rows.slice(1)) {
      const code = String(r[0] || '').trim();
      if (!code) continue;
      const note = String(r[1] || '').trim();
      const room = String(r[2] || '').trim();
      const c = cases[code] || (cases[code] = { room, notes: [] });
      if (!c.room && room) c.room = room;
      if (note && !/^books$/i.test(note) && !/^(left|right)( side)?$/i.test(note) && !/^left to right/i.test(note)) c.notes.push(note);
    }
    for (const c of Object.values(cases)) c.note = [...new Set(c.notes)].join(' / ');
    return { sheet: name, cases };
  }
  return { sheet: null, cases: {} };
}

export function inspect(buffer, filename) {
  const wb = readWorkbook(buffer, filename);
  const { sheet: casesSheet, cases } = readCases(wb);
  const sheets = wb.SheetNames.map(name => {
    const rows = sheetRows(wb, name);
    const headers = (rows[0] || []).map(h => (h === null ? '' : String(h)));
    const cols = detectColumns(headers);
    const dataRows = rows.slice(1).filter(r => cols.title !== undefined && r[cols.title]);
    return {
      name, headers, columns: cols, rows: dataRows.length,
      usable: cols.title !== undefined,
      hasPlan: cols.plan_location !== undefined,
      hasDisposition: cols.disposition !== undefined,
      dispositions: cols.disposition !== undefined ? [...new Set(dataRows.map(r => r[cols.disposition]).filter(Boolean).map(String))] : [],
      sample: dataRows.slice(0, 5).map(r => ({ title: r[cols.title], authors: cols.authors !== undefined ? r[cols.authors] : '', location: cols.location !== undefined ? r[cols.location] : '' })),
    };
  });
  // Prefer a sheet literally called "Master Database", else the usable sheet with most rows.
  const usable = sheets.filter(s => s.usable);
  const preferred = usable.find(s => /^master database$/i.test(s.name)) || usable.sort((a, b) => b.rows - a.rows)[0];
  return { sheets, casesSheet, caseCount: Object.keys(cases).length, suggested: preferred?.name || null };
}

function cell(r, i) {
  if (i === undefined) return null;
  const v = r[i];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function normBinding(b) {
  if (!b) return null;
  const s = b.toLowerCase();
  if (s.startsWith('hard')) return 'Hardback';
  if (s.startsWith('paper') || s.startsWith('soft') || s === 'mass market') return 'Paperback';
  if (s.startsWith('ebook') || s.startsWith('e-book') || s === 'digital') return 'Ebook';
  if (s.startsWith('audio')) return 'Audiobook';
  return b.length < 24 ? b.charAt(0).toUpperCase() + b.slice(1) : 'Other';
}

export function caseOf(code) {
  if (!code) return 'Unshelved';
  if (/^loose$/i.test(code)) return 'Loose';
  const m = String(code).match(/^([A-Za-z]+)\d*/);
  return m ? m[1].toUpperCase() : String(code);
}

/** Natural sort for shelf codes: A3 < A4 < B1 < B10. */
export function codeCompare(a, b) {
  const pa = String(a || '').match(/^([A-Za-z]*)(\d*)(.*)$/), pb = String(b || '').match(/^([A-Za-z]*)(\d*)(.*)$/);
  return pa[1].localeCompare(pb[1]) || (Number(pa[2] || 0) - Number(pb[2] || 0)) || pa[3].localeCompare(pb[3]);
}

/**
 * opts: { sheet, usePlan, skipDispositions: string[], mergeWithEbooks, buildShelves, rebuildShelves }
 */
export function runImport(buffer, filename, opts = {}) {
  const db = getDb();
  const wb = readWorkbook(buffer, filename);
  const sheet = opts.sheet || inspect(buffer, filename).suggested;
  if (!sheet || !wb.Sheets[sheet]) throw new Error('Sheet not found');
  const rows = sheetRows(wb, sheet);
  const cols = detectColumns(rows[0] || []);
  if (cols.title === undefined) throw new Error('No title column found (looked for "Title" or "Book Title")');
  const { cases } = readCases(wb);
  const usePlan = !!opts.usePlan && cols.plan_location !== undefined;
  const skip = new Set((opts.skipDispositions || []).map(s => s.toLowerCase()));

  const result = { sheet, created: 0, updated: 0, merged: 0, skipped: 0, shelves: [], warnings: [] };
  const seen = new Map(); // occurrence counter for identical title/author/binding (distinct physical copies)
  const placed = []; // {bookId, code, pos, order}

  const tx = db.transaction(() => {
    rows.slice(1).forEach((r, idx) => {
      const title = cell(r, cols.title);
      if (!title) return;
      const disposition = cell(r, cols.disposition);
      if (disposition && skip.has(disposition.toLowerCase())) { result.skipped++; return; }
      const authors = cell(r, cols.authors);
      const binding = normBinding(cell(r, cols.binding));
      let code = cell(usePlan ? r : r, usePlan ? cols.plan_location : cols.location);
      let pos = cell(r, usePlan ? cols.plan_position : cols.location_position);
      if (usePlan && !code) { code = cell(r, cols.location); pos = cell(r, cols.location_position); }
      if (code && /^loose$/i.test(code)) code = 'Loose';
      const caseInfo = code ? cases[code] : null;
      const data = {
        title, authors,
        series: cell(r, cols.series),
        series_index: cell(r, cols.series_index),
        binding,
        location: code,
        location_position: pos !== null ? Math.round(Number(pos)) || null : null,
        room: cell(r, cols.room) || caseInfo?.room || null,
        isbn: cell(r, cols.isbn), description: cell(r, cols.description), tags: cell(r, cols.tags),
        publisher: cell(r, cols.publisher), published: cell(r, cols.published), pages: cell(r, cols.pages),
        audible_url: cell(r, cols.audible_url), plex_url: cell(r, cols.plex_url), abs_url: cell(r, cols.abs_url),
        notes: cell(r, cols.notes),
      };
      const k = `${normTitle(title, { keepSubtitle: true })}|${normAuthor(authors)}|${binding || ''}`;
      const n = (seen.get(k) || 0) + 1; seen.set(k, n);
      const sourceKey = `sheet:${k}|${n}`;

      const existing = db.prepare('SELECT * FROM books WHERE source_key = ?').get(sourceKey);
      let bookId;
      if (existing) {
        // The sheet owns location/series/binding; anything else only fills blanks.
        const upd = { location: data.location, location_position: data.location_position, room: data.room, binding: data.binding,
          series: data.series ?? existing.series, series_index: data.series_index ?? existing.series_index, title: data.title, authors: data.authors ?? existing.authors };
        for (const f of ['isbn', 'description', 'tags', 'publisher', 'published', 'pages', 'audible_url', 'plex_url', 'abs_url', 'notes']) {
          if (data[f] && !existing[f]) upd[f] = data[f];
        }
        updateBook(existing.id, upd);
        bookId = existing.id; result.updated++;
      } else {
        let target = null;
        if (opts.mergeWithEbooks !== false && n === 1) {
          const m = findExactMatch(title, authors);
          if (m && !m.source_key && !m.location) target = m;
        }
        if (target) {
          const upd = { source_key: sourceKey, binding: data.binding || target.binding, location: data.location, location_position: data.location_position, room: data.room };
          for (const f of ['series', 'series_index', 'isbn', 'description', 'tags', 'publisher', 'published', 'pages', 'audible_url', 'plex_url', 'abs_url']) if (data[f] && !target[f]) upd[f] = data[f];
          updateBook(target.id, upd);
          bookId = target.id; result.merged++;
        } else {
          bookId = createBook({ ...data, source: 'import', source_key: sourceKey }); result.created++;
        }
      }
      placed.push({ bookId, code: data.location, pos: data.location_position, order: idx });
    });

    const known = new Set(getDb().prepare('SELECT code FROM physical_shelves').all().map(r => r.code.toLowerCase()));
    rememberPhysicalShelves(placed.map(p => p.code), cases);
    // New shelves start "unmeasured" (width 0) so the reorganiser sizes them from their current contents.
    const unmeasured = getDb().prepare('UPDATE physical_shelves SET width_in = 0 WHERE code = ? COLLATE NOCASE');
    for (const c of new Set(placed.map(p => p.code).filter(Boolean))) if (!known.has(String(c).toLowerCase())) unmeasured.run(c);
    if (opts.buildShelves !== false) result.shelves = buildCaseShelves(placed, cases, { rebuild: opts.rebuildShelves !== false });
  });
  tx();
  return result;
}

/** Record every shelf code (with its room and note) so the reorganiser knows the physical shelves. */
export function rememberPhysicalShelves(codes, cases = {}) {
  const st = getDb().prepare(`INSERT INTO physical_shelves (code, room, note) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET room = COALESCE(excluded.room, physical_shelves.room), note = COALESCE(excluded.note, physical_shelves.note)`);
  for (const code of new Set(codes)) {
    if (!code || /^loose$/i.test(code)) continue;
    st.run(code, cases[code]?.room || null, cases[code]?.note || null);
  }
}

/** Shelf code -> { room, note } from the physical_shelves table. */
export function casesFromDb() {
  const db = getDb();
  // Fill in rooms and notes that pre-date the physical_shelves table: rooms from the books, notes from bookcase labels.
  db.prepare(`UPDATE physical_shelves SET room = (SELECT b.room FROM books b WHERE b.location = physical_shelves.code COLLATE NOCASE AND COALESCE(b.room,'') <> '' LIMIT 1)
    WHERE COALESCE(room, '') = ''`).run();
  const setNote = db.prepare("UPDATE physical_shelves SET note = ? WHERE code = ? COLLATE NOCASE AND COALESCE(note, '') = ''");
  for (const l of db.prepare("SELECT i.text FROM shelf_items i JOIN shelves s ON s.id = i.shelf_id WHERE s.generated_by LIKE 'import:%' AND i.kind = 'label'").all()) {
    const m = String(l.text || '').match(/^([A-Za-z]{1,3}\d{1,3})\s+·\s+(.+)$/);
    if (m) setNote.run(m[2].trim(), m[1]);
  }
  const out = {};
  for (const r of getDb().prepare('SELECT * FROM physical_shelves').all()) out[r.code] = { room: r.room, note: r.note };
  return out;
}

/** Rebuild the "Bookcase X" shelves from where books are recorded at home, keeping per-book spine/cover choices. */
export function rebuildCaseShelvesFromDb() {
  rememberPhysicalShelves(getDb().prepare("SELECT DISTINCT location FROM books WHERE COALESCE(location,'') <> ''").all().map(r => r.location), {});
  const books = getDb().prepare("SELECT id, location, location_position FROM books WHERE COALESCE(location, '') <> ''").all();
  return buildCaseShelves(books.map((b, i) => ({ bookId: b.id, code: b.location, pos: b.location_position, order: i })), casesFromDb(), { rebuild: true });
}

export function buildCaseShelves(placed, cases, { rebuild }) {
  const db = getDb();
  // Remember spine/cover choices made on the old bookcases so a rebuild doesn't undo them.
  const display = new Map(db.prepare(`SELECT i.book_id, i.display FROM shelf_items i JOIN shelves s ON s.id = i.shelf_id
    WHERE s.generated_by LIKE 'import:%' AND i.kind = 'book' AND i.display <> 'inherit'`).all().map(r => [r.book_id, r.display]));
  const groups = new Map();
  for (const p of placed) {
    const g = p.code ? caseOf(p.code) : 'Unshelved';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const out = [];
  const letters = [...groups.keys()].sort((a, b) => (a === 'Loose' || a === 'Unshelved' ? 1 : 0) - (b === 'Loose' || b === 'Unshelved' ? 1 : 0) || a.localeCompare(b));
  for (const letter of letters) {
    const list = groups.get(letter).sort((a, b) => codeCompare(a.code, b.code) || ((a.pos ?? 1e9) - (b.pos ?? 1e9)) || a.order - b.order);
    const rooms = [...new Set(list.map(p => cases[p.code]?.room).filter(Boolean))];
    const name = letter === 'Loose' ? 'Loose Books' : letter === 'Unshelved' ? 'Unshelved' : `Bookcase ${letter}`;
    const description = rooms.length ? rooms.join(' · ') : null;
    const items = [];
    let last = undefined;
    for (const p of list) {
      if (p.code !== last) {
        if (last !== undefined) items.push({ kind: 'break' });
        const note = cases[p.code]?.note;
        if (p.code && letter !== 'Loose') items.push({ kind: 'label', text: note ? `${p.code} · ${note}` : p.code });
        last = p.code;
      }
      items.push({ kind: 'book', book_id: p.bookId, display: display.get(p.bookId) || 'inherit' });
    }
    const gen = `import:${letter}`;
    const existing = getDb().prepare('SELECT id FROM shelves WHERE generated_by = ?').get(gen);
    let id;
    if (existing) {
      id = existing.id;
      if (!rebuild) { out.push({ id, name, rebuilt: false }); continue; }
      updateShelf(id, { description });
    } else {
      id = createShelf({ name, description, kind: 'manual', display: 'mixed', generated_by: gen });
    }
    saveShelfItems(id, items);
    out.push({ id, name, slug: getShelf(id).slug, books: list.length, rebuilt: true });
  }
  // Bookcases that no longer have any books (everything moved out) are emptied rather than left stale.
  if (rebuild) {
    const used = new Set(letters.map(l => `import:${l}`));
    for (const s of db.prepare("SELECT id, generated_by FROM shelves WHERE generated_by LIKE 'import:%' AND generated_by <> 'import:all'").all()) {
      if (!used.has(s.generated_by)) saveShelfItems(s.id, []);
    }
  }
  // A single "whole house" smart shelf, grouped by shelf code.
  if (!getDb().prepare("SELECT id FROM shelves WHERE generated_by = 'import:all'").get()) {
    createShelf({ name: 'The Whole House', description: 'Every physical book, shelf by shelf', kind: 'smart', sort: 'location',
      rules: { has: 'physical', groupBy: 'location' }, display: 'spine', generated_by: 'import:all' });
  }
  return out;
}
