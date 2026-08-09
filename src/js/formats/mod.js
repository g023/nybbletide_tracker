/* =====================================================================
 * mod.js -- ProTracker / NoiseTracker / Startrekker (.mod) loader
 *
 * The .mod format is the ancestor of everything else here: 31 (or 15)
 * sample slots, a fixed 64 rows per pattern, 4 bytes per cell and Amiga
 * hardware periods instead of note numbers.  There is no instrument layer
 * and no volume column, so the loader synthesises one instrument per
 * sample to keep the canonical model uniform.
 *
 * Cell layout on disk (4 bytes, big endian nibble soup):
 *   byte0: sample high nibble | period bits 8..11
 *   byte1: period bits 0..7
 *   byte2: sample low nibble  | effect command
 *   byte3: effect parameter
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;
  var EFX = TM.EFX;

  /* Magic -> channel count.  Anything unrecognised with 31 samples is
   * treated as 4 channel M.K. which is what every other player does. */
  function channelsFromMagic(magic) {
    if (/^(M\.K\.|M!K!|FLT4|M&K!|N\.T\.|LARD|PATT)$/.test(magic)) return 4;
    if (magic === 'OCTA' || magic === 'OKTA' || magic === 'CD81') return 8;
    if (magic === 'FLT8') return 8;
    var m = /^(\d)CHN$/.exec(magic);
    if (m) return parseInt(m[1], 10);
    m = /^(\d\d)C[HN]$/.exec(magic);
    if (m) return parseInt(m[1], 10);
    m = /^TDZ(\d)$/.exec(magic);
    if (m) return parseInt(m[1], 10);
    m = /^(\d\d)CH$/.exec(magic);
    if (m) return parseInt(m[1], 10);
    return 0;
  }

  function trackerFromMagic(magic, ch) {
    switch (magic) {
      case 'M.K.':
        return 'ProTracker';
      case 'M!K!':
        return 'ProTracker (>64 patterns)';
      case 'FLT4':
      case 'FLT8':
        return 'Startrekker';
      case 'CD81':
        return 'Falcon Octalyser';
      case 'OCTA':
      case 'OKTA':
        return 'Oktalyzer';
      default:
        return ch + ' channel module';
    }
  }

  TM.detectMOD = function (bytes) {
    if (bytes.length < 1084) return false;
    var magic = TM.readString(bytes, 1080, 4);
    return channelsFromMagic(magic) > 0;
  };

  /**
   * @param {Uint8Array} bytes raw file
   * @returns {object} canonical song
   */
  TM.parseMOD = function (bytes) {
    var song = TM.makeSong();
    song.type = 'mod';

    var magic = bytes.length >= 1084 ? TM.readString(bytes, 1080, 4) : '';
    var channels = channelsFromMagic(magic);
    var numSamples = 31;
    var headerSize = 1084;

    if (!channels) {
      // 15-sample Ultimate Soundtracker style module: no magic at all.
      channels = 4;
      numSamples = 15;
      headerSize = 600;
      magic = '';
    }

    song.channels = channels;
    song.typeName = 'Amiga Module (.mod)';
    song.tracker = trackerFromMagic(magic, channels);
    song.title = TM.readString(bytes, 0, 20);
    song.flags.instrumentMode = false;
    song.flags.amigaLimits = true;
    song.flags.modVolSlideQuirk = true;

    /* ---- sample headers ------------------------------------------- */
    var sampleInfo = [];
    var off = 20;
    for (var i = 0; i < numSamples; i++) {
      var name = TM.readString(bytes, off, 22);
      var len = ((bytes[off + 22] << 8) | bytes[off + 23]) * 2;
      var ft = bytes[off + 24] & 0x0f;
      var vol = Math.min(64, bytes[off + 25]);
      var rep = ((bytes[off + 26] << 8) | bytes[off + 27]) * 2;
      var replen = ((bytes[off + 28] << 8) | bytes[off + 29]) * 2;
      sampleInfo.push({ name: name, len: len, ft: ft, vol: vol, rep: rep, replen: replen });
      off += 30;
    }

    var songLength = bytes[off];
    song.restartPos = bytes[off + 1];
    if (song.restartPos >= songLength) song.restartPos = 0;
    off += 2;

    /* ---- order list ------------------------------------------------ */
    var maxPattern = 0;
    var orders = [];
    for (i = 0; i < 128; i++) {
      var p = bytes[off + i];
      if (p > maxPattern) maxPattern = p;
      if (i < songLength) orders.push(p);
    }
    if (!orders.length) orders.push(0);
    song.orders = orders;

    /* ---- pattern data ---------------------------------------------- */
    var patOff = headerSize;
    var numPatterns = maxPattern + 1;
    var patSize = 64 * channels * 4;
    // Startrekker FLT8 stores two 4-channel patterns side by side.
    var flt8 = magic === 'FLT8';

    for (var pi = 0; pi < numPatterns; pi++) {
      var pat = TM.makePattern(64, channels);
      song.patterns.push(pat);
    }

    for (pi = 0; pi < numPatterns; pi++) {
      var pat = song.patterns[pi];
      for (var row = 0; row < 64; row++) {
        for (var ch = 0; ch < channels; ch++) {
          var src = patOff + pi * patSize + (row * channels + ch) * 4;
          if (src + 3 >= bytes.length) continue;
          var b0 = bytes[src],
            b1 = bytes[src + 1],
            b2 = bytes[src + 2],
            b3 = bytes[src + 3];
          var period = ((b0 & 0x0f) << 8) | b1;
          var inst = (b0 & 0xf0) | (b2 >> 4);
          var cmd = b2 & 0x0f;
          var param = b3;

          var o = TM.cellOffset(pat, row, ch);
          if (period > 0) pat.data[o + TM.C_NOTE] = periodToNote(period);
          if (inst > 0) pat.data[o + TM.C_INST] = inst;
          var fx = convertEffect(cmd, param);
          pat.data[o + TM.C_EFX] = fx[0];
          pat.data[o + TM.C_EFXPARAM] = fx[1];
        }
      }
    }
    if (flt8) unscrambleFLT8(song);

    /* ---- sample data ------------------------------------------------ */
    var dataOff = patOff + numPatterns * patSize;
    for (i = 0; i < numSamples; i++) {
      var si = sampleInfo[i];
      var smp = TM.makeSample();
      smp.name = si.name;
      smp.volume = si.vol;
      smp.modFinetune = si.ft;
      smp.finetune = (si.ft < 8 ? si.ft : si.ft - 16) * 16; // -128..112
      // A ProTracker C-2 is period 428, i.e. 3546894.6/428 = 8287.14 Hz --
      // not the 8363 Hz the other formats use.  Encoding that in c5speed
      // lets the engine derive Amiga periods with one logarithmic formula
      // instead of carrying the 16x36 entry period table into playback.
      smp.c5speed = (TM.AMIGA_K_MOD / 428) * Math.pow(2, (si.ft < 8 ? si.ft : si.ft - 16) / 96);
      smp.length = si.len;
      if (si.replen > 2 && si.rep + si.replen <= si.len + 2) {
        smp.loopType = TM.LOOP_FORWARD;
        smp.loopStart = si.rep;
        smp.loopEnd = Math.min(si.len, si.rep + si.replen);
      }
      if (si.len > 0) {
        var avail = Math.max(0, Math.min(si.len, bytes.length - dataOff));
        var f = new Float32Array(si.len);
        for (var s = 0; s < avail; s++) {
          var v = bytes[dataOff + s];
          f[s] = (v < 128 ? v : v - 256) / 128;
        }
        smp.data = f;
        smp.length = si.len;
        dataOff += si.len;
      }
      song.samples.push(smp);

      // One instrument per sample so the engine has a uniform lookup path.
      var ins = TM.makeInstrument();
      ins.name = si.name;
      for (var n = 0; n < 120; n++) ins.sampleMap[n] = i + 1;
      song.instruments.push(ins);
    }

    /* ---- default channel setup (Amiga LRRL) ------------------------- */
    for (ch = 0; ch < channels; ch++) {
      var left = ch % 4 === 0 || ch % 4 === 3;
      song.panning.push(left ? 64 : 192);
      song.chanVolume.push(64);
      song.chanMuted.push(false);
    }

    song.initialSpeed = 6;
    song.initialTempo = 125;
    song.globalVolume = 128;
    song.mixVolume = 48;
    return song;
  };

  /* Startrekker FLT8: patterns are stored as 4-channel pairs; pattern n
   * uses halves 2n and 2n+1.  Re-stitch them into real 8 channel data. */
  function unscrambleFLT8(song) {
    var out = [];
    for (var i = 0; i + 1 < song.patterns.length; i += 2) {
      var a = song.patterns[i],
        b = song.patterns[i + 1];
      var pat = TM.makePattern(64, 8);
      for (var row = 0; row < 64; row++) {
        for (var ch = 0; ch < 4; ch++) {
          pat.data.set(a.data.subarray(TM.cellOffset(a, row, ch), TM.cellOffset(a, row, ch) + 6), TM.cellOffset(pat, row, ch));
          pat.data.set(b.data.subarray(TM.cellOffset(b, row, ch), TM.cellOffset(b, row, ch) + 6), TM.cellOffset(pat, row, ch + 4));
        }
      }
      out.push(pat);
    }
    song.patterns = out;
    song.orders = song.orders.map(function (o) {
      return o >> 1;
    });
  }

  /* Amiga period -> canonical note.  Solving for the note logarithmically
   * (rather than searching the period table) also copes with the
   * out-of-range periods some trackers wrote for extended octaves. */
  function periodToNote(period) {
    if (period <= 0) return 0;
    var freq = TM.AMIGA_K_MOD / period;
    var n = Math.round(61 + 12 * Math.log2(freq / 8363));
    return TM.clamp(n, 1, 120);
  }
  TM.modPeriodToNote = periodToNote;

  /* MOD command -> canonical (effect, parameter). */
  function convertEffect(cmd, param) {
    var x = param >> 4,
      y = param & 0x0f;
    switch (cmd) {
      case 0x0:
        return param ? [EFX.ARPEGGIO, param] : [EFX.NONE, 0];
      case 0x1:
        return [EFX.PORTA_UP, param];
      case 0x2:
        return [EFX.PORTA_DOWN, param];
      case 0x3:
        return [EFX.TONE_PORTA, param];
      case 0x4:
        return [EFX.VIBRATO, param];
      case 0x5:
        return [EFX.TONEPORTA_VOLSLIDE, param];
      case 0x6:
        return [EFX.VIBRATO_VOLSLIDE, param];
      case 0x7:
        return [EFX.TREMOLO, param];
      case 0x8:
        return [EFX.SET_PANNING, param];
      case 0x9:
        return [EFX.SAMPLE_OFFSET, param];
      case 0xa:
        return [EFX.VOLUME_SLIDE, param];
      case 0xb:
        return [EFX.POSITION_JUMP, param];
      case 0xc:
        return [EFX.SET_VOLUME, Math.min(64, param)];
      case 0xd:
        // Pattern break stores the row in BCD.
        return [EFX.PATTERN_BREAK, Math.min(63, x * 10 + y)];
      case 0xe:
        switch (x) {
          case 0x0:
            return [EFX.NONE, 0]; // set hardware filter - meaningless here
          case 0x1:
            return [EFX.FINE_PORTA_UP, y];
          case 0x2:
            return [EFX.FINE_PORTA_DOWN, y];
          case 0x3:
            return [EFX.SET_GLISSANDO, y];
          case 0x4:
            return [EFX.SET_VIBRATO_WAVE, y];
          case 0x5:
            return [EFX.SET_FINETUNE, y];
          case 0x6:
            return [EFX.PATTERN_LOOP, y];
          case 0x7:
            return [EFX.SET_TREMOLO_WAVE, y];
          case 0x8:
            return [EFX.SET_PANNING_16, y];
          case 0x9:
            return [EFX.OLD_RETRIG, y];
          case 0xa:
            return [EFX.FINE_VOLSLIDE_UP, y];
          case 0xb:
            return [EFX.FINE_VOLSLIDE_DOWN, y];
          case 0xc:
            return [EFX.NOTE_CUT, y];
          case 0xd:
            return [EFX.NOTE_DELAY, y];
          case 0xe:
            return [EFX.PATTERN_DELAY, y];
          case 0xf:
            return [EFX.INVERT_LOOP, y];
        }
        return [EFX.NONE, 0];
      case 0xf:
        if (param === 0) return [EFX.NONE, 0];
        return param < 0x20 ? [EFX.SET_SPEED, param] : [EFX.SET_TEMPO, param];
    }
    return [EFX.NONE, 0];
  }
  TM.modConvertEffect = convertEffect;
})(typeof globalThis !== 'undefined' ? globalThis : this);
