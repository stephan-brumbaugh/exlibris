import { api, el, guard, watchJob, app } from './common.js';

const root = app();
const s = await api('GET', '/stats');
const card = (n, label, href) => el(href ? 'a' : 'div', { class: 'stat', href, style: { textDecoration: 'none', color: 'inherit' } }, el('b', {}, n), el('span', {}, label));
root.append(el('div', { class: 'cards' },
  card(s.books, 'books', '/admin/books'),
  card(s.files, 'digital files', '/admin/books?filter=files'),
  card(s.physical, 'physical copies', '/admin/books?filter=physical'),
  card(s.audio, 'with audiobook links', '/admin/books?filter=audio'),
  card(s.shelves, 'shelves', '/admin/shelves'),
  card(s.unshelved, 'not on any shelf', '/admin/books?filter=unshelved'),
  card(s.noCover, 'without a cover', '/admin/books?filter=nocover'),
));

const jobsHost = el('div');
const scanBtn = el('button', { class: 'btn primary', onclick: guard(async () => { const { job } = await api('POST', '/scan'); watchJob(job, jobsHost); }) }, 'Scan library folders now');
const enrichBtn = el('button', { class: 'btn', onclick: guard(async () => { const { job } = await api('POST', '/enrich-missing'); watchJob(job, jobsHost); }) }, `Fetch missing covers & details (${s.noCover} without covers)`);

root.append(el('div', { class: 'grid2' },
  el('section', { class: 'panel' },
    el('h2', {}, 'Library folders'),
    el('p', { class: 'muted' }, 'Book files in these folders are added automatically when the server starts. Files stay where they are; nothing is moved or modified.'),
    el('ul', {}, ...s.libraryDirs.map(d => el('li', {}, el('code', {}, d.path), ' ', el('span', { class: `chip ${d.exists ? 'ok' : 'bad'}` }, d.exists ? 'mounted' : 'not found')))),
    s.missingFiles ? el('p', { class: 'small' }, `${s.missingFiles} file(s) that were scanned before can no longer be found. Their books keep their shelf places.`) : null,
    el('div', { class: 'row' }, scanBtn, enrichBtn),
    jobsHost),
  el('section', { class: 'panel' },
    el('h2', {}, 'Quick start'),
    el('ol', {},
      el('li', {}, el('a', { href: '/admin/import' }, 'Import your home Bookcase Database'), ' to recreate your physical shelves.'),
      el('li', {}, el('a', { href: '/admin/add' }, 'Add e-books and PDFs'), ' by uploading them, or put them in a library folder.'),
      el('li', {}, el('a', { href: '/admin/integrations' }, 'Link audiobooks'), ' from Audiobookshelf or Plex.'),
      el('li', {}, el('a', { href: '/admin/media' }, 'Upload decorations'), ' (photos, GIFs, bookends) and ', el('a', { href: '/admin/shelves' }, 'arrange your shelves'), '.'),
      el('li', {}, el('a', { href: '/admin/settings' }, 'Pick a look'), ' for the whole library.')),
  )));

for (const j of s.jobs.filter(j => j.status === 'running')) watchJob(j, jobsHost);
