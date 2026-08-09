/* =====================================================================
 * dialogs.js -- the "new song" wizard and the song-properties editor.
 *
 * Both live in the single #modal sheet the rest of the app already uses.
 * They are kept out of app.js because they are the only screens with real
 * form state, and because neither one is allowed to touch app internals:
 * everything they need arrives in an `api` object (showModal, status, and
 * the two callbacks that adopt the result).  That keeps the "song object
 * is mutated in exactly one place" rule from app.js intact.
 *
 * The wizard is a three step affair rather than one long form because the
 * three decisions are genuinely sequential - the format caps the channel
 * count and fixes the pattern length, and the instrument step only makes
 * sense once you know how many channels the groove has to fill.  State
 * lives in a plain object; each step re-renders from it, so going back
 * never loses an answer.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function val(id, dflt) {
    var e = $(id);
    if (!e) return dflt;
    return e.type === 'checkbox' ? e.checked : e.value;
  }
  function num(id, dflt) {
    var v = parseInt(val(id, ''), 10);
    return isFinite(v) ? v : dflt;
  }

  /** <label> row for the two-column dialog forms. */
  function field(label, control, hint) {
    return (
      '<label class="f"><span>' + esc(label) + '</span><span class="c">' + control +
      (hint ? '<em>' + esc(hint) + '</em>' : '') + '</span></label>'
    );
  }
  function numberInput(id, value, min, max, step) {
    return (
      '<input type="number" id="' + id + '" value="' + value + '" min="' + min + '" max="' + max +
      '" step="' + (step || 1) + '">'
    );
  }
  function options(list, selected) {
    return list
      .map(function (o) {
        return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(selected) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      })
      .join('');
  }

  /* Enter anywhere in a dialog form triggers its primary action.  The
   * handler goes on the inputs, not on #modalcontent: that element is
   * reused by every dialog, so a listener left on it would pile up on the
   * next render and fire the button twice. */
  function bindEnter() {
    var content = $('modalcontent');
    if (!content) return;
    var inputs = content.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var btns = $('modalactions').querySelectorAll('button');
        var go = btns[btns.length - 1];
        if (go) go.click();
      });
    }
  }

  /* ================================================================== *
   * New song wizard
   * ================================================================== */
  var STEPS = ['Format', 'Timing', 'Instruments'];

  function crumbs(step) {
    return (
      '<div class="wizsteps">' +
      STEPS.map(function (s, i) {
        return '<span class="' + (i === step ? 'on' : i < step ? 'done' : '') + '">' + (i + 1) + '. ' + esc(s) + '</span>';
      }).join('') +
      '</div>'
    );
  }

  function openNew(api) {
    /* Defaults chosen so that pressing Enter three times yields something
     * that plays: a 4 channel MOD with a drum kit and a groove in it. */
    var w = {
      step: 0,
      title: 'Untitled',
      type: 'mod',
      channels: 4,
      rows: 64,
      patterns: 4,
      speed: 6,
      tempo: 125,
      globalVolume: 128,
      kit: TM.STARTER_KIT.map(function (k) { return k.id; }),
      emptySlots: 4,
      groove: true
    };

    function fmt() { return TM.FORMATS[w.type]; }

    /* Read whatever the visible step holds back into `w` so Back/Next and
     * the summary never show stale values. */
    function collect() {
      if (w.step === 0) {
        w.title = String(val('w-title', w.title)).substring(0, 63);
        w.type = val('w-type', w.type);
        w.channels = num('w-channels', w.channels);
        w.rows = num('w-rows', w.rows);
        w.patterns = num('w-patterns', w.patterns);
      } else if (w.step === 1) {
        w.speed = num('w-speed', w.speed);
        w.tempo = num('w-tempo', w.tempo);
        w.globalVolume = num('w-gv', w.globalVolume);
      } else if (w.step === 2) {
        w.kit = TM.STARTER_KIT.filter(function (k) { return val('w-kit-' + k.id, false); }).map(function (k) { return k.id; });
        w.emptySlots = num('w-empty', w.emptySlots);
        w.groove = !!val('w-groove', w.groove);
      }
      clampAll();
    }

    function clampAll() {
      var f = fmt();
      w.channels = TM.clamp(w.channels || 4, 1, f.maxChannels);
      w.rows = f.fixedRows || TM.clamp(w.rows || 64, 1, 256);
      w.patterns = TM.clamp(w.patterns || 1, 1, 128);
      w.speed = TM.clamp(w.speed || 6, 1, 31);
      w.tempo = TM.clamp(w.tempo || 125, 32, 255);
      w.globalVolume = TM.clamp(isFinite(w.globalVolume) ? w.globalVolume : 128, 0, 128);
      w.emptySlots = TM.clamp(w.emptySlots || 0, 0, 60);
    }

    function stepFormat() {
      var f = fmt();
      return (
        crumbs(0) +
        '<div class="form">' +
        field('Song title', '<input type="text" id="w-title" maxlength="63" value="' + esc(w.title) + '" placeholder="Untitled">',
          'MOD files store the first 20 characters.') +
        field('Format',
          '<select id="w-type">' +
            options(Object.keys(TM.FORMATS).map(function (k) { return [k, TM.FORMATS[k].label]; }), w.type) +
            '</select>', f.note) +
        field('Channels', numberInput('w-channels', w.channels, 1, f.maxChannels),
          'Up to ' + f.maxChannels + ' for this format.') +
        field('Rows per pattern',
          f.fixedRows
            ? '<input type="number" id="w-rows" value="' + f.fixedRows + '" disabled>'
            : numberInput('w-rows', w.rows, 1, 256),
          f.fixedRows ? 'MOD patterns are always 64 rows.' : '64 rows at 4 rows/beat is one 4-bar phrase.') +
        field('Patterns', numberInput('w-patterns', w.patterns, 1, 128),
          'They are placed in the order list as 00, 01, 02 ...') +
        '</div>'
      );
    }

    function stepTiming() {
      var rowsPerMin = (w.tempo * 24) / w.speed / 60; // rows per second
      var secs = (w.rows * w.patterns) / rowsPerMin;
      return (
        crumbs(1) +
        '<div class="form">' +
        field('Speed (ticks/row)', numberInput('w-speed', w.speed, 1, 31), 'Lower is faster. 6 is the tracker default.') +
        field('Tempo (BPM)', numberInput('w-tempo', w.tempo, 32, 255), '125 BPM at speed 6 = 50 Hz ticks, the Amiga standard.') +
        field('Global volume', numberInput('w-gv', w.globalVolume, 0, 128), '0-128. Leave headroom if you plan to layer.') +
        '</div>' +
        '<p class="hint">At speed ' + w.speed + ' / ' + w.tempo + ' BPM one row lasts ' +
        (1000 / rowsPerMin).toFixed(0) + ' ms, so ' + w.patterns + ' pattern' + (w.patterns === 1 ? '' : 's') +
        ' of ' + w.rows + ' rows runs about ' + secs.toFixed(1) + ' s. All of this is editable later.</p>'
      );
    }

    function stepInstruments() {
      var kit = TM.STARTER_KIT.map(function (k) {
        var on = w.kit.indexOf(k.id) >= 0;
        return (
          '<label class="kititem"><input type="checkbox" id="w-kit-' + k.id + '"' + (on ? ' checked' : '') + '>' +
          '<b>' + esc(k.name) + '</b><em>' + esc(k.hint) + '</em></label>'
        );
      }).join('');
      var total = w.kit.length + w.emptySlots;
      return (
        crumbs(2) +
        '<p class="hint">Generated in the browser at 8363 Hz, the reference rate this app tunes to - so they survive a ' +
        '.mod export untouched. Tonal waves are a single 16-sample cycle on a loop; drums are one-shots.</p>' +
        '<div class="kit">' + kit + '</div>' +
        '<div class="form">' +
        field('Empty slots', numberInput('w-empty', w.emptySlots, 0, 60), 'Blank sample slots to fill in later.') +
        field('Starter groove',
          '<label class="chk"><input type="checkbox" id="w-groove"' + (w.groove ? ' checked' : '') +
          '><span>Write a beat into pattern 00</span></label>',
          'Kick, snare, hats and a bass line - something to hear immediately.') +
        '</div>' +
        '<p class="hint">Creating <b>' + esc(w.title || 'Untitled') + '</b>: ' + esc(fmt().label) + ', ' +
        w.channels + ' channel' + (w.channels === 1 ? '' : 's') + ', ' + w.patterns + ' x ' + w.rows + ' rows, ' +
        total + ' sample slot' + (total === 1 ? '' : 's') + '.</p>'
      );
    }

    function render() {
      clampAll();
      var body = w.step === 0 ? stepFormat() : w.step === 1 ? stepTiming() : stepInstruments();
      var actions = [{ label: 'Cancel' }];
      if (w.step > 0) actions.push({ label: 'Back', keepOpen: true, onClick: function () { collect(); w.step--; render(); } });
      if (w.step < STEPS.length - 1) {
        actions.push({ label: 'Next', primary: true, keepOpen: true, onClick: function () { collect(); w.step++; render(); } });
      } else {
        actions.push({ label: 'Create song', primary: true, onClick: function () { collect(); finish(); } });
      }
      api.showModal('New song - step ' + (w.step + 1) + ' of ' + STEPS.length, body, actions);
      wire();
    }

    /* Live rewiring: the format select changes the limits shown on the same
     * step, and the timing step recomputes its length estimate as you type. */
    function wire() {
      var t = $('w-type');
      if (t) {
        t.addEventListener('change', function () {
          collect();
          var f = fmt();
          if (w.channels > f.maxChannels) w.channels = f.maxChannels;
          render();
        });
      }
      ['w-speed', 'w-tempo', 'w-patterns'].forEach(function (id) {
        var e = $(id);
        if (e && w.step === 1) e.addEventListener('change', function () { collect(); render(); });
      });
      var first = $('w-title') || $('w-speed') || $('w-empty');
      if (first) setTimeout(function () { first.focus(); if (first.select) first.select(); }, 30);
      bindEnter();
    }

    function finish() {
      var song;
      try {
        song = TM.createSong(w);
      } catch (e) {
        api.status('Could not create the song: ' + e.message, true);
        return;
      }
      /* Filename from the title: punctuation collapses to a single "_" and
       * is trimmed off the ends, so "Bass Test 9!" saves as "Bass Test 9",
       * not "Bass Test 9_". */
      var name =
        (w.title || 'untitled')
          .replace(/[^\w\-. ]+/g, '_')
          .replace(/_+/g, '_')
          .replace(/^[_ .]+|[_ .]+$/g, '')
          .substring(0, 40) || 'untitled';
      api.onCreate(song, name + '.' + w.type);
    }

    render();
  }

  /* ================================================================== *
   * Song properties (metadata) editor
   * ================================================================== */
  function openMetadata(api) {
    var song = api.song;
    if (!song) return;
    var fmt = TM.FORMATS[song.type] || TM.FORMATS.mod;
    var maxCh = Math.max(fmt.maxChannels, song.channels);

    function body() {
      return (
        '<div class="form">' +
        field('Title', '<input type="text" id="m-title" maxlength="63" value="' + esc(song.title) + '">',
          'The .mod exporter keeps the first 20 characters.') +
        field('Tracker', '<input type="text" id="m-tracker" value="' + esc(song.tracker || '') + '">',
          'Free text - shown next to the format in the status bar.') +
        field('Message', '<textarea id="m-message" rows="3" placeholder="Liner notes, greets, credits...">' +
          esc(song.message || '') + '</textarea>', 'Stored by XM and IT; ignored by MOD and S3M.') +
        '</div>' +
        '<h4>Playback</h4>' +
        '<div class="form">' +
        field('Initial speed', numberInput('m-speed', song.initialSpeed, 1, 31), 'Ticks per row.') +
        field('Initial tempo', numberInput('m-tempo', song.initialTempo, 32, 255), 'BPM.') +
        field('Global volume', numberInput('m-gv', song.globalVolume, 0, 128), '0-128.') +
        field('Mix volume', numberInput('m-mix', song.mixVolume, 0, 128), 'Pre-amp: lower it if loud songs clip.') +
        field('Restart position', numberInput('m-restart', song.restartPos, 0, Math.max(0, song.orders.length - 1)),
          'Order the song loops back to.') +
        field('Linear slides',
          '<label class="chk"><input type="checkbox" id="m-linear"' + (song.flags.linearSlides ? ' checked' : '') +
          '><span>Linear frequency slides</span></label>',
          'On for XM/IT, off for the Amiga-period formats.') +
        field('Amiga limits',
          '<label class="chk"><input type="checkbox" id="m-amiga"' + (song.flags.amigaLimits ? ' checked' : '') +
          '><span>Clamp periods to the Amiga range</span></label>',
          'Stops portamentos running off the top of the Paula range.') +
        '</div>' +
        '<h4>Structure</h4>' +
        '<div class="form">' +
        field('Channels', numberInput('m-channels', song.channels, 1, maxCh),
          'Adding channels appends empty ones; removing them discards their notes.') +
        field('Add patterns', numberInput('m-addpat', 0, 0, Math.max(0, 128 - song.patterns.length)),
          'Appends blank patterns to the end, each with its own order entry. Patterns are never removed here.') +
        '</div>' +
        '<p class="hint">Format: ' + esc(song.typeName) + ' &middot; ' + song.patterns.length + ' pattern' +
        (song.patterns.length === 1 ? '' : 's') + ' &middot; ' + song.orders.length + ' order' +
        (song.orders.length === 1 ? '' : 's') + ' &middot; ' + song.samples.length + ' sample' +
        (song.samples.length === 1 ? '' : 's') +
        '. Metadata changes are not covered by pattern undo.</p>'
      );
    }

    function show() {
      api.showModal('Song properties', body(), [
        { label: 'Cancel' },
        { label: 'Apply', primary: true, keepOpen: true, onClick: apply }
      ]);
      bindEnter();
      setTimeout(function () { var e = $('m-title'); if (e) { e.focus(); e.select(); } }, 30);
    }

    function apply() {
      var next = {
        title: String(val('m-title', song.title)).substring(0, 63),
        tracker: String(val('m-tracker', song.tracker || '')).substring(0, 63),
        message: String(val('m-message', song.message || '')),
        speed: TM.clamp(num('m-speed', song.initialSpeed), 1, 31),
        tempo: TM.clamp(num('m-tempo', song.initialTempo), 32, 255),
        gv: TM.clamp(num('m-gv', song.globalVolume), 0, 128),
        mix: TM.clamp(num('m-mix', song.mixVolume), 0, 128),
        restart: TM.clamp(num('m-restart', song.restartPos), 0, Math.max(0, song.orders.length - 1)),
        linear: !!val('m-linear', song.flags.linearSlides),
        amiga: !!val('m-amiga', song.flags.amigaLimits),
        channels: TM.clamp(num('m-channels', song.channels), 1, maxCh),
        addPat: TM.clamp(num('m-addpat', 0), 0, Math.max(0, 128 - song.patterns.length))
      };

      /* Dropping channels is the one destructive edit in this dialog and
       * pattern undo does not cover it, so ask first - but only when there
       * is actually something in the channels about to disappear. */
      if (next.channels < song.channels && TM.channelsInUse(song, next.channels)) {
        api.showModal(
          'Remove ' + (song.channels - next.channels) + ' channel' + (song.channels - next.channels === 1 ? '' : 's') + '?',
          '<p>Channels ' + (next.channels + 1) + '-' + song.channels + ' contain notes. Removing them deletes that ' +
            'data from every pattern, and this cannot be undone.</p>' +
            '<p class="hint">Export a .mod first if you want a copy of the current arrangement.</p>',
          [
            { label: 'Back', keepOpen: true, onClick: show },
            { label: 'Remove them', primary: true, onClick: function () { commit(next); } }
          ]
        );
        return;
      }
      commit(next);
      api.hideModal();
    }

    function commit(next) {
      var channelsChanged = next.channels !== song.channels;
      song.title = next.title;
      song.tracker = next.tracker;
      song.message = next.message;
      song.initialSpeed = next.speed;
      song.initialTempo = next.tempo;
      song.globalVolume = next.gv;
      song.mixVolume = next.mix;
      song.restartPos = next.restart;
      song.flags.linearSlides = next.linear;
      song.flags.amigaLimits = next.amiga;
      // Channels first: addPatterns() builds at the song's current width, so
      // patterns appended after the resize come out the right shape.
      if (channelsChanged) TM.setSongChannels(song, next.channels);
      if (next.addPat) TM.addPatterns(song, next.addPat);
      api.onApply({ channelsChanged: channelsChanged, patternsAdded: next.addPat });
    }

    show();
  }

  root.SongDialogs = { openNew: openNew, openMetadata: openMetadata };
})(typeof globalThis !== 'undefined' ? globalThis : this);
