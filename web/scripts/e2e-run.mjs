// End-to-end check in a real browser over CDP.
//   1. drop an .HSP -> convert -> verify SHA-256 against the reference HEIC
//   2. single file: the button must download a .HEIC
//   3. two files: the button must download a .ZIP containing both HEICs
//   4. screenshots: light, dark, mobile
//
// Usage: node scripts/e2e-run.mjs <debugPort> <outDir> <sampleUrl> <expectedSha256>
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const port = Number(process.argv[2] || 9222);
const outDir = process.argv[3] || '.';
const sampleUrl = process.argv[4] || '/test-sample.HSP';
const expectedSha = (process.argv[5] || '').toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = list.filter((t) => t.type === 'page');
const page = pages.find((t) => t.url === 'about:blank') ?? pages[0];
if (!page) throw new Error('no page target');
console.log('target:', page.url || '(blank)');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const listeners = new Set();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    for (const fn of listeners) fn(msg);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 20000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

const once = (method) =>
  new Promise((resolve) => {
    const fn = (msg) => {
      if (msg.method === method) {
        listeners.delete(fn);
        resolve(msg.params);
      }
    };
    listeners.add(fn);
  });

async function evaluate(expression, awaitPromise = false) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

async function navigate(url) {
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url });
  await Promise.race([loaded, sleep(3000)]);
  await sleep(800);
}

async function shot(name, { width, height, mobile }) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height,
  });
  await navigate('http://127.0.0.1:4321/');
  const full = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
  const tall = Math.min(Math.max(Number(full) || height, height), 12000);
  await send('Emulation.setDeviceMetricsOverride', {
    width, height: tall, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: tall,
  });
  await sleep(500);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
  console.log('shot', name, `${width}x${tall}`);
}

/** Drop a virtual File into the page through the real drag & drop handler. */
const addFileExpr = (name) => `(async () => {
  const res = await fetch(${JSON.stringify(sampleUrl)});
  const buf = await res.arrayBuffer();
  const dt = new DataTransfer();
  dt.items.add(new File([buf], ${JSON.stringify(name)}, { type: 'application/octet-stream' }));
  const dz = document.getElementById('dropzone');
  dz.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
  dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const e = window.__hsp.entries;
    if (e.length && e.every((x) => x.status === 'done' || x.status === 'error')) break;
  }
  const e = window.__hsp.entries;
  return {
    count: e.length,
    statuses: e.map((x) => x.status),
    error: e.find((x) => x.error)?.error ?? null,
    button: document.getElementById('btn-download').textContent.trim(),
    pct: document.getElementById('progress-pct').textContent,
  };
})()`;

async function waitForDownload(ext, timeoutMs = 25000) {
  const before = new Set(readdirSync(outDir));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    const found = readdirSync(outDir).find((f) => !before.has(f) && f.toLowerCase().endsWith(ext));
    if (found) return found;
  }
  throw new Error(`no ${ext} appeared in ${outDir}`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outDir });

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures.push(label);
};

// 1. light desktop
await shot('shot-desktop.png', { width: 1440, height: 1000, mobile: false });

// 2. single file conversion
const one = await evaluate(addFileExpr('_PAN0301.HSP'), true);
check(one.statuses[0] === 'done', 'convert one .HSP', JSON.stringify(one));
check(one.pct === '100%', 'progress reaches 100%', one.pct);

const outSha = await evaluate(`(async () => {
  const d = await crypto.subtle.digest('SHA-256', window.__hsp.entries[0].out);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
})()`, true);
check(outSha === expectedSha, 'output matches reference SHA-256', `${outSha.slice(0, 16)}...`);

// 3. single download -> .HEIC
await evaluate(`document.getElementById('btn-download').click()`);
const heicName = await waitForDownload('.heic');
const heicSha = sha256(readFileSync(join(outDir, heicName)));
check(heicSha === expectedSha, 'single download is a valid .HEIC', heicName);

// 4. second file -> ZIP
const two = await evaluate(addFileExpr('_PAN0766.HSP'), true);
check(two.count === 2 && two.statuses.every((s) => s === 'done'), 'convert two files', JSON.stringify(two.statuses));
check(two.button.includes('ZIP'), 'button switches to ZIP', two.button);

await evaluate(`document.getElementById('btn-download').click()`);
const zipName = await waitForDownload('.zip');
const zip = unzipSync(new Uint8Array(readFileSync(join(outDir, zipName))));
const names = Object.keys(zip);
check(names.length === 2, 'zip contains two files', names.join(', '));
check(Object.values(zip).every((z) => sha256(Buffer.from(z)) === expectedSha), 'zip entries are the same HEIC');
check(Object.values(zip).every((z) => Buffer.from(z).subarray(4, 8).toString() === 'ftyp'), 'zip entries start with ftyp');

// 5. screenshots with results in the list
await sleep(300);
const { data: resultShot } = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(outDir, 'shot-desktop-result.png'), Buffer.from(resultShot, 'base64'));

await evaluate(`document.getElementById('theme-toggle').click()`);
await sleep(500);
const { data: dark } = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(outDir, 'shot-dark.png'), Buffer.from(dark, 'base64'));
console.log('shot shot-dark.png');

// 6. mobile
await shot('shot-mobile.png', { width: 390, height: 844, mobile: true });

ws.close();

console.log(`\n${failures.length ? failures.length + ' check(s) failed' : 'all checks passed'}`);
if (failures.length) process.exitCode = 2;
