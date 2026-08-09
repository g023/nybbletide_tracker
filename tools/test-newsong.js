#!/usr/bin/env node
/* =====================================================================
 * tools/test-newsong.js -- the new-song wizard's output, checked.
 *
 * The wizard is only worth anything if what it produces is a real song:
 * it has to load into the replay engine, make a noise, survive a .mod
 * export and come back through the loader still making the same noise.
 * The dialog itself is DOM code, so this harness drives the layer under
 * it -- TM.createSong(), TM.seedGroove() and TM.setSongChannels() -- which
 * is where every decision the wizard makes actually lands.
 *
 *   node tools/test-newsong.js
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = [
  'src/js/core/common.js',
  'src/js/core/songfactory.js',
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
const RATE = 44100;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  -- ' + detail : ''));
}

/** Render `secs` of a song and report peak / RMS and how many rows moved. */
function render(song, secs) {
  const player = new TM.TrackerPlayer(RATE);
  player.setSong(song);
  player.playing = true;
  player.loopSong = true;
  const block = 1024;
  const l = new Float32Array(block);
  const r = new Float32Array(block);
  let peak = 0;
  let sum = 0;
  let n = 0;
  const rows = new Set();
  const total = Math.ceil((secs * RATE) / block);
  for (let i = 0; i < total; i++) {
    l.fill(0);
    r.fill(0);
    player.render(l, r, block);
    for (let s = 0; s < block; s++) {
      const v = Math.abs(l[s]) > Math.abs(r[s]) ? l[s] : r[s];
      if (Math.abs(v) > peak) peak = Math.abs(v);
      sum += l[s] * l[s] + r[s] * r[s];
      n += 2;
    }
    rows.add(player.order * 1000 + player.row);
  }
  return { peak, rms: Math.sqrt(sum / n), rows: rows.size, duration: player.estimateDuration(600) };
}

const KIT = TM.STARTER_KIT.map((k) => k.id);

console.log('new song, every format');
for (const type of Object.keys(TM.FORMATS)) {
  const song = TM.createSong({
    title: 'Wizard ' + type.toUpperCase(),
    type,
    channels: 4,
    rows: 64,
    patterns: 2,
    speed: 6,
    tempo: 125,
    kit: KIT,
    emptySlots: 2,
    groove: true
  });
  const a = render(song, 3);
  check(
    type + ': plays',
    a.peak > 0.02 && a.rows > 4,
    `peak ${a.peak.toFixed(3)} rms ${a.rms.toFixed(4)} rows ${a.rows} est ${a.duration.toFixed(1)}s`
  );
  check(type + ': geometry', song.channels === 4 && song.patterns.length === 2 && song.orders.length === 2);
  check(type + ': slots', song.samples.length === KIT.length + 2 && song.instruments.length === song.samples.length);
  check(type + ': title kept', song.title === 'Wizard ' + type.toUpperCase());
}

console.log('an empty song is still valid');
{
  const song = TM.createSong({ title: '', type: 'it', channels: 8, rows: 32, patterns: 1, kit: [], emptySlots: 0, groove: false });
  const a = render(song, 1);
  check('silent but running', a.peak === 0 && a.rows > 1, `rows ${a.rows}`);
  check('one blank slot exists', song.samples.length === 1 && song.instruments.length === 1);
  check('geometry', song.channels === 8 && song.patterns[0].rows === 32);
}

console.log('MOD keeps its fixed 64 rows');
{
  const song = TM.createSong({ type: 'mod', rows: 16, patterns: 1, kit: KIT, groove: true });
  check('rows forced to 64', song.patterns[0].rows === 64, 'got ' + song.patterns[0].rows);
}

console.log('.mod export round trip');
{
  const song = TM.createSong({ title: 'Round Trip', type: 'mod', channels: 4, patterns: 2, kit: KIT, emptySlots: 1, groove: true });
  const before = render(song, 3);
  const res = TM.exportMOD(song);
  const back = TM.loadModule(res.bytes, 'roundtrip.mod');
  const after = render(back, 3);
  check('re-parses', !!back && back.channels === 4, back && back.typeName);
  check('title survives', back.title === 'Round Trip', back && back.title);
  check(
    'still audible',
    after.peak > 0.02 && Math.abs(after.rms - before.rms) < before.rms * 0.5,
    `rms ${before.rms.toFixed(4)} -> ${after.rms.toFixed(4)}`
  );
  check('clean export', res.report.length === 0, res.report.join(' | ') || 'no notes from the writer');
  if (res.report.length) console.log('       writer notes: ' + res.report.join(' | '));
}

console.log('channel count changes (song properties)');
{
  const song = TM.createSong({ type: 'it', channels: 4, patterns: 2, kit: KIT, groove: true });
  const cell = (s, p, r, c, b) => s.patterns[p].data[TM.cellOffset(s.patterns[p], r, c) + b];
  const note0 = cell(song, 0, 0, 0, TM.C_NOTE);
  const note3 = cell(song, 0, 0, 3, TM.C_NOTE);
  TM.setSongChannels(song, 12);
  check('grew', song.channels === 12 && song.patterns.every((p) => p.channels === 12));
  check('data preserved', cell(song, 0, 0, 0, TM.C_NOTE) === note0 && cell(song, 0, 0, 3, TM.C_NOTE) === note3);
  check('new channels blank', cell(song, 0, 0, 11, TM.C_NOTE) === 0);
  check('panning extended', song.panning.length === 12 && song.chanVolume.length === 12);
  check('detects data past a cut', TM.channelsInUse(song, 1) === true && TM.channelsInUse(song, 12) === false);
  const a = render(song, 2);
  check('still plays at 12 channels', a.peak > 0.02, `peak ${a.peak.toFixed(3)}`);
  TM.setSongChannels(song, 2);
  check('shrank', song.channels === 2 && song.patterns.every((p) => p.channels === 2 && p.data.length === p.rows * 2 * 6));
  check('kept channel 0', cell(song, 0, 0, 0, TM.C_NOTE) === note0);
  const b = render(song, 2);
  check('still plays at 2 channels', b.peak > 0.02, `peak ${b.peak.toFixed(3)}`);
}

console.log('generated samples');
{
  for (const spec of TM.STARTER_KIT) {
    const smp = TM.makeKitSample(spec);
    let peak = 0;
    let dc = 0;
    for (let i = 0; i < smp.length; i++) {
      peak = Math.max(peak, Math.abs(smp.data[i]));
      dc += smp.data[i];
    }
    dc /= smp.length || 1;
    const looped = spec.tonal ? smp.loopType === TM.LOOP_FORWARD && smp.loopEnd === smp.length : smp.loopType === TM.LOOP_NONE;
    check(
      spec.id,
      smp.length > 0 && peak > 0.4 && peak <= 1 && Math.abs(dc) < 0.2 && looped && smp.c5speed === 8363,
      `len ${smp.length} peak ${peak.toFixed(2)} dc ${dc.toFixed(3)}`
    );
  }
  // Deterministic: two runs must be byte identical, or the WAV export and
  // the .mod export would differ between sessions.
  const a = TM.makeKitSample(TM.STARTER_KIT.find((k) => k.id === 'snare'));
  const b = TM.makeKitSample(TM.STARTER_KIT.find((k) => k.id === 'snare'));
  let same = true;
  for (let i = 0; i < a.length; i++) if (a.data[i] !== b.data[i]) same = false;
  check('noise is reproducible', same);
}

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
process.exit(failures ? 1 : 0);
