// Verify the browser port against the reference HEIC files checked into samples/.
// Usage: node scripts/verify.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertHsp } from '../src/lib/hsp2heic.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '..', '..', 'samples');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

let pass = 0;
let fail = 0;

for (const name of readdirSync(samples).filter((f) => f.toLowerCase().endsWith('.hsp')).sort()) {
  const hsp = readFileSync(join(samples, name));
  const ref = readFileSync(join(samples, name.replace(/\.hsp$/i, '.HEIC')));
  const t0 = performance.now();
  const { data, meta } = convertHsp(new Uint8Array(hsp));
  const ms = performance.now() - t0;
  const same = data.length === ref.length && Buffer.compare(Buffer.from(data), ref) === 0;
  if (same) pass++;
  else fail++;
  console.log(
    `${same ? 'PASS' : 'FAIL'}  ${name}\n` +
    `      ${meta.width}x${meta.height} ${meta.bitDepth}-bit, slices=${meta.slices}, exif=${meta.hasExif}\n` +
    `      ${(meta.sourceBytes / 1048576).toFixed(2)}MB -> ${(meta.outputBytes / 1048576).toFixed(2)}MB ` +
    `(ref ${(ref.length / 1048576).toFixed(2)}MB) in ${ms.toFixed(1)}ms\n` +
    `      sha256 ${sha(Buffer.from(data)).slice(0, 16)}… ${same ? '=== reference' : '!== reference (' + sha(ref).slice(0, 16) + '…)'}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
