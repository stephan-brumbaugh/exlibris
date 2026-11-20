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
  const small = Math.max(7, Math.min(11, Math.round(w * 0.27)));
  const spine = el('div', {
    class: `spine sp-${s.style} sp-v${s.v}${s.image ? ' sp-img' : ''}${w < 24 ? ' sp-narrow' : ''}`,
    style: { '--w': `${w}px`, '--hr': s.h, '--c': s.color, '--t': s.text, '--fs': `${fs}px`, '--fs-s': `${small}px`, ...(s.image ? { backgroundImage: `url(${s.image})` } : {}) },
  });
  if (!s.image) {
    const last = surname(book.authors);
    const num = book.series && book.series_index ? `#${fmtIndex(book.series_index)}` : '';
    // Title (and, on wider spines, the series name) run down the spine; the author's surname and the
    // number in the series sit across the foot, as on a real spine.
    const cols = el('span', { class: 'sp-cols' }, el('span', { class: 'sp-title' }, book.title),
      book.series && w >= 26 ? el('span', { class: 'sp-series' }, book.series) : null);
    spine.append(...[
      el('span', { class: 'sp-top' }),
      cols,
      (last || num) ? el('span', { class: 'sp-foot' }, last ? el('span', { class: 'sp-author' }, w < 24 ? last.slice(0, 3) : last) : null, num ? el('span', { class: 'sp-num' }, num) : null) : null,
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
    const cls = `item decor dz-${item.size || 'm'}${item.raise ? ' decor-raised' : ''}`;
    // "raise" lifts a picture up the back panel (0 = standing on the shelf, 100 = hung near the top).
    const style = item.raise ? { '--raise': item.raise / 100 } : null;
    if (item.link && !editable) return el('a', { ...common, class: cls, style, href: item.link, target: '_blank', rel: 'noopener' }, body);
    return el('div', { ...common, class: cls, style, 'data-media': item.media.url, tabindex: editable ? null : '0', role: editable ? null : 'button', 'aria-label': editable ? null : `View ${item.text || 'picture'} full size` }, body);
  }
  if (item.kind === 'space') {
    const w = Math.round((item.width || 40) * (rowH / REF_ROW));
    return el('div', { ...common, class: 'item space', style: { width: `${w}px` } }, editable ? el('span', { class: 'space-hint' }, '↔') : null);
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
export function fillRows(rowsEl, rowH, minRows = 2, scale = 1) {
  rowsEl.style.minHeight = '';
  const needed = Math.max(rowsEl.scrollHeight, (window.innerHeight - rowsEl.getBoundingClientRect().top - 40) / (scale || 1), rowH * minRows);
  rowsEl.style.minHeight = `${Math.ceil(needed / rowH) * rowH}px`;
}

/**
 * Fixed layout: the bookcase is always laid out at the same width (so a shelf ends where you ended it,
 * on any screen), then scaled down to fit. Wraps `root` in a sizer and returns it plus a refit function.
 */
export function scaledBookcase(root, getAvailable = null) {
  const sizer = el('div', { class: 'bc-sizer' }, root);
  let scale = 1;
  const fit = () => {
    root.style.transform = '';
    const natural = root.offsetWidth;
    const avail = getAvailable ? getAvailable() : sizer.parentElement?.clientWidth;
    scale = natural && avail ? Math.min(1, avail / natural) : 1;
    root.style.transform = scale < 1 ? `scale(${scale})` : '';
    sizer.style.width = `${Math.round(natural * scale)}px`;
    sizer.style.height = `${Math.round(root.offsetHeight * scale)}px`;
    return scale;
  };
  if ('ResizeObserver' in window) new ResizeObserver(() => { sizer.style.height = `${Math.round(root.offsetHeight * scale)}px`; }).observe(root);
  return { sizer, fit, scale: () => scale };
}
