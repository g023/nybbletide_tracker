#!/usr/bin/env node
/* =====================================================================
 * tools/test.js -- headless regression harness.
 *
 * Loads every module in testdata/ with the real loaders, renders a few
 * seconds through the real engine, and asserts the result is audible and
 * finite.  This is the only way to be confident about a replayer: unit
 * tests on effect handlers pass happily while the output is silence.
 *
 *   node tools/test.js [--seconds N] [--wav outdir] [file ...]
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = [
  'src/js/core/common.js',
  'src/js/formats/mod.js',
  'src/js/formats/s3m.js',
  'src/js/formats/xm.js',
  'src/js/formats/it.js',
  'src/js/formats/loader.js',
  'src/js/player/player.js'
];
for (const f of SRC) {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  // eslint-disable-next-line no-eval
  (0, eval)(code + '\n//# sourceURL=' + f);
}
const TM = globalThis.TM;

const args = process.argv.slice(2);
let seconds = 6;
let wavDir = null;
const explicit = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seconds') seconds = parseFloat(args[++i]);
  else if (args[i] === '--wav') wavDir = args[++i];
  else explicit.push(args[i]);
}

const dir = path.join(ROOT, 'testdata');
let files = explicit.length
  ? explicit
  : fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /\.(mod|s3m|xm|it)$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f))
    : [];

if (!files.length) {
  console.error('No test modules found in testdata/.');
  process.exit(1);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

function writeWav(file, l, r, rate) {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

const RATE = 44100;
let pass = 0,
  fail = 0;
const failures = [];

for (const file of files) {
  const name = path.basename(file);
  let song, player;
  try {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const t0 = Date.now();
    song = TM.loadModule(bytes, name);
    const parseMs = Date.now() - t0;

    player = new TM.TrackerPlayer(RATE);
    player.setSong(song);
    const dur = player.estimateDuration(1800);

    player.playing = true;
    player.loopSong = true;
    const total = Math.floor(seconds * RATE);
    const block = 1024;
    const L = new Float32Array(total);
    const R = new Float32Array(total);
    const bl = new Float32Array(block);
    const br = new Float32Array(block);
    const t1 = Date.now();
    let peak = 0,
      rms = 0,
      bad = 0,
      rowsSeen = new Set();
    for (let off = 0; off < total; off += block) {
      const n = Math.min(block, total - off);
      player.render(bl, br, n);
      rowsSeen.add(player.order * 1024 + player.row);
      for (let i = 0; i < n; i++) {
        const a = bl[i],
          b = br[i];
        if (!isFinite(a) || !isFinite(b)) bad++;
        L[off + i] = a;
        R[off + i] = b;
        const m = Math.max(Math.abs(a), Math.abs(b));
        if (m > peak) peak = m;
        rms += a * a + b * b;
      }
    }
    const renderMs = Date.now() - t1;
    rms = Math.sqrt(rms / (total * 2));

    const problems = [];
    if (bad) problems.push(bad + ' non-finite samples');
    if (peak < 0.005) problems.push('output is silent (peak ' + peak.toFixed(4) + ')');
    if (rms < 0.0015) problems.push('output is near-silent (rms ' + rms.toFixed(5) + ')');
    if (rowsSeen.size < 2) problems.push('playback position never advanced');
    if (!song.patterns.length) problems.push('no patterns');

    const tag = problems.length ? 'FAIL' : 'ok  ';
    if (problems.length) {
      fail++;
      failures.push(name + ': ' + problems.join('; '));
    } else pass++;

    console.log(
      `${tag} ${name.padEnd(16)} ${song.type.padEnd(4)} ch=${String(song.channels).padStart(2)} ` +
        `pat=${String(song.patterns.length).padStart(3)} smp=${String(song.samples.length).padStart(3)} ` +
        `ins=${String(song.instruments.length).padStart(3)} ord=${String(song.orders.length).padStart(3)} ` +
        `len=${fmtTime(dur).padStart(5)} peak=${peak.toFixed(3)} rms=${rms.toFixed(4)} ` +
        `parse=${parseMs}ms render=${renderMs}ms (${(seconds / (renderMs / 1000)).toFixed(0)}x) "${song.title}"`
    );
    if (problems.length) console.log('     -> ' + problems.join('; '));

    if (wavDir) {
      fs.mkdirSync(wavDir, { recursive: true });
      writeWav(path.join(wavDir, name + '.wav'), L, R, RATE);
    }
  } catch (e) {
    fail++;
    failures.push(name + ': ' + e.message);
    console.log(`FAIL ${name.padEnd(16)} ${e.message}`);
    if (process.env.TRACE) console.log(e.stack);
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + files.length + ' total');
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ' + f);
}
process.exit(fail ? 1 : 0);
