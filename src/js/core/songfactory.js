/* =====================================================================
 * songfactory.js -- building songs from nothing, and reshaping them.
 *
 * Everything else in this project reads a file and transcodes it into the
 * canonical model from common.js.  This file is the one place that creates
 * that model out of thin air, for the "new song" wizard, plus the two
 * structural edits the metadata dialog needs (changing the channel count
 * and re-tagging the song's format flavour).
 *
 * ARCHITECTURE NOTES
 * ------------------
 * 1. A brand new song with no samples is silent and no fun, so the wizard
 *    can seed a small synthesised kit.  Every generated sample is written
 *    at c5speed 8363 Hz - the reference rate the whole model is normalised
 *    to - which means the .mod exporter can store them with a finetune of
 *    ~0 and no "tuning clamped" warning.
 * 2. The tonal waveforms are exactly one cycle of 16 samples long, looped.
 *    16 samples at 8363 Hz is 522.7 Hz, i.e. the note the cell says (C-5),
 *    and a 16 point cycle carries no harmonic above the 8th, so it is
 *    naturally band limited and stays clean when the mixer resamples it
 *    upwards.  That is the same trick the Amiga chip-waveform modules use.
 * 3. Format choice is expressed purely as flags on the canonical song, the
 *    same ones the four parsers set.  There is no "MOD song object" - the
 *    engine only ever sees the one model.
 * ===================================================================== */
(function (root) {
  'use strict';

  var TM = root.TM;

  /* Reference rate for every generated sample: one sample at 8363 Hz is
   * exactly note C-5 in the canonical model. */
  var GEN_RATE = 8363;
  var CYCLE = 16; // samples per cycle of a tonal waveform

  /* Deterministic noise so two runs of the wizard produce byte-identical
   * songs (and so the WAV export is reproducible). */
  function noiseGen(seed) {
    var s = seed >>> 0 || 1;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s >>> 8) / 8388608 - 1; // -1 .. 1
    };
  }

  /* ---------------------------------------------------------------- *
   * Waveform generators
   * ---------------------------------------------------------------- */
  function tonalWave(kind) {
    var f = new Float32Array(CYCLE);
    for (var i = 0; i < CYCLE; i++) {
      var t = i / CYCLE;
      var v;
      if (kind === 'sine') v = Math.sin(2 * Math.PI * t);
      else if (kind === 'square') v = t < 0.5 ? 0.85 : -0.85;
      else if (kind === 'pulse') v = t < 0.25 ? 0.85 : -0.85;
      else if (kind === 'saw') v = 0.92 * (1 - 2 * t);
      else if (kind === 'triangle') v = t < 0.25 ? 4 * t : t < 0.75 ? 2 - 4 * t : 4 * t - 4;
      else v = 0;
      f[i] = v;
    }
    return f;
  }

  /* Kick: a pitch envelope from 180 Hz down to 45 Hz over ~60 ms with an
   * exponential amplitude decay.  Integrating the frequency (rather than
   * evaluating sin(2*pi*f(t)*t)) is what keeps the sweep phase continuous. */
  function kickWave() {
    var n = 2400,
      f = new Float32Array(n),
      phase = 0;
    for (var i = 0; i < n; i++) {
      var t = i / GEN_RATE;
      var hz = 45 + 135 * Math.exp(-t * 26);
      phase += (2 * Math.PI * hz) / GEN_RATE;
      var env = Math.exp(-t * 9) * (1 - Math.exp(-t * 900));
      f[i] = Math.sin(phase) * env * 0.98;
    }
    return f;
  }

  /* Snare: a short noise burst over a 190 Hz body tone. */
  function snareWave() {
    var n = 1800,
      f = new Float32Array(n),
      rnd = noiseGen(0x5eed);
    for (var i = 0; i < n; i++) {
      var t = i / GEN_RATE;
      var body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 34) * 0.45;
      var noise = rnd() * Math.exp(-t * 20) * 0.75;
      f[i] = Math.max(-1, Math.min(1, body + noise));
    }
    return f;
  }

  /* Hi-hat: differentiated noise (a cheap one-pole high pass) so it reads
   * as metallic rather than as a burst of pink mush. */
  function hatWave() {
    var n = 700,
      f = new Float32Array(n),
      rnd = noiseGen(0xbeef),
      prev = 0;
    for (var i = 0; i < n; i++) {
      var t = i / GEN_RATE;
      var x = rnd();
      var hp = x - prev;
      prev = x;
      f[i] = Math.max(-1, Math.min(1, hp * Math.exp(-t * 70) * 0.9));
    }
    return f;
  }

  /* ---------------------------------------------------------------- *
   * The starter kit.  `role` is what seedGroove() looks for.
   * ---------------------------------------------------------------- */
  TM.STARTER_KIT = [
    { id: 'sine', name: 'Sine Lead', role: 'lead', tonal: 'sine', volume: 48, hint: 'pure tone, good for leads and bleeps' },
    { id: 'square', name: 'Square Lead', role: 'lead', tonal: 'square', volume: 44, hint: 'hollow chip lead' },
    { id: 'saw', name: 'Saw Bass', role: 'bass', tonal: 'saw', volume: 48, hint: 'buzzy - the classic tracker bass' },
    { id: 'triangle', name: 'Triangle', role: 'pad', tonal: 'triangle', volume: 52, hint: 'soft, mellow, sits under a lead' },
    { id: 'kick', name: 'Kick', role: 'kick', drum: kickWave, volume: 64, hint: 'sine-sweep bass drum' },
    { id: 'snare', name: 'Snare', role: 'snare', drum: snareWave, volume: 60, hint: 'noise + body tone' },
    { id: 'hat', name: 'Hi-Hat', role: 'hat', drum: hatWave, volume: 42, hint: 'short metallic tick' }
  ];

  /** Build one canonical sample record for a starter-kit entry. */
  TM.makeKitSample = function (spec) {
    var smp = TM.makeSample();
    smp.name = spec.name;
    smp.volume = spec.volume;
    smp.c5speed = GEN_RATE;
    if (spec.tonal) {
      smp.data = tonalWave(spec.tonal);
      smp.length = smp.data.length;
      // A one-cycle loop is what turns 16 samples into a sustained note.
      smp.loopType = TM.LOOP_FORWARD;
      smp.loopStart = 0;
      smp.loopEnd = smp.length;
    } else {
      smp.data = spec.drum();
      smp.length = smp.data.length;
    }
    return smp;
  };

  /** The instrument wrapper MOD/S3M-style songs also carry, so the engine
   *  never needs a "no instrument layer" special case. */
  function instrumentForSample(index, name) {
    var ins = TM.makeInstrument();
    ins.name = name;
    for (var n = 0; n < 120; n++) ins.sampleMap[n] = index + 1;
    return ins;
  }
  TM.instrumentForSample = instrumentForSample;

  /* ---------------------------------------------------------------- *
   * Format flavours.  These are exactly the flags the four parsers set;
   * keeping them in one table means the wizard, the metadata dialog and
   * the loaders cannot drift apart.
   * ---------------------------------------------------------------- */
  TM.FORMATS = {
    mod: {
      type: 'mod',
      typeName: 'Amiga Module (.mod)',
      label: 'ProTracker MOD',
      note: '4 channels, 64-row patterns, Amiga periods. The only format this app can save to.',
      maxChannels: 32,
      fixedRows: 64,
      instrumentMode: false,
      apply: function (s) {
        s.flags.amigaLimits = true;
        s.flags.modVolSlideQuirk = true;
        s.flags.linearSlides = false;
        s.flags.gvScale = 1;
        s.tracker = 'ProTracker';
      }
    },
    s3m: {
      type: 's3m',
      typeName: 'Scream Tracker 3 (.s3m)',
      label: 'Scream Tracker 3',
      note: 'Up to 32 channels, variable pattern length, sample-based (no envelopes).',
      maxChannels: 32,
      instrumentMode: false,
      apply: function (s) {
        s.flags.st3Portas = true;
        s.flags.fastVolSlides = false;
        s.flags.linearSlides = false;
        s.flags.gvScale = 2;
        s.tracker = 'Scream Tracker 3';
      }
    },
    xm: {
      type: 'xm',
      typeName: 'FastTracker II (.xm)',
      label: 'FastTracker II XM',
      note: 'Instruments with envelopes, linear frequency slides, up to 32 channels.',
      maxChannels: 32,
      instrumentMode: true,
      apply: function (s) {
        s.flags.linearSlides = true;
        s.flags.xmMode = true;
        s.flags.xmGlobalVol = true;
        s.flags.gvScale = 2;
        s.tracker = 'FastTracker v2.00';
      }
    },
    it: {
      type: 'it',
      typeName: 'Impulse Tracker (.it)',
      label: 'Impulse Tracker',
      note: 'The richest model: NNAs, per-sample tuning, up to 64 channels.',
      maxChannels: 64,
      instrumentMode: true,
      apply: function (s) {
        s.flags.linearSlides = true;
        s.flags.itMode = true;
        s.flags.itCompatGxx = true;
        s.flags.gvScale = 1;
        s.tracker = 'Impulse Tracker 2.14';
      }
    }
  };

  /** Default channel panning for a format: MOD gets the Amiga LRRL layout,
   *  S3M the ST3 LRLR one, the rest start centred. */
  function defaultPanning(type, ch) {
    if (type === 'mod') return ch % 4 === 0 || ch % 4 === 3 ? 64 : 192;
    if (type === 's3m') return ch % 2 === 0 ? 64 : 192;
    return 128;
  }
  TM.defaultPanning = defaultPanning;

  /* ---------------------------------------------------------------- *
   * The factory itself
   * ---------------------------------------------------------------- */

  /**
   * Create a playable song from scratch.
   *
   * @param {object} opts
   *   title, type ('mod'|'s3m'|'xm'|'it'), channels, rows, patterns,
   *   speed, tempo, globalVolume, kit (array of STARTER_KIT ids),
   *   emptySlots (number of blank sample slots to append), groove (bool)
   * @returns {object} canonical song
   */
  TM.createSong = function (opts) {
    opts = opts || {};
    var fmt = TM.FORMATS[opts.type] || TM.FORMATS.mod;
    var song = TM.makeSong();

    song.type = fmt.type;
    song.typeName = fmt.typeName;
    song.title = String(opts.title === undefined ? '' : opts.title).substring(0, 63);
    song.flags.instrumentMode = fmt.instrumentMode;
    fmt.apply(song);

    song.channels = TM.clamp(opts.channels | 0 || 4, 1, fmt.maxChannels);
    var rows = TM.clamp(opts.rows | 0 || 64, 1, 256);
    if (fmt.fixedRows) rows = fmt.fixedRows;
    var count = TM.clamp(opts.patterns | 0 || 1, 1, 256);

    song.initialSpeed = TM.clamp(opts.speed | 0 || 6, 1, 31);
    song.initialTempo = TM.clamp(opts.tempo | 0 || 125, 32, 255);
    song.globalVolume = TM.clamp(opts.globalVolume === undefined ? 128 : opts.globalVolume | 0, 0, 128);
    song.mixVolume = 48;
    song.restartPos = 0;
    song.message = '';

    for (var i = 0; i < count; i++) {
      song.patterns.push(TM.makePattern(rows, song.channels));
      song.orders.push(i);
    }

    for (var ch = 0; ch < song.channels; ch++) {
      song.panning.push(defaultPanning(song.type, ch));
      song.chanVolume.push(64);
      song.chanMuted.push(false);
    }

    /* ---- samples ---------------------------------------------------- */
    var wanted = opts.kit || [];
    var roles = {};
    TM.STARTER_KIT.forEach(function (spec) {
      if (wanted.indexOf(spec.id) < 0) return;
      var smp = TM.makeKitSample(spec);
      song.samples.push(smp);
      song.instruments.push(instrumentForSample(song.samples.length - 1, smp.name));
      // First sample of each role wins - that is what the groove writes.
      if (roles[spec.role] === undefined) roles[spec.role] = song.samples.length;
    });

    var blanks = TM.clamp(opts.emptySlots === undefined ? 0 : opts.emptySlots | 0, 0, 99);
    for (i = 0; i < blanks; i++) {
      song.samples.push(TM.makeSample());
      song.instruments.push(instrumentForSample(song.samples.length - 1, ''));
    }

    /* Every format wants at least one slot to point notes at. */
    if (!song.samples.length) {
      song.samples.push(TM.makeSample());
      song.instruments.push(instrumentForSample(0, ''));
    }

    if (opts.groove) TM.seedGroove(song, roles);
    return song;
  };

  /* ---------------------------------------------------------------- *
   * Starter groove.
   *
   * Written at the conventional four rows per beat, so a 16 row block is
   * one bar: kick on every beat, snare on 2 and 4, hats on the offbeats
   * and a I-I-V-IV bass line.  Roles are packed into whatever channels
   * exist, and the drums are laid out so that two of them can share a
   * channel without ever colliding on the same row.
   * ---------------------------------------------------------------- */
  TM.seedGroove = function (song, roles) {
    var pat = song.patterns[0];
    if (!pat || pat.rows < 4) return;

    var lanes = [];
    if (roles.kick) lanes.push({ inst: roles.kick, note: 61, every: 4, offset: 0 });
    if (roles.snare) lanes.push({ inst: roles.snare, note: 61, every: 8, offset: 4 });
    if (roles.hat) lanes.push({ inst: roles.hat, note: 61, every: 2, offset: 2 });

    /* C-4 C-4 G-4 F-4.  Deliberately no lower than C-4: that is the bottom
     * of the ProTracker period table, so the groove exports to .mod without
     * a single note being transposed. */
    var bassNotes = [49, 49, 56, 54];
    var bass = roles.bass || roles.lead || roles.pad;

    /* Give each lane its own channel while there are channels left, then
     * start doubling up (the patterns interleave, so nothing is lost). */
    var chan = 0;
    lanes.forEach(function (lane) {
      lane.chan = chan % song.channels;
      chan++;
    });

    lanes.forEach(function (lane) {
      for (var r = lane.offset; r < pat.rows; r += lane.every) {
        var o = TM.cellOffset(pat, r, lane.chan);
        if (pat.data[o + TM.C_NOTE]) continue; // never overwrite a busier lane
        pat.data[o + TM.C_NOTE] = lane.note;
        pat.data[o + TM.C_INST] = lane.inst;
      }
    });

    if (bass) {
      var bchan = chan % song.channels;
      for (var r = 0; r < pat.rows; r += 4) {
        var o = TM.cellOffset(pat, r, bchan);
        if (pat.data[o + TM.C_NOTE]) continue;
        pat.data[o + TM.C_NOTE] = bassNotes[((r / 4) | 0) % bassNotes.length];
        pat.data[o + TM.C_INST] = bass;
      }
    }
  };

  /* ---------------------------------------------------------------- *
   * Structural edits used by the song-properties dialog
   * ---------------------------------------------------------------- */

  /** True when any cell outside the first `keep` channels holds data. */
  TM.channelsInUse = function (song, keep) {
    for (var p = 0; p < song.patterns.length; p++) {
      var pat = song.patterns[p];
      for (var r = 0; r < pat.rows; r++) {
        for (var c = keep; c < pat.channels; c++) {
          var o = TM.cellOffset(pat, r, c);
          for (var b = 0; b < TM.CELL_SIZE; b++) if (pat.data[o + b]) return true;
        }
      }
    }
    return false;
  };

  /**
   * Grow or shrink the song's channel count, rewriting every pattern.
   * Cells in dropped channels are lost; new channels come up empty with
   * the format's default panning.
   */
  TM.setSongChannels = function (song, n) {
    n = TM.clamp(n | 0, 1, 64);
    if (n === song.channels) return song;
    var old = song.channels;
    song.patterns = song.patterns.map(function (pat) {
      var next = TM.makePattern(pat.rows, n);
      next.name = pat.name;
      var copy = Math.min(old, n) * TM.CELL_SIZE;
      for (var r = 0; r < pat.rows; r++) {
        next.data.set(pat.data.subarray(TM.cellOffset(pat, r, 0), TM.cellOffset(pat, r, 0) + copy), TM.cellOffset(next, r, 0));
      }
      return next;
    });
    for (var c = old; c < n; c++) {
      song.panning[c] = defaultPanning(song.type, c);
      song.chanVolume[c] = 64;
      song.chanMuted[c] = false;
    }
    song.panning.length = n;
    song.chanVolume.length = n;
    song.chanMuted.length = n;
    song.channels = n;
    return song;
  };

  /**
   * Append `count` empty patterns of the song's current geometry, and give
   * each one an order-list entry.  The order entry is not optional: this
   * program has no order-list editor, so a pattern nothing points at would
   * be unreachable and the user would have no way to fix that.
   */
  TM.addPatterns = function (song, count, rows) {
    var r = TM.clamp(rows | 0 || (song.patterns[0] ? song.patterns[0].rows : 64), 1, 256);
    for (var i = 0; i < count; i++) {
      song.orders.push(song.patterns.length);
      song.patterns.push(TM.makePattern(r, song.channels));
    }
    return song;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
