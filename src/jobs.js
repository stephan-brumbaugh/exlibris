// Tiny in-memory background job tracker so long tasks (scans, metadata fetches, imports) report progress to the admin UI.
const jobs = new Map();
let seq = 0;

export function startJob(kind, label, fn) {
  for (const j of jobs.values()) if (j.kind === kind && j.status === 'running') return j;
  const job = { id: String(++seq), kind, label, status: 'running', done: 0, total: 0, message: 'Starting…', log: [], started: Date.now(), result: null };
  jobs.set(job.id, job);
  const api = {
    total(n) { job.total = n; },
    tick(msg) { job.done++; if (msg) job.message = msg; },
    msg(m) { job.message = m; },
    log(line) { job.log.push(line); if (job.log.length > 300) job.log.shift(); },
    cancelled: () => job.cancel === true,
  };
  Promise.resolve().then(() => fn(api)).then(result => {
    job.status = job.cancel ? 'cancelled' : 'done'; job.result = result ?? null; job.message = job.cancel ? 'Cancelled' : 'Finished';
  }).catch(err => {
    job.status = 'error'; job.message = err.message; job.log.push(`Error: ${err.message}`);
    console.error(`[job ${kind}]`, err);
  }).finally(() => { job.finished = Date.now(); });
  // keep the last 20 jobs
  if (jobs.size > 20) for (const [id, j] of jobs) { if (j.status !== 'running') { jobs.delete(id); break; } }
  return job;
}

export function getJob(id) { return jobs.get(String(id)) || null; }
export function listJobs() { return [...jobs.values()].sort((a, b) => b.started - a.started); }
export function cancelJob(id) { const j = jobs.get(String(id)); if (j && j.status === 'running') j.cancel = true; return j; }
export function runningJob(kind) { return [...jobs.values()].find(j => j.kind === kind && j.status === 'running') || null; }
