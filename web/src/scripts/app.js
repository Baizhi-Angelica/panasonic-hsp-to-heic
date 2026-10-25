import { convertHsp } from '../lib/hsp2heic.js';
import { zipSync } from 'fflate';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** @typedef {{id:string, name:string, size:number, file:File, status:'pending'|'working'|'done'|'error', out?:Uint8Array, url?:string, error?:string, el?:HTMLElement}} Entry */

/** @type {Entry[]} */
const entries = [];
let busy = false;

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const dom = {
  input: /** @type {HTMLInputElement} */ ($('file-input')),
  dropzone: $('dropzone'),
  files: $('files'),
  empty: $('empty'),
  banner: $('banner'),
  fill: $('progress-fill'),
  track: $('progress-track'),
  pct: $('progress-pct'),
  label: $('progress-label'),
  download: /** @type {HTMLButtonElement} */ ($('btn-download')),
  clear: /** @type {HTMLButtonElement} */ ($('btn-clear')),
  themeBtn: /** @type {HTMLButtonElement} */ ($('theme-toggle')),
  themeLabel: $('theme-label'),
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const isHsp = (file) => /\.hsp$/i.test(file.name);

function fmtBytes(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function saveBlob(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function outName(name) {
  return name.replace(/\.hsp$/i, '.HEIC');
}

function setBanner(text) {
  if (!text) {
    dom.banner.hidden = true;
    dom.banner.textContent = '';
    return;
  }
  dom.banner.hidden = false;
  dom.banner.textContent = text;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function paintProgress() {
  const total = entries.length;
  const done = entries.filter((e) => e.status === 'done' || e.status === 'error').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  dom.fill.style.width = `${pct}%`;
  dom.pct.textContent = `${pct}%`;
  dom.track.setAttribute('aria-valuenow', String(pct));

  const ok = entries.filter((e) => e.status === 'done').length;
  const failed = entries.filter((e) => e.status === 'error').length;
  if (!total) dom.label.textContent = '等待文件';
  else if (busy) dom.label.textContent = `处理中 · ${done} / ${total}`;
  else if (failed) dom.label.textContent = `完成 ${ok} 张 · 失败 ${failed} 张`;
  else dom.label.textContent = `完成 ${ok} 张`;

  dom.empty.hidden = total > 0;
  dom.clear.disabled = total === 0;

  // Download button adapts: single file -> HEIC, several -> ZIP
  const ready = entries.filter((e) => e.status === 'done');
  dom.download.disabled = ready.length === 0 || busy;
  dom.download.textContent = ready.length > 1 ? '打包下载 ZIP' : ready.length === 1 ? '下载 HEIC' : '下载';
  dom.download.title =
    ready.length > 1 ? `把 ${ready.length} 张 HEIC 打包成 ZIP` : ready.length === 1 ? outName(ready[0].name) : '';
}

function rowFor(entry) {
  const li = document.createElement('li');
  li.className = 'file';
  li.dataset.id = entry.id;

  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(entries.indexOf(entry) + 1).padStart(2, '0');

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry.name;
  name.title = entry.name;

  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = fmtBytes(entry.size);

  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = '等待';

  const actions = document.createElement('span');
  actions.style.display = 'flex';
  actions.style.gap = '2px';

  const dl = document.createElement('button');
  dl.className = 'row-btn';
  dl.type = 'button';
  dl.textContent = '↓';
  dl.title = '下载这张 HEIC';
  dl.setAttribute('aria-label', `下载 ${outName(entry.name)}`);
  dl.hidden = true;
  dl.addEventListener('click', () => downloadOne(entry));

  const rm = document.createElement('button');
  rm.className = 'row-btn';
  rm.type = 'button';
  rm.textContent = '✕';
  rm.title = '移除';
  rm.setAttribute('aria-label', `移除 ${entry.name}`);
  rm.addEventListener('click', () => removeEntry(entry));

  actions.append(dl, rm);
  li.append(num, name, size, status, actions);

  entry.el = li;
  entry.ui = { status, dl };
  return li;
}

function updateRow(entry) {
  if (!entry.el || !entry.ui) return;
  const { status, dl } = entry.ui;
  status.className = 'status';
  switch (entry.status) {
    case 'pending':
      status.textContent = '等待';
      break;
    case 'working':
      status.textContent = '转换中…';
      status.classList.add('status--working');
      break;
    case 'done':
      status.textContent = `完成 · ${fmtBytes(entry.out?.length ?? 0)}`;
      status.classList.add('status--done');
      dl.hidden = false;
      break;
    case 'error':
      status.textContent = '失败';
      status.classList.add('status--error');
      break;
  }
  if (entry.error) {
    let p = entry.el.querySelector('.file-error');
    if (!p) {
      p = document.createElement('p');
      p.className = 'file-error';
      entry.el.appendChild(p);
    }
    p.textContent = entry.error;
  }
}

function reposition() {
  entries.forEach((entry, i) => {
    const num = entry.el?.querySelector('.num');
    if (num) num.textContent = String(i + 1).padStart(2, '0');
  });
}

/* ------------------------------------------------------------------ */
/* Conversion                                                          */
/* ------------------------------------------------------------------ */

async function convertEntry(entry) {
  entry.status = 'working';
  updateRow(entry);
  await new Promise((r) => requestAnimationFrame(() => r()));

  try {
    const buf = new Uint8Array(await entry.file.arrayBuffer());
    const { data, meta } = convertHsp(buf);
    entry.out = data;
    entry.status = 'done';
    entry.meta = meta;
  } catch (e) {
    entry.status = 'error';
    entry.error = e instanceof Error ? e.message : String(e);
  }
  updateRow(entry);
  paintProgress();
}

async function pump() {
  if (busy) return;
  busy = true;
  paintProgress();
  try {
    for (const entry of entries) {
      if (entry.status === 'pending') await convertEntry(entry);
    }
  } finally {
    busy = false;
    paintProgress();
  }
}

// expose for debugging / e2e
window.__hsp = { entries, convertHsp };

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

function downloadOne(entry) {
  if (!entry.out) return;
  saveBlob(entry.out, outName(entry.name), 'image/heic');
}

async function downloadAll() {
  const ready = entries.filter((e) => e.status === 'done' && e.out);
  if (!ready.length) return;

  if (ready.length === 1) {
    downloadOne(ready[0]);
    return;
  }

  dom.download.disabled = true;
  const prev = dom.download.textContent;
  dom.download.textContent = '打包中…';
  await new Promise((r) => setTimeout(r, 30));

  try {
    const used = new Map();
    /** @type {Record<string, Uint8Array>} */
    const files = {};
    for (const entry of ready) {
      let name = outName(entry.name);
      const n = (used.get(name) ?? 0) + 1;
      used.set(name, n);
      if (n > 1) name = name.replace(/\.HEIC$/i, `-${n}.HEIC`);
      files[name] = entry.out;
    }
    // HEIC is already compressed: store, do not deflate.
    const zip = zipSync(files, { level: 0 });
    saveBlob(zip, `panasonic-hlg-${stamp()}.zip`, 'application/zip');
  } catch (e) {
    setBanner(`打包失败：${e instanceof Error ? e.message : e}`);
  } finally {
    dom.download.textContent = prev ?? '下载';
    paintProgress();
  }
}

/* ------------------------------------------------------------------ */
/* Files in / out                                                      */
/* ------------------------------------------------------------------ */

function addFiles(fileList) {
  const rejected = [];
  const incoming = Array.from(fileList);

  for (const file of incoming) {
    if (!isHsp(file)) {
      rejected.push(file.name);
      continue;
    }
    if (file.size === 0) {
      rejected.push(file.name);
      continue;
    }
    /** @type {Entry} */
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      size: file.size,
      file,
      status: 'pending',
    };
    entries.push(entry);
    dom.files.appendChild(rowFor(entry));
  }

  if (rejected.length) {
    const names = rejected.slice(0, 3).join('、') + (rejected.length > 3 ? ` 等 ${rejected.length} 个` : '');
    setBanner(`已忽略 ${rejected.length} 个非 .HSP 文件：${names}（只接受松下 HLG Photo）`);
  } else {
    setBanner('');
  }

  reposition();
  paintProgress();
  if (entries.some((e) => e.status === 'pending')) void pump();
}

function removeEntry(entry) {
  const i = entries.indexOf(entry);
  if (i < 0) return;
  entries.splice(i, 1);
  entry.el?.remove();
  reposition();
  paintProgress();
}

function clearAll() {
  for (const entry of entries) entry.el?.remove();
  entries.length = 0;
  dom.files.replaceChildren();
  setBanner('');
  paintProgress();
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

dom.input.addEventListener('change', () => {
  if (dom.input.files?.length) addFiles(dom.input.files);
  dom.input.value = '';
});

dom.download.addEventListener('click', () => void downloadAll());
dom.clear.addEventListener('click', clearAll);

// drag & drop — highlight only the drop zone, accept the drop anywhere on it
let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

dom.dropzone.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dom.dropzone.classList.add('is-dragover');
});

dom.dropzone.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

dom.dropzone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dom.dropzone.classList.remove('is-dragover');
});

dom.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dom.dropzone.classList.remove('is-dragover');
  const files = e.dataTransfer?.files;
  if (files?.length) addFiles(files);
});

// prevent the browser from navigating when a file is dropped elsewhere
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const root = document.documentElement;

function syncTheme() {
  const dark = root.dataset.theme === 'dark';
  dom.themeBtn.setAttribute('aria-pressed', String(dark));
  dom.themeBtn.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到夜间模式');
  dom.themeLabel.textContent = dark ? '日间' : '夜间';
}

dom.themeBtn.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('hsp-theme', root.dataset.theme);
  } catch {
    /* private mode: ignore */
  }
  syncTheme();
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  let saved = null;
  try {
    saved = localStorage.getItem('hsp-theme');
  } catch {
    /* ignore */
  }
  if (!saved) {
    root.dataset.theme = e.matches ? 'dark' : 'light';
    syncTheme();
  }
});

syncTheme();
paintProgress();
