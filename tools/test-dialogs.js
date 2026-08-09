#!/usr/bin/env node
/* =====================================================================
 * tools/test-dialogs.js -- drive the new-song wizard and the song
 * properties editor without a browser.
 *
 * dialogs.js is DOM code, but it is DOM code of a very narrow kind: it
 * builds HTML strings, hands them to showModal(), and later reads the
 * values back out by id.  That round trip is exactly where the bugs are
 * (a field renamed in the markup but not in the reader is silent), so
 * this harness closes the loop: a stub `document` parses the emitted
 * HTML back into fake input/select/textarea elements, and the test
 * clicks the dialog's own action buttons.  Nothing is stubbed on the
 * dialog side - the real collect(), clampAll(), apply() and commit()
 * run.
 *
 *   node tools/test-dialogs.js
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

/* ------------------------------------------------------------ stub DOM */
let elements = {};

function unesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
function attrs(tag) {
  const out = {};
  const re = /([\w-]+)(?:="([^"]*)")?/g;
  let m;
  re.exec(tag); // skip the tag name itself
  while ((m = re.exec(tag))) out[m[1]] = m[2] === undefined ? '' : unesc(m[2]);
  return out;
}
function mkEl(id, type, value, checked) {
  return {
    id, type, value, checked: !!checked,
    addEventListener(ev, fn) { (this._h || (this._h = {}))[ev] = fn; },
    dispatch(ev) { if (this._h && this._h[ev]) this._h[ev].call(this, { key: '', preventDefault() {} }); },
    focus() {}, select() {}
  };
}

/** Parse an emitted dialog body into the elements the dialog will read back. */
function parse(html) {
  const map = {};
  let m;
  const inputRe = /<input\b[^>]*>/g;
  while ((m = inputRe.exec(html))) {
    const a = attrs(m[0]);
    if (!a.id) continue;
    map[a.id] = mkEl(a.id, a.type || 'text', a.value === undefined ? '' : a.value, 'checked' in a);
  }
  const selRe = /<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
  while ((m = selRe.exec(html))) {
    const opts = [];
    let o;
    const optRe = /<option value="([^"]*)"( selected)?>/g;
    while ((o = optRe.exec(m[2]))) opts.push({ value: unesc(o[1]), selected: !!o[2] });
    const sel = opts.find((x) => x.selected) || opts[0];
    const el = mkEl(m[1], 'select-one', sel ? sel.value : '', false);
    el.options = opts.map((x) => x.value);
    map[m[1]] = el;
  }
  const taRe = /<textarea\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g;
  while ((m = taRe.exec(html))) map[m[1]] = mkEl(m[1], 'textarea', unesc(m[2]), false);
  return map;
}

globalThis.document = {
  getElementById(id) { return elements[id] || null; }
};
globalThis.setTimeout = globalThis.setTimeout || function () {};

for (const f of SRC) {
  // eslint-disable-next-line no-eval
  (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n//# sourceURL=' + f);
}
// dialogs.js must load after the stub document exists.
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(path.join(ROOT, 'src/js/app/dialogs.js'), 'utf8') + '\n//# sourceURL=dialogs.js');

const TM = globalThis.TM;
const D = globalThis.SongDialogs;

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  -- ' + detail : ''));
}

/* A fake modal: records the last screen and re-parses it into `elements`,
 * exactly as the browser would after innerHTML. */
function makeApi(extra) {
  const api = {
    screens: [],
    messages: [],
    open: false,
    showModal(title, html, actions) {
      api.screens.push({ title, html, actions: actions || [] });
      api.open = true;
      elements = parse(html);
    },
    hideModal() { api.open = false; },
    status(msg, bad) { api.messages.push((bad ? 'ERR ' : '') + msg); }
  };
  return Object.assign(api, extra || {});
}
function last(api) { return api.screens[api.screens.length - 1]; }
/** Click an action button by label, the way showModal wires them up. */
function click(api, label) {
  const a = last(api).actions.filter((x) => x.label === label)[0];
  if (!a) throw new Error('no "' + label + '" button on "' + last(api).title + '"');
  if (a.onClick) a.onClick();
  if (!a.keepOpen) api.open = false;
  return a;
}
/** Enough of a render to prove a mutated song still makes a noise. */
function render(song, secs) {
  const p = new TM.TrackerPlayer(44100);
  p.setSong(song);
  p.playing = true;
  p.loopSong = true;
  const l = new Float32Array(1024);
  const r = new Float32Array(1024);
  let peak = 0;
  for (let i = 0; i < Math.ceil((secs * 44100) / 1024); i++) {
    l.fill(0); r.fill(0);
    p.render(l, r, 1024);
    for (let s = 0; s < 1024; s++) peak = Math.max(peak, Math.abs(l[s]), Math.abs(r[s]));
  }
  return { peak };
}

function set(id, v) {
  const e = elements[id];
  if (!e) throw new Error('no element #' + id + ' on screen');
  if (e.type === 'checkbox') e.checked = !!v;
  else e.value = String(v);
  return e;
}

/* ================================================================== */
console.log('wizard: three Enters give a playable song');
{
  let made = null;
  const api = makeApi({ onCreate(song, name) { made = { song, name }; } });
  D.openNew(api);
  check('opens on step 1', /step 1 of 3/.test(last(api).title), last(api).title);
  check('step 1 has its fields', !!(elements['w-title'] && elements['w-type'] && elements['w-channels']));
  click(api, 'Next');
  check('step 2 is timing', /step 2 of 3/.test(last(api).title) && !!elements['w-speed'] && !!elements['w-tempo']);
  click(api, 'Next');
  check('step 3 is instruments', /step 3 of 3/.test(last(api).title) && !!elements['w-empty'] && !!elements['w-groove']);
  check('every kit item has a checkbox', TM.STARTER_KIT.every((k) => !!elements['w-kit-' + k.id]));
  click(api, 'Create song');
  check('created a song', !!made, api.messages.join(' | '));
  if (made) {
    check('defaults land', made.song.type === 'mod' && made.song.channels === 4 && made.song.patterns.length === 4,
      made.song.type + ' ' + made.song.channels + 'ch x' + made.song.patterns.length);
    check('filename', made.name === 'Untitled.mod', made.name);
    check('groove was written', TM.channelsInUse(made.song, 0) === true);
    check('full kit + empty slots', made.song.samples.length === TM.STARTER_KIT.length + 4, '' + made.song.samples.length);
    check('no error status', api.messages.length === 0, api.messages.join(' | '));
  }
}

console.log('wizard: edits survive Back and Next');
{
  let made = null;
  const api = makeApi({ onCreate(song, name) { made = { song, name }; } });
  D.openNew(api);
  set('w-title', 'Bass Test 9!');
  set('w-type', 'it');
  set('w-channels', '10');
  set('w-rows', '48');
  set('w-patterns', '3');
  click(api, 'Next');
  set('w-speed', '4');
  set('w-tempo', '150');
  set('w-gv', '96');
  click(api, 'Back');
  check('step 1 remembers', elements['w-title'].value === 'Bass Test 9!' && elements['w-channels'].value === '10' &&
    elements['w-rows'].value === '48', JSON.stringify([elements['w-title'].value, elements['w-channels'].value, elements['w-rows'].value]));
  check('format select re-selects IT', elements['w-type'].value === 'it', elements['w-type'].value);
  click(api, 'Next');
  check('step 2 remembers', elements['w-speed'].value === '4' && elements['w-tempo'].value === '150' &&
    elements['w-gv'].value === '96');
  click(api, 'Next');
  // Turn the tonal instruments off, keep the drums.
  TM.STARTER_KIT.forEach((k) => set('w-kit-' + k.id, !!k.drum));
  set('w-empty', '2');
  click(api, 'Create song');
  check('created', !!made, api.messages.join(' | '));
  if (made) {
    const s = made.song;
    check('format/geometry', s.type === 'it' && s.channels === 10 && s.patterns[0].rows === 48 && s.patterns.length === 3,
      s.type + ' ' + s.channels + 'ch ' + s.patterns[0].rows + 'r x' + s.patterns.length);
    check('timing', s.initialSpeed === 4 && s.initialTempo === 150 && s.globalVolume === 96,
      s.initialSpeed + '/' + s.initialTempo + '/' + s.globalVolume);
    check('kit trimmed to drums', s.samples.length === TM.STARTER_KIT.filter((k) => k.drum).length + 2, '' + s.samples.length);
    check('title kept, filename sanitised', s.title === 'Bass Test 9!' && made.name === 'Bass Test 9.it', made.name);
  }
}

console.log('wizard: format switch retunes the limits');
{
  const api = makeApi({ onCreate() {} });
  D.openNew(api);
  set('w-channels', '30');
  set('w-type', 's3m');
  elements['w-type'].dispatch('change');   // the live re-render the dialog binds
  check('channels clamped to the S3M max', Number(elements['w-channels'].value) <= TM.FORMATS.s3m.maxChannels,
    elements['w-channels'].value);
  set('w-type', 'mod');
  elements['w-type'].dispatch('change');
  check('MOD locks the row count', elements['w-rows'].value === '64' && /disabled/.test(last(api).html), elements['w-rows'].value);
  set('w-channels', '999');
  set('w-patterns', '0');
  click(api, 'Next');
  click(api, 'Back');
  check('out-of-range input is clamped, not rejected',
    Number(elements['w-channels'].value) === TM.FORMATS.mod.maxChannels && Number(elements['w-patterns'].value) === 1,
    elements['w-channels'].value + ' / ' + elements['w-patterns'].value);
}

console.log('wizard: an empty kit still builds');
{
  let made = null;
  const api = makeApi({ onCreate(song) { made = song; } });
  D.openNew(api);
  click(api, 'Next');
  click(api, 'Next');
  TM.STARTER_KIT.forEach((k) => set('w-kit-' + k.id, false));
  set('w-empty', '0');
  set('w-groove', false);
  click(api, 'Create song');
  check('song exists and is silent', !!made && made.samples.length === 1 && TM.channelsInUse(made, 0) === false);
}

console.log('properties: reads the song and writes it back');
{
  const song = TM.createSong({ title: 'Before', type: 'xm', channels: 8, patterns: 2, kit: ['kick', 'snare'], groove: true });
  let applied = null;
  const api = makeApi({ song, onApply(info) { applied = info; } });
  D.openMetadata(api);
  check('prefilled from the song', elements['m-title'].value === 'Before' &&
    Number(elements['m-speed'].value) === song.initialSpeed && Number(elements['m-channels'].value) === 8,
    elements['m-title'].value);
  check('flags prefilled', elements['m-linear'].checked === song.flags.linearSlides);
  set('m-title', 'After');
  set('m-tracker', 'Nybbletide');
  set('m-message', 'greets to everyone');
  set('m-speed', '3');
  set('m-tempo', '180');
  set('m-gv', '100');
  set('m-mix', '48');
  set('m-linear', !song.flags.linearSlides);
  click(api, 'Apply');
  check('applied', !!applied && applied.channelsChanged === false);
  check('fields written', song.title === 'After' && song.tracker === 'Nybbletide' && song.message === 'greets to everyone' &&
    song.initialSpeed === 3 && song.initialTempo === 180 && song.globalVolume === 100 && song.mixVolume === 48,
    [song.title, song.tracker, song.initialSpeed, song.initialTempo, song.globalVolume, song.mixVolume].join('/'));
  check('flag toggled', song.flags.linearSlides === true || song.flags.linearSlides === false);
  check('modal closed', api.open === false);
}

console.log('properties: clamps nonsense instead of corrupting the song');
{
  const song = TM.createSong({ type: 'it', channels: 4, patterns: 1, kit: ['sine'] });
  const api = makeApi({ song, onApply() {} });
  D.openMetadata(api);
  set('m-speed', '0');
  set('m-tempo', '9999');
  set('m-gv', '-5');
  set('m-channels', 'abc');
  click(api, 'Apply');
  check('speed/tempo/volume clamped', song.initialSpeed === 1 && song.initialTempo === 255 && song.globalVolume === 0,
    song.initialSpeed + '/' + song.initialTempo + '/' + song.globalVolume);
  check('unparseable channel count falls back', song.channels === 4, '' + song.channels);
}

console.log('properties: growing and shrinking channels');
{
  const song = TM.createSong({ type: 'it', channels: 4, patterns: 2, kit: ['kick', 'snare', 'hat', 'saw'], groove: true });
  let applied = null;
  const api = makeApi({ song, onApply(i) { applied = i; } });
  D.openMetadata(api);
  set('m-channels', '9');
  click(api, 'Apply');
  check('grew without a prompt', song.channels === 9 && applied && applied.channelsChanged === true &&
    song.patterns.every((p) => p.channels === 9));
  check('panning grew too', song.panning.length === 9 && song.chanVolume.length === 9);

  // Shrinking back over live data must ask first.
  applied = null;
  D.openMetadata(api);
  set('m-channels', '2');
  click(api, 'Apply');
  check('confirm sheet appears', /Remove \d+ channels\?/.test(last(api).title), last(api).title);
  check('nothing changed yet', song.channels === 9 && applied === null);
  click(api, 'Back');
  check('Back returns to the form', last(api).title === 'Song properties' && !!elements['m-channels']);
  set('m-channels', '2');
  click(api, 'Apply');
  click(api, 'Remove them');
  check('channels removed on confirm', song.channels === 2 && applied && applied.channelsChanged === true &&
    song.patterns.every((p) => p.channels === 2));
  check('modal closed after the confirm', api.open === false);
}

console.log('properties: appending patterns');
{
  const song = TM.createSong({ type: 'xm', channels: 6, patterns: 2, kit: ['sine'], groove: true });
  let applied = null;
  const api = makeApi({ song, onApply(i) { applied = i; } });
  D.openMetadata(api);
  check('defaults to adding none', elements['m-addpat'].value === '0');
  set('m-addpat', '3');
  click(api, 'Apply');
  check('three appended', song.patterns.length === 5 && applied.patternsAdded === 3, '' + song.patterns.length);
  check('each got an order entry', song.orders.length === 5 && song.orders[4] === 4, song.orders.join(','));
  check('appended at the song width', song.patterns[4].channels === 6 && song.patterns[4].rows === song.patterns[0].rows);
  check('new patterns are blank', song.patterns[4].data.every((b) => b === 0));
  check('existing patterns untouched', TM.channelsInUse(song, 0) === true);

  // Widening and appending in one Apply: the new patterns must come out at
  // the NEW width, not the old one.
  D.openMetadata(api);
  set('m-channels', '10');
  set('m-addpat', '1');
  click(api, 'Apply');
  check('appended after the resize', song.patterns.length === 6 && song.patterns.every((p) => p.channels === 10),
    song.patterns.map((p) => p.channels).join(','));
  const r = render(song, 2);
  check('still plays', r.peak > 0.02, `peak ${r.peak.toFixed(3)}`);
}

console.log('properties: shrinking empty channels does not nag');
{
  const song = TM.createSong({ type: 'it', channels: 8, patterns: 1, kit: ['sine'], groove: false });
  const api = makeApi({ song, onApply() {} });
  D.openMetadata(api);
  set('m-channels', '3');
  click(api, 'Apply');
  check('applied straight away', song.channels === 3 && last(api).title === 'Song properties');
}

console.log('properties: every id the dialogs read is actually rendered');
{
  const song = TM.createSong({ type: 'it', channels: 4, patterns: 1, kit: [] });
  const seen = {};
  const api = makeApi({ song, onApply() {}, onCreate() {} });
  D.openMetadata(api);
  api.screens.forEach((s) => Object.keys(parse(s.html)).forEach((id) => (seen[id] = 1)));
  const wapi = makeApi({ onCreate() {} });
  D.openNew(wapi);
  click(wapi, 'Next');
  click(wapi, 'Next');
  wapi.screens.forEach((s) => Object.keys(parse(s.html)).forEach((id) => (seen[id] = 1)));

  const src = fs.readFileSync(path.join(ROOT, 'src/js/app/dialogs.js'), 'utf8');
  const wanted = new Set();
  let m;
  const re = /\b(?:val|num)\(\s*'([\w-]+)'/g;
  while ((m = re.exec(src))) wanted.add(m[1]);
  const dyn = /'w-kit-'/.test(src);
  if (dyn) TM.STARTER_KIT.forEach((k) => wanted.add('w-kit-' + k.id));
  const missing = [...wanted].filter((id) => !seen[id] && id !== 'w-kit-');
  check('no reader without a field', missing.length === 0, missing.join(', ') || (wanted.size + ' ids checked'));
}

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
process.exit(failures ? 1 : 0);
