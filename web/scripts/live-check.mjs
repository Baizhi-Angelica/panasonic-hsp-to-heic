// Verify the deployed site: HTTP checks, asset hash comparison, a real
// browser conversion on the live page, and screenshots.
//
// Usage: node scripts/live-check.mjs <debugPort> <liveUrl> <localDistDir> <sampleHsp> <outDir>
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

const [portArg, liveUrl, distDir, samplePath, outDir] = process.argv.slice(2);
const port = Number(portArg || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures.push(label);
};

/* ---------------------------------------------------------------- HTTP */

const page = await fetch(liveUrl, { redirect: 'follow' });
const html = await page.text();
check(page.status === 200, 'page returns 200', String(page.status));
check(/<title>HSP → HEIC/.test(html), 'title is the app title');
check(html.includes('HSP'), 'page renders the hero');

const jsRef = html.match(/src="([^"]+\.js)"/)?.[1];
const cssRef = html.match(/href="([^"]+\.css)"/)?.[1];
check(!!jsRef, 'page references a JS bundle', jsRef);
check(!!cssRef, 'page references a CSS bundle', cssRef);

if (jsRef) {
  const live = Buffer.from(await (await fetch(new URL(jsRef, liveUrl))).arrayBuffer());
  const local = readFileSync(join(distDir, jsRef.replace(/^\//, '')));
  check(sha256(live) === sha256(local), 'live JS bundle is byte-identical to the tested build', `${jsRef} ${live.length}B`);
}
if (cssRef) {
  const res = await fetch(new URL(cssRef, liveUrl));
  check(res.status === 200, 'CSS bundle is served', String(res.status));
}

const favicon = await fetch(new URL('/favicon.svg', liveUrl));
check(favicon.status === 200, 'favicon is served', String(favicon.status));

/* ---------------------------------------------------------------- CDP */

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = targets.filter((t) => t.type === 'page');
const target = pages.find((t) => t.url === 'about:blank') ?? pages[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression, awaitPromise = false) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
};

await send('Page.enable');
await send('Runtime.enable');

const errors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.text ?? 'exception');
  }
});

async function shoot(name, width, height, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height,
  });
  const loaded = new Promise((resolve) => {
    const fn = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Page.loadEventFired') {
        ws.removeEventListener('message', fn);
        resolve();
      }
    };
    ws.addEventListener('message', fn);
  });
  await send('Page.navigate', { url: liveUrl });
  await Promise.race([loaded, sleep(4000)]);
  await sleep(800);
  const full = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
  const tall = Math.min(Math.max(Number(full) || height, height), 12000);
  await send('Emulation.setDeviceMetricsOverride', {
    width, height: tall, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: tall,
  });
  await sleep(400);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(data, 'base64'));
  console.log('shot', name, `${width}x${tall}`);
}

await shoot('live-desktop.png', 1440, 1000, false);

// conversion on the live page, with the sample injected as base64
const b64 = readFileSync(samplePath).toString('base64');
await evaluate(`window.__b64 = ${JSON.stringify(b64)}; true`);
const result = await evaluate(`(async () => {
  const raw = Uint8Array.from(atob(window.__b64), (c) => c.charCodeAt(0));
  window.__b64 = null;
  const { data, meta } = window.__hsp.convertHsp(raw);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return {
    bytes: data.length,
    sha: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    width: meta.width,
    height: meta.height,
    bitDepth: meta.bitDepth,
  };
})()`, true);

const expected = sha256(readFileSync(samplePath.replace(/\.hsp$/i, '.HEIC')));
check(result.sha === expected, 'live page converts byte-exactly', `${result.width}x${result.height} ${result.bitDepth}-bit ${result.sha.slice(0, 16)}...`);
check(result.width === 5984 && result.height === 4000, 'dimensions parsed from the bitstream', `${result.width}x${result.height}`);

// dark mode + mobile
await evaluate(`document.getElementById('theme-toggle').click()`);
await sleep(500);
const { data: dark } = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(outDir, 'live-dark.png'), Buffer.from(dark, 'base64'));
console.log('shot live-dark.png');

await shoot('live-mobile.png', 390, 844, true);

check(errors.length === 0, 'no console errors on the live page', errors.slice(0, 2).join(' | '));

ws.close();
console.log(`\n${failures.length ? failures.length + ' check(s) failed' : 'all live checks passed'}`);
if (failures.length) process.exitCode = 2;
