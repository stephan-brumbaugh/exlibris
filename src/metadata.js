// Online metadata lookup. Open Library first (no key needed), Google Books as a fallback.
import { similarity, normAuthor, sleep } from './util.js';
import { getBook, updateBook, queryBooks } from './books.js';
import { saveCover, fetchImage } from './covers.js';

const UA = { 'User-Agent': 'ExLibris/1.0 (self-hosted personal library)' };

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

function authorOk(want, got) {
  if (!want) return true;
  const a = normAuthor(want).split(' '), b = new Set(normAuthor(got).split(' '));
  return a.some(t => t.length > 2 && b.has(t));
}

/** Returns a list of candidates: {source, title, authors, year, pages, isbn, publisher, description?, coverUrl, score, workKey?} */
export async function searchCandidates({ title, authors, isbn }) {
  const out = [];
  const errors = [];
  try {
    const q = isbn ? `isbn=${encodeURIComponent(isbn)}` : `title=${encodeURIComponent(title || '')}${authors ? `&author=${encodeURIComponent(String(authors).split(/;|&/)[0])}` : ''}`;
    const data = await getJson(`https://openlibrary.org/search.json?${q}&limit=8&fields=key,title,subtitle,author_name,first_publish_year,number_of_pages_median,isbn,publisher,cover_i,subject,language`);
    for (const d of data.docs || []) {
      out.push({
        source: 'openlibrary', workKey: d.key, title: d.title, subtitle: d.subtitle, authors: (d.author_name || []).join('; '),
        year: d.first_publish_year, pages: d.number_of_pages_median, isbn: (d.isbn || []).find(i => i.length === 13) || (d.isbn || [])[0],
        publisher: (d.publisher || [])[0], tags: (d.subject || []).slice(0, 6).join(', '),
        coverUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
      });
    }
  } catch (e) { errors.push(`Open Library: ${e.message}`); }
  try {
    const q = isbn ? `isbn:${isbn}` : `intitle:${title || ''}${authors ? `+inauthor:${String(authors).split(/;|&/)[0]}` : ''}`;
    const data = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=6&printType=books`);
    for (const it of data.items || []) {
      const v = it.volumeInfo || {};
      const img = v.imageLinks?.extraLarge || v.imageLinks?.large || v.imageLinks?.medium || v.imageLinks?.thumbnail;
      out.push({
        source: 'google', title: v.title, subtitle: v.subtitle, authors: (v.authors || []).join('; '), year: (v.publishedDate || '').slice(0, 4),
        published: v.publishedDate, pages: v.pageCount, publisher: v.publisher, description: v.description,
        isbn: (v.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier,
        tags: (v.categories || []).join(', '),
        coverUrl: img ? img.replace(/^http:/, 'https:').replace('&edge=curl', '').replace(/zoom=\d/, 'zoom=1') : null,
      });
    }
  } catch (e) { errors.push(`Google Books: ${e.message}`); }
  if (!out.length && errors.length === 2) throw new Error(`Could not reach the book databases (${errors.join('; ')}). Check that the server has internet access.`);
  for (const c of out) {
    c.score = similarity(title || '', c.title || '') * (authorOk(authors, c.authors) ? 1 : 0.4) + (c.coverUrl ? 0.05 : 0);
  }
  return out.sort((a, b) => b.score - a.score);
}

async function workDescription(workKey) {
  try {
    const w = await getJson(`https://openlibrary.org${workKey}.json`);
    const d = typeof w.description === 'string' ? w.description : w.description?.value;
    return d ? d.replace(/\r/g, '').trim() : null;
  } catch { return null; }
}

/**
 * Fill blank fields on a book from the best candidate. Never overwrites existing values unless replaceCover is set.
 * Returns { applied: string[], candidate } or { applied: [] } when nothing confident was found.
 */
/**
 * Page count of the most commonly published hardcover edition of a work, falling back to paperback,
 * then to Open Library's median across all editions.
 */
export async function editionPages(workKey, fallbackMedian = null) {
  if (workKey) {
    try {
      const data = await getJson(`https://openlibrary.org${workKey}/editions.json?limit=300`);
      const eds = (data.entries || []).filter(e => Number(e.number_of_pages) > 20);
      const mode = list => {
        if (!list.length) return null;
        // Group page counts within ~3% of each other so 352 and 355 count as the same printing.
        const counts = new Map();
        for (const e of list) { const k = Math.round(Number(e.number_of_pages) / 8) * 8; counts.set(k, [...(counts.get(k) || []), Number(e.number_of_pages)]); }
        const best = [...counts.values()].sort((a, b) => b.length - a.length || b[0] - a[0])[0];
        return best.sort((a, b) => a - b)[Math.floor(best.length / 2)];
      };
      const fmt = e => String(e.physical_format || '').toLowerCase();
      const hard = mode(eds.filter(e => /hard|cloth|library binding/.test(fmt(e))));
      if (hard) return { pages: hard, source: 'hardcover' };
      const paper = mode(eds.filter(e => /paper|mass market|soft/.test(fmt(e))));
      if (paper) return { pages: paper, source: 'paperback' };
    } catch (e) { console.warn('editions lookup failed:', e.message); }
  }
  return fallbackMedian ? { pages: fallbackMedian, source: 'median' } : null;
}

export async function enrichBook(id, { replaceCover = false, minScore = 0.8 } = {}) {
  const b = getBook(id);
  if (!b) return { applied: [] };
  updateBook(id, { meta_checked_at: new Date().toISOString() });
  const cands = await searchCandidates({ title: b.title, authors: b.authors, isbn: b.isbn });
  const best = cands.find(c => c.score >= minScore);
  if (!best) return { applied: [], reason: cands.length ? 'no confident match' : 'no results' };
  return applyCandidate(id, best, { replaceCover, onlyBlank: true });
}

export async function applyCandidate(id, c, { replaceCover = false, onlyBlank = true } = {}) {
  const b = getBook(id);
  const fill = {}, applied = [];
  const set = (k, v) => { if (v === undefined || v === null || v === '') return; if (onlyBlank && b[k] !== null && b[k] !== '' && b[k] !== undefined) return; fill[k] = v; applied.push(k); };
  if (!b.authors) set('authors', c.authors);
  if (!b.pages || !onlyBlank) {
    const ep = c.source === 'openlibrary' ? await editionPages(c.workKey, c.pages) : (c.pages ? { pages: c.pages, source: 'google' } : null);
    if (ep) { fill.pages = ep.pages; fill.pages_source = ep.source; applied.push(`pages (${ep.source})`); }
  }
  set('isbn', c.isbn);
  set('publisher', c.publisher);
  set('published', c.published || (c.year ? String(c.year) : null));
  set('tags', c.tags);
  set('subtitle', c.subtitle);
  let desc = c.description;
  if (!desc && c.workKey && !b.description) desc = await workDescription(c.workKey);
  set('description', desc ? desc.replace(/<[^>]+>/g, '') : null);
  if (c.coverUrl && (!b.cover || replaceCover)) {
    try {
      const saved = await saveCover(await fetchImage(c.coverUrl));
      if (saved) { fill.cover = saved.file; fill.cover_color = saved.color; applied.push('cover'); }
    } catch (e) { console.warn('cover download failed:', e.message); }
  }
  if (Object.keys(fill).length) updateBook(id, fill);
  return { applied, candidate: { title: c.title, authors: c.authors, source: c.source } };
}

/** Background job: enrich many books one at a time (polite to the free APIs). */
export async function enrichMany(ids, job, opts = {}) {
  job.total(ids.length);
  const res = { updated: 0, skipped: 0, failed: 0 };
  for (const id of ids) {
    if (job.cancelled()) break;
    const b = getBook(id);
    try {
      const r = await enrichBook(id, opts);
      if (r.applied.length) { res.updated++; job.log(`✓ ${b.title}: ${r.applied.join(', ')}`); }
      else { res.skipped++; job.log(`– ${b.title}: ${r.reason || 'nothing new'}`); }
    } catch (e) { res.failed++; job.log(`✗ ${b?.title}: ${e.message}`); }
    job.tick(b?.title);
    await sleep(opts.delayMs ?? 1100);
  }
  return res;
}

/** Books missing a cover, description or page count. `uncheckedOnly` skips books already looked up once. */
export function booksNeedingMetadata({ uncheckedOnly = false } = {}) {
  return queryBooks({}, { includeHidden: true })
    .filter(b => !b.cover || !b.description || !b.pages)
    .filter(b => !uncheckedOnly || !b.meta_checked_at)
    .map(b => b.id);
}
