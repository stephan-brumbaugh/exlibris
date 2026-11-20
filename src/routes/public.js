import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../config.js';
import { getDb, siteSettings } from '../db.js';
import { getBook, bookFiles, publicBook, queryBooks, withFiles } from '../books.js';
import { listShelves, getShelf, shelfItems, shelvesForBook } from '../shelves.js';
import { publicPage } from '../views.js';
import { resolveTheme } from '../../public/js/themes.js';
import { escapeHtml as h, safeFilename } from '../util.js';
import { isAuthed } from '../auth.js';

export const publicRouter = express.Router();

/** Visitors who aren't signed in can download only when the library allows it. */
export const canDownload = req => siteSettings().publicDownloads !== false || isAuthed(req);

// A private library: everything except the health check and login sends visitors to sign in.
publicRouter.use((req, res, next) => {
  if (siteSettings().publicLibrary !== false || isAuthed(req) || req.path === '/healthz') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) return res.status(401).json({ error: 'This library is private' });
  if (req.path.startsWith('/covers/') || req.path.startsWith('/media/')) return res.status(401).end();
  res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
});

const MIME = { epub: 'application/epub+zip', pdf: 'application/pdf', mobi: 'application/x-mobipocket-ebook', azw3: 'application/vnd.amazon.ebook',
  azw: 'application/vnd.amazon.ebook', cbz: 'application/vnd.comicbook+zip', cbr: 'application/vnd.comicbook-rar', djvu: 'image/vnd.djvu',
  fb2: 'application/x-fictionbook+xml', txt: 'text/plain; charset=utf-8', rtf: 'application/rtf', m4b: 'audio/mp4', mp3: 'audio/mpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

function shelfPayload(shelf, { previewLimit = null } = {}) {
  let items = shelfItems(shelf);
  const total = items.filter(i => i.kind === 'book').length;
  if (previewLimit) {
    // Stop at the first shelf break after the limit so previews end cleanly.
    items = items.slice(0, previewLimit).filter(i => i.kind !== 'break');
  }
  return {
    shelf: { id: shelf.id, slug: shelf.slug, name: shelf.name, description: shelf.description, display: shelf.display, kind: shelf.kind, collection: shelf.collection },
    theme: resolveTheme(siteSettings().theme || {}, shelf.theme || {}),
    items, total,
  };
}

publicRouter.get('/', (req, res) => {
  const site = siteSettings();
  const shelves = listShelves({ publicOnly: true }).map(s => shelfPayload(s, { previewLimit: 28 }));
  const counts = getDb().prepare(`SELECT COUNT(*) AS books,
      SUM(EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = b.id AND f.missing = 0)) AS digital,
      SUM(COALESCE(abs_url,'') <> '' OR COALESCE(plex_url,'') <> '' OR COALESCE(audible_url,'') <> '') AS audio,
      SUM(COALESCE(location,'') <> '') AS physical FROM books b WHERE hidden = 0`).get();
  const recent = withFiles(queryBooks({ has: 'cover' }, { sort: 'added', limit: 18 }));
  res.send(publicPage({
    title: '', bodyClass: 'home',
    body: `<section class="hero"><h1>${h(site.title)}</h1>${site.tagline ? `<p class="tagline">${h(site.tagline)}</p>` : ''}
      ${site.homeIntro ? `<div class="intro">${h(site.homeIntro).replace(/\n/g, '<br>')}</div>` : ''}
      <p class="stats" id="stats"></p></section>
      <div id="hall"></div>
      <section id="recent" class="recent" aria-label="Recently added"></section>`,
    data: { page: 'home', shelves, counts, recent, theme: resolveTheme(site.theme || {}, {}) },
  }));
});

publicRouter.get('/shelf/:slug', (req, res, next) => {
  const shelf = getShelf(req.params.slug);
  if (!shelf || (!shelf.is_public && !isAuthed(req))) return next();
  const payload = shelfPayload(shelf);
  res.send(publicPage({
    title: shelf.name, theme: payload.theme, bodyClass: 'shelf-page',
    body: `<div class="shelf-tools" id="tools"></div><div id="bookcase"></div>`,
    data: { page: 'shelf', ...payload, shelves: listShelves({ publicOnly: true }).map(s => ({ slug: s.slug, name: s.name })) },
  }));
});

publicRouter.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  const books = q ? withFiles(queryBooks({ q }, { sort: 'author' })) : [];
  const theme = resolveTheme(siteSettings().theme || {}, {});
  res.send(publicPage({
    title: q ? `“${q}”` : 'Search', theme, bodyClass: 'shelf-page',
    body: `<div class="shelf-tools" id="tools"></div><div id="bookcase"></div>`,
    data: { page: 'search', q, theme, shelf: { name: q ? `Search: ${q}` : 'Search', display: 'spine', description: `${books.length} book${books.length === 1 ? '' : 's'} found` },
      items: books.map(b => ({ id: `b-${b.id}`, kind: 'book', display: 'inherit', book: b })) },
  }));
});

function bookPayload(id, req) {
  const b = getBook(Number(id));
  if (!b || (b.hidden && !isAuthed(req))) return null;
  const book = { ...publicBook(b, bookFiles(b.id)), shelves: shelvesForBook(b.id) };
  if (!canDownload(req) && book.files.length) { book.digitalCount = book.files.length; book.files = []; book.downloadsOff = true; }
  return book;
}

publicRouter.get('/book/:id', (req, res, next) => {
  const book = bookPayload(req.params.id, req);
  if (!book) return next();
  res.send(publicPage({ title: book.title, bodyClass: 'book-page', body: '<div id="book-root"></div>', data: { page: 'book', book } }));
});

publicRouter.get('/api/books/:id', (req, res) => {
  const book = bookPayload(req.params.id, req);
  if (!book) return res.status(404).json({ error: 'Not found' });
  res.json(book);
});

publicRouter.get('/api/shelves', (req, res) => res.json(listShelves({ publicOnly: true }).map(s => ({ slug: s.slug, name: s.name, books: s.book_count }))));

publicRouter.get('/api/shelves/:slug', (req, res) => {
  const shelf = getShelf(req.params.slug);
  if (!shelf || (!shelf.is_public && !isAuthed(req))) return res.status(404).json({ error: 'Not found' });
  res.json(shelfPayload(shelf));
});

publicRouter.get('/api/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  res.json(q ? withFiles(queryBooks({ q }, { sort: 'author', limit: 60 })) : []);
});

// Book files — addressed by id only, never by path.
function sendBookFile(req, res, next, inline) {
  const f = getDb().prepare('SELECT f.*, b.title, b.authors, b.hidden FROM book_files f JOIN books b ON b.id = f.book_id WHERE f.id = ?').get(Number(req.params.id));
  if (!f || f.missing || (f.hidden && !isAuthed(req))) return next();
  if (!canDownload(req)) return res.status(403).send('Downloads are turned off for visitors to this library.');
  if (!fs.existsSync(f.path)) return res.status(410).send('This file is no longer available on the server.');
  const name = safeFilename(`${f.title}${f.authors ? ' - ' + f.authors.split(/;|&/)[0].trim() : ''}`) + '.' + f.format;
  res.setHeader('Content-Type', MIME[f.format] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(f.path, { dotfiles: 'allow', acceptRanges: true, headers: { 'Cache-Control': 'private, max-age=3600' } });
}
publicRouter.get('/files/:id/download', (req, res, next) => sendBookFile(req, res, next, false));
publicRouter.get('/files/:id/read', (req, res, next) => sendBookFile(req, res, next, true));

publicRouter.get('/covers/:file', (req, res, next) => {
  if (!/^[a-f0-9]{8,40}\.jpg$/.test(req.params.file)) return next();
  res.sendFile(path.join(config.coversDir, req.params.file), { maxAge: '365d', immutable: true }, err => err && next());
});

publicRouter.get('/media/:id', (req, res, next) => {
  const m = getDb().prepare('SELECT * FROM media WHERE id = ?').get(Number(req.params.id));
  if (!m) return next();
  res.setHeader('Content-Type', m.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (m.mime === 'image/svg+xml') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(path.join(config.mediaDir, m.filename), { maxAge: '30d' }, err => err && next());
});

publicRouter.get('/healthz', (req, res) => { getDb().prepare('SELECT 1').get(); res.json({ ok: true, version: process.env.APP_VERSION || 'dev' }); });
