// Audiobookshelf + Plex: pull the catalogue, suggest matches, and let the admin confirm. Nothing here ever deletes a book.
import { getDb, getSetting } from './db.js';
import { createBook, updateBook, getBook } from './books.js';
import { matchKey, similarity, normAuthor, isbn13 } from './util.js';
import { saveCover, fetchImage } from './covers.js';

const trimSlash = s => String(s || '').replace(/\/+$/, '');

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
  return res.json();
}

// ───────────── Audiobookshelf ─────────────
function absConf() {
  const c = getSetting('abs') || {};
  return { url: trimSlash(c.url), publicUrl: trimSlash(c.publicUrl || c.url), token: c.token || '', libraryIds: (c.libraryIds || '').split(/[,\s]+/).filter(Boolean) };
}

function parseAbsSeries(md) {
  if (Array.isArray(md.series) && md.series.length) return { series: md.series[0].name, index: md.series[0].sequence ? Number(md.series[0].sequence) : null };
  if (md.seriesName) {
    const first = String(md.seriesName).split(',')[0].trim();
    const m = first.match(/^(.*?)\s*#\s*([\d.]+)$/);
    return m ? { series: m[1], index: Number(m[2]) } : { series: first, index: null };
  }
  return { series: null, index: null };
}

export async function fetchAbs() {
  const c = absConf();
  if (!c.url || !c.token) throw new Error('Audiobookshelf URL and API token are required');
  const H = { Authorization: `Bearer ${c.token}` };
  let libs = c.libraryIds;
  if (!libs.length) {
    const data = await getJson(`${c.url}/api/libraries`, H);
    libs = (data.libraries || []).filter(l => l.mediaType === 'book').map(l => l.id);
  }
  const out = [];
  for (const lib of libs) {
    let page = 0;
    for (;;) {
      const data = await getJson(`${c.url}/api/libraries/${lib}/items?limit=200&page=${page}`, H);
      for (const it of data.results || []) {
        const md = it.media?.metadata || {};
        const s = parseAbsSeries(md);
        out.push({
          external_id: it.id, title: md.title || md.titleIgnorePrefix || 'Untitled',
          authors: md.authorName || (md.authors || []).map(a => a.name).join('; '),
          series: s.series, series_index: s.index, description: md.description || null,
          url: `${c.publicUrl}/item/${it.id}`, cover_url: `${c.url}/api/items/${it.id}/cover`,
          payload: { isbn: md.isbn, published: md.publishedYear, publisher: md.publisher },
        });
      }
      page++;
      if (!data.results?.length || page * 200 >= (data.total || 0)) break;
    }
  }
  return out;
}

// ───────────── Plex ─────────────
function plexConf() {
  const c = getSetting('plex') || {};
  return { url: trimSlash(c.url), token: c.token || '', sectionIds: (c.sectionIds || '').split(/[,\s]+/).filter(Boolean), linkStyle: c.linkStyle || 'app' };
}

export async function fetchPlex() {
  const c = plexConf();
  if (!c.url || !c.token) throw new Error('Plex URL and token are required');
  const H = { 'X-Plex-Token': c.token };
  const ident = await getJson(`${c.url}/identity`, H);
  const machine = ident.MediaContainer?.machineIdentifier;
  let sections = c.sectionIds;
  if (!sections.length) {
    const data = await getJson(`${c.url}/library/sections`, H);
    sections = (data.MediaContainer?.Directory || []).filter(d => d.type === 'artist' && /audio ?book/i.test(d.title)).map(d => d.key);
    if (!sections.length) throw new Error('No Plex music library with "audiobook" in its name was found — enter the section id(s) explicitly.');
  }
  const out = [];
  for (const s of sections) {
    const data = await getJson(`${c.url}/library/sections/${s}/all?type=9`, H);
    for (const m of data.MediaContainer?.Metadata || []) {
      const key = `/library/metadata/${m.ratingKey}`;
      const url = c.linkStyle === 'local'
        ? `${c.url}/web/index.html#!/server/${machine}/details?key=${encodeURIComponent(key)}`
        : `https://app.plex.tv/desktop/#!/server/${machine}/details?key=${encodeURIComponent(key)}`;
      out.push({
        external_id: String(m.ratingKey), title: m.title, authors: m.parentTitle || '', series: null, series_index: null,
        description: m.summary || null, url, cover_url: m.thumb ? `${c.url}${m.thumb}?X-Plex-Token=${encodeURIComponent(c.token)}` : null,
        payload: { year: m.year },
      });
    }
  }
  return out;
}

// ───────────── Matching ─────────────
function suggest(item, books, byKey, byIsbn) {
  // Same ISBN (10- or 13-digit form) is the strongest evidence, as long as the authors don't disagree.
  const isbn = isbn13(item.payload?.isbn);
  const byI = isbn && byIsbn.get(isbn);
  if (byI && (!item.authors || !byI.authors || normAuthor(byI.authors).split(' ').some(t => t.length > 2 && normAuthor(item.authors).includes(t)))) {
    return { book: byI, confidence: 'exact', score: 1 };
  }
  const exact = byKey.get(matchKey(item.title, item.authors));
  if (exact) return { book: exact, confidence: 'exact', score: 1 };
  let best = null, bestScore = 0;
  const wantA = new Set(normAuthor(item.authors).split(' ').filter(t => t.length > 2));
  for (const b of books) {
    const authorHit = !wantA.size || normAuthor(b.authors).split(' ').some(t => wantA.has(t));
    if (!authorHit) continue;
    const s = similarity(item.title, b.title);
    if (s > bestScore) { bestScore = s; best = b; }
  }
  if (best && bestScore >= 0.6) return { book: best, confidence: 'fuzzy', score: Math.round(bestScore * 100) / 100 };
  return { book: null, confidence: 'none', score: 0 };
}

export async function refreshCandidates(provider) {
  const items = provider === 'abs' ? await fetchAbs() : await fetchPlex();
  const db = getDb();
  const books = db.prepare('SELECT id, title, authors, isbn, abs_id, plex_key FROM books').all();
  const byKey = new Map(books.map(b => [matchKey(b.title, b.authors), b]));
  const byIsbn = new Map(books.filter(b => isbn13(b.isbn)).map(b => [isbn13(b.isbn), b]));
  const linkedField = provider === 'abs' ? 'abs_id' : 'plex_key';
  const linked = new Map(books.filter(b => b[linkedField]).map(b => [b[linkedField], b.id]));
  const up = db.prepare(`INSERT INTO match_candidates (provider, external_id, title, authors, series, series_index, url, cover_url, description, suggested_book_id, confidence, score, status, payload)
    VALUES (@provider, @external_id, @title, @authors, @series, @series_index, @url, @cover_url, @description, @suggested_book_id, @confidence, @score, @status, @payload)
    ON CONFLICT(provider, external_id) DO UPDATE SET title=excluded.title, authors=excluded.authors, series=excluded.series, series_index=excluded.series_index,
      url=excluded.url, cover_url=excluded.cover_url, description=excluded.description, payload=excluded.payload,
      suggested_book_id=CASE WHEN match_candidates.status='pending' THEN excluded.suggested_book_id ELSE match_candidates.suggested_book_id END,
      confidence=CASE WHEN match_candidates.status='pending' THEN excluded.confidence ELSE match_candidates.confidence END,
      score=CASE WHEN match_candidates.status='pending' THEN excluded.score ELSE match_candidates.score END,
      status=CASE WHEN excluded.status='linked' THEN 'linked' ELSE match_candidates.status END`);
  const counts = { total: items.length, exact: 0, fuzzy: 0, none: 0, alreadyLinked: 0 };
  db.transaction(() => {
    for (const it of items) {
      const already = linked.get(it.external_id);
      const s = already ? { book: { id: already }, confidence: 'exact', score: 1 } : suggest(it, books, byKey, byIsbn);
      if (already) counts.alreadyLinked++; else counts[s.confidence]++;
      up.run({ provider, ...it, payload: JSON.stringify(it.payload || {}), suggested_book_id: s.book?.id ?? null, confidence: s.confidence, score: s.score, status: already ? 'linked' : 'pending' });
    }
  })();
  return counts;
}

export function listCandidates(provider, status = 'pending') {
  return getDb().prepare(`SELECT c.*, b.title AS book_title, b.authors AS book_authors, b.binding AS book_binding
    FROM match_candidates c LEFT JOIN books b ON b.id = c.suggested_book_id
    WHERE c.provider = ? AND (? = 'all' OR c.status = ?) ORDER BY CASE c.confidence WHEN 'exact' THEN 0 WHEN 'fuzzy' THEN 1 ELSE 2 END, c.authors, c.title`)
    .all(provider, status, status);
}

/** actions: [{ id, action: 'link'|'create'|'ignore'|'reset', bookId? }] */
export async function applyCandidates(provider, actions) {
  const db = getDb();
  const res = { linked: 0, created: 0, ignored: 0, errors: [] };
  const urlField = provider === 'abs' ? 'abs_url' : 'plex_url';
  const idField = provider === 'abs' ? 'abs_id' : 'plex_key';
  const token = provider === 'abs' ? absConf().token : null;
  for (const a of actions) {
    const c = db.prepare('SELECT * FROM match_candidates WHERE id = ? AND provider = ?').get(a.id, provider);
    if (!c) continue;
    try {
      if (a.action === 'link') {
        const bookId = Number(a.bookId || c.suggested_book_id);
        if (!getBook(bookId)) throw new Error(`book ${bookId} not found`);
        updateBook(bookId, { [urlField]: c.url, [idField]: c.external_id });
        db.prepare("UPDATE match_candidates SET status = 'linked', suggested_book_id = ? WHERE id = ?").run(bookId, c.id);
        res.linked++;
      } else if (a.action === 'create') {
        const p = JSON.parse(c.payload || '{}');
        const id = createBook({ title: c.title, authors: c.authors, series: c.series, series_index: c.series_index, description: c.description,
          isbn: p.isbn, published: p.published ? String(p.published) : (p.year ? String(p.year) : null), publisher: p.publisher,
          binding: 'Audiobook', [urlField]: c.url, [idField]: c.external_id, source: provider });
        if (c.cover_url) {
          try {
            const buf = await fetchImage(c.cover_url, token ? { Authorization: `Bearer ${token}` } : {});
            const saved = await saveCover(buf);
            if (saved) updateBook(id, { cover: saved.file, cover_color: saved.color });
          } catch (e) { res.errors.push(`${c.title}: cover — ${e.message}`); }
        }
        db.prepare("UPDATE match_candidates SET status = 'created', suggested_book_id = ? WHERE id = ?").run(id, c.id);
        res.created++;
      } else if (a.action === 'ignore') {
        db.prepare("UPDATE match_candidates SET status = 'ignored' WHERE id = ?").run(c.id); res.ignored++;
      } else if (a.action === 'reset') {
        db.prepare("UPDATE match_candidates SET status = 'pending' WHERE id = ?").run(c.id);
      }
    } catch (e) { res.errors.push(`${c.title}: ${e.message}`); }
  }
  return res;
}
