import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const LIBRARY_DIRS = (process.env.LIBRARY_DIRS || process.env.LIBRARY_DIR || '/library')
  .split(/[;,]/).map(s => s.trim()).filter(Boolean).map(p => path.resolve(p));

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'exlibris.db'),
  coversDir: path.join(DATA_DIR, 'covers'),
  mediaDir: path.join(DATA_DIR, 'media'),
  uploadsDir: path.join(DATA_DIR, 'books'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  libraryDirs: LIBRARY_DIRS,
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Set to "true" behind an HTTPS reverse proxy so the session cookie is marked Secure.
  secureCookies: process.env.SECURE_COOKIES === 'true',
  scanOnStart: process.env.SCAN_ON_START !== 'false',
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 0),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 1024),
};

export const BOOK_EXTENSIONS = ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'kfx', 'cbz', 'cbr', 'cb7', 'djvu', 'fb2', 'txt', 'rtf', 'docx', 'm4b', 'mp3'];

export function ensureDirs() {
  for (const d of [config.dataDir, config.coversDir, config.mediaDir, config.uploadsDir, config.tmpDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
