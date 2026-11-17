import { api, el, guard, toast, app, watchJob } from './common.js';

const root = app();
let conf = await api('GET', '/integrations');

function configPanel(provider) {
  const c = conf[provider] || {};
  const f = {};
  const field = (k, label, attrs = {}) => { f[k] = el('input', { value: c[k] || '', ...attrs }); return el('label', {}, label, f[k]); };
  const isAbs = provider === 'abs';
  const jobs = el('div');
  return el('section', { class: 'panel stack' },
    el('h2', {}, isAbs ? 'Audiobookshelf' : 'Plex'),
    isAbs
      ? el('p', { class: 'muted small' }, 'Create an API token in Audiobookshelf (Settings → Users → your user → API token, or Settings → API Keys on newer versions).')
      : el('p', { class: 'muted small' }, 'Use the server address (e.g. http://10.10.20.123:32400) and your X-Plex-Token. Audiobooks should be in a Music-type library; each album becomes a title.'),
    el('div', { class: 'form-grid' },
      field('url', isAbs ? 'Server address the app uses (e.g. http://10.10.20.123:30067/audiobookshelf)' : 'Server address', { class: 'wide', placeholder: 'http://…' }),
      isAbs ? field('publicUrl', 'Address for links people click (if different)', { placeholder: 'https://abs.example.com' }) : null,
      field('token', isAbs ? 'API token' : 'X-Plex-Token', { type: 'password', autocomplete: 'off' }),
      isAbs ? field('libraryIds', 'Library id(s) — blank = all book libraries', { placeholder: 'e60c427c-…' }) : field('sectionIds', 'Library section id(s) — blank = auto', { placeholder: 'e.g. 7' }),
      isAbs ? null : el('label', {}, 'Links open in', (f.linkStyle = el('select', {}, el('option', { value: 'app', selected: c.linkStyle !== 'local' }, 'app.plex.tv (works anywhere)'), el('option', { value: 'local', selected: c.linkStyle === 'local' }, 'This Plex server directly'))))),
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: guard(async () => {
        const body = Object.fromEntries(Object.entries(f).filter(([, n]) => n).map(([k, n]) => [k, n.value.trim()]));
        await api('PUT', `/integrations/${provider}`, body); toast('Saved'); conf = await api('GET', '/integrations');
      }) }, 'Save'),
      el('button', { class: 'btn primary', onclick: guard(async () => {
        const body = Object.fromEntries(Object.entries(f).filter(([, n]) => n).map(([k, n]) => [k, n.value.trim()]));
        await api('PUT', `/integrations/${provider}`, body);
        const { job } = await api('POST', `/integrations/${provider}/refresh`);
        watchJob(job, jobs, j => { if (j.status === 'done') { current = provider; loadReview(); } });
      }) }, 'Save & read catalogue')),
    jobs);
}

/* ───────── Review ───────── */
let current = 'abs', status = 'pending';
const review = el('section', { class: 'panel stack' });
async function loadReview() {
  const rows = await api('GET', `/integrations/${current}/candidates?status=${status}`);
  const choice = new Map();
  for (const r of rows) choice.set(r.id, r.status !== 'pending' ? 'keep' : r.confidence === 'exact' ? 'link' : 'skip');
  const head = el('div', { class: 'row' },
    el('div', { class: 'tabs', style: { margin: 0, border: 0 } }, ...[['abs', 'Audiobookshelf'], ['plex', 'Plex']].map(([k, l]) => el('button', { class: current === k ? 'on' : '', onclick: () => { current = k; loadReview(); } }, l))),
    el('span', { class: 'spacer' }),
    el('select', { onchange: e => { status = e.target.value; loadReview(); } }, ...[['pending', 'Waiting for review'], ['linked', 'Linked'], ['created', 'Added as new'], ['ignored', 'Ignored'], ['all', 'Everything']].map(([v, l]) => el('option', { value: v, selected: v === status }, l))));
  if (!rows.length) { review.replaceChildren(el('h2', {}, 'Review matches'), head, el('p', { class: 'muted' }, 'Nothing here. Read a catalogue above to see matches.')); return; }
  const tbody = el('tbody', {}, ...rows.map(r => {
    const opts = [['skip', 'Decide later'], ...(r.suggested_book_id ? [['link', `Link to “${r.book_title}”`]] : []), ['create', 'Add as a new audiobook'], ['ignore', 'Ignore'], ...(r.status !== 'pending' ? [['keep', '(no change)'], ['reset', 'Back to review']] : [])];
    const sel = el('select', { onchange: e => choice.set(r.id, e.target.value) }, ...opts.map(([v, l]) => el('option', { value: v, selected: choice.get(r.id) === v }, l)));
    const other = el('input', { type: 'number', placeholder: 'book id', style: { width: '90px' }, title: 'Link to a different book by its id (see the address of its edit page)', oninput: e => { if (e.target.value) { choice.set(r.id, `link:${e.target.value}`); } } });
    return el('tr', {},
      el('td', {}, el('strong', {}, r.title), el('div', { class: 'small muted' }, [r.authors, r.series ? `${r.series}${r.series_index ? ' #' + r.series_index : ''}` : null].filter(Boolean).join(' · ')),
        el('a', { class: 'small', href: r.url, target: '_blank', rel: 'noopener' }, 'open ↗')),
      el('td', {}, r.suggested_book_id ? el('div', {}, el('a', { href: `/admin/books/${r.suggested_book_id}`, target: '_blank' }, r.book_title), el('div', { class: 'small muted' }, [r.book_authors, r.book_binding].filter(Boolean).join(' · '))) : el('span', { class: 'muted' }, 'no match')),
      el('td', {}, el('span', { class: `chip ${r.confidence === 'exact' ? 'ok' : r.confidence === 'fuzzy' ? 'warn' : ''}` }, r.confidence === 'fuzzy' ? `similar (${Math.round(r.score * 100)}%)` : r.confidence), r.status !== 'pending' ? el('span', { class: 'chip', style: { marginLeft: '4px' } }, r.status) : null),
      el('td', {}, sel, el('div', { class: 'small', style: { marginTop: '4px' } }, 'or link to id ', other)));
  }));
  const bulk = (v, pred) => () => { rows.filter(pred).forEach(r => choice.set(r.id, v)); loadReviewSelects(); };
  function loadReviewSelects() { tbody.querySelectorAll('select').forEach((s, i) => { const v = choice.get(rows[i].id); if ([...s.options].some(o => o.value === v)) s.value = v; }); }
  review.replaceChildren(
    el('h2', {}, 'Review matches'), head,
    el('p', { class: 'muted small' }, 'Exact title + author matches are pre-selected. Similar matches are never applied unless you choose them. Linking only adds a “Listen” button to the book — nothing is ever deleted or merged away.'),
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: bulk('link', r => r.suggested_book_id) }, 'Link all suggestions'),
      el('button', { class: 'btn small', onclick: bulk('create', r => !r.suggested_book_id) }, 'Add all unmatched as new'),
      el('button', { class: 'btn small', onclick: bulk('skip', () => true) }, 'Clear choices')),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'In ' + (current === 'abs' ? 'Audiobookshelf' : 'Plex')), el('th', {}, 'Suggested book'), el('th', {}, 'Match'), el('th', {}, 'Action'))), tbody)),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: guard(async () => {
      const actions = [...choice.entries()].filter(([, v]) => v !== 'skip' && v !== 'keep').map(([id, v]) => v.startsWith('link:') ? { id, action: 'link', bookId: Number(v.slice(5)) } : { id, action: v });
      if (!actions.length) return toast('Nothing chosen');
      const creating = actions.filter(a => a.action === 'create').length;
      if (!confirm(`Apply ${actions.length} change(s)?${creating ? ` ${creating} new audiobook entries will be created.` : ''}`)) return;
      const r = await api('POST', `/integrations/${current}/apply`, { actions });
      toast(`Linked ${r.linked}, added ${r.created}, ignored ${r.ignored}${r.errors.length ? ` — ${r.errors.length} problem(s)` : ''}`, !!r.errors.length);
      if (r.errors.length) console.warn(r.errors);
      loadReview();
    }) }, 'Apply choices')));
}

root.append(el('div', { class: 'grid2' }, configPanel('abs'), configPanel('plex')),
  el('section', { class: 'panel' }, el('h2', {}, 'Audible'),
    el('p', { class: 'muted' }, 'Audible has no way to read your library from outside, so Audible links are added per book (there is a “Search Audible” helper on each book’s edit page) or in bulk with an “Audible URL” column in a spreadsheet import.')),
  review);
loadReview();
