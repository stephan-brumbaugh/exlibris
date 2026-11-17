// Renders shelf items into a flex-wrap "bookcase". Shared by the public site and the admin shelf builder.

const REF_ROW = 250; // spine widths from the server are in px at this row height

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined || sv === null) continue;
        if (sk.startsWith('--')) n.style.setProperty(sk, sv); else n.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

export function surname(authors) {
  const first = String(authors || '').split(/;|&/)[0].trim();
  if (!first) return '';
  if (first.includes(',')) return first.split(',')[0].trim();
  return first.split(/\s+/).pop();
}

export function effectiveDisplay(item, shelfDisplay, viewOverride) {
  if (viewOverride === 'spine' || viewOverride === 'cover') return viewOverride;
  if (item.display === 'spine' || item.display === 'cover') return item.display;
  return shelfDisplay === 'cover' ? 'cover' : 'spine';
}

function spineEl(book, rowH) {
  const s = book.spine;
  const scale = rowH / REF_ROW;
  const w = Math.max(12, Math.round(s.w * scale));
  const fs = Math.max(8, Math.min(16, Math.round(w * 0.42)));
  const spine = el('div', {
    class: `spine sp-${s.style} sp-v${s.v}${s.image ? ' sp-img' : ''}`,
    style: { '--w': `${w}px`, '--hr': s.h, '--c': s.color, '--t': s.text, '--fs': `${fs}px`, ...(s.image ? { backgroundImage: `url(${s.image})` } : {}) },
  });
  if (!s.image) {
    spine.append(...[
      el('span', { class: 'sp-top' }),
      el('span', { class: 'sp-title' }, book.title),
      book.authors ? el('span', { class: 'sp-author' }, surname(book.authors)) : null,
      el('span', { class: 'sp-bottom' }),
    ].filter(Boolean));
  }
  return spine;
}

export function generatedCover(book, extraClass = '') {
  const s = book.spine || {};
  return el('div', { class: `gen-cover ${extraClass}`, style: { '--c': s.color || '#5a3a24', '--t': s.text || '#f4ecd8' } },
    el('div', { class: 'gc-frame' },
      el('div', { class: 'gc-title' }, book.title),
      book.series ? el('div', { class: 'gc-series' }, book.series + (book.series_index ? ` · ${fmtIndex(book.series_index)}` : '')) : null,
      el('div', { class: 'gc-author' }, book.authors || '')));
}

export function fmtIndex(n) { return Number.isInteger(n) ? String(n) : String(n).replace(/\.0+$/, ''); }

function coverEl(book) {
  if (book.cover) {
    const img = el('img', { src: book.cover, alt: book.title, loading: 'lazy', decoding: 'async', draggable: 'false' });
    return el('div', { class: 'cover', style: { '--hr': Math.min(0.95, (book.spine?.h || 0.85) + 0.04) } }, img);
  }
  return el('div', { class: 'cover cover-gen', style: { '--hr': Math.min(0.95, (book.spine?.h || 0.85) + 0.04) } }, generatedCover(book));
}

/**
 * @param item  {kind, display, book?, media?, text?, size?, link?}
 * @param opts  {shelfDisplay, viewOverride, rowH, hrefBase, editable}
 */
export function renderItem(item, opts) {
  const { shelfDisplay = 'mixed', viewOverride = null, rowH = 250, editable = false } = opts;
  const common = { 'data-item-id': item.id, 'data-kind': item.kind };
  if (item.kind === 'book') {
    const b = item.book;
    const disp = effectiveDisplay(item, shelfDisplay, viewOverride);
    const inner = disp === 'cover' ? coverEl(b) : spineEl(b, rowH);
    const attrs = { ...common, class: `item book is-${disp}`, 'data-book-id': b.id, title: `${b.title}${b.authors ? ' — ' + b.authors : ''}` };
    if (editable) return el('div', attrs, inner);
    return el('a', { ...attrs, href: `/book/${b.id}`, 'aria-label': `${b.title}${b.authors ? ' by ' + b.authors : ''}` }, inner);
  }
  if (item.kind === 'decor') {
    const img = el('img', { src: item.media.url, alt: item.text || '', loading: 'lazy', draggable: 'false' });
    const body = el('figure', { class: 'decor-fig' }, img, item.text ? el('figcaption', {}, item.text) : null);
    const cls = `item decor dz-${item.size || 'm'}`;
    if (item.link && !editable) return el('a', { ...common, class: cls, href: item.link, target: '_blank', rel: 'noopener' }, body);
    return el('div', { ...common, class: cls }, body);
  }
  if (item.kind === 'label') {
    return el('div', { ...common, class: `item label lb-${item.size || 'plaque'}` }, el('span', { class: 'lb-inner' }, item.text || ''));
  }
  if (item.kind === 'break') {
    return el('div', { ...common, class: `break${item.size === 'row' ? ' break-row' : ''}` }, editable ? el('span', { class: 'break-hint' }, item.size === 'row' ? 'empty shelf' : 'new shelf ↵') : null);
  }
  return el('div', common);
}

export function renderShelf(container, items, opts) {
  container.replaceChildren(...items.map(it => renderItem(it, opts)));
}

/** Pad the rows area to a whole number of shelves that fills the viewport (the "infinite" bookcase). */
export function fillRows(rowsEl, rowH, minRows = 2) {
  rowsEl.style.minHeight = '';
  const needed = Math.max(rowsEl.scrollHeight, window.innerHeight - rowsEl.getBoundingClientRect().top - 40, rowH * minRows);
  rowsEl.style.minHeight = `${Math.ceil(needed / rowH) * rowH}px`;
}
