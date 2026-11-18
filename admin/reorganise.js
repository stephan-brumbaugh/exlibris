import { api, el, guard, toast, app, debounce } from './common.js';

const root = app();
let data = await api('GET', '/reorg');
const progress = el('div');
const shelvesBox = el('section', { class: 'panel stack' });
const planBox = el('section', { class: 'panel stack' });
const planOut = el('div', { class: 'stack' });

root.append(
  el('p', { class: 'muted', style: { maxWidth: '75ch' } }, 'Plan a better order for the books at home, see it on the digital bookcases first, then follow a printed checklist to move the real books. Nothing changes until you press Apply, and Undo puts every book back where the spreadsheet had it.'),
  progress, planBox, shelvesBox,
  el('section', { class: 'panel' }, el('h2', {}, 'Prefer to arrange by hand?'),
    el('p', { class: 'muted' }, 'Open any “Bookcase” shelf, drag books where you want them (labels like “B3” mark where each real shelf starts), then use “Save as home locations” in the builder’s Settings tab. The move list below picks up those changes too.')));

/* ───────── Progress / move list ───────── */
function drawProgress() {
  if (!data.active) { progress.replaceChildren(); return; }
  const moves = data.moves;
  const done = moves.filter(m => m.done).length;
  const groups = new Map();
  for (const m of moves) { if (!groups.has(m.code)) groups.set(m.code, []); groups.get(m.code).push(m); }
  progress.replaceChildren(el('section', { class: 'panel stack', style: { borderColor: 'var(--accent)' } },
    el('h2', {}, 'Reorganisation in progress'),
    el('div', { class: 'bar' }, el('i', { style: { width: `${moves.length ? Math.round((done / moves.length) * 100) : 100}%` } })),
    el('div', { class: 'row' }, el('span', {}, `${done} of ${moves.length} books moved`), el('span', { class: 'spacer' }),
      el('a', { class: 'btn', href: '/admin/reorganise/print?by=source', target: '_blank' }, '🖨 Take-off list (by current shelf)'),
      el('a', { class: 'btn primary', href: '/admin/reorganise/print?by=dest', target: '_blank' }, '🖨 Put-away list (by new shelf)')),
    el('p', { class: 'small muted' }, 'Easiest way: clear one bookcase at a time onto a table using the take-off list, then refill shelves in order with the put-away list. Tick books off here as you go — on your phone works well.'),
    el('div', { class: 'stack' }, ...[...groups.entries()].map(([code, g]) => el('details', { open: g.some(m => !m.done) && groups.size < 12 },
      el('summary', {}, el('strong', {}, code), ` — ${g.filter(m => m.done).length}/${g.length} done`),
      el('div', { class: 'stack', style: { padding: '6px 0 6px 12px', gap: '4px' } }, ...g.map(m => el('label', { class: 'inline', style: { opacity: m.done ? 0.5 : 1 } },
        el('input', { type: 'checkbox', checked: !!m.done, onchange: guard(async e => { await api('POST', '/reorg/done', { ids: [m.id], done: e.target.checked }); m.done = e.target.checked ? 1 : 0; drawProgress(); }) }),
        el('span', {}, `${m.pos ?? '–'}. `, el('strong', {}, m.title), m.series ? ` (${m.series}${m.series_index ? ' #' + m.series_index : ''})` : '',
          el('span', { class: 'muted' }, ` — from ${m.from_code || '?'}${m.from_pos ? ' #' + m.from_pos : ''}`)))))))),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: guard(async () => {
        if (!confirm('Finish? The new places become the official home locations and the move list is cleared.')) return;
        await api('POST', '/reorg/finish'); data = await api('GET', '/reorg'); drawAll(); toast('Done — enjoy the new shelves');
      }) }, 'Finish'),
      el('button', { class: 'btn danger', onclick: guard(async () => {
        if (!confirm('Undo the whole reorganisation and put every book back where it was before?')) return;
        await api('POST', '/reorg/cancel'); data = await api('GET', '/reorg'); drawAll(); toast('Restored the original locations');
      }) }, 'Undo everything'))));
}

/* ───────── Physical shelves ───────── */
function drawShelves() {
  const caseSel = el('select', {}, ...[...new Set(data.shelves.map(s => s.code.replace(/\d+.*$/, '')))].map(c => el('option', { value: c }, `Bookcase ${c}`)));
  const width = el('input', { type: 'number', min: 4, step: 0.5, value: 30, style: { width: '80px' } });
  const newCode = el('input', { placeholder: 'e.g. F1', style: { width: '90px' } });
  const save = debounce(guard(async (code, body) => { await api('PUT', `/reorg/shelves/${encodeURIComponent(code)}`, body); }), 400);
  shelvesBox.replaceChildren(
    el('h2', {}, 'Your shelves at home'),
    el('p', { class: 'muted small' }, 'Widths start out sized to fit what is on each shelf today. For a better plan, measure the usable width of each shelf (inside the uprights) in inches. Untick shelves that hold lamps, baskets or anything that isn’t books. Book thickness comes from page counts once covers & details have been looked up, otherwise it’s estimated.'),
    el('div', { class: 'row' }, 'Set every shelf in', caseSel, 'to', width, 'inches',
      el('button', { class: 'btn small', onclick: guard(async () => {
        const codes = data.shelves.filter(s => s.code.replace(/\d+.*$/, '') === caseSel.value).map(s => s.code);
        await api('POST', '/reorg/shelves/bulk', { codes, data: { width_in: Number(width.value) } }); data = await api('GET', '/reorg'); drawShelves();
      }) }, 'Apply'),
      el('span', { class: 'spacer' }), 'Add a shelf', newCode,
      el('button', { class: 'btn small', onclick: guard(async () => {
        const c = newCode.value.trim().toUpperCase(); if (!/^[A-Z]{1,3}\d{1,3}$/.test(c)) return toast('Use a code like F1', true);
        await api('PUT', `/reorg/shelves/${c}`, { width_in: 30 }); data = await api('GET', '/reorg'); drawShelves();
      }) }, 'Add')),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['Shelf', 'Room', 'Note', 'Width (in)', 'For books', 'Now holds', 'Full'].map(h => el('th', {}, h)))),
      el('tbody', {}, ...data.shelves.map(s => el('tr', { style: { opacity: s.enabled ? 1 : 0.5 } },
        el('td', {}, el('strong', {}, s.code)),
        el('td', {}, el('input', { value: s.room || '', style: { width: '130px' }, oninput: e => save(s.code, { room: e.target.value }) })),
        el('td', {}, el('input', { value: s.note || '', style: { width: '130px' }, oninput: e => save(s.code, { note: e.target.value }) })),
        el('td', {}, el('input', { type: 'number', min: 4, step: 0.5, value: s.width_in, style: { width: '75px' }, oninput: e => save(s.code, { width_in: Number(e.target.value) }) })),
        el('td', {}, el('input', { type: 'checkbox', checked: s.enabled, onchange: guard(async e => { await api('PUT', `/reorg/shelves/${encodeURIComponent(s.code)}`, { enabled: e.target.checked }); s.enabled = e.target.checked; drawShelves(); }) })),
        el('td', {}, `${s.count} books · ${s.inches}"`),
        el('td', { style: { minWidth: '110px' } }, el('div', { class: 'bar', title: `${s.fill}%` }, el('i', { style: { width: `${Math.min(100, s.fill || 0)}%`, background: s.fill > 100 ? 'var(--bad)' : '' } })),
          el('span', { class: 'small muted' }, `${s.fill ?? 0}%`))))))),
    el('p', { class: 'small muted' }, `${data.loose} loose book(s) not on any shelf yet.`));
}

/* ───────── Plan ───────── */
function drawPlan() {
  const order = el('select', {}, ...[['author', 'By author (a series stays with its author)'], ['series-first', 'All series first, then other books by author'], ['title', 'By title'], ['binding', 'Hardbacks first, then paperbacks, each by author']].map(([v, l]) => el('option', { value: v }, l)));
  const keep = el('input', { type: 'checkbox', checked: true });
  const big = el('input', { type: 'number', min: 0, value: 10, style: { width: '64px' } });
  const fill = el('input', { type: 'range', min: 60, max: 100, step: 5, value: 90 });
  const fillLabel = el('span', {}, '90%');
  fill.oninput = () => { fillLabel.textContent = `${fill.value}%`; };
  const loose = el('input', { type: 'checkbox', checked: true });
  const opts = () => ({ order: order.value, keepTogether: keep.checked, bigSeries: Number(big.value) || 0, fill: Number(fill.value) / 100, includeLoose: loose.checked });
  planBox.replaceChildren(
    el('h2', {}, 'Plan a new order'),
    el('div', { class: 'form-grid' },
      el('label', {}, 'Order books', order),
      el('label', {}, el('span', {}, 'Fill each shelf to ', fillLabel, ' (room to add books later)'), fill),
      el('label', {}, 'Series with this many books or more get their own shelf (0 = off)', big),
      el('div', { class: 'stack' }, el('label', { class: 'inline' }, keep, 'Don’t split a series across shelves when it fits on one'),
        el('label', { class: 'inline' }, loose, 'Find homes for loose books too'))),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: guard(async () => showPlan(await api('POST', '/reorg/plan', opts()), opts)) }, 'Preview plan')),
    planOut);
}

function showPlan(p, opts) {
  const used = p.shelves.filter(s => s.count);
  planOut.replaceChildren(
    el('div', { class: 'row' },
      el('span', { class: 'chip' }, `${p.placements.length} books`), el('span', { class: 'chip warn' }, `${p.changingShelf} change shelf`),
      el('span', { class: 'chip' }, `${used.length} of ${p.shelves.length} shelves used`),
      p.overflow ? el('span', { class: 'chip bad' }, `${p.overflow} don’t fit — add shelves, widen them or raise the fill level`) : el('span', { class: 'chip ok' }, 'everything fits')),
    el('div', { class: 'table-wrap', style: { maxHeight: '420px', overflow: 'auto' } }, el('table', {},
      el('thead', {}, el('tr', {}, ...['Shelf', 'Books', 'Full', 'Starts with', 'Ends with'].map(h => el('th', {}, h)))),
      el('tbody', {}, ...p.shelves.map(s => el('tr', { style: { opacity: s.count ? 1 : 0.45 } },
        el('td', {}, el('strong', {}, s.code), s.room ? el('div', { class: 'small muted' }, s.room) : null), el('td', {}, String(s.count)),
        el('td', {}, `${s.fill}%`), el('td', { class: 'small' }, s.first || '—'), el('td', { class: 'small' }, s.last || '—')))))),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: guard(async () => {
        if (!confirm('Apply this plan? The digital Bookcases are rearranged to match (pictures you placed on those bookcases are removed) and you get a move list. You can undo it.')) return;
        await api('POST', '/reorg/apply', opts()); data = await api('GET', '/reorg'); drawAll(); planOut.replaceChildren();
        toast('Plan applied — have a look at your Bookcases, then follow the move list'); window.scrollTo({ top: 0, behavior: 'smooth' });
      }) }, 'Apply this plan'),
      el('span', { class: 'small muted' }, 'You can fine-tune afterwards by dragging books in the Bookcase shelves.')));
}

function drawAll() { drawProgress(); drawShelves(); drawPlan(); }
drawAll();
