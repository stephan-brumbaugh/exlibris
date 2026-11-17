import { api, el, guard, toast, pageData, app, dropZone, uploadForm, watchJob } from './common.js';

const root = app();
const shelves = (await api('GET', '/shelves')).filter(s => s.kind === 'manual');
const shelfSel = el('select', {}, el('option', { value: '' }, "Don't add to a shelf"), ...shelves.map(s => el('option', { value: s.id }, s.name)));
const results = el('div', { class: 'stack' });
const progress = el('div', { class: 'bar', style: { display: 'none' } }, el('i', { style: { width: '0%' } }));

async function send(files) {
  // Upload in batches so one huge drop doesn't become one huge request.
  const batches = [];
  let cur = [], size = 0;
  for (const f of files) { if (cur.length && (size + f.size > 300e6 || cur.length >= 20)) { batches.push(cur); cur = []; size = 0; } cur.push(f); size += f.size; }
  if (cur.length) batches.push(cur);
  progress.style.display = 'block';
  let done = 0;
  for (const b of batches) {
    const fd = new FormData();
    b.forEach(f => fd.append('files', f));
    if (shelfSel.value) fd.append('shelfId', shelfSel.value);
    try {
      const r = await uploadForm('/upload', fd, p => { progress.firstChild.style.width = `${Math.round(((done + p * b.length) / files.length) * 100)}%`; });
      for (const x of r.results) results.prepend(el('div', { class: 'row panel', style: { padding: '8px 12px', margin: 0 } },
        x.cover ? el('img', { src: x.cover, alt: '', style: { width: '34px', height: '50px', objectFit: 'cover', borderRadius: '2px' } }) : null,
        el('div', { style: { flex: 1 } }, x.bookId ? el('a', { href: `/admin/books/${x.bookId}` }, x.title || x.name) : el('span', {}, x.name),
          x.authors ? el('div', { class: 'small muted' }, x.authors) : null),
        el('span', { class: `chip ${x.error ? 'bad' : 'ok'}` }, x.error || ({ added: 'new book', attached: 'added to existing book', unchanged: 'already here', updated: 'updated' }[x.status] || x.status))));
    } catch (e) { toast(e.message, true); }
    done += b.length;
  }
  progress.firstChild.style.width = '100%';
  toast(`Finished ${files.length} file(s)`);
}

const jobs = el('div');
root.append(
  el('section', { class: 'panel stack' },
    el('h2', {}, 'Upload'),
    dropZone({ accept: pageData.extensions.map(e => '.' + e).join(','), label: el('div', {}, el('b', {}, 'Drop e-books, PDFs and comics here'), el('br'), `or click to choose files — ${pageData.extensions.join(', ')}`), onFiles: guard(send) }),
    el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Put new books on:'), shelfSel),
    progress,
    el('p', { class: 'small muted' }, 'Covers, titles, authors and series are read from the files. If another format of the same book is already here (same title and author), the file is added to that book instead of making a duplicate.')),
  el('section', { class: 'panel stack' },
    el('h2', {}, 'Library folders'),
    el('p', { class: 'muted' }, 'Anything in these folders (and their subfolders) is picked up automatically. Calibre libraries work as-is, including their metadata.opf and cover.jpg files.'),
    el('ul', {}, ...pageData.libraryDirs.map(d => el('li', {}, el('code', {}, d)))),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: guard(async () => { const { job } = await api('POST', '/scan'); watchJob(job, jobs); }) }, 'Scan now')),
    jobs),
  el('section', { class: 'panel stack' },
    el('h2', {}, 'Add a book by hand'),
    el('p', { class: 'muted' }, 'For a physical book, an Audible-only title, or anything without a file.'),
    (() => {
      const t = el('input', { placeholder: 'Title' }), a = el('input', { placeholder: 'Author' }), b = el('select', {}, ...['Hardback', 'Paperback', 'Audiobook', 'Ebook', 'Other'].map(x => el('option', {}, x)));
      return el('div', { class: 'row' }, t, a, b, el('button', { class: 'btn', onclick: guard(async () => {
        if (!t.value.trim()) return toast('Enter a title', true);
        const { id } = await api('POST', '/books', { title: t.value, authors: a.value, binding: b.value });
        if (shelfSel.value) await api('POST', `/shelves/${shelfSel.value}/books`, { ids: [id] });
        location.href = `/admin/books/${id}`;
      }) }, 'Create'));
    })()),
  el('h2', {}, 'Results'), results);
