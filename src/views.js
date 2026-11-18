import { escapeHtml as h } from './util.js';
import { siteSettings } from './db.js';
import { resolveTheme, pageStyle } from '../public/js/themes.js';

const V = Date.now().toString(36); // cache-buster per process start

function json(data) {
  // Safe to embed inside <script type="application/json">
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function publicPage({ title, body, data = {}, theme = null, script = 'public.js', bodyClass = '' }) {
  const site = siteSettings();
  const t = theme || resolveTheme(site.theme || {}, {});
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title ? `${title} · ${site.title}` : site.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/site.css?v=${V}">
<link rel="stylesheet" href="/css/shelf.css?v=${V}">
</head>
<body class="pub ${h(bodyClass)}${t.wallpaper ? ' has-wallpaper' : ''}" style="${h(pageStyle(t))}">
<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">❦</span><span>${h(site.title)}</span></a>
  <form class="search" action="/search" method="get" role="search">
    <input type="search" name="q" placeholder="Search the library…" aria-label="Search the library" value="${h(data.q || '')}">
  </form>
</header>
<main id="main">${body}</main>
<script type="application/json" id="page-data">${json({ site: { title: site.title, tagline: site.tagline }, ...data })}</script>
<script type="module" src="/js/${script}?v=${V}"></script>
</body>
</html>`;
}

export function adminPage({ title, body, data = {}, script = null, active = '' }) {
  const site = siteSettings();
  const nav = [
    ['/admin', 'Dashboard', 'dash'], ['/admin/books', 'Books', 'books'], ['/admin/shelves', 'Shelves', 'shelves'], ['/admin/series', 'Series', 'series'], ['/admin/reorganise', 'Reorganise at home', 'reorg'],
    ['/admin/add', 'Add books', 'add'], ['/admin/media', 'Decorations', 'media'], ['/admin/import', 'Import', 'import'],
    ['/admin/integrations', 'Audio links', 'integrations'], ['/admin/settings', 'Settings', 'settings'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · ${h(site.title)} admin</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/shelf.css?v=${V}">
<link rel="stylesheet" href="/css/admin.css?v=${V}">
</head>
<body class="adm">
<aside class="side">
  <a class="brand" href="/admin"><span class="brand-mark">❦</span> ${h(site.title)}</a>
  <nav>${nav.map(([href, label, key]) => `<a href="${href}"${key === active ? ' class="on"' : ''}>${label}</a>`).join('')}</nav>
  <div class="side-foot">
    <a href="/" target="_blank" rel="noopener">View public site ↗</a>
    <form method="post" action="/admin/logout"><button class="linkish">Sign out</button></form>
    <span class="muted small" title="Build of the running app">Version ${h(String(process.env.APP_VERSION || 'dev').slice(0, 7))}</span>
  </div>
</aside>
<main class="content">
<h1 class="page-title">${h(title)}</h1>
${body}
</main>
<div id="toasts" aria-live="polite"></div>
<script type="application/json" id="page-data">${json(data)}</script>
${script ? `<script type="module" src="/admin-js/${script}?v=${V}"></script>` : ''}
</body>
</html>`;
}

export function loginPage({ setup = false, error = '', next = '/admin' }) {
  const site = siteSettings();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${setup ? 'Set up' : 'Sign in'} · ${h(site.title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/css/admin.css?v=${V}"></head>
<body class="login-body"><form class="login-card" method="post" action="${setup ? '/admin/setup' : '/admin/login'}">
<div class="brand big"><span class="brand-mark">❦</span> ${h(site.title)}</div>
<p>${setup ? 'Welcome. Choose an admin password to finish setting up your library.' : 'Sign in to manage your library.'}</p>
${error ? `<p class="err">${h(error)}</p>` : ''}
<input type="hidden" name="next" value="${h(next)}">
<label>Password<input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 8 : 1}" autofocus></label>
${setup ? '<label>Confirm password<input type="password" name="confirm" autocomplete="new-password" required minlength="8"></label>' : ''}
<button class="btn primary" type="submit">${setup ? 'Save and continue' : 'Sign in'}</button>
<a class="muted" href="/">← Back to the library</a>
</form></body></html>`;
}
