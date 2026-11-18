import { api, el, guard, toast, app, fmtIndex } from './common.js';

const root = app();
let pairs = await api('GET', '/copies');
const chosen = new Set();

root.append(el('p', { class: 'muted', style: { maxWidth: '75ch' } },
  'A book you own in print and as an e-book or audiobook is kept as one book, so its card on the home bookcases offers the download, and its card on the digital shelves says where it sits at home. Copies with exactly the same title and author join up by themselves; these are the near-matches that need a yes or no from you.'));
const box = el('div');
root.append(box);

const bookCell = (b, side) => el('td', {},
  el('a', { href: `/admin/books/${b.id}`, target: '_blank' }, el('strong', {}, b.title)),
  el('div', { class: 'small muted' }, [b.authors, b.series ? `${b.series}${b.series_index ? ' #' + fmtIndex(b.series_index) : ''}` : null].filter(Boolean).join(' · ')),
  el('div', { class: 'small' }, side === 'print'
    ? `${b.binding || 'Print'}${b.location ? ` · shelf ${b.location}${b.location_position ? ' #' + b.location_position : ''}` : ''}`
    : [b.formats ? b.formats.toUpperCase().replace(/,/g, ', ') : null, b.audio ? 'audiobook' : null].filter(Boolean).join(' · ')));

function draw() {
  if (!pairs.length) { box.replaceChildren(el('section', { class: 'panel' }, el('p', {}, 'Nothing to match — every digital book either has its print copy joined already, or has no likely print twin.'))); return; }
  const all = el('input', { type: 'checkbox', onchange: () => { pairs.forEach((p, i) => (all.checked ? chosen.add(i) : chosen.delete(i))); draw(); } });
  box.replaceChildren(
    el('div', { class: 'row', style: { marginBottom: '10px' } },
      el('span', {}, `${pairs.length} possible pairs`), el('span', { class: 'spacer' }),
      el('button', { class: 'btn small', onclick: () => { pairs.forEach((p, i) => { if (p.score >= 0.95) chosen.add(i); }); draw(); } }, 'Tick the near-certain ones'),
      el('button', { class: 'btn primary', disabled: !chosen.size, onclick: guard(async () => {
        const list = [...chosen].map(i => pairs[i]);
        if (!confirm(`Join ${list.length} pair(s)? Each digital record's files and links move onto the print book, and the separate digital record is removed.`)) return;
        const r = await api('POST', '/copies/merge', { pairs: list.map(p => ({ keep: p.print.id, drop: p.digital.id })) });
        toast(`Joined ${r.merged}${r.errors.length ? ` — ${r.errors.length} problem(s)` : ''}`, !!r.errors.length);
        chosen.clear(); pairs = await api('GET', '/copies'); draw();
      }) }, `Join ${chosen.size || ''} selected`)),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, all), el('th', {}, 'Print copy (at home)'), el('th', {}, 'Digital copy'), el('th', {}, 'Match'), el('th', {}))),
      el('tbody', {}, ...pairs.map((p, i) => el('tr', {},
        el('td', {}, el('input', { type: 'checkbox', checked: chosen.has(i), onchange: e => { e.target.checked ? chosen.add(i) : chosen.delete(i); draw(); } })),
        bookCell(p.print, 'print'), bookCell(p.digital, 'digital'),
        el('td', {}, el('span', { class: `chip ${p.score >= 0.95 ? 'ok' : 'warn'}` }, `${Math.round(p.score * 100)}%`)),
        el('td', {}, el('button', { class: 'btn small', title: 'Not the same book — stop suggesting this pair', onclick: guard(async () => {
          await api('POST', '/copies/ignore', { keep: p.print.id, drop: p.digital.id }); pairs.splice(i, 1); chosen.clear(); draw();
        }) }, 'Not the same'))))))));
}
draw();
