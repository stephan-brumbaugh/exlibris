import { api, el, guard, toast, app } from './common.js';
import Sortable from '/vendor/sortable.js';

const root = app();
let shelves = await api('GET', '/shelves');

const name = el('input', { placeholder: 'e.g. Science Fiction, Bedroom bookcase, Favourites' , style: { minWidth: '260px' } });
const kind = el('select', {}, el('option', { value: 'manual' }, 'Hand-arranged shelf'), el('option', { value: 'smart' }, 'Smart shelf (fills itself from rules)'));
root.append(el('section', { class: 'panel' }, el('h2', {}, 'New shelf'),
  el('div', { class: 'row' }, name, kind, el('button', { class: 'btn primary', onclick: guard(async () => {
    if (!name.value.trim()) return toast('Give the shelf a name', true);
    const { id } = await api('POST', '/shelves', { name: name.value.trim(), kind: kind.value, rules: kind.value === 'smart' ? { has: 'files' } : {} });
    location.href = `/admin/shelves/${id}`;
  }) }, 'Create')),
  el('p', { class: 'muted small' }, 'Hand-arranged shelves let you drag books, mix spines and covers, add pictures, GIFs and labels. Smart shelves stay up to date automatically (for example “every e-book by Terry Pratchett”, or “everything with an audiobook”).')));

const list = el('div', { class: 'table-wrap' });
root.append(el('p', { class: 'muted small' }, 'Drag rows to change the order bookcases appear on the home page.'), list);

function render() {
  const tbody = el('tbody', {}, ...shelves.map(s => el('tr', { 'data-id': s.id },
    el('td', { style: { cursor: 'grab', width: '24px' }, class: 'muted' }, '⋮⋮'),
    el('td', {}, el('a', { href: `/admin/shelves/${s.id}` }, el('strong', {}, s.name)), s.description ? el('div', { class: 'small muted' }, s.description) : null),
    el('td', {}, el('span', { class: 'chip' }, s.kind === 'smart' ? 'smart' : 'arranged'), s.generated_by?.startsWith('import:') ? el('span', { class: 'chip', style: { marginLeft: '4px' } }, 'from import') : null),
    el('td', {}, s.kind === 'smart' ? '—' : String(s.book_count)),
    el('td', {}, el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: s.is_public, onchange: guard(async e => { await api('PATCH', `/shelves/${s.id}`, { is_public: e.target.checked }); toast(e.target.checked ? 'Now public' : 'Now private'); }) }), 'Public')),
    el('td', { class: 'row' },
      el('a', { class: 'btn small', href: `/admin/shelves/${s.id}` }, 'Arrange & style'),
      el('a', { class: 'btn small', href: `/shelf/${s.slug}`, target: '_blank' }, 'View ↗'),
      el('button', { class: 'btn small danger', onclick: guard(async () => {
        if (!confirm(`Delete the shelf “${s.name}”? The books stay in your library.`)) return;
        await api('DELETE', `/shelves/${s.id}`); shelves = shelves.filter(x => x.id !== s.id); render();
      }) }, 'Delete')))));
  list.replaceChildren(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}), el('th', {}, 'Shelf'), el('th', {}, 'Type'), el('th', {}, 'Books'), el('th', {}, 'Visibility'), el('th', {}))), tbody));
  if (!shelves.length) list.replaceChildren(el('p', { class: 'muted', style: { padding: '20px' } }, 'No shelves yet.'));
  Sortable.create(tbody, { handle: 'td:first-child', animation: 150, onEnd: guard(async () => {
    const ids = [...tbody.children].map(tr => Number(tr.dataset.id));
    await api('POST', '/shelves/reorder', { ids }); shelves.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); toast('Order saved');
  }) });
}
render();
