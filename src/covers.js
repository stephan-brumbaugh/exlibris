import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from './config.js';

function hex({ r, g, b }) { return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''); }

/** Colour of the left edge of the cover — usually closest to what the real spine looks like. */
export async function spineColorFrom(buf) {
  try {
    const img = sharp(buf);
    const { width, height } = await img.metadata();
    if (!width || !height) return null;
    const strip = await sharp(buf).extract({ left: 0, top: Math.floor(height * 0.05), width: Math.max(2, Math.floor(width * 0.08)), height: Math.floor(height * 0.9) })
      .resize(8, 64, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const { data, info } = strip;
    let r = 0, g = 0, b = 0; const n = info.width * info.height;
    for (let i = 0; i < data.length; i += info.channels) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    return hex({ r: r / n, g: g / n, b: b / n });
  } catch { return null; }
}

/** Normalise any cover image to a JPEG ≤ 900px tall in the covers dir. Returns { file, color } or null. */
export async function saveCover(buf) {
  if (!buf || buf.length < 200) return null;
  try {
    const out = await sharp(buf, { failOn: 'none' }).rotate().resize({ height: 900, width: 700, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    const meta = await sharp(out).metadata();
    if (!meta.width || meta.width < 40 || meta.height < 40) return null;
    // Open Library returns a 1x1 / tiny placeholder for missing covers; ignore very small images.
    const file = crypto.createHash('sha1').update(out).digest('hex').slice(0, 20) + '.jpg';
    fs.writeFileSync(path.join(config.coversDir, file), out);
    return { file, color: await spineColorFrom(out) };
  } catch (e) {
    console.warn('cover rejected:', e.message);
    return null;
  }
}

export function removeCoverIfUnused(db, file) {
  if (!file) return;
  const n = db.prepare('SELECT COUNT(*) AS n FROM books WHERE cover = ?').get(file).n;
  if (n === 0) fs.rm(path.join(config.coversDir, file), { force: true }, () => {});
}

export async function fetchImage(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ExLibris/1.0 (self-hosted library)', ...headers }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error(`Not an image (${type})`);
  return Buffer.from(await res.arrayBuffer());
}
