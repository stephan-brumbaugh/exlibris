import { api, el, guard, toast, pageData, debounce, app, fmtIndex } from './common.js';
import { renderItem, surname } from '/js/shelf-render.js';
import { resolveTheme, themeStyle, themeClasses, PRESETS } from '/js/themes.js';
import Sortable from '/vendor/sortable.js';

const root = app();
const shelfId = pageData.id;
let { shelf, items: serverItems, site } = await api('GET', `/shelves/${shelfId}`);
let media = await api('GET', '/media');
let seq = 0;
const toLocal = it => ({ ...it, key: `k${++seq}`, book_id: it.book?.id, media_id: it.media?.id });
let items = serverItems.map(toLocal);
const selected = new Set();
let lastClicked = null;
let tab = shelf.kind === 'smart' ? 'settings' : 'add';
const manual = () => shelf.kind === 'manual';

/* ───────── Saving ───────── */
const saveState = el('span', { class: 'save-state' }, 'All changes saved');
let pending = 0;
function setState(text, dirty = false) { saveState.textContent = text; saveState.classList.toggle('dirty', dirty); }
const saveItems = debounce(guard(async () => {
  pending++; setState('Saving…', true);
  try {
    await api('PUT', `/shelves/${shelfId}/items`, { items: items.map(i => ({ kind: i.kind, book_id: i.book_id, media_id: i.media_id, display: i.display, size: i.size, text: i.text, link: i.link })) });
    setState('All changes saved');
  } finally { pending--; }
}), 600);
async function saveNow() {
  await api('PUT', `/shelves/${shelfId}/items`, { items: items.map(i => ({ kind: i.kind, book_id: i.book_id, media_id: i.media_id, display: i.display, size: i.size, text: i.text, link: i.link })) });
  setState('All changes saved');
}
const saveShelf = debounce(guard(async patch => {
  setState('Saving…', true);
  const r = await api('PATCH', `/shelves/${shelfId}`, patch);
  shelf = r.shelf; setState('All changes saved');
}), 500);
let shelfPatch = {};
function patchShelf(p, { redraw = true } = {}) {
  Object.assign(shelf, p); Object.assign(shelfPatch, p);
  setState('Unsaved changes', true);
  const send = shelfPatch; shelfPatch = {};
  saveShelf(send);
  if (redraw) drawStage();
}
const changed = () => { setState('Unsaved changes', true); saveItems(); };
window.addEventListener('beforeunload', e => { if (saveState.classList.contains('dirty')) { e.preventDefault(); e.returnValue = ''; } });

/* ───────── Stage ───────── */
const stage = el('div', { class: 'builder-stage' });
let rowsEl, sortable;
function theme() { return resolveTheme(site.theme || {}, shelf.theme || {}); }

function drawStage() {
  const t = theme();
  rowsEl = el('div', { class: 'bc-rows' });
  const bc = el('section', { class: themeClasses(t), style: themeStyle(t) },
    el('header', { class: 'bc-crown' }, el('div', { class: 'bc-nameplate' }, shelf.name), shelf.description ? el('p', { class: 'bc-desc' }, shelf.description) : null),
    rowsEl);
  for (const it of items) {
    const n = renderItem({ ...it, id: it.key }, { shelfDisplay: shelf.display, rowH: t.rowHeight, editable: true });
    if (selected.has(it.key)) n.classList.add('sel');
    rowsEl.append(n);
  }
  if (!items.length) rowsEl.append(el('div', { class: 'item', style: { color: 'var(--ink)', opacity: .7, padding: '0 20px 40px', fontFamily: 'var(--font)' } },
    manual() ? 'This shelf is empty — add books from the panel on the right →' : 'No books match these rules yet.'));
  const page = el('div', { style: `background:${t.page};padding:18px;border-radius:12px;${t.wallpaper ? `background-image:url(/media/${t.wallpaper});background-size:cover;` : ''}` }, bc);
  stage.replaceChildren(page);
  const usable = stage.getBoundingClientRect().width;
  rowsEl.style.minHeight = `${Math.max(3, Math.ceil(rowsEl.scrollHeight / t.rowHeight)) * t.rowHeight}px`;
  sortable?.destroy();
  if (manual()) {
    sortable = Sortable.create(rowsEl, {
      animation: 150, draggable: '[data-item-id]', ghostClass: 'sortable-ghost', delay: 0, forceFallback: false,
      onEnd: e => {
        const order = [...rowsEl.querySelectorAll(':scope > [data-item-id]')].map(n => n.dataset.itemId);
        const byKey = new Map(items.map(i => [i.key, i]));
        let next = order.map(k => byKey.get(k)).filter(Boolean);
        const moved = e.item.dataset.itemId;
        if (selected.has(moved) && selected.size > 1) {
          // Bring the rest of the selection along, keeping their relative order.
          const group = items.filter(i => selected.has(i.key));
          next = next.filter(i => !selected.has(i.key) || i.key === moved);
          const at = next.findIndex(i => i.key === moved);
          next.splice(at, 1, ...group);
        }
        items = next; changed(); drawStage();
      },
    });
  }
  void usable;
}

stage.addEventListener('click', e => {
  const n = e.target.closest('[data-item-id]');
  if (!n || !manual()) return;
  const key = n.dataset.itemId;
  if (e.shiftKey && lastClicked) {
    const a = items.findIndex(i => i.key === lastClicked), b = items.findIndex(i => i.key === key);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) selected.add(items[i].key);
  } else if (e.metaKey || e.ctrlKey) {
    selected.has(key) ? selected.delete(key) : selected.add(key);
  } else { selected.clear(); selected.add(key); }
  lastClicked = key;
  tab = 'selected';
  drawStage(); drawInspector();
});
stage.addEventListener('dblclick', e => {
  const n = e.target.closest('[data-kind="book"]');
  if (!n) return;
  const it = items.find(i => i.key === n.dataset.itemId);
  if (it?.book_id) window.open(`/admin/books/${it.book_id}`, '_blank');
});
document.addEventListener('keydown', e => {
  if (!manual() || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) { e.preventDefault(); removeSelected(); }
  else if (e.key === 'Escape') { selected.clear(); drawStage(); drawInspector(); }
  else if (e.key.toLowerCase() === 's' && selected.size && !e.metaKey && !e.ctrlKey) setDisplay('spine');
  else if (e.key.toLowerCase() === 'c' && selected.size && !e.metaKey && !e.ctrlKey) setDisplay('cover');
  else if (e.key === 'Enter' && selected.size) insert([{ kind: 'break' }]);
});

function insertIndex() {
  if (!selected.size) return items.length;
  let last = -1; items.forEach((it, i) => { if (selected.has(it.key)) last = i; });
  return last + 1;
}
function insert(newItems, { select = true } = {}) {
  const locals = newItems.map(n => ({ display: 'inherit', ...n, key: `k${++seq}` }));
  items.splice(insertIndex(), 0, ...locals);
  if (select) { selected.clear(); locals.forEach(l => selected.add(l.key)); lastClicked = locals.at(-1)?.key; }
  changed(); drawStage(); drawInspector();
}
function removeSelected() {
  items = items.filter(i => !selected.has(i.key)); selected.clear(); changed(); drawStage(); drawInspector();
}
function setDisplay(d) {
  items.forEach(i => { if (selected.has(i.key) && i.kind === 'book') i.display = d; }); changed(); drawStage(); drawInspector();
}

/* ───────── Sorting ───────── */
function hue(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [999, 0];
  const n = parseInt(m[1], 16); const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (d < 0.08) return [400 + (1 - l) * 100, l]; // greys and near-whites go to the end, light to dark
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, l];
}
const codeCmp = (a, b) => String(a || '~').localeCompare(String(b || '~'), undefined, { numeric: true });
const SORTERS = {
  author: (a, b) => surname(a.authors || '~').localeCompare(surname(b.authors || '~')) || (a.authors || '').localeCompare(b.authors || '') || (a.series || '~').localeCompare(b.series || '~') || (a.series_index ?? 1e9) - (b.series_index ?? 1e9) || a.title.localeCompare(b.title),
  series: (a, b) => (a.series ? 0 : 1) - (b.series ? 0 : 1) || (a.series || '').localeCompare(b.series || '') || (a.series_index ?? 1e9) - (b.series_index ?? 1e9) || SORTERS.author(a, b),
  title: (a, b) => a.title.replace(/^(the|a|an)\s+/i, '').localeCompare(b.title.replace(/^(the|a|an)\s+/i, '')),
  colour: (a, b) => { const [ha, la] = hue(a.spine?.color), [hb, lb] = hue(b.spine?.color); return Math.floor(ha / 12) - Math.floor(hb / 12) || lb - la || SORTERS.series(a, b); },
  height: (a, b) => (b.spine?.h || 0) - (a.spine?.h || 0) || SORTERS.series(a, b),
  location: (a, b) => codeCmp(a.location, b.location) || (a.location_position ?? 1e9) - (b.location_position ?? 1e9),
};
const SORT_LABELS = [['author', 'Author, then series order'], ['series', 'Series, then everything else by author'], ['title', 'Title'], ['colour', 'Colour (rainbow)'], ['height', 'Height, tallest first'], ['location', 'Where it sits at home']];

/** Sort books inside each shelf section; labels, breaks and decorations stay exactly where they are. */
function sortWithinSections(key) {
  const out = []; let seg = [];
  const flush = () => {
    const books = seg.filter(i => i.kind === 'book').sort((a, b) => SORTERS[key](a.book, b.book));
    let j = 0; for (const it of seg) out.push(it.kind === 'book' ? books[j++] : it);
    seg = [];
  };
  for (const it of items) { if (it.kind === 'break') { flush(); out.push(it); } else seg.push(it); }
  flush();
  items = out;
}

/** Throw away breaks and labels, sort everything, and start a labelled shelf for each series or author. */
function regroup(by) {
  const books = items.filter(i => i.kind === 'book').sort((a, b) => SORTERS[by === 'series' ? 'series' : 'author'](a.book, b.book));
  const decor = items.filter(i => i.kind === 'decor');
  const out = []; let last;
  for (const it of books) {
    const g = by === 'series' ? (it.book.series || 'Other books') : (surname(it.book.authors) ? (it.book.authors || '').split(/;|&/)[0].trim() : 'Unknown author');
    if (g !== last) {
      if (out.length) out.push({ kind: 'break', key: `k${++seq}` });
      out.push({ kind: 'label', text: g, size: 'plaque', key: `k${++seq}` });
      last = g;
    }
    out.push(it);
  }
  items = [...out, ...decor];
}

function tidyPanel() {
  const by = el('select', {}, ...SORT_LABELS.map(([v, l]) => el('option', { value: v }, l)));
  const group = el('select', {}, el('option', { value: 'series' }, 'each series'), el('option', { value: 'author' }, 'each author'));
  return el('div', { class: 'panel stack' }, el('h2', {}, 'Tidy up'),
    el('label', {}, 'Sort books', by),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => { sortWithinSections(by.value); changed(); drawStage(); toast('Sorted within each shelf'); } }, 'Sort within each shelf'),
      el('button', { class: 'btn', onclick: () => {
        if (!confirm('Sort every book on this bookcase, ignoring the current shelf breaks? (Labels and breaks are kept but books flow past them.)')) return;
        const books = items.filter(i => i.kind === 'book').sort((a, b) => SORTERS[by.value](a.book, b.book));
        let j = 0; items = items.map(i => (i.kind === 'book' ? books[j++] : i)); changed(); drawStage();
      } }, 'Sort the whole bookcase')),
    el('p', { class: 'small muted' }, '“Within each shelf” keeps your labels, breaks and pictures where they are and only reorders the books between them.'),
    el('div', { class: 'row' }, 'Give', group, 'its own labelled shelf',
      el('button', { class: 'btn', onclick: () => {
        if (!confirm('Rebuild this bookcase so every group starts a new labelled shelf? Existing labels and breaks are replaced; pictures move to the end.')) return;
        regroup(group.value); selected.clear(); changed(); drawStage(); drawInspector();
      } }, 'Rebuild')));
}

let allShelves = null;
async function moveSelection(copy) {
  allShelves = allShelves || (await api('GET', '/shelves')).filter(s => s.kind === 'manual' && s.id !== shelfId);
  const books = items.filter(i => selected.has(i.key) && i.kind === 'book');
  if (!books.length) return toast('Select some books first', true);
  const dlg = el('dialog', { style: { width: 'min(420px, 92vw)' } },
    el('h2', {}, `${copy ? 'Copy' : 'Move'} ${books.length} book(s) to…`),
    el('div', { class: 'stack' }, ...allShelves.map(s => el('button', { class: 'btn', onclick: guard(async () => {
      const r = await api('POST', `/shelves/${s.id}/books`, { ids: books.map(b => b.book_id) });
      if (!copy) { items = items.filter(i => !(selected.has(i.key) && i.kind === 'book')); selected.clear(); changed(); drawStage(); drawInspector(); }
      toast(`${r.added} added to ${s.name}${r.added < books.length ? ` (${books.length - r.added} were already there)` : ''}`); dlg.close();
    }) }, s.name))),
    el('div', { class: 'row end', style: { marginTop: '12px' } }, el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel')));
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
}

/* ───────── Inspector ───────── */
const inspector = el('aside', { class: 'inspector' });
const onShelf = () => new Set(items.filter(i => i.kind === 'book').map(i => i.book_id));

function tabs() {
  const list = manual() ? [['add', 'Add'], ['selected', `Selected${selected.size ? ` (${selected.size})` : ''}`], ['style', 'Look'], ['settings', 'Settings']]
    : [['settings', 'Rules'], ['style', 'Look']];
  return el('div', { class: 'tabs', role: 'tablist' }, ...list.map(([k, l]) => el('button', { class: tab === k ? 'on' : '', role: 'tab', 'aria-selected': String(tab === k), onclick: () => { tab = k; drawInspector(); } }, l)));
}

function addTab() {
  const box = el('div');
  const q = el('input', { type: 'search', placeholder: 'Search your books…', style: { width: '100%' } });
  const sortSel = el('select', {}, ...[['author', 'by author'], ['series', 'by series'], ['title', 'by title'], ['location', 'by home shelf'], ['added', 'newest first']].map(([v, l]) => el('option', { value: v }, l)));
  const hideShelved = el('input', { type: 'checkbox', checked: true });
  const list = el('div', { class: 'pick-list' });
  const chosen = new Set();
  let results = [];
  const addBtn = el('button', { class: 'btn primary', disabled: true }, 'Add selected');
  const asSel = el('select', {}, el('option', { value: 'inherit' }, 'shelf default'), el('option', { value: 'spine' }, 'spine out'), el('option', { value: 'cover' }, 'cover out'));
  const refreshAdd = () => { addBtn.disabled = !chosen.size; addBtn.textContent = chosen.size ? `Add ${chosen.size} book${chosen.size > 1 ? 's' : ''}` : 'Add selected'; };
  addBtn.onclick = () => {
    const picked = results.filter(b => chosen.has(b.id));
    insert(picked.map(b => ({ kind: 'book', book_id: b.id, book: b, display: asSel.value })));
    toast(`Added ${picked.length} book(s)`);
  };
  const search = debounce(guard(async () => {
    results = await api('GET', `/books/lite?q=${encodeURIComponent(q.value)}&sort=${sortSel.value}&limit=200`);
    draw();
  }), 250);
  function draw() {
    const shelfSet = onShelf();
    const shown = hideShelved.checked ? results.filter(b => !shelfSet.has(b.id)) : results;
    list.replaceChildren(...shown.map(b => {
      const cb = el('input', { type: 'checkbox', checked: chosen.has(b.id), tabindex: -1 });
      return el('div', { class: `pick${shelfSet.has(b.id) ? ' on-shelf' : ''}`, onclick: () => { chosen.has(b.id) ? chosen.delete(b.id) : chosen.add(b.id); cb.checked = chosen.has(b.id); refreshAdd(); } },
        cb, b.cover ? el('img', { src: b.cover, alt: '', loading: 'lazy' }) : el('div', { class: 'ph' }),
        el('div', {}, el('div', { class: 't' }, b.title), el('div', { class: 'a' }, [b.authors, b.series ? `${b.series} ${b.series_index ? '#' + fmtIndex(b.series_index) : ''}` : null, b.location].filter(Boolean).join(' · '))));
    }));
    if (!shown.length) list.append(el('p', { class: 'muted small', style: { padding: '10px' } }, results.length ? 'Everything here is already on this shelf.' : 'No books found.'));
  }
  q.oninput = search; sortSel.onchange = search; hideShelved.onchange = draw;
  search();
  const decor = el('div', { class: 'media-grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(70px, 1fr))' } },
    ...media.map(m => el('div', { class: 'media-tile pick', title: `Add ${m.original_name}`, onclick: () => insert([{ kind: 'decor', media_id: m.id, media: { id: m.id, url: m.url }, size: 'm' }]) },
      el('div', { class: 'img', style: { height: '60px' } }, el('img', { src: m.url, alt: '', style: { maxHeight: '60px' } })))));
  box.append(
    el('div', { class: 'panel stack' }, el('h2', {}, 'Books'), q, el('div', { class: 'row small' }, 'Sort', sortSel, el('label', { class: 'inline' }, hideShelved, 'hide ones already here')), list,
      el('div', { class: 'row' }, addBtn, el('span', { class: 'small muted' }, 'as'), asSel, el('button', { class: 'linkish small', onclick: () => { results.filter(b => !onShelf().has(b.id)).forEach(b => chosen.add(b.id)); draw(); refreshAdd(); } }, 'select all')),
      el('p', { class: 'small muted' }, selected.size ? 'New items go right after your selection.' : 'New items go at the end of the shelf.')),
    el('div', { class: 'panel stack' }, el('h2', {}, 'Structure'),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => insert([{ kind: 'break' }]) }, '↵ Start new shelf'),
        el('button', { class: 'btn', onclick: () => insert([{ kind: 'break', size: 'row' }]) }, '▭ Empty shelf'),
        el('button', { class: 'btn', onclick: () => { const t = prompt('Label text (e.g. “Science Fiction” or “Shelf B3”)'); if (t) insert([{ kind: 'label', text: t, size: 'plaque' }]); } }, '🏷 Label'))),
    el('div', { class: 'panel stack' }, el('h2', {}, 'Decorations'),
      media.length ? decor : el('p', { class: 'muted small' }, 'No images yet.'),
      el('a', { class: 'small', href: '/admin/media', target: '_blank' }, 'Upload pictures & GIFs ↗')),
    tidyPanel(),
  );
  return box;
}

function selectedTab() {
  const sel = items.filter(i => selected.has(i.key));
  if (!sel.length) return el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'Click anything on the shelf to select it. Shift-click selects a range; Ctrl/⌘-click adds to the selection. Drag to move — a selected group moves together.'),
    el('p', { class: 'small muted' }, 'Keys: S = spine out, C = cover out, Enter = new shelf after selection, Delete = remove.'));
  const books = sel.filter(i => i.kind === 'book');
  const box = el('div', { class: 'panel stack' });
  if (sel.length === 1 && books.length === 1) {
    const b = books[0].book;
    box.append(el('h2', {}, b.title), el('div', { class: 'small muted' }, [b.authors, b.series].filter(Boolean).join(' · ')),
      el('a', { class: 'small', href: `/admin/books/${b.id}`, target: '_blank' }, 'Edit book details, cover or spine colour ↗'));
  } else box.append(el('h2', {}, `${sel.length} items selected`));
  if (books.length) {
    const cur = books.every(b => b.display === books[0].display) ? books[0].display : '';
    box.append(el('label', {}, 'Show as', el('div', { class: 'row' }, ...[['inherit', 'Shelf default'], ['spine', 'Spine out'], ['cover', 'Cover out']].map(([v, l]) =>
      el('button', { class: `btn small${cur === v ? ' primary' : ''}`, onclick: () => setDisplay(v) }, l)))));
  }
  if (sel.length === 1 && sel[0].kind === 'decor') {
    const d = sel[0];
    box.append(
      el('h2', {}, 'Decoration'),
      el('label', {}, 'Size', el('div', { class: 'row' }, ...[['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Full height']].map(([v, l]) =>
        el('button', { class: `btn small${(d.size || 'm') === v ? ' primary' : ''}`, onclick: () => { d.size = v; changed(); drawStage(); drawInspector(); } }, l)))),
      el('label', {}, 'Caption (optional)', el('input', { value: d.text || '', oninput: e => { d.text = e.target.value; changed(); drawStage(); } })),
      el('label', {}, 'Link when clicked (optional)', el('input', { type: 'url', value: d.link || '', placeholder: 'https://…', oninput: e => { d.link = e.target.value; changed(); } })));
  }
  if (sel.length === 1 && sel[0].kind === 'label') {
    const l = sel[0];
    box.append(el('label', {}, 'Label text', el('input', { value: l.text || '', oninput: e => { l.text = e.target.value; changed(); drawStage(); } })),
      el('label', {}, 'Style', el('div', { class: 'row' }, ...[['plaque', 'Plaque'], ['tag', 'Upright tag'], ['sign', 'Big sign']].map(([v, n]) =>
        el('button', { class: `btn small${(l.size || 'plaque') === v ? ' primary' : ''}`, onclick: () => { l.size = v; changed(); drawStage(); drawInspector(); } }, n)))));
  }
  if (sel.length === 1 && sel[0].kind === 'break') {
    const b = sel[0];
    box.append(el('label', {}, 'Type', el('div', { class: 'row' },
      el('button', { class: `btn small${b.size !== 'row' ? ' primary' : ''}`, onclick: () => { b.size = null; changed(); drawStage(); drawInspector(); } }, 'Start new shelf'),
      el('button', { class: `btn small${b.size === 'row' ? ' primary' : ''}`, onclick: () => { b.size = 'row'; changed(); drawStage(); drawInspector(); } }, 'Leave a shelf empty'))));
  }
  box.append(el('div', { class: 'row' },
    el('button', { class: 'btn', onclick: () => insert([{ kind: 'break' }]) }, '↵ New shelf after'),
    el('button', { class: 'btn danger', onclick: removeSelected }, 'Remove from shelf')));
  if (books.length) box.append(el('div', { class: 'row' },
    el('button', { class: 'btn', onclick: guard(() => moveSelection(false)) }, 'Move to another shelf…'),
    el('button', { class: 'btn', onclick: guard(() => moveSelection(true)) }, 'Copy to…')));
  if (books.length > 1) {
    box.append(el('button', { class: 'btn', onclick: () => {
      const order = { author: (a, b) => (a.book.authors || '').localeCompare(b.book.authors || '') || (a.book.series || '').localeCompare(b.book.series || '') || (a.book.series_index || 0) - (b.book.series_index || 0) };
      const idx = items.map((it, i) => (selected.has(it.key) && it.kind === 'book' ? i : -1)).filter(i => i >= 0);
      const sorted = idx.map(i => items[i]).sort(order.author);
      idx.forEach((i, j) => { items[i] = sorted[j]; });
      changed(); drawStage();
    } }, 'Sort selection by author & series'));
  }
  return box;
}

function swatch(key, p) {
  const cols = [p.wood, '#8c3b2b', '#2f4858', p.accent, '#3d5a40'];
  return el('button', { class: `swatch${theme().preset === key ? ' on' : ''}`, onclick: () => { patchShelf({ theme: { preset: key, ...(shelf.theme.backImage ? { backImage: shelf.theme.backImage } : {}) } }); drawInspector(); } },
    el('div', { class: 'sw', style: { background: p.back === 'transparent' ? p.page : p.back, borderBottom: `6px solid ${p.plank.startsWith('rgba') ? '#9fb0b5' : p.plank}` } },
      ...cols.map((c, i) => el('i', { style: { background: c, height: `${18 + (i * 7) % 14}px` } }))),
    el('div', { class: 'lb' }, p.label));
}

async function pickMedia(onPick) {
  media = await api('GET', '/media');
  const dlg = el('dialog', { style: { maxWidth: '760px', width: '92vw' } },
    el('h2', {}, 'Choose an image'),
    el('div', { class: 'media-grid' }, ...media.map(m => el('div', { class: 'media-tile pick', onclick: () => { onPick(m.id); dlg.close(); } }, el('div', { class: 'img' }, el('img', { src: m.url, alt: '' })), el('div', { class: 'name' }, m.original_name)))),
    media.length ? null : el('p', { class: 'muted' }, 'Upload images on the Decorations page first.'),
    el('div', { class: 'row end', style: { marginTop: '12px' } }, el('button', { class: 'btn', onclick: () => { onPick(null); dlg.close(); } }, 'None'), el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel')));
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
}

function styleTab() {
  const t = theme();
  const th = shelf.theme || {};
  const set = (k, v) => { const next = { ...shelf.theme, [k]: v }; if (v === '' || v === null || v === undefined) delete next[k]; patchShelf({ theme: next }); };
  const color = (k, label) => {
    const val = /^#[0-9a-f]{6}$/i.test(t[k]) ? t[k] : '#000000';
    return el('label', {}, label, el('div', { class: 'row' }, el('input', { type: 'color', value: val, oninput: debounce(e => set(k, e.target.value), 120) }),
      th[k] ? el('button', { class: 'linkish small', onclick: () => { set(k, null); drawInspector(); } }, 'reset') : el('span', { class: 'small muted' }, 'from preset')));
  };
  const choice = (k, label, opts) => el('label', {}, label, el('select', { onchange: e => set(k, e.target.value) }, ...opts.map(([v, l]) => el('option', { value: v, selected: String(t[k]) === v }, l))));
  const imgPicker = (k, label) => el('label', {}, label, el('div', { class: 'row' },
    t[k] ? el('img', { src: `/media/${t[k]}`, alt: '', style: { height: '40px', borderRadius: '4px' } }) : el('span', { class: 'small muted' }, 'none'),
    el('button', { class: 'btn small', onclick: () => pickMedia(id => { set(k, id); drawInspector(); }) }, 'Choose…')));
  const rowH = el('input', { type: 'range', min: 160, max: 380, step: 10, value: t.rowHeight, oninput: debounce(e => set('rowHeight', Number(e.target.value)), 80) });
  return el('div', {},
    el('div', { class: 'panel stack' }, el('h2', {}, 'Bookcase style'), el('div', { class: 'swatches' }, ...Object.entries(PRESETS).map(([k, p]) => swatch(k, p))),
      el('p', { class: 'small muted' }, 'Pick a starting point, then fine-tune below. Changes apply to this shelf only — set the library-wide default in Settings.')),
    el('div', { class: 'panel stack' }, el('h2', {}, 'Books'),
      el('label', {}, 'Default presentation', el('div', { class: 'row' }, ...[['mixed', 'Spines (per-book choice)'], ['cover', 'Covers']].map(([v, l]) =>
        el('button', { class: `btn small${(shelf.display === 'cover' ? 'cover' : 'mixed') === v ? ' primary' : ''}`, onclick: () => { patchShelf({ display: v }); drawInspector(); } }, l)))),
      el('label', {}, `Shelf height: ${t.rowHeight}px`, rowH),
      choice('spineFont', 'Spine lettering', [['serif', 'Book serif'], ['classic', 'Garamond'], ['sans', 'Modern sans'], ['condensed', 'Condensed'], ['typewriter', 'Typewriter']])),
    el('div', { class: 'panel stack' }, el('h2', {}, 'Colours'),
      el('div', { class: 'form-grid', style: { gridTemplateColumns: '1fr 1fr' } },
        color('wood', 'Frame'), color('plank', 'Shelf boards'), color('back', 'Back panel'), color('page', 'Room / page'), color('ink', 'Text'), color('accent', 'Accent & gilt'))),
    el('div', { class: 'panel stack' }, el('h2', {}, 'Atmosphere'),
      choice('lighting', 'Lighting', [['none', 'Even'], ['warm', 'Warm lamp'], ['cool', 'Cool daylight'], ['spot', 'Shelf spotlights']]),
      choice('labelStyle', 'Name plate & labels', [['brass', 'Brass plaque'], ['paper', 'Paper card'], ['chalk', 'Chalkboard'], ['none', 'Plain text']]),
      choice('frame', 'Frame', [['true', 'Wooden frame & crown'], ['false', 'No frame (floating shelves)']]),
      el('label', {}, 'Wood grain', el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: t.grain ?? 0.4, oninput: debounce(e => set('grain', Number(e.target.value)), 80) })),
      imgPicker('backImage', 'Picture behind the books'),
      choice('backImageMode', 'Back picture fit', [['cover', 'Fill'], ['tile', 'Tile (repeat)']]),
      imgPicker('wallpaper', 'Wallpaper around the bookcase'),
      el('button', { class: 'btn small', onclick: () => { patchShelf({ theme: { preset: t.preset } }); drawInspector(); } }, 'Reset all tweaks to the preset')),
  );
}

function settingsTab() {
  const name = el('input', { value: shelf.name, oninput: debounce(e => patchShelf({ name: e.target.value || 'Untitled shelf' }), 400) });
  const desc = el('textarea', { style: { minHeight: '70px' }, oninput: debounce(e => patchShelf({ description: e.target.value }), 400) }); desc.value = shelf.description || '';
  const slug = el('input', { value: shelf.slug, onchange: e => patchShelf({ slug: e.target.value }, { redraw: false }) });
  const pub = el('input', { type: 'checkbox', checked: shelf.is_public, onchange: e => patchShelf({ is_public: e.target.checked }, { redraw: false }) });
  const panel = el('div', {},
    el('div', { class: 'panel stack' }, el('h2', {}, 'Shelf'),
      el('label', {}, 'Name', name), el('label', {}, 'Description (shown under the name plate)', desc),
      el('label', {}, 'Web address', el('div', { class: 'row small' }, '/shelf/', slug)),
      el('label', { class: 'inline' }, pub, 'Visible on the public site'),
      el('div', { class: 'row' }, el('a', { class: 'btn small', href: `/shelf/${shelf.slug}`, target: '_blank' }, 'View on site ↗'))));
  if (manual() && items.some(i => i.kind === 'label' && /^([A-Za-z]{1,3}\d{1,3}|Loose)\b/i.test(i.text || ''))) {
    panel.append(el('div', { class: 'panel stack' }, el('h2', {}, 'Home shelf locations'),
      el('p', { class: 'small muted' }, 'This bookcase has shelf-code labels (like “B3”). If you rearranged it to match how you want the real shelves, save the new order as each book’s home location. You’ll get a move list on the Reorganise page.'),
      el('button', { class: 'btn primary', onclick: guard(async () => {
        await saveNow();
        const r = await api('POST', `/shelves/${shelfId}/save-locations`);
        toast(`${r.changed} book location(s) updated${r.skipped ? ` — ${r.skipped} before the first label were left alone` : ''}`);
      }) }, 'Save as home locations'),
      el('a', { class: 'small', href: '/admin/reorganise' }, 'Open the move list →')));
  }
  if (!manual()) {
    const r = { ...(shelf.rules || {}) };
    const rule = (k, label, ph) => el('label', {}, label, el('input', { value: r[k] || '', placeholder: ph, oninput: debounce(async e => { r[k] = e.target.value || undefined; await refreshSmart(r); }, 500) }));
    const sel = (k, label, opts) => el('label', {}, label, el('select', { onchange: async e => { r[k] = e.target.value || undefined; await refreshSmart(r); } }, ...opts.map(([v, l]) => el('option', { value: v, selected: (r[k] || '') === v }, l))));
    panel.append(el('div', { class: 'panel stack' }, el('h2', {}, 'Rules'), el('p', { class: 'small muted' }, 'Books matching all of these appear automatically.'),
      rule('q', 'Text anywhere', 'e.g. dragon'), rule('author', 'Author contains', 'e.g. Pratchett'), rule('series', 'Series contains', 'e.g. Discworld'),
      rule('tag', 'Has tag', 'e.g. Science Fiction'), rule('location', 'Home shelf code starts with', 'e.g. B'), rule('room', 'Room is', 'e.g. Bedroom Right'),
      sel('has', 'Must have', [['', 'Anything'], ['files', 'A digital file'], ['audio', 'An audiobook link'], ['physical', 'A physical copy at home'], ['cover', 'A cover image']]),
      sel('format', 'File format', [['', 'Any'], ['epub', 'EPUB'], ['pdf', 'PDF'], ['mobi', 'MOBI'], ['azw3', 'AZW3'], ['cbz', 'CBZ']]),
      rule('binding', 'Format is (comma list)', 'Hardback, Paperback'),
      el('label', {}, 'Order', el('select', { onchange: e => patchShelf({ sort: e.target.value }) }, ...[['author', 'Author, then series'], ['series', 'Series'], ['title', 'Title'], ['added', 'Newest first'], ['published', 'Publication date'], ['location', 'Home shelf location']]
        .map(([v, l]) => el('option', { value: v, selected: shelf.sort === v }, l)))),
      sel('groupBy', 'Start a new shelf for each', [['', '(no grouping)'], ['author', 'Author'], ['series', 'Series'], ['location', 'Home shelf']]),
      el('button', { class: 'btn', onclick: guard(async () => {
        if (!confirm('Turn this into a hand-arranged shelf with its current books? It will stop updating automatically.')) return;
        await api('POST', `/shelves/${shelfId}/freeze`); location.reload();
      }) }, 'Convert to hand-arranged shelf')));
  }
  return panel;
}

async function refreshSmart(rules) {
  shelf.rules = rules;
  await api('PATCH', `/shelves/${shelfId}`, { rules });
  const r = await api('GET', `/shelves/${shelfId}`);
  shelf = r.shelf; items = r.items.map(toLocal); drawStage();
}

function drawInspector() {
  const body = tab === 'add' ? addTab() : tab === 'selected' ? selectedTab() : tab === 'style' ? styleTab() : settingsTab();
  inspector.replaceChildren(tabs(), body);
}

root.append(
  el('div', { class: 'row', style: { marginBottom: '12px' } }, el('a', { href: '/admin/shelves' }, '← All shelves'), el('span', { class: 'spacer' }), saveState,
    el('a', { class: 'btn', href: `/shelf/${shelf.slug}`, target: '_blank' }, 'View on site ↗')),
  el('div', { class: 'builder' }, stage, inspector));
document.querySelector('.page-title').textContent = shelf.name;
drawStage(); drawInspector();
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawStage, 200); });
