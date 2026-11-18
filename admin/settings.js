import { api, el, guard, toast, pageData, app } from './common.js';

const root = app();
let { site, autoMetadata } = await api('GET', '/settings');
const presets = pageData.presets;

const title = el('input', { value: site.title });
const tagline = el('input', { value: site.tagline || '' });
const intro = el('textarea', {}); intro.value = site.homeIntro || '';
let preset = site.theme?.preset || 'walnut';
const sw = el('div', { class: 'swatches' });
function drawSwatches() {
  sw.replaceChildren(...Object.entries(presets).map(([k, p]) => el('button', { class: `swatch${preset === k ? ' on' : ''}`, onclick: () => { preset = k; drawSwatches(); } },
    el('div', { class: 'sw', style: { background: p.back === 'transparent' ? p.page : p.back, borderBottom: `6px solid ${p.plank.startsWith('rgba') ? '#9fb0b5' : p.plank}` } },
      ...[p.wood, '#8c3b2b', '#2f4858', p.accent, '#3d5a40'].map((c, i) => el('i', { style: { background: c, height: `${18 + (i * 7) % 14}px` } }))),
    el('div', { class: 'lb' }, p.label))));
}
drawSwatches();
const auto = el('input', { type: 'checkbox', checked: autoMetadata });
const rowH = el('input', { type: 'number', min: 160, max: 380, step: 10, value: site.theme?.rowHeight || 250 });
const lighting = el('select', {}, ...[['', 'Preset default'], ['none', 'Even'], ['warm', 'Warm lamp'], ['cool', 'Cool daylight'], ['spot', 'Shelf spotlights']].map(([v, l]) => el('option', { value: v, selected: (site.theme?.lighting || '') === v }, l)));
const font = el('select', {}, ...[['serif', 'Book serif'], ['classic', 'Garamond'], ['sans', 'Modern sans'], ['typewriter', 'Typewriter']].map(([v, l]) => el('option', { value: v, selected: (site.theme?.font || 'serif') === v }, l)));

root.append(
  el('section', { class: 'panel stack' }, el('h2', {}, 'Library'),
    el('div', { class: 'form-grid' }, el('label', {}, 'Name', title), el('label', {}, 'Tagline', tagline), el('label', { class: 'wide' }, 'Welcome text on the home page (optional)', intro))),
  el('section', { class: 'panel stack' }, el('h2', {}, 'Default look'),
    el('p', { class: 'muted small' }, 'Used by the home page and by every shelf that has not picked its own style.'), sw,
    el('div', { class: 'form-grid' }, el('label', {}, 'Shelf height (px)', rowH), el('label', {}, 'Lighting', lighting), el('label', {}, 'Page font', font))),
  el('section', { class: 'panel stack' }, el('h2', {}, 'Covers & details'),
    el('label', { class: 'inline' }, auto, 'Automatically look up covers, descriptions and page counts for new books'),
    el('p', { class: 'small muted' }, 'Runs after imports, uploads and scans, and every few hours for anything still missing. Each book is looked up once, slowly, on Open Library and Google Books. Page counts prefer the most common hardcover edition, then paperback, and set how thick each spine is drawn.')),
  el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: guard(async () => {
    const theme = { preset, rowHeight: Number(rowH.value) || 250, font: font.value };
    if (lighting.value) theme.lighting = lighting.value;
    site = (await api('PUT', '/settings', { title: title.value, tagline: tagline.value, homeIntro: intro.value, theme, autoMetadata: auto.checked })).site;
    toast('Saved');
  }) }, 'Save settings')),
  el('section', { class: 'panel stack', style: { marginTop: '18px' } }, el('h2', {}, 'Admin password'),
    (() => {
      const cur = el('input', { type: 'password', autocomplete: 'current-password' }), next = el('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
      return el('div', { class: 'row' }, el('label', {}, 'Current', cur), el('label', {}, 'New (8+ characters)', next),
        el('button', { class: 'btn', style: { alignSelf: 'flex-end' }, onclick: guard(async () => { await api('POST', '/password', { current: cur.value, next: next.value }); cur.value = next.value = ''; toast('Password changed. Other sessions were signed out.'); }) }, 'Change'));
    })(),
    el('p', { class: 'small muted' }, 'If you ever get locked out, set ADMIN_PASSWORD in the app’s environment and restart it.')),
);
