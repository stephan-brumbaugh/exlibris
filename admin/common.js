export { el, generatedCover, fmtIndex } from '/js/shelf-render.js';
import { el } from '/js/shelf-render.js';

export const pageData = JSON.parse(document.getElementById('page-data').textContent || '{}');

export async function api(method, url, body, { form = false } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (form) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(`/admin/api${url}`, opts);
  if (res.status === 401) { location.href = `/admin/login?next=${encodeURIComponent(location.pathname)}`; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function toast(msg, bad = false) {
  const t = el('div', { class: `toast${bad ? ' bad' : ''}`, role: bad ? 'alert' : 'status' }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

export function guard(fn) {
  return async (...args) => { try { return await fn(...args); } catch (e) { toast(e.message, true); } };
}

export function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

/** Render a job's progress into `host` and poll until it finishes. */
export function watchJob(job, host, onDone) {
  const box = el('div', { class: 'job' });
  host.prepend(box);
  let showLog = false;
  const draw = j => {
    const pct = j.total ? Math.round((j.done / j.total) * 100) : (j.status === 'running' ? 5 : 100);
    box.replaceChildren(...[
      el('div', { class: 'row' }, el('strong', {}, j.label), el('span', { class: 'spacer' }),
        el('span', { class: `chip ${j.status === 'done' ? 'ok' : j.status === 'error' ? 'bad' : 'warn'}` }, j.status),
        j.status === 'running' ? el('button', { class: 'btn small', onclick: guard(() => api('POST', `/jobs/${j.id}/cancel`)) }, 'Stop') : null),
      el('div', { class: 'bar' }, el('i', { style: { width: `${pct}%` } })),
      el('div', { class: 'small muted' }, `${j.done}${j.total ? ' / ' + j.total : ''} — ${j.message}`),
      j.result ? el('div', { class: 'small' }, Object.entries(j.result).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · ')) : null,
      j.log?.length ? el('button', { class: 'linkish small', onclick: () => { showLog = !showLog; draw(j); } }, showLog ? 'Hide details' : 'Show details') : null,
      showLog ? el('div', { class: 'job-log' }, j.log.join('\n')) : null,
    ].filter(Boolean));
  };
  draw(job);
  const poll = async () => {
    try {
      const j = await api('GET', `/jobs/${job.id}`);
      draw(j);
      if (j.status === 'running') setTimeout(poll, 1000);
      else onDone?.(j);
    } catch { setTimeout(poll, 3000); }
  };
  setTimeout(poll, 600);
  return box;
}

export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export function dropZone({ accept, multiple = true, label, onFiles }) {
  const input = el('input', { type: 'file', accept, multiple, hidden: true, onchange: () => { if (input.files.length) onFiles([...input.files]); input.value = ''; } });
  const zone = el('div', { class: 'drop', tabindex: '0', role: 'button', onclick: () => input.click(), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } }, label, input);
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
  return zone;
}

/** Upload with progress via XHR (fetch has no upload progress). */
export function uploadForm(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/admin/api${url}`);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* */ }
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — network error'));
    xhr.send(form);
  });
}

export function app() { const a = document.getElementById('app'); a.classList.remove('loading'); a.textContent = ''; return a; }
