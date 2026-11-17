import { api, el, guard, toast, debounce, watchJob, app, fmtIndex } from './common.js';

const root = app();
const params = new URLSearchParams(location.search);
const state = { q: params.get('q') || '', filter: params.get('filter') || '', sort: params.get('sort') || 'author', page: 1, per: 100, selected: new Set(), editing: false, rows: [], total: 0 };
let shelves = await api('GET', '/shelves');
const dirty = new Map();

const q = el('input', { type: 'search', placeholder: 'Search title, author, series, tag, ISBN…', value: state.q, style: { minWidth: '280px' }, oninput: debounce(() => { state.q = q.value; state.page = 1; load(); }) });
const filter = el('select', { onchange: () => { state.filter = filter.value; state.page = 1; load(); } },
  ...[['', 'All books'], ['files', 'Has a digital file'], ['physical', 'Physical copies'], ['audio', 'Has audiobook link'], ['nocover', 'No cover'], ['unshelved', 'Not on a shelf'], ['hidden', 'Hidden']]
    .map(([v, l]) => el('option', { value: v, selected: v === state.filter }, l)));
const sort = el('select', { onchange: () => { state.sort = sort.value; load(); } },
  ...[['author', 'Author, series'], ['title', 'Title'], ['series', 'Series'], ['location', 'Home shelf location'], ['added', 'Recently added'], ['published', 'Publication date']]
    .map(([v, l]) => el('option', { value: v, selected: v === state.sort }, l)));
const editToggle = el('button', { class: 'btn', onclick: () => toggleEdit() }, 'Quick edit');
const newBtn = el('button', { class: 'btn', onclick: guard(async () => {
  const title = prompt('Title of the new book?'); if (!title) return;
  const { id } = await api('POST', '/books', { title }); location.href = `/admin/books/${id}`;
}) }, '+ New book');

const bulk = el('div', { class: 'panel row', style: { display: 'none', position: 'sticky', top: '8px', zIndex: 5 } });
const jobs = el('div');
const tableWrap = el('div', { class: 'table-wrap' });
const pager = el('div', { class: 'pager' });
root.append(el('div', { class: 'row', style: { marginBottom: '14px' } }, q, filter, sort, el('span', { class: 'spacer' }), editToggle, newBtn), bulk, jobs, tableWrap, pager);

function toggleEdit() {
  if (state.editing && dirty.size && !confirm('Discard unsaved quick edits?')) return;
  state.editing = !state.editing; dirty.clear();
  editToggle.textContent = state.editing ? 'Done editing' : 'Quick edit';
  render();
}

async function load() {
  const p = new URLSearchParams({ q: state.q, filter: state.filter, sort: state.sort, page: state.page, per: state.per });
  const u = new URL(location.href); for (const k of ['q', 'filter', 'sort']) state[k] ? u.searchParams.set(k, state[k]) : u.searchParams.delete(k); history.replaceState(null, '', u);
  const data = await api('GET', `/books?${p}`);
  state.rows = data.books; state.total = data.total;
  render();
}

function renderBulk() {
  const n = state.selected.size;
  bulk.style.display = n ? 'flex' : 'none';
  if (!n) return;
  const shelfSel = el('select', {}, el('option', { value: '' }, 'Add to shelf…'), ...shelves.filter(s => s.kind === 'manual').map(s => el('option', { value: s.id }, s.name)));
  shelfSel.onchange = guard(async () => {
    if (!shelfSel.value) return;
    const r = await api('POST', '/books/bulk', { ids: [...state.selected], action: 'addToShelf', value: shelfSel.value });
    toast(`Added ${r.count} book(s) to the shelf`); shelfSel.value = '';
  });
  const bindingSel = el('select', {}, el('option', { value: '' }, 'Set format…'), ...['Hardback', 'Paperback', 'Ebook', 'Audiobook', 'Other'].map(b => el('option', { value: b }, b)));
  bindingSel.onchange = guard(async () => {
    if (!bindingSel.value) return;
    await api('POST', '/books/bulk', { ids: [...state.selected], action: 'set', value: { binding: bindingSel.value } });
    toast('Format updated'); load();
  });
  const act = (label, fn, cls = 'btn') => el('button', { class: cls, onclick: guard(fn) }, label);
  bulk.replaceChildren(
    el('strong', {}, `${n} selected`),
    shelfSel,
    act('New shelf from selection', async () => {
      const name = prompt('Name for the new shelf?'); if (!name) return;
      const { id } = await api('POST', '/shelves', { name, bookIds: [...state.selected] });
      location.href = `/admin/shelves/${id}`;
    }),
    act('Fetch covers & details', async () => { const { job } = await api('POST', '/books/bulk', { ids: [...state.selected], action: 'enrich' }); watchJob(job, jobs, () => load()); }),
    bindingSel,
    act('Hide', async () => { await api('POST', '/books/bulk', { ids: [...state.selected], action: 'hide' }); toast('Hidden from the public site'); load(); }),
    act('Unhide', async () => { await api('POST', '/books/bulk', { ids: [...state.selected], action: 'unhide' }); load(); }),
    el('span', { class: 'spacer' }),
    act('Delete', async () => {
      if (!confirm(`Delete ${n} book record(s)? Files in your library folders are never touched; uploaded files are kept unless you choose to remove them next.`)) return;
      const files = confirm('Also delete files that were uploaded through this site for these books?');
      await api('POST', '/books/bulk', { ids: [...state.selected], action: 'delete', value: files ? 'files' : null });
      state.selected.clear(); toast('Deleted'); load();
    }, 'btn danger'),
    act('Clear', () => { state.selected.clear(); render(); }),
  );
}

function render() {
  renderBulk();
  const all = el('input', { type: 'checkbox', 'aria-label': 'Select all on this page', checked: state.rows.length && state.rows.every(r => state.selected.has(r.id)),
    onchange: () => { state.rows.forEach(r => (all.checked ? state.selected.add(r.id) : state.selected.delete(r.id))); render(); } });
  const head = state.editing
    ? ['Title', 'Author(s)', 'Series', '#', 'Format', 'Shelf', 'Pos']
    : ['Title', 'Author(s)', 'Series', 'Format', 'Home shelf', 'Files / audio'];
  const cellInput = (r, field, w) => el('input', { class: 'cell', value: r[field] ?? '', style: w ? { width: w } : null, oninput: e => {
    const d = dirty.get(r.id) || { id: r.id }; d[field] = e.target.value; dirty.set(r.id, d); saveBar();
  } });
  const rows = state.rows.map(r => el('tr', {},
    el('td', {}, el('input', { type: 'checkbox', 'aria-label': `Select ${r.title}`, checked: state.selected.has(r.id), onchange: e => { e.target.checked ? state.selected.add(r.id) : state.selected.delete(r.id); renderBulk(); } })),
    el('td', { class: 'thumb' }, r.cover ? el('img', { src: r.cover, alt: '', loading: 'lazy' }) : el('div', { class: 'ph' })),
    ...(state.editing ? [
      el('td', {}, cellInput(r, 'title')), el('td', {}, cellInput(r, 'authors')), el('td', {}, cellInput(r, 'series')),
      el('td', {}, cellInput(r, 'series_index', '56px')), el('td', {}, cellInput(r, 'binding', '96px')), el('td', {}, cellInput(r, 'location', '64px')), el('td', {}, cellInput(r, 'location_position', '56px')),
    ] : [
      el('td', {}, el('a', { href: `/admin/books/${r.id}` }, r.title), r.hidden ? el('span', { class: 'chip', style: { marginLeft: '6px' } }, 'hidden') : null),
      el('td', {}, r.authors || ''),
      el('td', {}, r.series ? `${r.series}${r.series_index ? ' #' + fmtIndex(r.series_index) : ''}` : ''),
      el('td', {}, r.binding || ''),
      el('td', {}, r.location ? `${r.location}${r.location_position ? ' · ' + r.location_position : ''}` : ''),
      el('td', {}, ...r.formats.map(f => el('span', { class: 'chip', style: { marginRight: '4px' } }, f)), r.audio ? el('span', { class: 'chip ok' }, '♪ audio') : null),
    ])));
  tableWrap.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, all), el('th', {}), ...head.map(h => el('th', {}, h)))),
    el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 9, class: 'muted', style: { padding: '30px', textAlign: 'center' } }, 'No books match.'))]))));
  const pages = Math.max(1, Math.ceil(state.total / state.per));
  pager.replaceChildren(
    el('span', { class: 'muted' }, `${state.total} book${state.total === 1 ? '' : 's'}`),
    el('button', { class: 'btn small', disabled: state.page <= 1, onclick: () => { state.page--; load(); } }, '‹ Prev'),
    el('span', {}, `Page ${state.page} of ${pages}`),
    el('button', { class: 'btn small', disabled: state.page >= pages, onclick: () => { state.page++; load(); } }, 'Next ›'));
  saveBar();
}

const saveBox = el('div', { class: 'panel row', style: { display: 'none', position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: 20, boxShadow: '0 10px 30px rgba(0,0,0,.2)' } });
document.body.append(saveBox);
function saveBar() {
  saveBox.style.display = state.editing && dirty.size ? 'flex' : 'none';
  saveBox.replaceChildren(el('span', {}, `${dirty.size} book(s) changed`),
    el('button', { class: 'btn primary', onclick: guard(async () => {
      await api('POST', '/books/quick-edit', { rows: [...dirty.values()] });
      toast(`Saved ${dirty.size} book(s)`); dirty.clear(); load();
    }) }, 'Save changes'),
    el('button', { class: 'btn', onclick: () => { dirty.clear(); render(); } }, 'Discard'));
}
window.addEventListener('beforeunload', e => { if (dirty.size) { e.preventDefault(); e.returnValue = ''; } });

load();
