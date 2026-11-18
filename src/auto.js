// Background "fill in the gaps": looks up covers, descriptions and page counts for books that
// have never been looked up. Runs after imports, uploads and scans, and every few hours.
import { getSetting } from './db.js';
import { startJob, runningJob } from './jobs.js';
import { booksNeedingMetadata, enrichMany } from './metadata.js';

export function autoMetadataEnabled() { return getSetting('autoMetadata', true) !== false; }

export function queueAutoEnrich(reason = 'new books') {
  if (!autoMetadataEnabled() || runningJob('enrich')) return null;
  const ids = booksNeedingMetadata({ uncheckedOnly: true });
  if (!ids.length) return null;
  return startJob('enrich', `Looking up covers & details for ${ids.length} books (${reason})`, j => enrichMany(ids, j, {}));
}
