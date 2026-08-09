#!/usr/bin/env node
/* =====================================================================
 * build.js -- concatenate everything into a single self-contained
 * index.html.
 *
 * The brief requires one file that can be dropped on any server (or even
 * opened from disk).  That rules out ES modules, import maps and separate
 * worklet files, so every source file is a plain IIFE that hangs its
 * exports off a global `TM` namespace and the build simply pastes them in
 * dependency order.
 *
 * The worklet bundle deliberately DUPLICATES common.js, player.js and
 * processor.js: the AudioWorklet global scope shares nothing with the
 * window, and inlining the text is the only way to feed it those files
 * without a network request.  The alternative - eval()ing the same text on
 * both threads - breaks under a strict Content-Security-Policy, which is
 * exactly the kind of server this thing is supposed to be droppable onto.
 *
 * Usage:  node tools/build.js [--out index.html] [--minify]
 * ===================================================================== */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SRC = path.join(ROOT, 'src');

/* Order matters: common defines the vocabulary, formats depend on it,
 * loader depends on the formats, archive only on common (it hands bytes
 * back to the loader), the player on common, and the app layer on
 * everything. */
var MAIN_BUNDLE = [
  'js/core/common.js',
  'js/formats/mod.js',
  'js/formats/s3m.js',
  'js/formats/xm.js',
  'js/formats/it.js',
  'js/formats/loader.js',
  'js/formats/archive.js',
  'js/player/player.js',
  'js/player/processor.js',
  'js/export/modwriter.js',
  'js/app/audio.js',
  'js/app/patterngrid.js',
  'js/app/visualizer.js',
  'js/app/app.js'
];

/* The audio thread needs only the model, the replay engine and the
 * processor shell - no parsers, no DOM code. */
var WORKLET_BUNDLE = ['js/core/common.js', 'js/player/player.js', 'js/player/processor.js'];

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

function banner(rel) {
  return '\n/* ===== ' + rel + ' ' + new Array(Math.max(2, 62 - rel.length)).join('=') + ' */\n';
}

function bundle(files) {
  return files.map(function (f) { return banner(f) + read(f); }).join('\n');
}

/* A literal "</script" anywhere inside inline script text ends the element,
 * no matter that it sits inside a JS string or comment.  Splitting it is
 * the standard, parser-safe escape. */
function escapeScript(text) {
  return text.replace(/<\/(script)/gi, '<\\/$1');
}

/* Conservative size trim: strip full-line block comments and leading
 * indentation only.  Anything cleverer would need a real parser, and the
 * unminified build is the readable artefact the brief asks for. */
function trim(text) {
  return text
    .split('\n')
    .filter(function (l) {
      var t = l.trim();
      return t !== '' && !/^\/\/ /.test(t) && !/^\*/.test(t) && !/^\/\*/.test(t);
    })
    .map(function (l) { return l.replace(/^\s+/, ''); })
    .join('\n');
}

function main() {
  var args = process.argv.slice(2);
  var outPath = path.join(ROOT, 'index.html');
  var minify = false;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--out') outPath = path.resolve(args[++i]);
    else if (args[i] === '--minify') minify = true;
  }

  var css = fs.readFileSync(path.join(SRC, 'css/style.css'), 'utf8');
  var worklet = bundle(WORKLET_BUNDLE);
  var mainJs = bundle(MAIN_BUNDLE);

  if (minify) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n/g, '\n');
    worklet = trim(worklet);
    mainJs = trim(mainJs);
  }

  var html = fs.readFileSync(path.join(SRC, 'html/index.template.html'), 'utf8');
  // Replacement callbacks, not strings: "$&" and friends in the sources
  // would otherwise be interpreted as replacement patterns.
  html = html.replace('/*[[CSS]]*/', function () { return css; });
  html = html.replace('/*[[WORKLET]]*/', function () { return escapeScript(worklet); });
  html = html.replace('/*[[JS]]*/', function () { return escapeScript(mainJs); });

  var head =
    '<!doctype html>\n<html lang="en">\n' +
    '<!--\n' +
    '  Nybbletide - MOD / S3M / XM / IT player and editor.\n' +
    '  Built by tools/build.js from the files under src/ - edit those, not this.\n' +
    '  (c) g023  https://github.com/g023  https://x.com/g023dev   MIT licence.\n' +
    '-->\n';
  html = head + html + '\n</html>\n';

  fs.writeFileSync(outPath, html);
  var kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log('built ' + path.relative(ROOT, outPath) + '  ' + kb + ' KB' + (minify ? '  (minified)' : ''));

  // Sanity: every placeholder must be gone, or the page silently ships broken.
  ['/*[[CSS]]*/', '/*[[WORKLET]]*/', '/*[[JS]]*/'].forEach(function (p) {
    if (html.indexOf(p) !== -1) {
      console.error('ERROR: placeholder ' + p + ' was not replaced');
      process.exit(1);
    }
  });
}

main();
