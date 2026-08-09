/* =====================================================================
 * modwriter.js -- serialise the canonical song model back to ProTracker
 *                 .mod, plus a WAV renderer for the "export audio" path.
 *
 * .mod is by far the most restrictive of the four formats, so writing it
 * from the canonical model is a *down*-conversion and some information is
 * always at risk:
 *
 *   - 31 samples max, 8-bit signed, <= 128 KB, one loop, no sustain loop
 *   - 64 rows per pattern, exactly
 *   - three octaves of notes (C-3 .. B-5 in this project's numbering)
 *   - no instrument layer: instrument N must mean sample N
 *   - a much smaller effect set than S3M/XM/IT
 *
 * Rather than silently mangling the song, the writer returns a structured
 * report of everything it had to change so the UI can show it before the
 * download starts.  That honesty is the whole point of this module.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;
  var EFX = TM.EFX;
  var VC = TM.VC;

  var MOD_NOTE_MIN = 49; // lowest note the ProTracker period table can express
  var MOD_NOTE_MAX = 84;

  /* Canonical effect -> [MOD command, transform] ---------------------- */
  function convertEffectOut(fx, param, report, where) {
    var x = param >> 4,
      y = param & 0x0f;
    switch (fx) {
      case EFX.NONE:
        return [0, 0];
      case EFX.ARPEGGIO:
        return [0x0, param];
      case EFX.PORTA_UP:
        return [0x1, Math.min(0xff, param)];
      case EFX.PORTA_DOWN:
        return [0x2, Math.min(0xff, param)];
      case EFX.TONE_PORTA:
        return [0x3, Math.min(0xff, param)];
      case EFX.VIBRATO:
      case EFX.FINE_VIBRATO:
        return [0x4, param];
      case EFX.TONEPORTA_VOLSLIDE:
        return [0x5, param];
      case EFX.VIBRATO_VOLSLIDE:
        return [0x6, param];
      case EFX.TREMOLO:
        return [0x7, param];
      case EFX.SET_PANNING:
        return [0x8, Math.min(0xff, param)];
      case EFX.SET_PANNING_16:
        return [0x8, Math.min(0xff, param * 17)];
      case EFX.SAMPLE_OFFSET:
        return [0x9, param];
      case EFX.VOLUME_SLIDE:
        return [0xa, param];
      case EFX.POSITION_JUMP:
        return [0xb, param];
      case EFX.SET_VOLUME:
        return [0xc, Math.min(64, param)];
      case EFX.PATTERN_BREAK:
        // MOD stores the break row as BCD.
        return [0xd, ((Math.floor(param / 10) % 10) << 4) | param % 10];
      case EFX.SET_SPEED:
        return [0xf, Math.min(0x1f, param)];
      case EFX.SET_TEMPO:
        return [0xf, Math.max(0x20, Math.min(0xff, param))];
      case EFX.FINE_PORTA_UP:
        return [0xe, 0x10 | Math.min(0x0f, param)];
      case EFX.FINE_PORTA_DOWN:
        return [0xe, 0x20 | Math.min(0x0f, param)];
      case EFX.SET_GLISSANDO:
        return [0xe, 0x30 | (param & 0x0f)];
      case EFX.SET_VIBRATO_WAVE:
        return [0xe, 0x40 | (param & 0x0f)];
      case EFX.SET_FINETUNE:
        return [0xe, 0x50 | (param & 0x0f)];
      case EFX.PATTERN_LOOP:
        return [0xe, 0x60 | (param & 0x0f)];
      case EFX.SET_TREMOLO_WAVE:
        return [0xe, 0x70 | (param & 0x0f)];
      case EFX.OLD_RETRIG:
      case EFX.RETRIG:
        return [0xe, 0x90 | (param & 0x0f)];
      case EFX.FINE_VOLSLIDE_UP:
        return [0xe, 0xa0 | Math.min(0x0f, param)];
      case EFX.FINE_VOLSLIDE_DOWN:
        return [0xe, 0xb0 | Math.min(0x0f, param)];
      case EFX.NOTE_CUT:
        return [0xe, 0xc0 | Math.min(0x0f, param)];
      case EFX.NOTE_DELAY:
        return [0xe, 0xd0 | Math.min(0x0f, param)];
      case EFX.PATTERN_DELAY:
        return [0xe, 0xe0 | Math.min(0x0f, param)];
      case EFX.INVERT_LOOP:
        return [0xe, 0xf0 | (param & 0x0f)];
      case EFX.EXTRA_FINE_PORTA_UP:
        return [0xe, 0x10 | Math.min(0x0f, Math.max(1, param >> 2))];
      case EFX.EXTRA_FINE_PORTA_DOWN:
        return [0xe, 0x20 | Math.min(0x0f, Math.max(1, param >> 2))];
      case EFX.GLOBAL_VOLUME:
      case EFX.GLOBAL_VOLSLIDE:
      case EFX.SET_CHANNEL_VOLUME:
      case EFX.CHANNEL_VOLSLIDE:
      case EFX.PANNING_SLIDE:
      case EFX.PANNING_SLIDE_XM:
      case EFX.TREMOR:
      case EFX.PANBRELLO:
      case EFX.SET_NNA:
      case EFX.MIDI_MACRO:
      case EFX.SET_ACTIVE_MACRO:
      case EFX.SET_ENV_POSITION:
      case EFX.KEY_OFF:
      case EFX.FINE_PATTERN_DELAY:
      case EFX.HIGH_OFFSET:
      case EFX.SOUND_CONTROL:
      case EFX.SET_PANBRELLO_WAVE:
        report.add('Dropped effect ' + (TM.EFX_NAME[fx] || fx) + ' at ' + where);
        return [0, 0];
      default:
        if (fx) report.add('Dropped effect ' + (TM.EFX_NAME[fx] || fx) + ' at ' + where);
        return [0, 0];
    }
  }

  function Report() {
    this.items = [];
    this.counts = {};
  }
  Report.prototype.add = function (msg) {
    // Collapse repeats: "dropped effect X" happens thousands of times.
    var key = msg.replace(/ at .*$/, '');
    this.counts[key] = (this.counts[key] || 0) + 1;
    if (this.counts[key] === 1) this.items.push({ msg: msg, key: key });
  };
  Report.prototype.lines = function () {
    var self = this;
    return this.items.map(function (it) {
      var n = self.counts[it.key];
      return it.msg + (n > 1 ? ' (and ' + (n - 1) + ' more)' : '');
    });
  };

  /**
   * Build a ProTracker .mod file from the song.
   * @returns {{bytes: Uint8Array, report: string[]}}
   */
  TM.exportMOD = function (song) {
    var report = new Report();
    var i, j, r, c;

    var channels = TM.clamp(song.channels, 1, 32);
    if (song.channels > 32) report.add('Only the first 32 channels were kept (song has ' + song.channels + ').');
    if (channels < 4) channels = 4;

    // ---- samples -----------------------------------------------------
    var samples = song.samples.slice(0, 31);
    if (song.samples.length > 31) report.add('Only the first 31 samples were kept (song has ' + song.samples.length + ').');

    var smpOut = [];
    for (i = 0; i < 31; i++) {
      var s = samples[i];
      var rec = { name: '', length: 0, ft: 0, vol: 64, loopStart: 0, loopLen: 1, data: null };
      if (s && s.data && s.length > 0) {
        var len = s.length;
        if (len > 131070) {
          len = 131070;
          report.add('Sample ' + (i + 1) + ' truncated to 128 KB.');
        }
        len &= ~1; // MOD lengths are in words
        var pcm = new Int8Array(len);
        for (j = 0; j < len; j++) {
          var v = Math.round(s.data[j] * 127);
          pcm[j] = v > 127 ? 127 : v < -128 ? -128 : v;
        }
        rec.data = pcm;
        rec.length = len;
        rec.name = (s.name || '').substring(0, 22);
        rec.vol = TM.clamp(Math.round(s.volume), 0, 64);
        // Recover a 4-bit finetune from c5speed.
        var base = TM.AMIGA_K_MOD / 428;
        var ftf = Math.round(96 * Math.log(s.c5speed / base) / Math.LN2);
        if (ftf < -8 || ftf > 7) report.add('Sample ' + (i + 1) + ' tuning clamped to the MOD finetune range.');
        ftf = TM.clamp(ftf, -8, 7);
        rec.ft = ftf < 0 ? ftf + 16 : ftf;
        if (s.loopType !== TM.LOOP_NONE && s.loopEnd > s.loopStart) {
          var ls = Math.min(s.loopStart, len) & ~1;
          var le = Math.min(s.loopEnd, len) & ~1;
          rec.loopStart = ls;
          rec.loopLen = Math.max(2, le - ls);
          if (s.loopType === TM.LOOP_PINGPONG) report.add('Sample ' + (i + 1) + ': ping-pong loop written as a forward loop.');
        }
        if (s.susLoopType !== TM.LOOP_NONE) report.add('Sample ' + (i + 1) + ': sustain loop dropped (not supported by MOD).');
      }
      smpOut.push(rec);
    }

    /* In XM and IT the pattern's instrument number addresses the
     * *instrument* layer, which then maps each note to a sample.  MOD has
     * no such layer: its numbers are sample numbers.  Exporting the
     * instrument number verbatim would point every note at the wrong slot
     * (or at an empty one, which is silence), so resolve it here. */
    function resolveSample(instNo, note) {
      if (instNo <= 0) return -1;
      if (!song.flags.instrumentMode) return instNo - 1;
      var inst = song.instruments[instNo - 1];
      if (!inst) return -1;
      var key = note >= TM.NOTE_MIN && note <= TM.NOTE_MAX ? note - 1 : 60;
      var si = inst.sampleMap[key] - 1;
      if (si < 0 || !song.samples[si]) {
        for (var k = 0; k < 120; k++) {
          var t = inst.sampleMap[k] - 1;
          if (t >= 0 && song.samples[t] && song.samples[t].length) { si = t; break; }
        }
      }
      return si;
    }

    // ---- orders ------------------------------------------------------
    var orders = [];
    for (i = 0; i < song.orders.length && orders.length < 128; i++) {
      var o = song.orders[i];
      if (o === TM.ORDER_SKIP || o === TM.ORDER_END) continue;
      if (o > 127) {
        report.add('Pattern ' + o + ' cannot be referenced by MOD (max 128 patterns).');
        continue;
      }
      orders.push(o);
    }
    if (!orders.length) orders.push(0);
    if (song.orders.length > 128) report.add('Order list truncated to 128 entries.');

    var maxPat = 0;
    for (i = 0; i < orders.length; i++) if (orders[i] > maxPat) maxPat = orders[i];
    var numPatterns = Math.min(128, Math.max(maxPat + 1, 1));

    // ---- size --------------------------------------------------------
    var patBytes = numPatterns * 64 * channels * 4;
    var smpBytes = 0;
    for (i = 0; i < 31; i++) smpBytes += smpOut[i].length;
    var total = 1084 + patBytes + smpBytes;
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    var p = 0;

    function writeStr(str, len) {
      for (var k = 0; k < len; k++) {
        var ch = k < str.length ? str.charCodeAt(k) : 0;
        out[p + k] = ch < 32 || ch > 126 ? (k < str.length ? 32 : 0) : ch;
      }
      p += len;
    }

    writeStr(song.title || 'untitled', 20);
    for (i = 0; i < 31; i++) {
      var rec2 = smpOut[i];
      writeStr(rec2.name, 22);
      dv.setUint16(p, rec2.length >> 1, false);
      p += 2;
      out[p++] = rec2.ft & 0x0f;
      out[p++] = rec2.vol;
      dv.setUint16(p, rec2.loopStart >> 1, false);
      p += 2;
      dv.setUint16(p, Math.max(1, rec2.loopLen >> 1), false);
      p += 2;
    }
    out[p++] = orders.length;
    out[p++] = 127; // classic "restart" byte; PT ignores it
    for (i = 0; i < 128; i++) out[p++] = i < orders.length ? orders[i] : 0;

    var magic = channels === 4 ? 'M.K.' : channels < 10 ? channels + 'CHN' : channels + 'CH';
    if (channels === 4 && numPatterns > 64) magic = 'M!K!';
    writeStr(magic, 4);

    // ---- patterns ----------------------------------------------------
    var periods = TM.MOD_PERIODS; // finetune 0 row is entries 0..35
    for (i = 0; i < numPatterns; i++) {
      var pat = song.patterns[i];
      for (r = 0; r < 64; r++) {
        for (c = 0; c < channels; c++) {
          var note = 0,
            inst = 0,
            fx = 0,
            fxp = 0;
          if (pat && r < pat.rows && c < pat.channels) {
            var off = TM.cellOffset(pat, r, c);
            var d = pat.data;
            note = d[off + TM.C_NOTE];
            inst = d[off + TM.C_INST];
            var vcmd = d[off + TM.C_VOLCMD];
            var vpar = d[off + TM.C_VOLPARAM];
            var conv = convertEffectOut(d[off + TM.C_EFX], d[off + TM.C_EFXPARAM], report, 'pattern ' + i + ' row ' + r);
            fx = conv[0];
            fxp = conv[1];
            // The volume column has no MOD equivalent: fold a plain volume
            // into Cxx when the effect slot is still free.
            if (vcmd === VC.VOLUME && fx === 0 && fxp === 0) {
              fx = 0x0c;
              fxp = TM.clamp(vpar, 0, 64);
            } else if (vcmd && !(vcmd === VC.VOLUME && fx === 0x0c)) {
              report.add('Dropped volume-column command in pattern ' + i + '.');
            }
          }

          var sampleIndex = resolveSample(inst, note);
          if (inst > 0 && sampleIndex < 0) {
            report.add('Instrument ' + inst + ' has no sample and was dropped.');
            inst = 0;
          } else if (sampleIndex >= 31) {
            report.add('Sample ' + (sampleIndex + 1) + ' is past MOD\'s 31 slots; the note was left unassigned.');
            inst = 0;
            sampleIndex = -1;
          } else if (sampleIndex >= 0) {
            inst = sampleIndex + 1;
          }

          var period = 0;
          if (note >= TM.NOTE_MIN && note <= TM.NOTE_MAX) {
            // MOD has no per-sample transpose, so fold relativeNote into
            // the written note - otherwise XM/IT samples play at the wrong
            // octave even though the pattern "looks" right.
            var srcSmp = sampleIndex >= 0 ? song.samples[sampleIndex] : null;
            var n = note + (srcSmp && srcSmp.relativeNote ? srcSmp.relativeNote : 0);
            if (n < MOD_NOTE_MIN || n > MOD_NOTE_MAX) {
              var clamped = TM.clamp(n, MOD_NOTE_MIN, MOD_NOTE_MAX);
              report.add('Note ' + TM.noteName(n) + ' is outside the MOD range; written as ' + TM.noteName(clamped) + '.');
              n = clamped;
            }
            period = periods[n - MOD_NOTE_MIN];
          } else if (note === TM.NOTE_OFF || note === TM.NOTE_CUT || note === TM.NOTE_FADE) {
            // MOD has no note-off: EC0 (note cut at tick 0) is the closest.
            if (fx === 0 && fxp === 0) {
              fx = 0x0e;
              fxp = 0xc0;
            } else report.add('Dropped a note-off (MOD has no note-off command).');
          }
          if (inst > 31) {
            report.add('Instrument ' + inst + ' is out of MOD range; clamped to 31.');
            inst = 31;
          }

          out[p] = (inst & 0xf0) | ((period >> 8) & 0x0f);
          out[p + 1] = period & 0xff;
          out[p + 2] = ((inst & 0x0f) << 4) | (fx & 0x0f);
          out[p + 3] = fxp & 0xff;
          p += 4;
        }
      }
      if (!pat) report.add('Pattern ' + i + ' does not exist and was written empty.');
      else if (pat.rows !== 64) report.add('Pattern ' + i + ' has ' + pat.rows + ' rows; MOD patterns are always 64.');
    }

    // ---- sample data -------------------------------------------------
    for (i = 0; i < 31; i++) {
      var rd = smpOut[i];
      if (!rd.data) continue;
      for (j = 0; j < rd.length; j++) out[p++] = rd.data[j] & 0xff;
    }

    if (song.type !== 'mod') {
      report.add('Converted from ' + song.type.toUpperCase() + ' to ProTracker MOD.');
    }
    if (song.flags.linearSlides) report.add('Linear frequency slides become Amiga slides; pitch effects may drift.');
    if (song.flags.instrumentMode) {
      report.add('Instrument layer flattened: envelopes, NNAs and note maps are not stored in MOD.');
    }

    return { bytes: out.subarray(0, p), report: report.lines() };
  };

  /* ------------------------------------------------------------------ *
   * WAV export -- renders the song offline through the same engine.
   * ------------------------------------------------------------------ */
  TM.renderWAV = function (song, opts) {
    opts = opts || {};
    var rate = opts.sampleRate || 44100;
    var player = new TM.TrackerPlayer(rate);
    player.setSong(song);
    player.masterVolume = opts.volume === undefined ? 0.7 : opts.volume;
    player.interpolation = opts.interpolation === undefined ? 1 : opts.interpolation;
    if (opts.muteMask) player.muteMask = opts.muteMask.slice();
    var seconds = opts.seconds || player.estimateDuration(1800) || 30;
    player.reset();
    player.loopSong = false;
    player.playing = true;

    var frames = Math.ceil(seconds * rate);
    var block = 4096;
    var bl = new Float32Array(block);
    var br = new Float32Array(block);
    var bytes = new Uint8Array(44 + frames * 4);
    var dv = new DataView(bytes.buffer);
    function wstr(o, s) {
      for (var i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
    }
    wstr(0, 'RIFF');
    dv.setUint32(4, 36 + frames * 4, true);
    wstr(8, 'WAVE');
    wstr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true);
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 16, true);
    wstr(36, 'data');
    dv.setUint32(40, frames * 4, true);

    var o = 44;
    for (var done = 0; done < frames; done += block) {
      var n = Math.min(block, frames - done);
      player.render(bl, br, n);
      for (var i = 0; i < n; i++) {
        dv.setInt16(o, TM.clamp(Math.round(bl[i] * 32767), -32768, 32767), true);
        dv.setInt16(o + 2, TM.clamp(Math.round(br[i] * 32767), -32768, 32767), true);
        o += 4;
      }
      if (opts.onProgress && done % (block * 32) === 0) opts.onProgress(done / frames);
    }
    return bytes;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
