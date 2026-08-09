#!/usr/bin/env node
/* =====================================================================
 * tools/test-archive.js -- regression harness for the archive readers.
 *
 * Builds ZIP / tar / gzip fixtures with the system tools when they are
 * available, then unpacks every archive in testdata/ with the real
 * browser code and compares each member byte-for-byte against the
 * original file it was made from.  A decompressor that is "nearly right"
 * produces plausible-looking noise, so nothing short of an exact compare
 * is worth asserting.
 *
 *   node tools/test-archive.js [archive ...]
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
for (const f of [
  'src/js/core/common.js',
  'src/js/formats/mod.js',
  'src/js/formats/s3m.js',
  'src/js/formats/xm.js',
  'src/js/formats/it.js',
  'src/js/formats/loader.js',
  'src/js/formats/archive.js'
]) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n//# sourceURL=' + f);
}
const TM = globalThis.TM;

const TESTDATA = path.join(ROOT, 'testdata');
const explicit = process.argv.slice(2);

/* ------------------------------------------------------------ fixtures */
const SOURCES = ['m42400.mod', 's66000.s3m', 't33000.xm', 'm45000.it']
  .map((f) => path.join(TESTDATA, f))
  .filter((f) => fs.existsSync(f));

function have(cmd) {
  try {
    execFileSync('sh', ['-c', 'command -v ' + cmd], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function buildFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-arc-'));
  const made = [];
  const staging = path.join(dir, 'src');
  fs.mkdirSync(staging);
  for (const s of SOURCES) fs.copyFileSync(s, path.join(staging, path.basename(s)));
  const names = SOURCES.map((s) => path.basename(s));

  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'ignore' });

  if (have('zip')) {
    for (const [level, tag] of [['-0', 'store'], ['-9', 'deflate']]) {
      const out = path.join(dir, `zip-${tag}.zip`);
      run('zip', [level, '-q', out, ...names], staging);
      made.push(out);
    }
  }
  if (have('tar')) {
    const t = path.join(dir, 'plain.tar');
    run('tar', ['-cf', t, ...names], staging);
    made.push(t);
    const tg = path.join(dir, 'plain.tar.gz');
    run('tar', ['-czf', tg, ...names], staging);
    made.push(tg);
  }
  if (have('gzip')) {
    const one = path.join(dir, path.basename(SOURCES[0]));
    fs.copyFileSync(SOURCES[0], one);
    run('gzip', ['-9', '-f', one], dir);
    made.push(one + '.gz');
  }
  if (have('arj')) {
    for (const m of [0, 1, 2, 3, 4]) {
      const out = path.join(dir, `arj-m${m}.arj`);
      try {
        run('arj', ['a', `-m${m}`, out, ...names], staging);
        made.push(out);
      } catch (e) { /* arj returns non-zero on warnings; keep going */ }
    }
  }
  return { dir, made };
}

/* -------------------------------------------------------------- checks */
let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ok    ' + label);
  } else {
    fail++;
    console.log('  FAIL  ' + label + (detail ? '  -- ' + detail : ''));
  }
}

function originalFor(name) {
  const base = path.basename(name);
  const p = path.join(TESTDATA, base);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

function testArchive(file) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const rel = path.basename(file);
  let arc;
  try {
    arc = TM.listArchive(bytes, rel);
  } catch (e) {
    check(rel, false, e.message);
    return;
  }
  console.log(rel + '  [' + arc.typeName + ', ' + arc.entries.length + ' entries]');
  if (!arc.entries.length) check(rel + ': entries', false, 'archive listed empty');

  for (const e of arc.entries) {
    let data;
    try {
      data = e.extract();
    } catch (err) {
      check(e.name + ' (' + e.methodName + ')', false, err.message);
      continue;
    }
    const want = originalFor(e.name);
    if (want) {
      const same = data.length === want.length && Buffer.compare(Buffer.from(data), want) === 0;
      check(e.name + ' (' + e.methodName + ', ' + data.length + ' bytes)', same,
        same ? '' : 'content differs from testdata/' + path.basename(e.name));
    } else {
      check(e.name + ' (' + e.methodName + ')', data.length === e.size, 'size mismatch');
    }
    /* The point of all this: an extracted member must parse as a module. */
    if (TM.looksLikeModuleName(e.name) && typeof TM.loadModule === 'function') {
      try {
        TM.loadModule(data, e.name);
      } catch (err) {
        check(e.name + ': parses as a module', false, err.message);
      }
    }
  }
}

/* ------------------------------------------------------------ negative */
function testRejections() {
  console.log('rejections');
  check('random bytes are not an archive',
    TM.detectArchive(new Uint8Array(64).fill(0x41)) === null);
  /* A false positive here would break plain module loading, so every
   * module in testdata/ has to sniff as "not an archive". */
  const mods = fs.readdirSync(TESTDATA).filter((f) => /\.(mod|s3m|xm|it)$/i.test(f));
  const wrong = mods.filter(
    (f) => TM.detectArchive(new Uint8Array(fs.readFileSync(path.join(TESTDATA, f)))) !== null
  );
  check(mods.length + ' bare modules are not mistaken for archives', wrong.length === 0, wrong.join(', '));
  check('an empty buffer is not an archive', TM.detectArchive(new Uint8Array(0)) === null);
}

function testCorruption(dir) {
  const zips = fs.readdirSync(dir).filter((f) => /^zip-deflate\.zip$/.test(f));
  if (!zips.length) return;
  console.log('corruption handling');
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, zips[0])));
  /* Flip bytes deep inside the first member's compressed data. */
  for (let i = 200; i < 260 && i < bytes.length; i++) bytes[i] ^= 0xff;
  let threw = false;
  try {
    const arc = TM.listArchive(bytes, 'damaged.zip');
    arc.entries[0].extract();
  } catch (e) {
    threw = true;
  }
  check('damaged deflate stream is rejected', threw);
}

/* ---------------------------------------------------------------- main */
let files = explicit;
let tmp = null;
if (!files.length) {
  tmp = buildFixtures();
  files = tmp.made;
  const fromTestdata = fs
    .readdirSync(TESTDATA)
    .filter((f) => /\.(zip|arj|lha|lzh|tar|gz|tgz)$/i.test(f))
    .map((f) => path.join(TESTDATA, f));
  files = files.concat(fromTestdata);
}

if (!files.length) {
  console.error('No archives to test (install zip/arj or pass files on the command line).');
  process.exit(1);
}

for (const f of files) testArchive(f);
testRejections();
if (tmp) testCorruption(tmp.dir);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
