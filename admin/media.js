import { api, el, guard, toast, app, dropZone, uploadForm } from './common.js';

const root = app();
const grid = el('div', { class: 'media-grid' });
let media = await api('GET', '/media');

function draw() {
  grid.replaceChildren(...media.map(m => el('div', { class: 'media-tile' },
    el('div', { class: 'img' }, el('img', { src: m.url, alt: m.original_name || '', loading: 'lazy' })),
    el('div', { class: 'name', title: m.original_name }, m.original_name || `#${m.id}`),
    el('div', { class: 'row small muted' }, m.width ? `${m.width}×${m.height}` : 'vector', m.animated ? el('span', { class: 'chip ok' }, 'animated') : null, el('span', { class: 'spacer' }),
      el('button', { class: 'btn small danger', title: 'Delete', onclick: guard(async () => {
        if (!confirm('Delete this image? It will also disappear from any shelf it decorates.')) return;
        await api('DELETE', `/media/${m.id}`); media = media.filter(x => x.id !== m.id); draw();
      }) }, '✕')))));
  if (!media.length) grid.append(el('p', { class: 'muted' }, 'Nothing uploaded yet.'));
}

root.append(
  el('section', { class: 'panel stack' },
    el('p', { class: 'muted' }, 'Pictures, transparent PNGs and animated GIFs to place on your shelves — bookends, plants, framed photos, a sleeping cat. They can also be used as the back panel of a bookcase, the wallpaper around it, or a custom book spine.'),
    dropZone({ accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif', label: el('div', {}, el('b', {}, 'Drop images here'), el('br'), 'PNG, JPG, GIF (animated is fine), WebP, SVG'), onFiles: guard(async files => {
      const fd = new FormData(); files.forEach(f => fd.append('files', f));
      const r = await uploadForm('/media', fd);
      const bad = r.results.filter(x => x.error);
      if (bad.length) toast(bad.map(b => `${b.name}: ${b.error}`).join('\n'), true);
      media = await api('GET', '/media'); draw(); toast(`Uploaded ${r.results.length - bad.length} image(s)`);
    }) }),
    el('p', { class: 'small muted' }, 'Tip: images with transparent backgrounds look best standing on a shelf.')),
  grid);
draw();
