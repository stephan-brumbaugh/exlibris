import { api, el, guard, toast, app, debounce, fmtIndex } from './common.js';

const root = app();
let list = await api('GET', '/series');
const state = { q: '', only: '' };

const minBooks = el('input', { type: 'number', min: 1, value: 3, style: { width: '70px' } });
const coll = el('select', {}, el('option', { value: 'physical' }, 'my books at home'), el('option', { value: 'digital' }, 'my digital library'), el('option', { value: 'any' }, 'both'));
root.append(el('section', { class: 'panel stack' },
  el('h2', {}, 'Series shelves'),
  el('p', { class: 'muted' }, 'Smart shelves that keep each series together in reading order, and update themselves as books are added. Choose whether they show your physical books or your digital ones — the two never mix.'),
  el('div', { class: 'row' }, 'Using', coll, ', for series with at least', minBooks, 'books:',
    el('button', { class: 'btn primary', onclick: guard(async () => {
      const r = await api('POST', '/series/shelves', { mode: 'combined', minBooks: Number(minBooks.value) || 1, collection: coll.value });
      location.href = `/admin/shelves/${r.created[0].id}`;
    }) }, 'One “Series” bookcase, each series on its own shelf'),
    el('button', { class: 'btn', onclick: guard(async () => {
      const n = list.filter(s => s.count >= (Number(minBooks.value) || 1) && !s.shelves.some(x => x.collection === coll.value)).length;
      if (!n) return toast('Every series that size already has its own bookcase');
      if (!confirm(`Create up to ${n} bookcase(s), one per series?`)) return;
      const r = await api('POST', '/series/shelves', { mode: 'each', minBooks: Number(minBooks.value) || 1, collection: coll.value });
      toast(`Created ${r.created.length} bookcase(s)`); list = await api('GET', '/series'); draw();
    }) }, 'A separate bookcase for each series'))));

const q = el('input', { type: 'search', placeholder: 'Find a series…', oninput: debounce(() => { state.q = q.value.toLowerCase(); draw(); }, 150) });
const only = el('select', { onchange: () => { state.only = only.value; draw(); } },
  el('option', { value: '' }, 'All series'), el('option', { value: 'scattered' }, 'Spread over more than one home shelf'),
  el('option', { value: 'gaps' }, 'Missing numbers'), el('option', { value: 'custom' }, 'Colour chosen by me'));
const summary = el('span', { class: 'muted' });
const table = el('div', { class: 'table-wrap' });
root.append(el('div', { class: 'row', style: { margin: '6px 0 12px' } }, q, only, el('span', { class: 'spacer' }), summary), table);

const save = debounce(guard(async (s, color, text) => {
  await api('PUT', '/series', { name: s.name, color, text_color: text });
  toast(`${s.name}: colour saved`);
}), 300);

function spines(s) {
  return el('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '1px', height: '44px' } },
    ...s.books.slice(0, 14).map(() => el('i', { style: { display: 'block', width: '7px', height: '40px', background: s.color, borderRadius: '1px', boxShadow: 'inset -2px 0 2px rgba(0,0,0,.3)', borderTop: `3px solid ${s.text_color}` } })));
}

function draw() {
  const rows = list.filter(s => (!state.q || s.name.toLowerCase().includes(state.q) || (s.authors || '').toLowerCase().includes(state.q))
    && (state.only !== 'scattered' || s.scattered) && (state.only !== 'gaps' || s.missing.length) && (state.only !== 'custom' || s.custom));
  summary.textContent = `${rows.length} of ${list.length} series · ${list.filter(s => s.scattered).length} spread across shelves at home`;
  table.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ...['Colour', '', 'Series', 'Books', 'Not on your shelves', 'At home', ''].map(h => el('th', {}, h)))),
    el('tbody', {}, ...rows.map(s => {
      const preview = el('td', {}, spines(s));
      const color = el('input', { type: 'color', value: s.color, title: 'Spine colour for every book in this series', oninput: () => { s.color = color.value; s.custom = true; preview.replaceChildren(spines(s)); save(s, s.color, null); } });
      return el('tr', {},
        el('td', {}, color),
        preview,
        el('td', {}, el('strong', {}, s.name), el('div', { class: 'small muted' }, s.authors || ''),
          el('details', { class: 'small' }, el('summary', {}, 'books'), el('ol', { style: { margin: '4px 0', paddingLeft: '18px' } },
            ...s.books.map(b => el('li', {}, el('a', { href: `/admin/books/${b.id}` }, `${b.series_index ? '#' + fmtIndex(b.series_index) + ' ' : ''}${b.title}`), b.location ? el('span', { class: 'muted' }, ` — ${b.location}${b.location_position ? ' · ' + b.location_position : ''}`) : null))))),
        el('td', {}, String(s.count)),
        el('td', { class: 'small' }, s.missing.length ? s.missing.map(n => `#${n}`).join(', ') : el('span', { class: 'muted' }, '—')),
        el('td', {}, ...s.locations.map(l => el('span', { class: `chip${s.scattered ? ' warn' : ''}`, style: { marginRight: '3px' } }, l))),
        el('td', { class: 'row', style: { flexWrap: 'nowrap' } },
          s.firstCoverColor ? el('button', { class: 'btn small', title: 'Use the colour of the first book’s cover', onclick: () => { s.color = s.firstCoverColor; color.value = s.color; s.custom = true; preview.replaceChildren(spines(s)); save(s, s.color, null); } }, 'From cover') : null,
          s.custom ? el('button', { class: 'btn small', onclick: guard(async () => { await api('PUT', '/series', { name: s.name, color: null }); list = await api('GET', '/series'); draw(); }) }, 'Reset') : null,
          el('button', { class: 'btn small', title: 'Rename, or merge into another series by typing its exact name', onclick: guard(async () => {
            const to = prompt(`Rename “${s.name}” on all ${s.count} books to:`, s.name);
            if (!to || to === s.name) return;
            const r = await api('POST', '/series/rename', { from: s.name, to }); toast(`Updated ${r.changed} books`); list = await api('GET', '/series'); draw();
          }) }, 'Rename'),
          ...s.shelves.map(x => el('a', { class: 'btn small', href: `/admin/shelves/${x.id}`, title: 'Open this series bookcase' }, x.collection === 'physical' ? 'Home shelf' : x.collection === 'digital' ? 'Digital shelf' : 'Shelf')),
          el('button', { class: 'btn small', title: 'Make a bookcase for this series, using the collection chosen at the top', onclick: guard(async () => {
            const r = await api('POST', '/series/shelves', { mode: 'each', names: [s.name], collection: coll.value });
            if (!r.created.length) return toast('That bookcase already exists');
            location.href = `/admin/shelves/${r.created[0].id}`;
          }) }, 'Make shelf')));
    }))));
}
draw();
