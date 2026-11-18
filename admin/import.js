import { api, el, guard, toast, app, dropZone, uploadForm, watchJob } from './common.js';

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
          el('p', { class: 'muted' }, r.job ? 'Covers, descriptions and page counts are now being looked up in the background — progress shows on the Dashboard. It takes a while (a few seconds per book), and the shelves fill in as it goes.' : 'Books in a series share a spine colour — pick the colours on the Series page.'),
          el('div', { class: 'row' }, el('a', { class: 'btn primary', href: '/admin' }, 'Go to dashboard'), el('a', { class: 'btn', href: '/', target: '_blank' }, 'See the library ↗'))));
        toast('Import finished');
      } finally { e.target.disabled = false; e.target.textContent = 'Import'; }
    }) }, 'Import'))));
}

/* ───────── From ShelfHaven ───────── */
const shJobs = el('div');
const shUrl = el('input', { value: 'http://10.10.20.123:13000', style: { minWidth: '260px' } });
const shEmail = el('input', { type: 'email', autocomplete: 'off', placeholder: 'the email you sign in to ShelfHaven with' });
const shPass = el('input', { type: 'password', autocomplete: 'off' });
const shAbs = el('input', { placeholder: 'e.g. http://10.10.20.123:30067/audiobookshelf (optional)', style: { minWidth: '320px' } });
root.append(el('section', { class: 'panel stack', style: { marginTop: '28px' } },
  el('h2', {}, 'Bring books over from ShelfHaven'),
  el('p', { class: 'muted' }, 'Copies every e-book and PDF out of your old ShelfHaven, with its cover, series and Audiobookshelf link. A book you also own in print is joined to its print copy instead of appearing twice. Running it again only picks up what is new.'),
  el('h3', {}, 'Option 1 — from the running ShelfHaven app'),
  el('div', { class: 'form-grid' }, el('label', {}, 'ShelfHaven address', shUrl), el('label', {}, 'Email', shEmail), el('label', {}, 'Password', shPass),
    el('label', { class: 'wide' }, 'Audiobookshelf address, used to rebuild audiobook links', shAbs)),
  el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: guard(async () => {
    const { job } = await api('POST', '/shelfhaven/server', { url: shUrl.value.trim(), email: shEmail.value.trim(), password: shPass.value, absUrl: shAbs.value.trim() });
    shPass.value = '';
    watchJob(job, shJobs);
  }) }, 'Import from ShelfHaven')),
  el('p', { class: 'small muted' }, 'Your ShelfHaven password is only used for this import and is not saved.'),
  el('h3', {}, 'Option 2 — from a ShelfHaven backup file'),
  el('p', { class: 'small muted' }, 'If your ShelfHaven has Admin → Backup, download a backup there and drop the .zip here.'),
  dropZone({ accept: '.zip', multiple: false, label: el('div', {}, el('b', {}, 'Drop the ShelfHaven backup .zip'), el('br'), 'or click to choose'), onFiles: guard(async ([f]) => {
    const fd = new FormData(); fd.append('file', f); fd.append('absUrl', shAbs.value.trim());
    toast('Uploading backup…');
    const { job } = await uploadForm('/shelfhaven/backup', fd);
    watchJob(job, shJobs);
  }) }),
  shJobs));
