/* =====================================================================
 * app.js -- the UI controller.
 *
 * Everything the user touches lives here: file intake, transport, the
 * order list, channel meters, the instrument/sample browser, the sample
 * waveform view, themes, keyboard shortcuts, undo and the exporters.
 *
 * Two rules keep this file from turning into spaghetti:
 *   1. The song object on this thread is the single source of truth for
 *      editing; every mutation goes through pushPattern() so the audio
 *      thread's copy is updated in exactly one place.
 *   2. Nothing here polls the engine.  The worklet posts a state message
 *      roughly every 23 ms; a single requestAnimationFrame loop paints
 *      whatever the latest state says.  No setInterval anywhere.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;

  var app = {
    song: null,
    engine: null,
    grid: null,
    viz: null,
    mutes: [],
    solos: [],
    currentInstrument: 1,
    duration: 0,
    playState: null,
    undoStack: [],
    redoStack: [],
    lastMessage: 0,
    filename: '',
    archiveName: '',
    followPattern: -1
  };
  root.Nybbletide = app;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function hex(v, n) {
    var s = (v | 0).toString(16).toUpperCase();
    while (s.length < n) s = '0' + s;
    return s;
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    var m = Math.floor(s / 60);
    return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  /* ------------------------------------------------------------ theme */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('wt-theme', t); } catch (e) {}
    $('themebtn').textContent = t === 'dark' ? '☀' : '☾';
    $('themebtn').title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    if (app.grid) app.grid.readColors();
    if (app.viz) app.viz.readColors();
    drawWaveform();
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('wt-theme'); } catch (e) {}
    if (!saved) {
      saved = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(saved);
    $('themebtn').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
  }

  /* ---------------------------------------------------------- status */
  function status(msg, isError) {
    var s = $('statusmsg');
    s.textContent = msg || '';
    s.className = 'msg' + (isError ? ' err' : '');
    app.lastMessage = Date.now();
    if (msg && !isError) {
      setTimeout(function () {
        if (Date.now() - app.lastMessage >= 4000) s.textContent = '';
      }, 4200);
    }
  }

  /* ----------------------------------------------------------- modal */
  function showModal(title, html, actions) {
    $('modaltitle').textContent = title;
    $('modalcontent').innerHTML = html;
    var box = $('modalactions');
    box.innerHTML = '';
    (actions || [{ label: 'Close' }]).forEach(function (a) {
      var b = el('button', a.primary ? 'primary' : '', a.label);
      b.addEventListener('click', function () {
        if (a.onClick) a.onClick();
        if (!a.keepOpen) $('modal').classList.remove('show');
      });
      box.appendChild(b);
    });
    $('modal').classList.add('show');
  }
  function hideModal() { $('modal').classList.remove('show'); }

  /* ------------------------------------------------------ file input */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(new Error('Could not read ' + file.name)); };
      fr.readAsArrayBuffer(file);
    });
  }

  function loadBytes(bytes, name) {
    var song;
    try {
      song = TM.loadModule(bytes, name);
    } catch (e) {
      status(e.message, true);
      return false;
    }
    app.song = song;
    app.filename = name;
    app.archiveName = '';
    app.duration = 0;
    app.undoStack = [];
    app.redoStack = [];
    app.currentInstrument = 1;
    app.mutes = [];
    app.solos = [];
    for (var i = 0; i < song.channels; i++) {
      app.mutes.push(!!song.chanMuted[i]);
      app.solos.push(false);
    }
    document.title = (song.title || name) + ' - Nybbletide';

    app.grid.setSong(song);
    app.grid.patternIndex = firstPattern(song);
    app.engine.loadSong(song);
    app.engine.setMutes(app.mutes);

    $('welcome').classList.add('hidden');
    buildOrderList();
    buildChannels();
    buildInstruments();
    selectInstrument(firstUsefulInstrument(song));
    updateInfo();
    updateTransport();
    status('Loaded ' + name + ' - ' + song.typeName);
    if ($('autoplay').checked) app.engine.play();
    return true;
  }

  function firstPattern(song) {
    for (var i = 0; i < song.orders.length; i++) {
      var o = song.orders[i];
      if (o !== TM.ORDER_SKIP && o !== TM.ORDER_END && o < song.patterns.length) return o;
    }
    return 0;
  }

  /* Slot 1 is very often a text-only "sample" holding the author's greets,
   * so open on the first entry that actually has audio in it. */
  function firstUsefulInstrument(song) {
    var list = song.flags.instrumentMode ? song.instruments : song.samples;
    for (var i = 0; i < list.length; i++) {
      if (song.flags.instrumentMode ? hasSample(song, list[i]) : list[i].data && list[i].length) return i + 1;
    }
    return 1;
  }

  /* ---------------------------------------------------------- archives */

  /* Modules travel in containers - ZIPs from ModArchive, ARJ from the DOS
   * boards, LHA from Aminet - so anything that sniffs as an archive is
   * opened rather than rejected.  One module inside means load it and say
   * nothing; several means show a picker. */
  function loadAnyBytes(bytes, name) {
    if (TM.detectArchive && TM.detectArchive(bytes)) {
      openArchive(bytes, name);
      return;
    }
    loadBytes(bytes, name);
  }

  function openArchive(bytes, name) {
    var arc;
    try {
      arc = TM.listArchive(bytes, name);
    } catch (e) {
      status('Could not read ' + name + ': ' + e.message, true);
      return;
    }
    if (!arc.entries.length) {
      status(name + ' is an empty ' + arc.typeName + ' archive.', true);
      return;
    }

    /* Sort likely modules to the top but keep everything: archives are
     * full of renamed files, and the loader detects by content anyway. */
    var modules = arc.entries.filter(function (e) { return TM.looksLikeModuleName(e.name); });
    var others = arc.entries.filter(function (e) { return !TM.looksLikeModuleName(e.name); });

    /* One module (plus any number of readmes and pictures) needs no
     * decision from the user. */
    if (modules.length === 1) {
      loadFromArchive(modules[0], name, arc);
      return;
    }
    if (!modules.length && arc.entries.length === 1) {
      loadFromArchive(arc.entries[0], name, arc);
      return;
    }
    showArchivePicker(arc, modules.concat(others), name);
  }

  function showArchivePicker(arc, entries, archiveName) {
    var rows = entries
      .map(function (e, i) {
        var likely = TM.looksLikeModuleName(e.name);
        return (
          '<tr class="arcrow' + (likely ? ' likely' : '') + '" data-index="' + i + '" tabindex="0">' +
          '<td class="arcname">' + escapeHtml(e.name) + '</td>' +
          '<td class="arcsize">' + fmtBytes(e.size) + '</td>' +
          '<td class="arcmethod">' + escapeHtml(e.methodName) + '</td>' +
          '</tr>'
        );
      })
      .join('');

    showModal(
      escapeHtml(archiveName) + ' - ' + arc.typeName + ' archive',
      '<p class="hint">' + entries.length + ' file' + (entries.length === 1 ? '' : 's') +
        ' inside. Pick one to load - it is unpacked here in the browser.</p>' +
        '<table class="arclist"><tbody>' + rows + '</tbody></table>',
      [{ label: 'Cancel' }]
    );

    var list = $('modalcontent').querySelectorAll('.arcrow');
    for (var i = 0; i < list.length; i++) {
      (function (row) {
        var entry = entries[parseInt(row.getAttribute('data-index'), 10)];
        function pick() {
          hideModal();
          loadFromArchive(entry, archiveName, arc);
        }
        row.addEventListener('click', pick);
        row.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); return; }
          /* A pack can hold dozens of files; tabbing through them all to
           * reach the one module is not navigation. */
          var step = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0;
          if (!step && ev.key !== 'Home' && ev.key !== 'End') return;
          ev.preventDefault();
          var here = parseInt(row.getAttribute('data-index'), 10);
          var to = ev.key === 'Home' ? 0
            : ev.key === 'End' ? list.length - 1
            : Math.min(list.length - 1, Math.max(0, here + step));
          list[to].focus();
        });
      })(list[i]);
    }
    if (list.length) list[0].focus();
  }

  function loadFromArchive(entry, archiveName, arc) {
    var data;
    status('Unpacking ' + entry.name + ' ...');
    try {
      data = entry.extract();
    } catch (e) {
      status(e.message, true);
      return;
    }
    var shortName = entry.name.split('/').pop() || entry.name;
    if (loadBytes(data, shortName)) {
      app.archiveName = archiveName;
      status('Loaded ' + shortName + ' from ' + archiveName + ' - ' + app.song.typeName);
    }
  }

  function handleFiles(files) {
    if (!files || !files.length) return;
    var file = files[0];
    readFile(file).then(
      function (bytes) { loadAnyBytes(bytes, file.name); },
      function (e) { status(e.message, true); }
    );
  }

  function loadFromUrl(url) {
    status('Fetching ' + url + ' ...');
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching the file');
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var name = url.split('/').pop().split('?')[0] || 'module';
        loadAnyBytes(new Uint8Array(buf), name);
      })
      .catch(function (e) {
        status(e.message + ' (the server may not allow cross-origin requests)', true);
      });
  }

  /* -------------------------------------------------------- info bar */
  function updateInfo() {
    var s = app.song;
    if (!s) return;
    $('i-title').textContent = s.title || '(untitled)';
    $('i-format').textContent = s.typeName + (s.tracker ? ' - ' + s.tracker : '');
    $('i-channels').textContent = s.channels;
    $('i-patterns').textContent = s.patterns.length;
    $('i-orders').textContent = s.orders.length;
    $('i-samples').textContent = s.samples.length + (s.flags.instrumentMode ? ' / ' + s.instruments.length + ' ins' : '');
    $('i-length').textContent = app.duration ? fmtTime(app.duration) : '-';
  }

  /* ------------------------------------------------------ order list */
  function buildOrderList() {
    var box = $('orderlist');
    box.innerHTML = '';
    var s = app.song;
    if (!s) return;
    for (var i = 0; i < s.orders.length; i++) {
      var o = s.orders[i];
      var marker = o === TM.ORDER_SKIP || o === TM.ORDER_END;
      var d = el('div', 'ord' + (marker ? ' marker' : ''), marker ? (o === TM.ORDER_SKIP ? '+++' : '---') : hex(o, 2));
      d.title = 'Order ' + i + (marker ? '' : ' - pattern ' + o);
      d.dataset.index = i;
      if (!marker) {
        (function (idx, pat) {
          d.addEventListener('click', function () {
            app.grid.patternIndex = pat;
            app.grid.row = 0;
            app.grid.dirty = true;
            app.engine.setPosition(idx, 0);
            highlightOrder(idx);
          });
        })(i, o);
      }
      box.appendChild(d);
    }
  }
  function highlightOrder(idx) {
    var kids = $('orderlist').children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('current', i === idx);
  }

  /* -------------------------------------------------------- channels */
  function buildChannels() {
    var box = $('channels');
    box.innerHTML = '';
    var s = app.song;
    if (!s) return;
    for (var i = 0; i < s.channels; i++) {
      (function (ci) {
        var row = el('div', 'chan');
        row.dataset.ch = ci;
        row.appendChild(el('div', 'num', String(ci + 1)));
        var meter = el('div', 'meter');
        var bar = el('i');
        meter.appendChild(bar);
        meter.appendChild(el('span', '', ''));
        row.appendChild(meter);
        var m = el('button', 'm', 'M');
        m.title = 'Mute channel ' + (ci + 1);
        m.addEventListener('click', function () { toggleMute(ci); });
        var so = el('button', 's', 'S');
        so.title = 'Solo channel ' + (ci + 1);
        so.addEventListener('click', function () { toggleSolo(ci); });
        row.appendChild(m);
        row.appendChild(so);
        box.appendChild(row);
      })(i);
    }
    refreshChannelButtons();
  }

  function toggleMute(ci) {
    app.mutes[ci] = !app.mutes[ci];
    app.engine.setMutes(app.mutes);
    refreshChannelButtons();
    app.grid.dirty = true;
  }
  function toggleSolo(ci) {
    var wasOnlySolo = app.solos[ci] && app.solos.filter(Boolean).length === 1;
    if (wasOnlySolo) app.solos = app.solos.map(function () { return false; });
    else {
      app.solos = app.solos.map(function (_, i) { return i === ci; });
    }
    app.engine.setSolos(app.solos);
    refreshChannelButtons();
    app.grid.dirty = true;
  }
  function refreshChannelButtons() {
    var kids = $('channels').children;
    var anySolo = app.solos.some(Boolean);
    for (var i = 0; i < kids.length; i++) {
      var row = kids[i];
      row.querySelector('button.m').classList.toggle('on', !!app.mutes[i]);
      row.querySelector('button.s').classList.toggle('on', !!app.solos[i]);
      row.classList.toggle('muted', effectivelyMuted(i));
    }
    $('unmuteall').classList.toggle('on', app.mutes.some(Boolean) || anySolo);
  }
  function effectivelyMuted(i) {
    if (app.solos.some(Boolean)) return !app.solos[i];
    return !!app.mutes[i];
  }

  /* ----------------------------------------------------- instruments */
  function buildInstruments() {
    var box = $('instlist');
    box.innerHTML = '';
    var s = app.song;
    if (!s) return;
    var list = s.flags.instrumentMode ? s.instruments : s.samples;
    for (var i = 0; i < list.length; i++) {
      (function (idx) {
        var item = list[idx];
        var name = (item.name || '').trim();
        var empty = s.flags.instrumentMode
          ? !hasSample(s, s.instruments[idx])
          : !(item.data && item.length);
        var d = el('div', 'inst' + (empty ? ' empty' : ''));
        d.appendChild(el('div', 'n', hex(idx + 1, 2)));
        d.appendChild(el('div', 'name', name || (empty ? '-' : '(unnamed)')));
        d.title = (s.flags.instrumentMode ? 'Instrument ' : 'Sample ') + (idx + 1) + ': ' + (name || 'unnamed');
        d.addEventListener('click', function () { selectInstrument(idx + 1); });
        d.addEventListener('dblclick', function () { previewNote(61); });
        box.appendChild(d);
      })(i);
    }
  }
  function hasSample(song, inst) {
    for (var i = 0; i < 120; i++) {
      var si = inst.sampleMap[i] - 1;
      if (si >= 0 && song.samples[si] && song.samples[si].length) return true;
    }
    return false;
  }

  function currentSample() {
    var s = app.song;
    if (!s) return null;
    if (!s.flags.instrumentMode) return s.samples[app.currentInstrument - 1] || null;
    var inst = s.instruments[app.currentInstrument - 1];
    if (!inst) return null;
    var si = inst.sampleMap[60] - 1; // C-5 by default
    if (si < 0 || !s.samples[si]) {
      for (var i = 0; i < 120; i++) {
        var t = inst.sampleMap[i] - 1;
        if (t >= 0 && s.samples[t] && s.samples[t].length) { si = t; break; }
      }
    }
    return s.samples[si] || null;
  }

  function selectInstrument(n) {
    app.currentInstrument = n;
    var kids = $('instlist').children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('sel', i === n - 1);
    if (kids[n - 1] && kids[n - 1].scrollIntoView) {
      var box = $('instlist');
      var top = kids[n - 1].offsetTop;
      if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 20) box.scrollTop = top - 40;
    }
    drawWaveform();
    updateSampleInfo();
  }

  function updateSampleInfo() {
    var s = app.song;
    var box = $('sampleinfo');
    box.innerHTML = '';
    var smp = currentSample();
    if (!smp) {
      box.appendChild(el('div', '', 'no sample'));
      return;
    }
    var inst = s.flags.instrumentMode ? s.instruments[app.currentInstrument - 1] : null;
    var rows = [
      ['name', smp.name || '-'],
      ['length', smp.length.toLocaleString() + ' smp'],
      ['C-5', Math.round(smp.c5speed) + ' Hz'],
      ['volume', smp.volume + '/64'],
      ['loop', smp.loopType === TM.LOOP_NONE ? 'off' : (smp.loopType === TM.LOOP_PINGPONG ? 'ping-pong ' : 'forward ') + smp.loopStart + '-' + smp.loopEnd],
      ['sustain', smp.susLoopType === TM.LOOP_NONE ? 'off' : smp.susLoopStart + '-' + smp.susLoopEnd]
    ];
    if (inst) {
      rows.push(['env', (inst.volEnv.enabled ? 'vol ' : '') + (inst.panEnv.enabled ? 'pan ' : '') + (inst.pitchEnv.enabled ? 'pitch' : '') || 'none']);
      rows.push(['NNA', ['cut', 'continue', 'note off', 'fade'][inst.nna] || 'cut']);
    }
    rows.forEach(function (r) {
      var d = el('div');
      d.appendChild(el('span', '', r[0] + ': '));
      var b = el('b', '', String(r[1]));
      d.appendChild(b);
      box.appendChild(d);
    });
  }

  /* --------------------------------------------------- waveform view */
  function drawWaveform() {
    var canvas = $('waveform');
    if (!canvas) return;
    var dpr = root.devicePixelRatio || 1;
    var w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cs = getComputedStyle(document.documentElement);
    var g = function (n) { return cs.getPropertyValue(n).trim(); };
    ctx.fillStyle = g('--bg-sunken');
    ctx.fillRect(0, 0, w, h);

    var smp = currentSample();
    ctx.strokeStyle = g('--border');
    ctx.beginPath();
    ctx.moveTo(0, h / 2 + 0.5);
    ctx.lineTo(w, h / 2 + 0.5);
    ctx.stroke();
    if (!smp || !smp.length) {
      ctx.fillStyle = g('--fg-faint');
      ctx.font = '11px ' + g('--ui');
      ctx.fillText('no sample data', 8, h / 2 - 6);
      return;
    }

    // Loop region behind the waveform.
    if (smp.loopType !== TM.LOOP_NONE) {
      ctx.fillStyle = g('--accent-soft');
      var lx0 = (smp.loopStart / smp.length) * w;
      var lx1 = (smp.loopEnd / smp.length) * w;
      ctx.fillRect(lx0, 0, Math.max(1, lx1 - lx0), h);
    }

    // Min/max envelope per pixel column: correct at any zoom, and cheap.
    var data = smp.data;
    var n = smp.length;
    var accent = g('--accent');
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.85;
    var step = n / w;
    ctx.beginPath();
    for (var x = 0; x < w; x++) {
      var i0 = Math.floor(x * step);
      var i1 = Math.min(n, Math.floor((x + 1) * step));
      if (i1 <= i0) i1 = i0 + 1;
      var mn = 1,
        mx = -1;
      for (var i = i0; i < i1 && i < n; i++) {
        var v = data[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mn > mx) { mn = mx = 0; }
      var y0 = h / 2 - mx * (h / 2 - 3);
      var y1 = h / 2 - mn * (h / 2 - 3);
      ctx.moveTo(x + 0.5, y0);
      ctx.lineTo(x + 0.5, Math.max(y1, y0 + 0.6));
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (smp.loopType !== TM.LOOP_NONE) {
      ctx.strokeStyle = g('--ok');
      ctx.beginPath();
      var a = (smp.loopStart / smp.length) * w;
      var b = (smp.loopEnd / smp.length) * w;
      ctx.moveTo(a + 0.5, 0); ctx.lineTo(a + 0.5, h);
      ctx.moveTo(b - 0.5, 0); ctx.lineTo(b - 0.5, h);
      ctx.stroke();
    }
  }

  function previewNote(note) {
    app.engine.noteOn(note, app.currentInstrument, 64);
  }

  /* ------------------------------------------------------- transport */
  function updateTransport() {
    var has = !!app.song;
    ['play', 'pause', 'stop', 'savemod', 'savewav'].forEach(function (id) { $(id).disabled = !has; });
  }

  function play() { app.engine.play(); }
  function pause() { app.engine.pause(); }
  function stop() {
    app.engine.stop();
    app.grid.playRow = -1;
    app.grid.dirty = true;
  }
  function togglePlay() {
    if (app.playState && app.playState.playing) pause();
    else play();
  }

  /* ------------------------------------------------------------ undo */
  function snapshot(patIndex) {
    var pat = app.song.patterns[patIndex];
    if (!pat) return;
    app.undoStack.push({ index: patIndex, data: new Uint8Array(pat.data), rows: pat.rows });
    if (app.undoStack.length > 200) app.undoStack.shift();
    app.redoStack.length = 0;
  }
  function undo() {
    var s = app.undoStack.pop();
    if (!s) { status('Nothing to undo'); return; }
    var pat = app.song.patterns[s.index];
    app.redoStack.push({ index: s.index, data: new Uint8Array(pat.data), rows: pat.rows });
    pat.data = s.data;
    pat.rows = s.rows;
    app.engine.pushPattern(s.index, pat);
    app.grid.patternIndex = s.index;
    app.grid.dirty = true;
    status('Undo');
  }
  function redo() {
    var s = app.redoStack.pop();
    if (!s) { status('Nothing to redo'); return; }
    var pat = app.song.patterns[s.index];
    app.undoStack.push({ index: s.index, data: new Uint8Array(pat.data), rows: pat.rows });
    pat.data = s.data;
    pat.rows = s.rows;
    app.engine.pushPattern(s.index, pat);
    app.grid.patternIndex = s.index;
    app.grid.dirty = true;
    status('Redo');
  }

  /* --------------------------------------------------------- exports */
  function download(bytes, name, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function baseName() {
    var n = (app.filename || app.song.title || 'module').replace(/\.[a-z0-9]+$/i, '');
    return n.replace(/[^\w\-. ]+/g, '_').substring(0, 60) || 'module';
  }

  function saveMOD() {
    if (!app.song) return;
    var res;
    try {
      res = TM.exportMOD(app.song);
    } catch (e) {
      status('Export failed: ' + e.message, true);
      return;
    }
    var doIt = function () {
      download(res.bytes, baseName() + '.mod', 'audio/mod');
      status('Saved ' + baseName() + '.mod (' + fmtBytes(res.bytes.length) + ')');
    };
    if (!res.report.length) { doIt(); return; }
    var html =
      '<p>ProTracker MOD is a smaller format than what this song uses. ' +
      'The file will still be valid and playable, but the following changes were made:</p><ul>' +
      res.report.map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') +
      '</ul><p class="hint">Nothing in the editor is modified - only the exported file.</p>';
    showModal('Save as .mod - ' + res.report.length + ' note' + (res.report.length > 1 ? 's' : ''), html, [
      { label: 'Cancel' },
      { label: 'Download anyway', primary: true, onClick: doIt }
    ]);
  }

  function saveWAV() {
    if (!app.song) return;
    status('Rendering WAV, this can take a few seconds...');
    setTimeout(function () {
      try {
        var seconds = Math.min(600, app.duration || 120);
        var bytes = TM.renderWAV(app.song, {
          sampleRate: 44100,
          seconds: seconds,
          muteMask: app.mutes.map(function (m, i) { return effectivelyMuted(i); })
        });
        download(bytes, baseName() + '.wav', 'audio/wav');
        status('Rendered ' + fmtTime(seconds) + ' to WAV (' + fmtBytes(bytes.length) + ')');
      } catch (e) {
        status('WAV render failed: ' + e.message, true);
      }
    }, 60);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ------------------------------------------------------- main loop */
  function frame() {
    if (app.viz && app.engine.ctx) app.viz.draw(app.engine.ctx.sampleRate);

    var st = app.playState;
    if (st) {
      $('t-order').textContent = hex(st.order, 2) + '/' + hex(app.song ? app.song.orders.length - 1 : 0, 2);
      $('t-pattern').textContent = hex(st.pattern, 2);
      $('t-row').textContent = hex(st.row, 2);
      $('t-speed').textContent = st.speed;
      $('t-tempo').textContent = st.tempo;
      $('t-voices').textContent = st.activeVoices;
      // Elapsed time is derived from the tick clock, not wall time, so it
      // stays correct across pauses and seeks.
      $('t-time').textContent = fmtTime(st.time || 0) + ' / ' + fmtTime(app.duration);

      var kids = $('channels').children;
      for (var i = 0; i < kids.length && i < st.vu.length; i++) {
        var bar = kids[i].firstChild.nextSibling.firstChild;
        bar.style.width = Math.round(Math.min(1, st.vu[i]) * 100) + '%';
        var lbl = kids[i].firstChild.nextSibling.lastChild;
        var nn = st.notes[i] ? TM.noteName(st.notes[i]) : '';
        if (lbl.textContent !== nn) lbl.textContent = nn;
      }

      if (app.grid) {
        app.grid.playing = st.playing;
        app.grid.playRow = st.row;
        if (st.playing && app.grid.follow && app.grid.patternIndex !== st.pattern) {
          app.grid.patternIndex = st.pattern;
          app.grid.dirty = true;
        }
        if (st.playing) app.grid.dirty = true;
        if (app.followPattern !== st.order) {
          app.followPattern = st.order;
          highlightOrder(st.order);
        }
      }
      $('play').classList.toggle('on', st.playing);
    }

    if (app.grid && app.song) {
      $('patternwrap').classList.toggle('nofocus', !app.grid.focused);
    }
    if (app.grid && (app.grid.dirty || (st && st.playing))) {
      app.grid.render();
      app.grid.dirty = false;
    }
    requestAnimationFrame(frame);
  }

  /* --------------------------------------------------------- startup */
  function bindGlobalKeys() {
    document.addEventListener('keydown', function (e) {
      var tag = (e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'select' || tag === 'textarea';
      if (e.key === 'Escape') { hideModal(); return; }
      if (typing) return;
      // The pattern grid calls preventDefault() on everything it consumes,
      // so this is how the two keyboard owners stay out of each other's way.
      if (e.defaultPrevented) return;

      if (e.ctrlKey || e.metaKey) {
        if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); redo(); }
        else if (e.code === 'KeyO') { e.preventDefault(); $('fileinput').click(); }
        else if (e.code === 'KeyS') { e.preventDefault(); saveMOD(); }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'F5') { e.preventDefault(); play(); }
      else if (e.code === 'F6') { e.preventDefault(); pause(); }
      else if (e.code === 'F8') { e.preventDefault(); stop(); }
      else if (e.code === 'F1') { e.preventDefault(); showHelp(); }
      else if (e.code === 'KeyL' && e.altKey) { e.preventDefault(); $('loop').click(); }
    });
  }

  function showHelp() {
    showModal(
      'Nybbletide - help',
      '<table>' +
        [
          ['<kbd>Space</kbd>', 'Play / pause'],
          ['<kbd>F5</kbd> / <kbd>F6</kbd> / <kbd>F8</kbd>', 'Play, pause, stop'],
          ['<kbd>Ctrl</kbd>+<kbd>O</kbd>', 'Open a module'],
          ['<kbd>Ctrl</kbd>+<kbd>S</kbd>', 'Save as .mod'],
          ['<kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>', 'Undo / redo pattern edits'],
          ['Arrows, <kbd>PgUp</kbd>/<kbd>PgDn</kbd>, <kbd>Home</kbd>/<kbd>End</kbd>', 'Move the edit cursor'],
          ['<kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd>', 'Next / previous channel'],
          ['<kbd>Z</kbd> <kbd>S</kbd> <kbd>X</kbd> <kbd>D</kbd> <kbd>C</kbd> ... / <kbd>Q</kbd> <kbd>2</kbd> <kbd>W</kbd> <kbd>3</kbd> ...',
            'Piano keys: lower and upper octave (tracker layout)'],
          ['<kbd>`</kbd>', 'Note off (<code>===</code>)'],
          ['<kbd>Space</kbd> in the note column', 'Note cut (<code>^^^</code>)'],
          ['<kbd>0</kbd>-<kbd>9</kbd>, <kbd>A</kbd>-<kbd>F</kbd>', 'Hex digits in the instrument / volume / effect columns'],
          ['A letter in the effect column', 'Set the effect (IT letters: A speed, D volume slide, ...)'],
          ['<kbd>Del</kbd> / <kbd>Ins</kbd>', 'Clear the field / insert a blank row in this channel'],
          ['Mouse wheel / <kbd>Shift</kbd>+wheel', 'Scroll rows / channels'],
          ['Click a row number', 'Jump playback to that row'],
          ['Click a channel header', 'Mute that channel'],
          ['Double-click an instrument', 'Audition it at C-5']
        ]
          .map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>'; })
          .join('') +
        '</table>' +
        '<p class="hint">Supported formats: ProTracker <code>.mod</code>, Scream Tracker 3 <code>.s3m</code>, ' +
        'FastTracker II <code>.xm</code> and Impulse Tracker <code>.it</code>. ' +
        'Archives are unpacked in the browser too: <code>.zip</code>, <code>.arj</code>, ' +
        '<code>.lha</code>/<code>.lzh</code>, <code>.tar</code>, <code>.gz</code> and ' +
        '<code>.tar.gz</code> - drop one in and pick the module you want. ' +
        'Everything runs locally in your browser - no file ever leaves this machine.</p>',
      [{ label: 'Got it', primary: true }]
    );
  }

  function showOpenUrl() {
    showModal(
      'Open a module from a URL',
      '<p>The server must send permissive CORS headers, otherwise the browser will block the request.</p>' +
        '<p><input type="text" id="urlinput" style="width:100%" placeholder="https://example.com/song.xm"></p>',
      [
        { label: 'Cancel' },
        {
          label: 'Load',
          primary: true,
          onClick: function () {
            var v = $('urlinput').value.trim();
            if (v) loadFromUrl(v);
          }
        }
      ]
    );
    setTimeout(function () { var i = $('urlinput'); if (i) i.focus(); }, 30);
  }

  function init() {
    initTheme();
    bindGlobalKeys();

    app.engine = new root.AudioEngine();
    app.grid = new root.PatternGrid($('pattern'), {
      isMuted: effectivelyMuted,
      currentInstrument: function () { return app.currentInstrument; },
      beforeEdit: snapshot,
      onEdit: function (idx) {
        app.engine.pushPattern(idx, app.song.patterns[idx]);
      },
      onPreview: function (note) { previewNote(note); },
      onSeekRow: function (row) {
        var order = app.playState ? app.playState.order : 0;
        // Seek within whichever order slot currently shows this pattern.
        var s = app.song;
        if (s.orders[order] !== app.grid.patternIndex) {
          for (var i = 0; i < s.orders.length; i++) if (s.orders[i] === app.grid.patternIndex) { order = i; break; }
        }
        app.engine.setPosition(order, row);
      },
      onHeaderClick: function (ci) { toggleMute(ci); },
      onFollowChange: function (v) { $('follow').classList.toggle('on', v); }
    });

    app.engine.onLoaded = function (m) {
      app.duration = m.duration;
      updateInfo();
    };
    app.engine.onState = function (st) {
      app.playState = st;
    };

    app.engine
      .init()
      .then(function () {
        app.viz = new root.Visualizer(app.engine.analyser, $('scope'), $('spectrum'));
        $('i-engine').textContent = app.engine.mode === 'worklet' ? 'AudioWorklet' : 'ScriptProcessor';
        $('i-rate').textContent = Math.round(app.engine.ctx.sampleRate) + ' Hz';
        var q = new URLSearchParams(location.search);
        var u = q.get('mod') || q.get('url');
        if (u) loadFromUrl(u);
      })
      .catch(function (e) {
        status(e.message, true);
      });

    // ---- file intake ---------------------------------------------
    $('openbtn').addEventListener('click', function () { $('fileinput').click(); });
    $('urlbtn').addEventListener('click', showOpenUrl);
    $('fileinput').addEventListener('change', function (e) {
      handleFiles(e.target.files);
      e.target.value = '';
    });

    var dropOverlay = $('drop');
    var dragDepth = 0;
    ['dragenter', 'dragover'].forEach(function (t) {
      root.addEventListener(t, function (e) {
        e.preventDefault();
        if (t === 'dragenter') dragDepth++;
        dropOverlay.classList.add('show');
      });
    });
    root.addEventListener('dragleave', function (e) {
      e.preventDefault();
      if (--dragDepth <= 0) { dragDepth = 0; dropOverlay.classList.remove('show'); }
    });
    root.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      dropOverlay.classList.remove('show');
      handleFiles(e.dataTransfer.files);
    });

    // ---- transport -------------------------------------------------
    $('play').addEventListener('click', play);
    $('pause').addEventListener('click', pause);
    $('stop').addEventListener('click', stop);
    $('loop').addEventListener('click', function () {
      var on = !this.classList.contains('on');
      this.classList.toggle('on', on);
      app.engine.setLoop(on);
    });
    $('follow').addEventListener('click', function () {
      app.grid.follow = !app.grid.follow;
      this.classList.toggle('on', app.grid.follow);
      app.grid.dirty = true;
    });
    $('editmode').addEventListener('click', function () {
      app.grid.editMode = !app.grid.editMode;
      this.classList.toggle('on', app.grid.editMode);
      app.grid.dirty = true;
      status(app.grid.editMode ? 'Edit mode on' : 'Edit mode off (playback only)');
    });
    $('unmuteall').addEventListener('click', function () {
      app.mutes = app.mutes.map(function () { return false; });
      app.solos = app.solos.map(function () { return false; });
      app.engine.setMutes(app.mutes);
      app.engine.setSolos(app.solos);
      refreshChannelButtons();
      app.grid.dirty = true;
    });
    $('savemod').addEventListener('click', saveMOD);
    $('savewav').addEventListener('click', saveWAV);
    $('helpbtn').addEventListener('click', showHelp);
    $('modalclose').addEventListener('click', hideModal);
    $('modal').addEventListener('click', function (e) { if (e.target === this) hideModal(); });

    $('volume').addEventListener('input', function () {
      app.engine.setMasterVolume(parseFloat(this.value));
      $('volumeval').textContent = Math.round(this.value * 100) + '%';
    });
    $('interp').addEventListener('change', function () {
      app.engine.setInterpolation(parseInt(this.value, 10));
    });
    $('sep').addEventListener('input', function () {
      app.engine.setStereoSeparation(parseFloat(this.value));
      $('sepval').textContent = Math.round(this.value * 100) + '%';
    });
    $('octave').addEventListener('change', function () {
      app.grid.octave = parseInt(this.value, 10);
    });
    $('step').addEventListener('change', function () {
      app.grid.step = parseInt(this.value, 10);
    });

    root.addEventListener('resize', function () {
      if (app.grid) app.grid.dirty = true;
      drawWaveform();
    });

    updateTransport();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
