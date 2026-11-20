import { el, renderShelf, renderItem, fillRows, generatedCover, fmtIndex, surname, scaledBookcase } from './shelf-render.js';
import { themeStyle, themeClasses } from './themes.js';

const data = JSON.parse(document.getElementById('page-data').textContent);

function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

/* ───────────── Bookcase ───────────── */
export function bookcase({ shelf, theme, items, viewOverride = null, rowH = null, crown = true }) {
  // Small previews (home page) always flow to fit; full bookcases keep their arrangement and scale instead.
  const t = { ...theme, ...(rowH ? { rowHeight: rowH, layout: 'fluid' } : {}) };
  const fixed = t.layout !== 'fluid';
  // Phones, flowing layout only: shorter shelves so more than a handful of spines fit across.
  if (!rowH && !fixed && window.innerWidth < 640) t.rowHeight = Math.max(150, Math.round((t.rowHeight || 250) * 0.72));
  const rows = el('div', { class: 'bc-rows' });
  const root = el('section', { class: themeClasses(t), style: themeStyle(t), 'aria-label': shelf.name },
    crown ? el('header', { class: 'bc-crown' }, el('div', { class: 'bc-nameplate' }, shelf.name), shelf.description ? el('p', { class: 'bc-desc' }, shelf.description) : null) : null,
    rows);
  renderShelf(rows, items, { shelfDisplay: shelf.display, viewOverride, rowH: t.rowHeight });
  if (!fixed) return { root, rows, rowH: t.rowHeight, fit: () => 1 };
  const sc = scaledBookcase(root);
  return { root: sc.sizer, rows, rowH: t.rowHeight, fit: sc.fit };
}

/* ───────────── Spine tooltip ───────────── */
let tip;
function setupTooltip(container, books) {
  if (matchMedia('(hover: none)').matches) return;
  tip = tip || document.body.appendChild(el('div', { class: 'spine-tip', role: 'presentation' }));
  container.addEventListener('mouseover', e => {
    const a = e.target.closest('.item.book.is-spine');
    if (!a) return;
    const b = books.get(Number(a.dataset.bookId));
    if (!b) return;
    a.removeAttribute('title');
    tip.replaceChildren(
      b.cover ? el('img', { src: b.cover, alt: '' }) : generatedCover(b),
      el('div', {}, el('div', { class: 'tt-title' }, b.title), el('div', { class: 'tt-meta' }, [b.authors, b.series ? `${b.series}${b.series_index ? ' #' + fmtIndex(b.series_index) : ''}` : null].filter(Boolean).join(' · '))));
    const r = a.getBoundingClientRect();
    const tw = 300;
    tip.style.left = `${Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - 60))}px`;
    tip.style.top = `${Math.max(8, r.top - 104)}px`;
    tip.classList.add('show');
  });
  container.addEventListener('mouseout', e => { if (e.target.closest('.item.book')) tip.classList.remove('show'); });
  window.addEventListener('scroll', () => tip.classList.remove('show'), { passive: true });
}

/* ───────────── Book detail ───────────── */
/** Which copies you own — the same card appears from a home bookcase or a digital one. */
function ownedBadges(b) {
  const print = !!b.location || ['Hardback', 'Paperback', 'Other'].includes(b.binding);
  const digital = (b.files || []).length > 0 || b.digitalCount > 0;
  const audio = (b.links || []).some(l => ['abs', 'plex', 'audible'].includes(l.kind));
  const tags = [print && `Print copy at home${b.binding && b.binding !== 'Other' ? ` (${b.binding.toLowerCase()})` : ''}`, digital && 'Digital copy', audio && 'Audiobook'].filter(Boolean);
  return tags.length ? el('p', { class: 'bk-owned' }, ...tags.map(t => el('span', {}, t))) : null;
}

function bookCard(b, { modal = false } = {}) {
  const searchLink = (q, label) => el('a', { href: `/search?q=${encodeURIComponent(q)}` }, label || q);
  const authors = (b.authors || '').split(/\s*;\s*/).filter(Boolean);
  const actions = el('div', { class: 'bk-actions' });
  const files = [...(b.files || [])].sort((x, y) => ['epub', 'pdf'].indexOf(y.format) - ['epub', 'pdf'].indexOf(x.format));
  files.forEach((f, i) => {
    actions.append(el('a', { class: `btn-pub${i === 0 ? ' primary' : ''}`, href: `/files/${f.id}/download`, download: '' },
      `Download ${f.format.toUpperCase()}`, el('small', {}, fmtSize(f.size))));
    if (f.format === 'pdf') actions.append(el('a', { class: 'btn-pub', href: `/files/${f.id}/read`, target: '_blank', rel: 'noopener' }, 'Read PDF in browser'));
  });
  for (const l of b.links || []) actions.append(el('a', { class: `btn-pub ${l.kind}`, href: l.url, target: '_blank', rel: 'noopener' }, `${l.kind === 'link' ? '' : '▶ '}${l.label}`));

  const where = b.location ? el('div', { class: 'bk-where' }, '📍 On the shelf at home: ',
    el('strong', {}, [b.room, `Shelf ${b.location}`].filter(Boolean).join(' · ')),
    b.location_position ? ` — book ${b.location_position} from the left` : '', b.binding ? ` (${b.binding.toLowerCase()})` : '') : null;

  const desc = b.description ? el('div', { class: 'bk-desc' }, b.description) : null;
  let more = null;
  if (desc && b.description.length > 700) {
    desc.classList.add('clamped');
    more = el('button', { class: 'bk-more', type: 'button', onclick: () => { desc.classList.remove('clamped'); more.remove(); } }, 'Read more');
  }
  const facts = [['Published', b.published], ['Publisher', b.publisher], ['Pages', b.pages], ['ISBN', b.isbn], ['Format', b.binding], ['Language', b.language]]
    .filter(([, v]) => v);
  const card = el('article', { class: 'book-card', role: modal ? 'dialog' : null, 'aria-modal': modal ? 'true' : null, 'aria-labelledby': 'bk-title' },
    modal ? el('button', { class: 'bk-close', type: 'button', 'aria-label': 'Close', onclick: closeModal }, '×') : null,
    el('div', { class: 'bk-cover' }, b.cover ? el('img', { src: b.cover, alt: `Cover of ${b.title}` }) : generatedCover(b)),
    el('div', { class: 'bk-body' },
      el('h2', { id: 'bk-title' }, b.title),
      b.subtitle ? el('p', { class: 'bk-sub' }, b.subtitle) : null,
      authors.length ? el('p', { class: 'bk-author' }, 'by ', ...authors.flatMap((a, i) => [i ? ', ' : '', searchLink(a)])) : null,
      b.series ? el('p', { class: 'bk-series' }, b.series_index ? `Book ${fmtIndex(b.series_index)} of ` : 'Part of ', searchLink(b.series)) : null,
      ownedBadges(b),
      actions.childElementCount ? actions : null,
      where,
      desc, more,
      facts.length ? el('dl', { class: 'bk-facts' }, ...facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])) : null,
      b.tags?.length ? el('div', { class: 'bk-tags' }, ...b.tags.map(t => searchLink(t))) : null,
      b.shelves?.length ? el('p', { class: 'bk-shelves' }, 'On shelves: ', ...b.shelves.flatMap((s, i) => [i ? ', ' : '', el('a', { href: `/shelf/${s.slug}` }, s.name)])) : null,
    ));
  return card;
}

let modalEl = null, returnFocus = null, pushed = false;
let bookOrder = [];            // the order books appear on the current page, for Previous / Next
export function setBookOrder(ids) { bookOrder = ids; }

function navFor(id) {
  const i = bookOrder.indexOf(id);
  if (i < 0 || bookOrder.length < 2) return null;
  return { prev: i > 0 ? bookOrder[i - 1] : null, next: i < bookOrder.length - 1 ? bookOrder[i + 1] : null, pos: i + 1, total: bookOrder.length };
}

async function openBook(id, push = true) {
  try {
    const res = await fetch(`/api/books/${id}`);
    if (!res.ok) throw new Error();
    const b = await res.json();
    const wasOpen = !!modalEl;
    if (modalEl) { modalEl.remove(); modalEl = null; }
    if (!wasOpen) returnFocus = document.activeElement;
    const nav = navFor(id);
    const card = bookCard(b, { modal: true });
    if (nav) {
      const go = to => () => { if (to) openBook(to, 'replace'); };
      card.append(el('div', { class: 'bk-nav' },
        el('button', { type: 'button', class: 'bk-prev', disabled: !nav.prev, onclick: go(nav.prev), 'aria-label': 'Previous book' }, '‹ Previous'),
        el('span', {}, `${nav.pos} of ${nav.total}`),
        el('button', { type: 'button', class: 'bk-next', disabled: !nav.next, onclick: go(nav.next), 'aria-label': 'Next book' }, 'Next ›')));
    }
    modalEl = el('div', { class: 'modal-backdrop', onclick: e => { if (e.target === modalEl) closeModal(); } }, card);
    modalEl.dataset.bookId = id;
    document.body.append(modalEl);
    document.body.style.overflow = 'hidden';
    modalEl.querySelector('.bk-close').focus();
    if (push === 'replace') history.replaceState({ book: id }, '', `/book/${id}`);
    else if (push) { history.pushState({ book: id }, '', `/book/${id}`); pushed = true; }
    document.title = `${b.title} · ${data.site.title}`;
    // Keep the shelf in step with the card, so closing it lands on the book you were last looking at.
    document.querySelector(`.item.book[data-book-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  } catch { location.href = `/book/${id}`; }
}
function closeModal(pop = true) {
  if (!modalEl) return;
  modalEl.remove(); modalEl = null; document.body.style.overflow = '';
  if (pop && pushed) { pushed = false; history.back(); }
  returnFocus?.focus?.();
}
const baseTitle = document.title;
window.addEventListener('popstate', () => { if (modalEl) { pushed = false; closeModal(false); document.title = baseTitle; } });
document.addEventListener('keydown', e => {
  if (lightboxEl && e.key === 'Escape') { lightboxEl.remove(); lightboxEl = null; return; }
  if (!modalEl) return;
  if (e.key === 'Escape') { closeModal(); return; }
  const nav = navFor(Number(modalEl.dataset.bookId));
  if (nav && e.key === 'ArrowRight' && nav.next) openBook(nav.next, 'replace');
  if (nav && e.key === 'ArrowLeft' && nav.prev) openBook(nav.prev, 'replace');
});

/* Full-size view of a decoration */
let lightboxEl = null;
function showPicture(src, alt) {
  lightboxEl?.remove();
  lightboxEl = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': alt || 'Picture', onclick: () => { lightboxEl.remove(); lightboxEl = null; } },
    el('img', { src, alt: alt || '' }), el('button', { type: 'button', 'aria-label': 'Close' }, '×'));
  document.body.append(lightboxEl);
}

function interceptBookLinks(container) {
  container.addEventListener('click', e => {
    const pic = e.target.closest('.decor[data-media]');
    if (pic) { showPicture(pic.dataset.media, pic.querySelector('img')?.alt); return; }
    const a = e.target.closest('a.item.book');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    tip?.classList.remove('show');
    openBook(Number(a.dataset.bookId));
  });
  container.addEventListener('keydown', e => {
    const pic = e.target.closest?.('.decor[data-media]');
    if (pic && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showPicture(pic.dataset.media, pic.querySelector('img')?.alt); }
  });
}

/* ───────────── Pages ───────────── */
function shelfPage() {
  const tools = document.getElementById('tools');
  const host = document.getElementById('bookcase');
  const books = new Map(data.items.filter(i => i.kind === 'book').map(i => [i.book.id, i.book]));
  const params = new URLSearchParams(location.search);
  let view = params.get('view') || 'arranged';
  let current;
  const draw = () => {
    current = bookcase({ shelf: data.shelf, theme: data.theme, items: data.items, viewOverride: view === 'arranged' ? null : view });
    host.replaceChildren(current.root);
    const s1 = current.fit();
    fillRows(current.rows, current.rowH, 3, s1);
    current.fit();
    applyFilter();
    setBookOrder([...current.rows.querySelectorAll('.item.book')].map(n => Number(n.dataset.bookId)));
  };
  const viewBtns = [['arranged', 'As arranged'], ['spine', 'Spines'], ['cover', 'Covers']].map(([v, label]) =>
    el('button', { type: 'button', 'aria-pressed': String(view === v), onclick: () => {
      view = v; viewBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
      const u = new URL(location.href); v === 'arranged' ? u.searchParams.delete('view') : u.searchParams.set('view', v); history.replaceState(null, '', u);
      draw();
    }, dataset: { v } }, label));
  const filter = el('input', { type: 'search', placeholder: 'Find on this shelf…', 'aria-label': 'Find on this shelf (Enter opens the first match)', oninput: () => applyFilter(),
    onkeydown: e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = current.rows.querySelector('.item.book:not(.dim)');
      if (first && filter.value.trim()) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => openBook(Number(first.dataset.bookId)), 350); }
    } });
  const note = el('span', { class: 'count-note' }, `${books.size} book${books.size === 1 ? '' : 's'}`);
  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    let hits = 0, first = null;
    current.rows.querySelectorAll('.item.book').forEach(n => {
      const b = books.get(Number(n.dataset.bookId));
      const hit = !q || `${b.title} ${b.authors || ''} ${b.series || ''}`.toLowerCase().includes(q);
      n.classList.toggle('dim', !hit);
      if (hit) { hits++; first = first || n; }
    });
    note.textContent = q ? `${hits} match${hits === 1 ? '' : 'es'}` : `${books.size} book${books.size === 1 ? '' : 's'}`;
    if (q && first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  const jump = data.shelves?.length > 1 ? el('select', { 'aria-label': 'Go to another shelf', onchange: e => { location.href = `/shelf/${e.target.value}`; } },
    ...data.shelves.map(s => el('option', { value: s.slug, selected: s.slug === data.shelf.slug }, s.name))) : null;
  tools.append(
    el('div', { class: 'tool-group' }, data.page === 'search' ? null : el('div', { class: 'seg', role: 'group', 'aria-label': 'Show books as' }, ...viewBtns), note),
    el('div', { class: 'tool-group' }, data.page === 'search' ? null : filter, jump));
  draw();
  interceptBookLinks(host);
  setupTooltip(host, books);
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { const sc = current.fit(); fillRows(current.rows, current.rowH, 3, sc); current.fit(); }, 150); });
}

function homePage() {
  const { shelves, counts, recent } = data;
  const stats = document.getElementById('stats');
  const parts = [`${counts.books || 0} books`];
  if (counts.physical) parts.push(`${counts.physical} on shelves at home`);
  if (counts.digital) parts.push(`${counts.digital} to download`);
  if (counts.audio) parts.push(`${counts.audio} to listen to`);
  stats.replaceChildren(...parts.map(p => el('span', {}, p)));
  const hall = document.getElementById('hall');
  if (!shelves.length) hall.append(el('p', { class: 'hall-empty' }, 'No shelves yet. Sign in to the admin area to build your first bookcase.'));
  const groups = [
    ['physical', 'At home', 'The real bookcases around the house'],
    ['digital', 'Digital library', 'E-books, PDFs and audiobooks'],
    ['any', 'Other shelves', null],
  ];
  for (const [key, title, sub] of groups) {
    const list = shelves.filter(s => (s.shelf.collection || 'any') === key);
    if (!list.length) continue;
    const grid = el('section', { class: 'hall', 'aria-label': title });
    for (const s of list) {
      const bc = bookcase({ shelf: s.shelf, theme: s.theme, items: s.items, rowH: 150 });
      grid.append(el('a', { class: 'hall-card', href: `/shelf/${s.shelf.slug}`, 'aria-label': `${s.shelf.name}, ${s.total} books` }, bc.root,
        el('div', { class: 'hall-meta' }, el('span', {}, `${s.total} book${s.total === 1 ? '' : 's'}`), el('span', {}, 'Browse →'))));
    }
    const showHeads = shelves.some(s => (s.shelf.collection || 'any') !== key);
    hall.append(el('div', { class: 'hall-group' }, showHeads ? el('h2', { class: 'section-title' }, title) : null, showHeads && sub ? el('p', { class: 'hall-sub' }, sub) : null, grid));
  }
  if (recent?.length) {
    const sec = document.getElementById('recent');
    const items = recent.map(b => ({ id: `r${b.id}`, kind: 'book', display: 'cover', book: b }));
    const bc = bookcase({ shelf: { name: 'Recently added', display: 'cover' }, theme: data.theme, items, rowH: 200, crown: false });
    bc.rows.style.minHeight = '200px'; bc.rows.style.maxHeight = '200px'; bc.rows.style.overflow = 'hidden'; bc.rows.style.justifyContent = 'center';
    sec.append(el('h2', { class: 'section-title' }, 'Recently added'), bc.root);
    interceptBookLinks(sec);
  }
}

function bookPage() {
  document.getElementById('book-root').append(bookCard(data.book));
}

if (data.page === 'shelf' || data.page === 'search') shelfPage();
else if (data.page === 'home') homePage();
else if (data.page === 'book') bookPage();
