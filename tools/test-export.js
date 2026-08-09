#!/usr/bin/env node
/* =====================================================================
 * tools/test-export.js -- .mod export round-trip harness.
 *
 * The Save button is only useful if the bytes it produces are a real
 * ProTracker module, so this exports every module in testdata/, feeds the
 * result straight back into the loader, and renders it.  A file that
 * cannot be re-parsed, or that re-parses into silence, is a broken export
 * no matter how plausible the hexdump looks.
 *
 * Songs that are not 4-channel MOD to begin with lose things on the way
 * out (extra effects, >64 rows, 16-bit samples); the writer reports those
 * and this harness prints them rather than failing on them.
 *
 *   node tools/test-export.js [--seconds N] [--out dir] [file ...]
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
  'src/js/player/player.js',
  'src/js/export/modwriter.js'
];
for (const f of SRC) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n//# sourceURL=' + f);
}
const TM = globalThis.TM;

const args = process.argv.slice(2);
let seconds = 4;
let outDir = null;
const explicit = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seconds') seconds = parseFloat(args[++i]);
  else if (args[i] === '--out') outDir = args[++i];
  else explicit.push(args[i]);
}

const dir = path.join(ROOT, 'testdata');
const files = explicit.length
  ? explicit
  : fs.readdirSync(dir).filter((f) => /\.(mod|s3m|xm|it)$/i.test(f)).sort().map((f) => path.join(dir, f));

const RATE = 44100;

function analyse(song, secs) {
  const player = new TM.TrackerPlayer(RATE);
  player.setSong(song);
  player.playing = true;
  player.loopSong = true;
  const block = 1024;
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  const total = Math.floor(secs * RATE);
  let peak = 0, rms = 0, bad = 0;
  const seen = new Set();
  for (let off = 0; off < total; off += block) {
    const n = Math.min(block, total - off);
    player.render(bl, br, n);
    seen.add(player.order * 1024 + player.row);
    for (let i = 0; i < n; i++) {
      if (!isFinite(bl[i]) || !isFinite(br[i])) bad++;
      const m = Math.max(Math.abs(bl[i]), Math.abs(br[i]));
      if (m > peak) peak = m;
      rms += bl[i] * bl[i] + br[i] * br[i];
    }
  }
  return { peak, rms: Math.sqrt(rms / (total * 2)), bad, positions: seen.size };
}

let pass = 0, fail = 0;
const failures = [];

for (const file of files) {
  const name = path.basename(file);
  try {
    const song = TM.loadModule(new Uint8Array(fs.readFileSync(file)), name);
    const res = TM.exportMOD(song);

    const problems = [];
    if (!res.bytes || res.bytes.length < 1084) problems.push('exported file is impossibly small');

    // Re-parse: this is the real assertion.
    const back = TM.loadModule(res.bytes, name.replace(/\.[a-z0-9]+$/i, '.mod'));
    if (back.type !== 'mod') problems.push('re-parsed as ' + back.type + ', not mod');
    if (back.channels !== Math.min(song.channels, 32)) {
      problems.push('channel count changed ' + song.channels + ' -> ' + back.channels);
    }
    if (!back.patterns.length) problems.push('no patterns survived');

    const a = analyse(back, seconds);
    if (a.bad) problems.push(a.bad + ' non-finite samples');
    if (a.peak < 0.005) problems.push('re-parsed export is silent');
    if (a.positions < 2) problems.push('re-parsed export never advances');

    // Every note that MOD can represent must survive verbatim when the
    // source is itself a MOD.  This catches period-table and note-range
    // regressions that "it still makes noise" would happily hide.  For
    // XM/IT sources the written note is deliberately transposed by the
    // sample's relativeNote, so only require that a note is still there.
    const strict = song.type === 'mod';
    let cells = 0, kept = 0;
    const chans = Math.min(song.channels, back.channels);
    for (let p = 0; p < Math.min(song.patterns.length, back.patterns.length); p++) {
      const sp = song.patterns[p], bp = back.patterns[p];
      for (let r = 0; r < Math.min(64, sp.rows, bp.rows); r++) {
        for (let c = 0; c < chans; c++) {
          const so = TM.cellOffset(sp, r, c), bo = TM.cellOffset(bp, r, c);
          const n = sp.data[so + TM.C_NOTE];
          if (n < 49 || n > 84) continue; // outside MOD's three octaves
          cells++;
          const got = bp.data[bo + TM.C_NOTE];
          if (strict ? got === n : got >= TM.NOTE_MIN && got <= TM.NOTE_MAX) kept++;
        }
      }
    }
    const noteRatio = cells ? kept / cells : 1;
    if (noteRatio < 0.999) problems.push('notes changed: ' + kept + '/' + cells + ' preserved');

    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, name.replace(/\.[a-z0-9]+$/i, '') + '.export.mod'), Buffer.from(res.bytes));
    }

    if (problems.length) {
      fail++;
      failures.push(name + ': ' + problems.join('; '));
      console.log(`FAIL ${name.padEnd(16)} ${problems.join('; ')}`);
    } else {
      pass++;
      console.log(
        `ok   ${name.padEnd(16)} -> ${String((res.bytes.length / 1024).toFixed(0) + 'K').padStart(5)} ` +
          `ch=${back.channels} pat=${String(back.patterns.length).padStart(3)} ` +
          `notes=${kept}/${cells} peak=${a.peak.toFixed(3)} rms=${a.rms.toFixed(4)} ` +
          `notes-lost=${res.report.length ? res.report.length + ' report(s)' : 'none'}`
      );
      if (process.env.VERBOSE) res.report.forEach((l) => console.log('       - ' + l));
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
  failures.forEach((f) => console.log('  ' + f));
}
process.exit(fail ? 1 : 0);
