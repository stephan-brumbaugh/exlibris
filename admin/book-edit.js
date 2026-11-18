import { api, el, guard, toast, pageData, fmtSize, app, generatedCover, uploadForm, dropZone } from './common.js';
import { renderItem } from '/js/shelf-render.js';
import { themeStyle, themeClasses, resolveTheme } from '/js/themes.js';

const root = app();
const id = pageData.id;
let data = await api('GET', `/books/${id}`);
const site = (await api('GET', '/settings')).site;
let media = null;
let dirty = false;

const F = {}; // field inputs
const input = (name, label, attrs = {}) => {
  const tag = attrs.textarea ? 'textarea' : 'input';
  const node = el(tag, { name, ...Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'textarea')), oninput: () => { dirty = true; updatePreview(); } });
  node.value = data.book[name] ?? '';
  F[name] = node;
  return el('label', { class: attrs.wide || attrs.textarea ? 'wide' : '' }, label, node);
};

const preview = el('div', { class: 'preview' });
function currentDraft() {
  const b = { ...data.preview };
  const v = k => F[k]?.value || null;
  Object.assign(b, { title: v('title') || 'Untitled', authors: v('authors'), series: v('series'), binding: v('binding') });
  b.spine = { ...b.spine, color: v('spine_color') || b.spine.color, text: v('spine_text_color') || b.spine.text };
  return b;
}
function updatePreview() {
  const b = currentDraft();
  const t = resolveTheme(site.theme || {}, {});
  const bc = el('div', { class: themeClasses(t), style: `${themeStyle({ ...t, rowHeight: 260 })};background:none` },
    el('div', { class: 'bc-rows', style: { minHeight: '0', background: 'none', boxShadow: 'none', padding: 0 } }, renderItem({ id: 'p', kind: 'book', display: 'spine', book: b }, { rowH: 260, editable: true })));
  preview.replaceChildren(bc, b.cover ? el('img', { src: b.cover, alt: 'Cover' }) : generatedCover(b));
}

const coverBtns = el('div', { class: 'stack' },
  el('button', { class: 'btn primary', onclick: () => findOnline() }, '🔍 Find cover & details online'),
  el('div', { class: 'row' },
    el('label', { class: 'btn', style: { flexDirection: 'row' } }, 'Upload cover', el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: guard(async e => {
      const f = e.target.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('cover', f);
      const r = await uploadForm(`/books/${id}/cover`, fd);
      data.preview.cover = r.cover; data.preview.spine.color = data.book.spine_color || r.color || data.preview.spine.color; updatePreview(); toast('Cover updated');
    }) })),
    el('button', { class: 'btn', onclick: guard(async () => {
      const url = prompt('Paste an image URL'); if (!url) return;
      const r = await api('POST', `/books/${id}/cover`, { url });
      data.preview.cover = r.cover; updatePreview(); toast('Cover updated');
    }) }, 'From URL'),
    el('button', { class: 'btn danger', onclick: guard(async () => { if (!confirm('Remove the cover?')) return; await api('DELETE', `/books/${id}/cover`); data.preview.cover = null; updatePreview(); }) }, 'Remove')));

const results = el('div');
async function findOnline(title, authors, isbn) {
  results.replaceChildren(el('p', { class: 'muted' }, 'Searching Open Library and Google Books…'));
  const qs = new URLSearchParams({ title: title ?? F.title.value, authors: authors ?? F.authors.value, ...(isbn ? { isbn } : {}) });
  try {
    const cands = await api('GET', `/books/${id}/lookup?${qs}`);
    const tIn = el('input', { value: title ?? F.title.value }), aIn = el('input', { value: authors ?? F.authors.value }), iIn = el('input', { placeholder: 'ISBN', value: isbn || '' });
    const replace = el('input', { type: 'checkbox' });
    results.replaceChildren(
      el('div', { class: 'row', style: { marginBottom: '8px' } }, tIn, aIn, iIn, el('button', { class: 'btn small', onclick: () => findOnline(tIn.value, aIn.value, iIn.value) }, 'Search again')),
      el('label', { class: 'inline small' }, replace, 'Replace the current cover'),
      cands.length ? el('div', {}, ...cands.slice(0, 10).map(c => el('div', { class: 'cand' },
        c.coverUrl ? el('img', { src: c.coverUrl.replace('-L.jpg', '-M.jpg'), alt: '', loading: 'lazy' }) : el('div', { class: 'ph', style: { width: '54px', height: '80px', background: 'var(--chip)' } }),
        el('div', {}, el('strong', {}, c.title), el('div', { class: 'small muted' }, [c.authors, c.year, c.publisher, c.pages ? `${c.pages} pp` : null, c.isbn].filter(Boolean).join(' · ')),
          el('div', { class: 'small muted' }, `${c.source === 'google' ? 'Google Books' : 'Open Library'} · match ${Math.round(c.score * 100)}%`)),
        el('div', { class: 'stack' },
          el('button', { class: 'btn small primary', onclick: guard(() => apply(c, false, replace.checked)) }, 'Fill blanks'),
          el('button', { class: 'btn small', onclick: guard(() => apply(c, true, replace.checked)) }, 'Overwrite'))))) : el('p', { class: 'muted' }, 'Nothing found. Try a shorter title or an ISBN.'));
  } catch (e) { results.replaceChildren(el('p', { class: 'err' }, e.message)); }
}
async function apply(c, overwrite, replaceCover) {
  const r = await api('POST', `/books/${id}/apply`, { candidate: c, overwrite, replaceCover });
  toast(r.applied.length ? `Updated: ${r.applied.join(', ')}` : 'Nothing new to add');
  data = await api('GET', `/books/${id}`); render();
}

function filesPanel() {
  const list = el('div', { class: 'stack' }, ...data.files.map(f => el('div', { class: 'row' },
    el('span', { class: 'chip' }, f.format.toUpperCase()),
    el('span', { class: 'small', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: f.path }, f.path.split('/').pop()),
    el('span', { class: 'small muted' }, fmtSize(f.size)),
    f.missing ? el('span', { class: 'chip bad' }, 'missing') : el('a', { class: 'btn small', href: `/files/${f.id}/download` }, 'Download'),
    el('button', { class: 'btn small danger', onclick: guard(async () => {
      if (!confirm(f.origin === 'upload' ? 'Delete this uploaded file?' : 'Remove this file from the book? (It stays in your library folder.)')) return;
      const r = await api('DELETE', `/files/${f.id}`); if (r.note) toast(r.note); data = await api('GET', `/books/${id}`); render();
    }) }, 'Remove'))));
  const zone = dropZone({ accept: '.epub,.pdf,.mobi,.azw3,.cbz,.cbr,.djvu,.fb2,.txt,.m4b,.mp3', label: el('span', {}, el('b', {}, 'Add a file to this book'), ' — drop it here or click'), onFiles: guard(async files => {
    const fd = new FormData(); files.forEach(f => fd.append('files', f));
    toast('Uploading…');
    await uploadForm(`/books/${id}/files`, fd);
    data = await api('GET', `/books/${id}`); render(); toast('File added');
  }) });
  return el('section', { class: 'panel' }, el('h2', {}, 'Files'), data.files.length ? list : el('p', { class: 'muted' }, 'No digital files. This book shows as a physical or audio-only title.'), zone);
}

function linksEditor() {
  let links = []; try { links = JSON.parse(data.book.other_links || '[]'); } catch { /* */ }
  const box = el('div', { class: 'stack wide' });
  const draw = () => box.replaceChildren(...links.map((l, i) => el('div', { class: 'row' },
    el('input', { placeholder: 'Label', value: l.label || '', oninput: e => { l.label = e.target.value; dirty = true; } }),
    el('input', { placeholder: 'https://…', value: l.url || '', style: { flex: 1 }, oninput: e => { l.url = e.target.value; dirty = true; } }),
    el('button', { class: 'btn small', onclick: () => { links.splice(i, 1); dirty = true; draw(); } }, '✕'))),
    el('button', { class: 'btn small', onclick: () => { links.push({ label: '', url: '' }); draw(); } }, '+ Add another link'));
  draw();
  box.getLinks = () => links.filter(l => l.url);
  return box;
}

async function pickSpineImage() {
  media = media || await api('GET', '/media');
  const dlg = el('dialog', { style: { maxWidth: '720px', width: '90vw' } },
    el('h2', {}, 'Choose a spine image'), el('p', { class: 'muted small' }, 'A tall, narrow image works best. Upload images on the Decorations page.'),
    el('div', { class: 'media-grid' }, ...media.map(m => el('div', { class: 'media-tile pick', onclick: () => { F.spine_image.value = m.id; dirty = true; spineImgLabel(); dlg.close(); } },
      el('div', { class: 'img' }, el('img', { src: m.url, alt: '' })), el('div', { class: 'name' }, m.original_name)))),
    el('div', { class: 'row end', style: { marginTop: '12px' } }, el('button', { class: 'btn', onclick: () => { F.spine_image.value = ''; dirty = true; spineImgLabel(); dlg.close(); } }, 'No image'), el('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel')));
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
}
const spineImgText = el('span', { class: 'small muted' });
function spineImgLabel() { spineImgText.textContent = F.spine_image.value ? `Using image #${F.spine_image.value}` : 'Generated spine'; }

function render() {
  dirty = false;
  const b = data.book;
  const links = linksEditor();
  const hidden = el('input', { type: 'checkbox', checked: !!b.hidden, onchange: () => { dirty = true; } });
  F.spine_image = el('input', { type: 'hidden', value: b.spine_image ?? '' });
  const colorPair = (name, label) => {
    const txt = el('input', { name, value: b[name] || '', placeholder: 'auto', style: { width: '90px' }, oninput: () => { color.value = /^#[0-9a-f]{6}$/i.test(txt.value) ? txt.value : color.value; dirty = true; updatePreview(); } });
    const color = el('input', { type: 'color', value: b[name] || data.preview.spine[name === 'spine_color' ? 'color' : 'text'] || '#5a3a24', oninput: () => { txt.value = color.value; dirty = true; updatePreview(); } });
    F[name] = txt;
    return el('label', {}, label, el('div', { class: 'row' }, color, txt, el('button', { class: 'btn small', onclick: () => { txt.value = ''; dirty = true; updatePreview(); } }, 'Auto')));
  };
  const save = guard(async () => {
    const body = {};
    for (const [k, n] of Object.entries(F)) body[k] = n.value;
    body.hidden = hidden.checked ? 1 : 0;
    body.other_links = links.getLinks();
    const r = await api('PATCH', `/books/${id}`, body);
    data.book = r.book; dirty = false; toast('Saved');
    data = await api('GET', `/books/${id}`); updatePreview();
  });
  const audibleSearch = () => `https://www.audible.com/search?keywords=${encodeURIComponent(`${F.title?.value || b.title} ${F.authors?.value || b.authors || ''}`)}`;

  root.replaceChildren(
    el('div', { class: 'row', style: { marginBottom: '14px' } },
      el('a', { href: '/admin/books' }, '← All books'), el('span', { class: 'spacer' }),
      el('a', { class: 'btn', href: `/book/${id}`, target: '_blank' }, 'View on site ↗'),
      el('button', { class: 'btn danger', onclick: guard(async () => {
        if (!confirm(`Delete “${b.title}”? Files in library folders are not touched.`)) return;
        const files = data.files.some(f => f.origin === 'upload') && confirm('Also delete the files uploaded for this book?');
        await api('DELETE', `/books/${id}${files ? '?deleteFiles=1' : ''}`); location.href = '/admin/books';
      }) }, 'Delete'),
      el('button', { class: 'btn primary', onclick: save }, 'Save')),
    el('div', { class: 'edit-layout' },
      el('div', { class: 'edit-cover' }, preview, coverBtns,
        data.shelves.length ? el('div', { class: 'small' }, 'On shelves: ', ...data.shelves.flatMap((s, i) => [i ? ', ' : '', el('a', { href: `/admin/shelves/${s.id}` }, s.name)])) : el('div', { class: 'small muted' }, 'Not on any shelf yet.')),
      el('div', {},
        el('section', { class: 'panel', id: 'lookup' }, results),
        el('section', { class: 'panel' }, el('h2', {}, 'Book'), el('div', { class: 'form-grid' },
          input('title', 'Title', { wide: true }), input('subtitle', 'Subtitle', { wide: true }), input('authors', 'Author(s) — separate with ;'),
          input('series', 'Series'), input('series_index', 'Number in series', { type: 'number', step: 'any' }),
          input('description', 'Description', { textarea: true }),
          input('publisher', 'Publisher'), input('published', 'Published (year or date)'), input('isbn', 'ISBN'), input('pages', 'Pages', { type: 'number' }),
          input('language', 'Language'), input('tags', 'Tags — comma separated', { wide: true }))),
        el('section', { class: 'panel' }, el('h2', {}, 'At home'), el('p', { class: 'muted small' }, 'Where the physical copy lives. Leave blank for digital-only books.'),
          el('div', { class: 'form-grid' },
            (() => { const l = input('binding', 'Format', { list: 'bindings' }); l.append(el('datalist', { id: 'bindings' }, ...['Hardback', 'Paperback', 'Ebook', 'Audiobook', 'Other'].map(v => el('option', { value: v })))); return l; })(),
            input('room', 'Room'), input('location', 'Shelf code (e.g. B3)'), input('location_position', 'Position from left', { type: 'number' }))),
        el('section', { class: 'panel' }, el('h2', {}, 'Listen'), el('div', { class: 'form-grid' },
          input('abs_url', 'Audiobookshelf link', { wide: true, type: 'url' }), input('plex_url', 'Plex link', { wide: true, type: 'url' }),
          (() => { const l = input('audible_url', 'Audible link', { wide: true, type: 'url' }); l.append(el('a', { class: 'small', href: '#', onclick: e => { e.preventDefault(); window.open(audibleSearch(), '_blank', 'noopener'); } }, 'Search Audible for this title ↗')); return l; })(),
          el('div', { class: 'wide' }, el('h3', {}, 'Other links'), links))),
        el('section', { class: 'panel' }, el('h2', {}, 'Spine'), el('div', { class: 'form-grid' },
          colorPair('spine_color', 'Spine colour (auto = series colour)'), colorPair('spine_text_color', 'Lettering colour'),
          el('label', {}, 'Custom spine image', el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: pickSpineImage }, 'Choose…'), spineImgText), F.spine_image))),
        filesPanel(),
        el('section', { class: 'panel' }, el('h2', {}, 'Private'), el('div', { class: 'form-grid' },
          input('notes', 'Notes (never shown publicly)', { textarea: true }),
          el('label', { class: 'inline' }, hidden, 'Hide this book from the public site'))))),
  );
  spineImgLabel();
  updatePreview();
  results.replaceChildren(el('div', { class: 'row' }, el('span', { class: 'muted' }, 'Missing a cover or description?'), el('button', { class: 'btn small', onclick: () => findOnline() }, 'Search online')));
}
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); root.querySelector('.btn.primary')?.click(); } });
render();
