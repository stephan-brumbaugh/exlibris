import Database from 'better-sqlite3';
import { config } from './config.js';
import { token } from './util.js';

let db;

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE books (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    subtitle TEXT,
    sort_title TEXT,
    authors TEXT,
    author_sort TEXT,
    series TEXT,
    series_index REAL,
    description TEXT,
    publisher TEXT,
    published TEXT,
    isbn TEXT,
    language TEXT,
    pages INTEGER,
    tags TEXT,
    binding TEXT,              -- Hardback, Paperback, Ebook, Audiobook, Other
    room TEXT,                 -- physical: room name
    location TEXT,             -- physical: shelf code, e.g. B3
    location_position INTEGER, -- physical: left-to-right position on that shelf
    cover TEXT,                -- filename in covers dir
    cover_color TEXT,          -- dominant colour of cover
    spine_color TEXT,          -- explicit override
    spine_text_color TEXT,
    spine_image INTEGER,       -- media id of a custom spine image
    abs_url TEXT,
    abs_id TEXT,
    plex_url TEXT,
    plex_key TEXT,
    audible_url TEXT,
    other_links TEXT,          -- JSON [{label,url}]
    notes TEXT,                -- private admin notes
    hidden INTEGER NOT NULL DEFAULT 0,
    source TEXT,               -- upload | scan | import | abs | plex | manual
    source_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX books_source_key ON books(source_key) WHERE source_key IS NOT NULL;
  CREATE INDEX books_sort ON books(author_sort, series, series_index, sort_title);

  CREATE TABLE book_files (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL,      -- upload | scan
    format TEXT NOT NULL,
    size INTEGER,
    mtime INTEGER,
    missing INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX book_files_book ON book_files(book_id);

  CREATE TABLE media (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime TEXT,
    width INTEGER,
    height INTEGER,
    animated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE shelves (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL DEFAULT 'manual',   -- manual | smart
    rules TEXT,                             -- JSON for smart shelves
    sort TEXT NOT NULL DEFAULT 'author',    -- smart shelf ordering
    display TEXT NOT NULL DEFAULT 'mixed',  -- spine | cover | mixed (mixed = per-item)
    theme TEXT,                             -- JSON overrides
    position INTEGER NOT NULL DEFAULT 0,
    is_public INTEGER NOT NULL DEFAULT 1,
    generated_by TEXT,                      -- e.g. import:B (rebuilt on re-import)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE shelf_items (
    id INTEGER PRIMARY KEY,
    shelf_id INTEGER NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,                     -- book | decor | break | label
    book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
    media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
    display TEXT NOT NULL DEFAULT 'inherit',-- inherit | spine | cover
    size TEXT,                              -- decor: s | m | l | xl ; label: style
    text TEXT,                              -- label text / decor caption
    link TEXT                               -- decor: optional link
  );
  CREATE INDEX shelf_items_shelf ON shelf_items(shelf_id, position);

  CREATE TABLE match_candidates (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,                 -- abs | plex
    external_id TEXT NOT NULL,
    title TEXT, authors TEXT, series TEXT, series_index REAL,
    url TEXT, cover_url TEXT, description TEXT,
    suggested_book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
    confidence TEXT,                        -- exact | fuzzy | none
    score REAL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | linked | created | ignored
    payload TEXT,
    UNIQUE(provider, external_id)
  );
  `,
  // 2 — series colours, metadata attempts, physical reorganisation
  `
  ALTER TABLE books ADD COLUMN meta_checked_at TEXT;
  ALTER TABLE books ADD COLUMN pages_source TEXT;
  CREATE TABLE series_info (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    color TEXT,
    text_color TEXT
  );
  CREATE TABLE physical_shelves (
    code TEXT PRIMARY KEY COLLATE NOCASE,
    room TEXT,
    note TEXT,
    width_in REAL NOT NULL DEFAULT 30,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE reorg_snapshot (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    code TEXT,
    pos INTEGER,
    done INTEGER NOT NULL DEFAULT 0
  );
  `,
  // 3 — keep physical and digital bookcases apart
  `
  ALTER TABLE shelves ADD COLUMN collection TEXT NOT NULL DEFAULT 'any';
  UPDATE shelves SET collection = 'physical' WHERE generated_by LIKE 'import:%';
  `,
  // 4 — spacers with a width, decorations that hang higher up the back of the shelf
  `
  ALTER TABLE shelf_items ADD COLUMN width INTEGER;
  ALTER TABLE shelf_items ADD COLUMN raise INTEGER;
  `,
];

export function openDb(file = config.dbFile) {
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => { db.exec(MIGRATIONS[v]); db.pragma(`user_version = ${v + 1}`); })();
  }
  if (!getSetting('session_secret')) setSetting('session_secret', token());
  return db;
}

export function getDb() { return db; }

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export const DEFAULT_SITE = {
  title: 'Ex Libris',
  tagline: 'A personal library',
  theme: { preset: 'walnut' },
  homeIntro: '',
  publicLibrary: true,     // false: visitors must sign in to see anything
  publicDownloads: true,   // false: only the signed-in admin can download files
  logo: null,              // media id shown beside the library name
};

export function siteSettings() {
  return { ...DEFAULT_SITE, ...(getSetting('site') || {}) };
}
