import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import XLSX from 'xlsx';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exl-test-'));
process.env.DATA_DIR = tmp;
const { ensureDirs, config } = await import('../src/config.js');
const { openDb, getDb } = await import('../src/db.js');
const util = await import('../src/util.js');
const books = await import('../src/books.js');
const shelves = await import('../src/shelves.js');
const importer = await import('../src/importer.js');
const ingest = await import('../src/ingest.js');
const auth = await import('../src/auth.js');
const themes = await import('../public/js/themes.js');

before(() => { ensureDirs(); openDb(path.join(tmp, 't.db')); });

test('title and author normalisation match common variants', () => {
  assert.equal(util.matchKey('The Hobbit', 'J. R. R. Tolkien'), util.matchKey('Hobbit: or There and Back Again', 'Tolkien, J.R.R.'));
  assert.notEqual(util.matchKey('Iceberg', 'Clive Cussler'), util.matchKey('Iceberg', 'Someone Else'));
  assert.equal(util.sortTitle('The Hobbit'), 'hobbit, the');
  assert.equal(util.authorSort('Clive Cussler'), 'cussler, clive');
});

test('password hashing and verification', () => {
  const h = auth.hashPassword('correct horse');
  assert.ok(auth.verifyPassword('correct horse', h));
  assert.ok(!auth.verifyPassword('wrong', h));
  assert.ok(!auth.verifyPassword('x', null));
});

test('spine geometry is deterministic and series share a colour', () => {
  const a = { id: 1, title: 'A', series: 'Dirk Pitt', binding: 'Hardback' }, b = { id: 2, title: 'B', series: 'Dirk Pitt', binding: 'Paperback' };
  assert.deepEqual(books.spineGeometry(a), books.spineGeometry(a));
  assert.equal(books.spineColors(a).color, books.spineColors(b).color);
  assert.equal(books.spineGeometry(a).h, books.spineGeometry(b).h); // a series stands at one height
  const thin = books.spineGeometry({ id: 3, title: 'C', pages: 150, binding: 'Hardback' }).w;
  const thick = books.spineGeometry({ id: 4, title: 'D', pages: 900, binding: 'Hardback' }).w;
  assert.ok(thick > thin * 3 && thick <= 80, `${thin} vs ${thick}`);
});

test('EPUB metadata, series and cover are read', async () => {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'));
  zip.addFile('OPS/book.opf', Buffer.from(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Guards! Guards!</dc:title><dc:creator>Terry Pratchett</dc:creator><dc:identifier>urn:isbn:9780062225757</dc:identifier>
    <meta property="belongs-to-collection" id="c1">Discworld</meta><meta refines="#c1" property="group-position">8</meta></metadata>
    <manifest><item id="ci" href="img/c.png" media-type="image/png" properties="cover-image"/></manifest></package>`));
  const sharp = (await import('sharp')).default;
  zip.addFile('OPS/img/c.png', await sharp({ create: { width: 300, height: 450, channels: 3, background: '#224466' } }).png().toBuffer());
  const file = path.join(tmp, 'gg.epub'); zip.writeZip(file);
  const m = ingest.parseEpub(file);
  assert.equal(m.title, 'Guards! Guards!');
  assert.equal(m.authors, 'Terry Pratchett');
  assert.equal(m.series, 'Discworld');
  assert.equal(m.series_index, 8);
  assert.equal(m.isbn, '9780062225757');
  assert.ok(m.coverBuffer.length > 100);
  const r = await ingest.ingestFile(file, 'upload');
  assert.equal(r.status, 'added');
  const b = books.getBook(r.bookId);
  assert.ok(b.cover && b.cover_color);
  assert.equal((await ingest.ingestFile(file, 'upload')).status, 'unchanged');
});

test('file names give a title and author when metadata is missing', () => {
  assert.deepEqual(ingest.metaFromPath('/lib/Frank Herbert - Dune.pdf'), { title: 'Dune', authors: 'Frank Herbert' });
  assert.deepEqual(ingest.metaFromPath('/lib/Frank Herbert/Dune (12)/Dune - Frank Herbert.epub'), { title: 'Dune', authors: 'Frank Herbert' });
});

function workbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Book Title', 'Book Author', 'Shelf', 'Shelf Position', 'Series', 'Series Order', 'Binding'],
    ['Guards! Guards!', 'Terry Pratchett', 'B2', 2, 'Discworld', 8, 'Paperback'],
    ['Mort', 'Terry Pratchett', 'B2', 1, 'Discworld', 4, 'Paperback'],
    ['Raise the Titanic', 'Clive Cussler', 'B10', 1, 'Dirk Pitt', 4, 'Paperback'],
    ['Raise the Titanic', 'Clive Cussler', 'Loose', null, 'Dirk Pitt', 4, 'Hardback'],
    ['Atlas', null, 'A3', 1, null, null, 'Hardback'],
  ]), 'Master Database');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Case Identifier ', 'Notes', null, 'Image'], ['B2', 'Books', 'Bedroom Right', 'x'], ['A3', 'Books', 'Kitchen', 'y']]), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('spreadsheet import builds bookcases, merges with e-books, and is idempotent', () => {
  const buf = workbook();
  const info = importer.inspect(buf, 'x.xlsx');
  assert.equal(info.suggested, 'Master Database');
  assert.equal(info.casesSheet, 'Sheet1');
  const r1 = importer.runImport(buf, 'x.xlsx', {});
  assert.equal(r1.created, 4); assert.equal(r1.merged, 1); // Guards! Guards! already exists as an e-book
  const gg = getDb().prepare("SELECT * FROM books WHERE title = 'Guards! Guards!'").all();
  assert.equal(gg.length, 1); assert.equal(gg[0].location, 'B2'); assert.equal(gg[0].room, 'Bedroom Right');
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM books WHERE title = 'Raise the Titanic'").get().n, 2);
  const b = shelves.getShelf('bookcase-b');
  const items = shelves.shelfItems(b);
  assert.deepEqual(items.map(i => i.kind === 'book' ? i.book.title : `${i.kind}:${i.text ?? ''}`),
    ['label:B2', 'Mort', 'Guards! Guards!', 'break:', 'label:B10', 'Raise the Titanic']);
  const r2 = importer.runImport(buf, 'x.xlsx', {});
  assert.equal(r2.created, 0); assert.equal(r2.updated, 5);
  assert.ok(shelves.getShelf('loose-books'));
  assert.equal(importer.caseOf('Loose'), 'Loose');
  assert.ok(importer.codeCompare('B2', 'B10') < 0);
});

test('manual shelf items save in order and smart shelves group', () => {
  const id = shelves.createShelf({ name: 'Test' });
  const all = books.queryBooks({});
  shelves.saveShelfItems(id, [{ kind: 'label', text: 'Hi' }, { kind: 'book', book_id: all[0].id, display: 'cover' }, { kind: 'break' }, { kind: 'bogus' }, { kind: 'book' }]);
  const items = shelves.shelfItems(shelves.getShelf(id));
  assert.deepEqual(items.map(i => i.kind), ['label', 'book', 'break']);
  assert.equal(items[1].display, 'cover');
  const sid = shelves.createShelf({ name: 'By author', kind: 'smart', rules: { groupBy: 'author' } });
  const sItems = shelves.shelfItems(shelves.getShelf(sid));
  assert.ok(sItems.some(i => i.kind === 'label' && i.text === 'Terry Pratchett'));
});

test('themes resolve with shelf overrides and coerce the frame flag', () => {
  const t = themes.resolveTheme({ preset: 'oak', rowHeight: 300 }, { wood: '#123456', frame: 'false' });
  assert.equal(t.preset, 'oak'); assert.equal(t.wood, '#123456'); assert.equal(t.rowHeight, 300); assert.equal(t.frame, false);
  const t2 = themes.resolveTheme({ preset: 'oak', wood: '#999999' }, { preset: 'ebony' });
  assert.equal(t2.wood, themes.PRESETS.ebony.wood);
  assert.match(themes.themeStyle(t), /--row-h:300px/);
});

test('series colours apply to every book in the series', async () => {
  const series = await import('../src/series.js');
  series.setSeriesColor('Discworld', '#112233');
  const mort = getDb().prepare("SELECT * FROM books WHERE title = 'Mort'").get();
  assert.equal(books.spineColors(mort).color, '#112233');
  assert.equal(books.spineColors({ ...mort, spine_color: '#abcdef' }).color, '#abcdef');
  const list = series.listSeries();
  assert.ok(list.find(s => s.name === 'Discworld' && s.custom && s.count === 2));
});

test('reorganisation plan fits shelves, keeps series together, and can be undone', async () => {
  const reorg = await import('../src/reorg.js');
  // Two small shelves: B2 fits roughly two books.
  reorg.updatePhysicalShelf('B2', { width_in: 3 });
  reorg.updatePhysicalShelf('B10', { width_in: 30 });
  reorg.updatePhysicalShelf('A3', { width_in: 30 });
  const plan = reorg.makePlan({ order: 'author', fill: 1, bigSeries: 0 });
  const where = Object.fromEntries(plan.placements.map(p => [`${p.title}|${p.from_code}`, p]));
  // Discworld books stay together on one shelf
  assert.equal(where['Mort|B2'].code, where['Guards! Guards!|B2'].code);
  assert.ok(where['Mort|B2'].pos < where['Guards! Guards!|B2'].pos);
  for (const s of plan.shelves) assert.ok(s.inches <= s.width + 3, `${s.code} overfull`);
  const before = getDb().prepare('SELECT id, location, location_position FROM books ORDER BY id').all();
  reorg.applyPlan(plan);
  assert.ok(reorg.reorgActive());
  assert.equal(reorg.moves().length, plan.moving);
  reorg.cancelReorg();
  assert.deepEqual(getDb().prepare('SELECT id, location, location_position FROM books ORDER BY id').all(), before);
});

test('a hand-arranged bookcase can be saved back as home locations', async () => {
  const reorg = await import('../src/reorg.js');
  const ids = getDb().prepare("SELECT id FROM books WHERE title IN ('Mort', 'Atlas') ORDER BY title").all().map(r => r.id);
  const sid = shelves.createShelf({ name: 'Manual layout' });
  shelves.saveShelfItems(sid, [{ kind: 'label', text: 'C4 · Top' }, { kind: 'book', book_id: ids[1] }, { kind: 'book', book_id: ids[0] }]);
  const r = reorg.locationsFromShelf(sid);
  assert.equal(r.books, 2);
  const mort = books.getBook(ids[1]);
  assert.equal(mort.location, 'C4'); assert.equal(mort.location_position, 1);
  assert.equal(books.getBook(ids[0]).location_position, 2);
  reorg.cancelReorg();
});

test('metadata lookup: hardcover page count, gap-filling from a second source, clear outcomes', async () => {
  const meta = await import('../src/metadata.js');
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 300, height: 450, channels: 3, background: '#335577' } }).jpeg().toBuffer();
  const realFetch = globalThis.fetch;
  const json = d => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async url => {
    url = String(url);
    if (url.includes('openlibrary.org/search.json')) return url.includes('Nonexistent') ? json({ docs: [] }) :
      json({ docs: [{ key: '/works/OL1W', title: 'Mort: A Discworld Novel', author_name: ['Terry Pratchett'], number_of_pages_median: 300, cover_i: 1 }] });
    if (url.includes('/editions.json')) return json({ entries: [
      { physical_format: 'Paperback', number_of_pages: 272 }, { physical_format: 'Hardcover', number_of_pages: 243 },
      { physical_format: 'Hardcover', number_of_pages: 244 }, { physical_format: 'Hardcover', number_of_pages: 316 }] });
    if (url.includes('/works/OL1W.json')) return json({ title: 'Mort' }); // no description on Open Library
    if (url.includes('googleapis')) return url.includes('Nonexistent') ? json({}) :
      json({ items: [{ volumeInfo: { title: 'Mort', authors: ['Terry Pratchett'], description: 'Death takes an apprentice.', pageCount: 288 } }] });
    if (url.includes('covers.openlibrary.org')) return new Response(png, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    return new Response('nope', { status: 404 });
  };
  try {
    const mort = getDb().prepare("SELECT * FROM books WHERE title = 'Mort'").get();
    books.updateBook(mort.id, { pages: null, description: null, cover: null });
    const r = await meta.enrichBook(mort.id);
    const after = books.getBook(mort.id);
    assert.equal(r.outcome, 'updated');
    assert.ok([243, 244].includes(after.pages), String(after.pages)); assert.equal(after.pages_source, 'hardcover');
    assert.equal(after.description, 'Death takes an apprentice.'); // filled from Google when Open Library had none
    assert.ok(after.cover);
    const again = await meta.enrichBook(mort.id);
    assert.equal(again.outcome, 'nothingnew');
    const id = books.createBook({ title: 'Nonexistent Pamphlet', authors: 'Nobody' });
    assert.equal((await meta.enrichBook(id)).outcome, 'nomatch');
  } finally { globalThis.fetch = realFetch; }
});

async function makeEpub(file, title, author) {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf"/></rootfiles></container>'));
  zip.addFile('c.opf', Buffer.from(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator></metadata><manifest/></package>`));
  if (file) zip.writeZip(file);
  return zip.toBuffer();
}

test('physical and digital bookcases never mix, but one book can sit on both', async () => {
  // Atlas is print-only; give an e-book-only record and a joined (print + e-book) record.
  const ebookPath = path.join(tmp, 'Solo Ebook.epub');
  await makeEpub(ebookPath, 'Solo Ebook', 'Some Writer');
  const solo = (await ingest.ingestFile(ebookPath, 'upload')).bookId;
  const mort = getDb().prepare("SELECT id FROM books WHERE title = 'Mort'").get().id;
  const mortEpub = path.join(tmp, 'Mort.epub');
  await makeEpub(mortEpub, 'Mort', 'Terry Pratchett');
  assert.equal((await ingest.ingestFile(mortEpub, 'upload')).bookId, mort); // joined to the print copy
  const atlas = getDb().prepare("SELECT id FROM books WHERE title = 'Atlas'").get().id;

  const home = shelves.createShelf({ name: 'Home case', collection: 'physical' });
  const added = shelves.addBooksToShelf(home, [solo, mort, atlas]);
  assert.equal(added, 2); // the e-book-only title is refused
  const homeIds = shelves.shelfItems(shelves.getShelf(home)).filter(i => i.kind === 'book').map(i => i.book.id);
  assert.deepEqual(homeIds.sort(), [mort, atlas].sort());

  const dig = shelves.createShelf({ name: 'Digital', kind: 'smart', collection: 'digital' });
  const digIds = shelves.shelfItems(shelves.getShelf(dig)).map(i => i.book.id);
  assert.ok(digIds.includes(solo) && digIds.includes(mort) && !digIds.includes(atlas));
  // The joined book's card carries both sides
  const card = books.publicBook(books.getBook(mort), books.bookFiles(mort));
  assert.equal(card.location, 'B2'); assert.equal(card.files.length, 1);
});

test('near-match print and digital records can be found and joined', async () => {
  const copies = await import('../src/copies.js');
  const ebookPath = path.join(tmp, 'Raise.epub');
  await makeEpub(ebookPath, 'Raise the Titanic Special Edition', 'Clive Cussler');
  const digital = (await ingest.ingestFile(ebookPath, 'upload')).bookId;
  books.updateBook(digital, { abs_url: 'http://abs/item/x' });
  const pairs = copies.findCopyPairs();
  const pair = pairs.find(p => p.digital.id === digital);
  assert.ok(pair, 'pair found');
  assert.match(pair.print.title, /Raise the Titanic/);
  const kept = copies.mergeBooks(pair.print.id, digital);
  assert.equal(kept.abs_url, 'http://abs/item/x');
  assert.equal(books.bookFiles(kept.id).length, 1);
  assert.equal(books.getBook(digital), undefined);
});

test('ShelfHaven backup zip and live server imports', async () => {
  const sh = await import('../src/shelfhaven.js');
  const { createServer } = await import('node:http');
  const epub = await makeEpub(null, 'Guards! Guards!', 'Terry Pratchett'); // matches an existing book
  const epub2 = await makeEpub(null, 'Brand New Book', 'New Author');
  const sharp = (await import('sharp')).default;
  const cover = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#aa3300' } }).jpeg().toBuffer();

  // Backup zip
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from('{"platform":"ShelfHaven"}'));
  z.addFile('database.json', Buffer.from(JSON.stringify({ books: [
    { id: 'b1', title: 'Guards! Guards!', author: 'Terry Pratchett', fileUrl: 'ebooks/u1/gg.epub', originalFormat: 'epub', coverUrl: 'covers/u1/gg.jpg', series: 'Discworld', seriesNumber: 8, pageCount: 288 },
    { id: 'b2', title: 'Brand New Book', author: 'New Author', fileUrl: 'http://minio:9000/ebooks/u1/new.epub', originalFormat: 'epub', audiobookshelfItemId: 'li_9' },
    { id: 'b3', title: 'Listen Only', author: 'Voice Person', fileUrl: '', audiobookshelfItemId: 'li_7' },
  ] })));
  z.addFile('files/ebooks/u1/gg.epub', epub); z.addFile('files/ebooks/u1/new.epub', epub2); z.addFile('files/covers/u1/gg.jpg', cover);
  const zipPath = path.join(tmp, 'sh-backup.zip'); z.writeZip(zipPath);
  const job = { total() {}, tick() {}, msg() {}, log() {}, cancelled: () => false };
  const r = await sh.importFromBackup(zipPath, { absUrl: 'http://abs.local/audiobookshelf' }, job);
  assert.equal(r['added to an existing book'], 1);
  assert.equal(r.new, 2);
  const newBook = getDb().prepare("SELECT * FROM books WHERE title = 'Brand New Book'").get();
  assert.equal(newBook.abs_url, 'http://abs.local/audiobookshelf/item/li_9');
  assert.equal(getDb().prepare("SELECT binding FROM books WHERE title = 'Listen Only'").get().binding, 'Audiobook');
  const again = await sh.importFromBackup(zipPath, {}, job);
  assert.equal(again['already imported'], 3);

  // Live server (NextAuth-style sign in)
  const srv = createServer((req, res) => {
    const authed = (req.headers.cookie || '').includes('authjs.session-token=ok');
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    if (req.url === '/api/auth/csrf') return send(200, { csrfToken: 't' }, { 'set-cookie': 'authjs.csrf-token=t; Path=/' });
    if (req.url === '/api/auth/callback/credentials') {
      let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
        const ok = new URLSearchParams(b).get('password') === 'pw';
        send(302, '', ok ? { 'set-cookie': 'authjs.session-token=ok; Path=/; HttpOnly', location: '/' } : { location: '/login?error=1' });
      }); return;
    }
    if (req.url === '/api/auth/session') return send(200, authed ? { user: { email: 'a@b' } } : {});
    if (!authed) return send(401, { error: 'Unauthorized' });
    if (req.url === '/api/books') return send(200, { books: [{ id: 's1', title: 'Server Book', author: 'Remote Writer', fileUrl: '/api/books/s1/download', coverUrl: '/api/books/s1/cover' }], total: 1 });
    if (req.url === '/api/books/s1') return send(200, { id: 's1', title: 'Server Book', author: 'Remote Writer', series: 'Remote Saga', seriesNumber: 2, fileUrl: 'ebooks/s1.epub', originalFormat: 'epub', coverUrl: '/api/books/s1/cover' });
    if (req.url === '/api/books/s1/download') return send(200, epub2, { 'content-type': 'application/epub+zip' });
    if (req.url === '/api/books/s1/cover') return send(200, cover, { 'content-type': 'image/jpeg' });
    send(404, {});
  });
  await new Promise(r2 => srv.listen(0, r2));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    await assert.rejects(sh.importFromServer({ url: base, email: 'a@b', password: 'wrong' }, job), /did not accept/);
    const r3 = await sh.importFromServer({ url: base, email: 'a@b', password: 'pw' }, job);
    assert.equal(r3.new + r3['added to an existing book'], 1);
    const sb = getDb().prepare("SELECT * FROM books WHERE series = 'Remote Saga'").get();
    assert.ok(sb && sb.cover, 'series and cover came across');
  } finally { srv.close(); }
});

test('spaces keep their width and pictures their height on the back panel', () => {
  const id = shelves.createShelf({ name: 'Spacing' });
  const media = getDb().prepare("INSERT INTO media (filename, mime) VALUES ('x.png', 'image/png')").run().lastInsertRowid;
  shelves.saveShelfItems(id, [{ kind: 'space', width: 120 }, { kind: 'decor', media_id: media, size: 'l', raise: 60 }, { kind: 'space', width: 99999 }]);
  const items = shelves.shelfItems(shelves.getShelf(id));
  assert.equal(items[0].width, 120);
  assert.equal(items[1].raise, 60);
  assert.equal(items[2].width, 600); // clamped
});

test('ISBN-10 and ISBN-13 of one edition match; apostrophes do not split titles', () => {
  assert.equal(util.isbn13('0-345-39180-2'), '9780345391803');
  assert.equal(util.normTitle("The Hitchhiker's Guide"), util.normTitle('The Hitchhikers Guide'));
});

test('an audiobook-only duplicate of an e-book is offered for joining, separate print copies are not', async () => {
  const copies = await import('../src/copies.js');
  const ebook = getDb().prepare("SELECT id FROM books WHERE title = 'Solo Ebook'").get().id;
  const audio = books.createBook({ title: 'Solo Ebook', authors: 'Some Writer', binding: 'Audiobook', abs_url: 'http://abs/item/s' });
  const dupes = copies.findDuplicatePairs();
  const p = dupes.find(d => [d.keep.id, d.drop.id].sort().join() === [ebook, audio].sort().join());
  assert.ok(p, 'pair offered');
  assert.equal(p.keep.id, ebook); // the one with a file is kept
  assert.ok(!dupes.some(d => d.keep.location && d.drop.location), 'two print copies never paired');
});

test('a pasted book page gives title, author, pages and cover', async () => {
  const meta = await import('../src/metadata.js');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<html><head><meta property="og:title" content="Mort by Terry Pratchett"><meta property="og:image" content="https://img/x.jpg">
    <script type="application/ld+json">{"@type":"Book","name":"Mort","author":[{"@type":"Person","name":"Terry Pratchett"}],"numberOfPages":243,"isbn":"9780062225719"}</script></head></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    const c = await meta.candidateFromPage('https://www.goodreads.com/book/show/1');
    assert.equal(c.title, 'Mort'); assert.equal(c.authors, 'Terry Pratchett'); assert.equal(c.pages, 243); assert.equal(c.coverUrl, 'https://img/x.jpg');
  } finally { globalThis.fetch = real; }
});
