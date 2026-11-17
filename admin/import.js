import { api, el, guard, toast, app, dropZone, uploadForm } from './common.js';

const root = app();
const step2 = el('div');
const out = el('div');

root.append(
  el('section', { class: 'panel stack' },
    el('h2', {}, '1 · Choose a spreadsheet'),
    el('p', { class: 'muted' }, 'Export your Google Sheet as Excel (File → Download → Microsoft Excel) and drop it here, or use a CSV. Columns are recognised by name: Title / Book Title, Author / Book Author, Shelf, Shelf Position, Series, Series Order, Binding — plus optional ISBN, Description, Tags, Audible URL, Plex URL, Audiobookshelf URL. A sheet whose first column is “Case Identifier” is used to name rooms.'),
    dropZone({ accept: '.xlsx,.xls,.ods,.csv,.tsv', multiple: false, label: el('div', {}, el('b', {}, 'Drop the .xlsx or .csv here'), el('br'), 'or click to choose'), onFiles: guard(async ([f]) => {
      const fd = new FormData(); fd.append('file', f);
      const info = await uploadForm('/import/inspect', fd);
      showOptions(info);
    }) })),
  step2, out);

function showOptions(info) {
  out.replaceChildren();
  const sheetSel = el('select', {}, ...info.sheets.filter(s => s.usable).map(s => el('option', { value: s.name, selected: s.name === info.suggested }, `${s.name} — ${s.rows} rows`)));
  const optsBox = el('div', { class: 'stack' });
  const preview = el('div', { class: 'table-wrap' });
  const state = {};
  function drawOpts() {
    const s = info.sheets.find(x => x.name === sheetSel.value);
    state.usePlan = el('input', { type: 'checkbox' });
    const skippable = s.dispositions.filter(d => !/^keep$/i.test(d));
    state.skip = skippable.map(d => ({ d, cb: el('input', { type: 'checkbox', checked: true }) }));
    state.merge = el('input', { type: 'checkbox', checked: true });
    state.build = el('input', { type: 'checkbox', checked: true });
    state.rebuild = el('input', { type: 'checkbox', checked: true });
    const found = Object.keys(s.columns).filter(k => !['plan_location', 'plan_position'].includes(k));
    optsBox.replaceChildren(
      el('div', { class: 'small' }, 'Columns found: ', ...found.map(k => el('span', { class: 'chip', style: { marginRight: '4px' } }, k.replace('_', ' ')))),
      s.hasPlan ? el('label', { class: 'inline' }, state.usePlan, 'Use the planned layout (“New Shelf” / “New Position”) instead of where books are now') : null,
      skippable.length ? el('div', { class: 'row' }, el('span', {}, 'Skip rows marked:'), ...state.skip.map(({ d, cb }) => el('label', { class: 'inline' }, cb, d))) : null,
      el('label', { class: 'inline' }, state.merge, 'If an e-book with the same title and author is already here, attach the physical copy to it instead of making a second entry'),
      el('label', { class: 'inline' }, state.build, 'Build a bookcase for each case letter (A, B, C…), with a labelled shelf for every shelf code'),
      el('label', { class: 'inline', style: { paddingLeft: '24px' } }, state.rebuild, 'Re-arrange those bookcases if they already exist (anything you added to them by hand is replaced)'),
      info.casesSheet ? el('p', { class: 'small muted' }, `Room names come from the “${info.casesSheet}” sheet (${info.caseCount} shelf codes).`) : null);
    preview.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Title'), el('th', {}, 'Author'), el('th', {}, 'Shelf'))),
      el('tbody', {}, ...s.sample.map(r => el('tr', {}, el('td', {}, r.title), el('td', {}, r.authors || ''), el('td', {}, r.location || ''))))));
  }
  sheetSel.onchange = drawOpts;
  drawOpts();
  step2.replaceChildren(el('section', { class: 'panel stack' },
    el('h2', {}, `2 · Options for ${info.name}`),
    el('label', {}, 'Sheet to import', sheetSel),
    optsBox,
    el('h3', {}, 'First rows'), preview,
    el('p', { class: 'small muted' }, 'Importing again later is safe: books already imported are updated in place (new shelf positions, series fixes) rather than duplicated, and nothing is deleted.'),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: guard(async e => {
      e.target.disabled = true; e.target.textContent = 'Importing…';
      try {
        const r = await api('POST', '/import/run', { key: info.key, options: {
          sheet: sheetSel.value, usePlan: state.usePlan.checked, skipDispositions: state.skip.filter(s => s.cb.checked).map(s => s.d),
          mergeWithEbooks: state.merge.checked, buildShelves: state.build.checked, rebuildShelves: state.rebuild.checked } });
        out.replaceChildren(el('section', { class: 'panel stack' }, el('h2', {}, '3 · Done'),
          el('p', {}, `${r.created} new books, ${r.updated} updated, ${r.merged} matched to existing e-books, ${r.skipped} skipped.`),
          r.shelves.length ? el('ul', {}, ...r.shelves.map(s => el('li', {}, el('a', { href: `/admin/shelves/${s.id}` }, s.name), s.books ? ` — ${s.books} books` : '', s.rebuilt === false ? ' (left as it was)' : ''))) : null,
          el('p', { class: 'muted' }, 'Physical books start with generated spines in a colour picked per series. To add real covers and descriptions, run “Fetch missing covers & details” on the dashboard (it works through them slowly and politely).'),
          el('div', { class: 'row' }, el('a', { class: 'btn primary', href: '/admin' }, 'Go to dashboard'), el('a', { class: 'btn', href: '/', target: '_blank' }, 'See the library ↗'))));
        toast('Import finished');
      } finally { e.target.disabled = false; e.target.textContent = 'Import'; }
    }) }, 'Import'))));
}
