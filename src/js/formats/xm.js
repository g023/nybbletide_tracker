/* =====================================================================
 * xm.js -- FastTracker II Extended Module (.xm) loader
 *
 * XM is the first of the four formats with a real instrument layer:
 * an instrument owns up to 16 samples, a note->sample map, and volume /
 * panning envelopes.  It also introduces linear frequency slides, which
 * changes the meaning of every pitch effect - hence song.flags.linearSlides.
 *
 * Structure: a header, then <patterns> each with its own little header and
 * a bit-packed body, then <instruments> each followed by its sample
 * headers and then all of that instrument's delta-encoded sample data.
 * Every header carries its own size field, and files in the wild lie about
 * everything else, so the loader always navigates by those size fields and
 * bounds-checks each read.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;
  var EFX = TM.EFX;
  var VC = TM.VC;

  TM.detectXM = function (bytes) {
    return bytes.length > 80 && TM.readString(bytes, 0, 17) === 'Extended Module:';
  };

  TM.parseXM = function (bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var song = TM.makeSong();
    song.type = 'xm';
    song.typeName = 'FastTracker II (.xm)';
    song.title = TM.readString(bytes, 17, 20);
    song.tracker = TM.readString(bytes, 38, 20) || 'FastTracker II';

    var version = dv.getUint16(58, true);
    var headerSize = dv.getUint32(60, true);
    var songLength = dv.getUint16(64, true);
    song.restartPos = dv.getUint16(66, true);
    var channels = TM.clamp(dv.getUint16(68, true), 1, 64);
    var numPatterns = dv.getUint16(70, true);
    var numInstruments = dv.getUint16(72, true);
    var flags = dv.getUint16(74, true);
    song.initialSpeed = dv.getUint16(76, true) || 6;
    song.initialTempo = TM.clamp(dv.getUint16(78, true) || 125, 32, 512);

    song.channels = channels;
    song.flags.linearSlides = (flags & 1) !== 0;
    song.flags.instrumentMode = true;
    song.flags.xmMode = true;
    song.flags.xmGlobalVol = true;
    song.flags.gvScale = 2; // XM Gxx is 0..64

    song.globalVolume = 128;
    song.mixVolume = 48;

    for (var i = 0; i < songLength && i < 256; i++) song.orders.push(bytes[80 + i]);
    if (!song.orders.length) song.orders.push(0);
    if (song.restartPos >= song.orders.length) song.restartPos = 0;

    for (i = 0; i < channels; i++) {
      song.panning.push(128); // FT2 centres everything by default
      song.chanVolume.push(64);
      song.chanMuted.push(false);
    }

    /* ---- patterns ----------------------------------------------------- */
    var off = 60 + headerSize;
    for (var pi = 0; pi < numPatterns; pi++) {
      if (off + 9 > bytes.length) {
        song.patterns.push(TM.makePattern(64, channels));
        continue;
      }
      var phLen = dv.getUint32(off, true);
      var rows = dv.getUint16(off + 5, true);
      var packed = dv.getUint16(off + 7, true);
      if (rows < 1 || rows > 256) rows = 64;
      var pat = TM.makePattern(rows, channels);
      song.patterns.push(pat);
      var q = off + (phLen > 0 ? phLen : 9);
      var end = Math.min(bytes.length, q + packed);
      if (packed > 0) {
        for (var row = 0; row < rows; row++) {
          for (var ch = 0; ch < channels; ch++) {
            if (q >= end) break;
            var note = 0,
              inst = 0,
              vol = 0,
              fx = 0,
              fxp = 0;
            var b = bytes[q++];
            if (b & 0x80) {
              if (b & 1) note = bytes[q++];
              if (b & 2) inst = bytes[q++];
              if (b & 4) vol = bytes[q++];
              if (b & 8) fx = bytes[q++];
              if (b & 16) fxp = bytes[q++];
            } else {
              note = b;
              inst = bytes[q++];
              vol = bytes[q++];
              fx = bytes[q++];
              fxp = bytes[q++];
            }
            var o = TM.cellOffset(pat, row, ch);
            // XM note 1..96 is C-0..B-7 with C-4 == 8363 Hz; shift by an
            // octave so that note 61 == C-5 == 8363 Hz as everywhere else.
            if (note === 97) pat.data[o + TM.C_NOTE] = TM.NOTE_OFF;
            else if (note > 0 && note < 97) pat.data[o + TM.C_NOTE] = note + 12;
            pat.data[o + TM.C_INST] = inst;
            var vc = convertVolumeColumn(vol);
            pat.data[o + TM.C_VOLCMD] = vc[0];
            pat.data[o + TM.C_VOLPARAM] = vc[1];
            var e = convertEffect(fx, fxp);
            pat.data[o + TM.C_EFX] = e[0];
            pat.data[o + TM.C_EFXPARAM] = e[1];
          }
        }
      }
      off = end;
    }
    // Some XMs reference patterns that were never stored.
    var maxOrd = 0;
    for (i = 0; i < song.orders.length; i++) maxOrd = Math.max(maxOrd, song.orders[i]);
    while (song.patterns.length <= maxOrd) song.patterns.push(TM.makePattern(64, channels));

    /* ---- instruments --------------------------------------------------- */
    for (var ii = 0; ii < numInstruments; ii++) {
      if (off + 4 > bytes.length) break;
      var insHeaderSize = dv.getUint32(off, true);
      if (insHeaderSize < 29 || insHeaderSize > 1024) insHeaderSize = 263;
      var ins = TM.makeInstrument();
      ins.name = TM.readString(bytes, off + 4, 22);
      var numSamples = off + 28 <= bytes.length ? dv.getUint16(off + 27, true) : 0;
      var firstSample = song.samples.length;

      if (numSamples > 0 && numSamples <= 32) {
        var sampleHeaderSize = dv.getUint32(off + 29, true) || 40;
        var p = off + 33;
        // note -> sample-within-instrument map (96 entries)
        var noteToSample = [];
        for (i = 0; i < 96; i++) noteToSample.push(bytes[p + i] || 0);
        p += 96;
        var volPts = [],
          panPts = [];
        for (i = 0; i < 12; i++) volPts.push({ x: dv.getUint16(p + i * 4, true), y: dv.getUint16(p + i * 4 + 2, true) });
        p += 48;
        for (i = 0; i < 12; i++) panPts.push({ x: dv.getUint16(p + i * 4, true), y: dv.getUint16(p + i * 4 + 2, true) });
        p += 48;
        var numVol = bytes[p++],
          numPan = bytes[p++];
        var volSus = bytes[p++],
          volLoopS = bytes[p++],
          volLoopE = bytes[p++];
        var panSus = bytes[p++],
          panLoopS = bytes[p++],
          panLoopE = bytes[p++];
        var volType = bytes[p++],
          panType = bytes[p++];
        var vibType = bytes[p++],
          vibSweep = bytes[p++],
          vibDepth = bytes[p++],
          vibRate = bytes[p++];
        var fadeout = dv.getUint16(p, true);
        p += 2;

        // Normalise to "per-tick decrement of a 65536 scale counter", the
        // same units the IT loader uses, so the engine has one fade path.
        ins.fadeout = fadeout * 2;
        setupEnvelope(ins.volEnv, volPts, numVol, volType, volSus, volLoopS, volLoopE);
        setupEnvelope(ins.panEnv, panPts, numPan, panType, panSus, panLoopS, panLoopE);

        for (i = 0; i < 96; i++) {
          // XM note i (0-based, C-0) maps to our note i+12 (0-based)
          var tgt = i + 12;
          if (tgt < 120) ins.sampleMap[tgt] = firstSample + Math.min(noteToSample[i], numSamples - 1) + 1;
        }
        // Notes below the XM range reuse the lowest mapped sample.
        for (i = 0; i < 12; i++) ins.sampleMap[i] = ins.sampleMap[12];

        // --- sample headers ---
        var sp = off + insHeaderSize;
        var headers = [];
        for (i = 0; i < numSamples; i++) {
          var hp = sp + i * sampleHeaderSize;
          if (hp + 40 > bytes.length) {
            headers.push(null);
            continue;
          }
          headers.push({
            length: dv.getUint32(hp, true),
            loopStart: dv.getUint32(hp + 4, true),
            loopLen: dv.getUint32(hp + 8, true),
            volume: Math.min(64, bytes[hp + 12]),
            finetune: bytes[hp + 13] > 127 ? bytes[hp + 13] - 256 : bytes[hp + 13],
            type: bytes[hp + 14],
            panning: bytes[hp + 15],
            relNote: bytes[hp + 16] > 127 ? bytes[hp + 16] - 256 : bytes[hp + 16],
            name: TM.readString(bytes, hp + 18, 22)
          });
        }
        var dp = sp + numSamples * sampleHeaderSize;
        for (i = 0; i < numSamples; i++) {
          var h = headers[i];
          var smp = TM.makeSample();
          if (h) {
            var is16 = (h.type & 16) !== 0;
            var frames = is16 ? h.length >> 1 : h.length;
            smp.name = h.name;
            smp.volume = h.volume;
            smp.panning = Math.round((h.panning * 256) / 255);
            smp.relativeNote = h.relNote;
            smp.finetune = h.finetune;
            smp.c5speed = Math.round(8363 * Math.pow(2, h.finetune / (128 * 12)));
            smp.length = frames;
            var loopType = h.type & 3;
            var lsFrames = is16 ? h.loopStart >> 1 : h.loopStart;
            var llFrames = is16 ? h.loopLen >> 1 : h.loopLen;
            if (loopType && llFrames > 0) {
              smp.loopType = loopType === 2 ? TM.LOOP_PINGPONG : TM.LOOP_FORWARD;
              smp.loopStart = Math.min(lsFrames, frames);
              smp.loopEnd = Math.min(lsFrames + llFrames, frames);
              if (smp.loopEnd <= smp.loopStart) smp.loopType = TM.LOOP_NONE;
            }
            smp.vibType = [0, 2, 1, 3][vibType & 3]; // FT2 order: sine, square, ramp down, ramp up
            smp.vibSweep = vibSweep;
            smp.vibDepth = vibDepth;
            smp.vibRate = vibRate;
            smp.data = decodeDeltaPCM(bytes, dp, frames, is16);
            dp += h.length;
          } else {
            smp.data = new Float32Array(0);
          }
          song.samples.push(smp);
        }
        off = dp;
      } else {
        off += insHeaderSize;
        for (i = 0; i < 120; i++) ins.sampleMap[i] = 0;
      }
      song.instruments.push(ins);
    }

    return song;
  };

  function setupEnvelope(env, points, count, type, sus, loopS, loopE) {
    count = TM.clamp(count, 0, 12);
    env.enabled = (type & 1) !== 0 && count > 0;
    env.sustain = (type & 2) !== 0;
    env.loop = (type & 4) !== 0;
    env.points = [];
    var lastX = -1;
    for (var i = 0; i < count; i++) {
      var x = points[i].x,
        y = TM.clamp(points[i].y, 0, 64);
      if (x <= lastX) x = lastX + 1; // FT2 tolerates unsorted points; we do not
      lastX = x;
      env.points.push({ x: x, y: y });
    }
    env.sustainStart = env.sustainEnd = TM.clamp(sus, 0, Math.max(0, count - 1));
    env.loopStart = TM.clamp(loopS, 0, Math.max(0, count - 1));
    env.loopEnd = TM.clamp(loopE, 0, Math.max(0, count - 1));
    if (env.loopEnd < env.loopStart) env.loopEnd = env.loopStart;
  }

  /** XM sample data is stored as deltas; integrate then normalise. */
  function decodeDeltaPCM(bytes, off, frames, is16) {
    var out = new Float32Array(Math.max(0, frames));
    var old = 0,
      i;
    if (is16) {
      var avail = Math.min(frames, (bytes.length - off) >> 1);
      for (i = 0; i < avail; i++) {
        var d = bytes[off + i * 2] | (bytes[off + i * 2 + 1] << 8);
        if (d > 32767) d -= 65536;
        old = (old + d) & 0xffff;
        var v = old > 32767 ? old - 65536 : old;
        out[i] = v / 32768;
      }
    } else {
      var avail8 = Math.min(frames, bytes.length - off);
      for (i = 0; i < avail8; i++) {
        var d8 = bytes[off + i];
        if (d8 > 127) d8 -= 256;
        old = (old + d8) & 0xff;
        var v8 = old > 127 ? old - 256 : old;
        out[i] = v8 / 128;
      }
    }
    return out;
  }

  /* XM's packed volume column -> canonical (command, parameter). */
  function convertVolumeColumn(v) {
    if (v === 0) return [VC.NONE, 0];
    if (v >= 0x10 && v <= 0x50) return [VC.VOLUME, v - 0x10];
    var x = v & 0x0f;
    switch (v >> 4) {
      case 0x6:
        return [VC.VOLSLIDE_DOWN, x];
      case 0x7:
        return [VC.VOLSLIDE_UP, x];
      case 0x8:
        return [VC.FINE_VOLSLIDE_DOWN, x];
      case 0x9:
        return [VC.FINE_VOLSLIDE_UP, x];
      case 0xa:
        return [VC.VIBRATO_SPEED, x];
      case 0xb:
        return [VC.VIBRATO_DEPTH, x];
      case 0xc:
        return [VC.PAN, Math.round((x * 64) / 15)];
      case 0xd:
        return [VC.PAN_SLIDE_LEFT, x];
      case 0xe:
        return [VC.PAN_SLIDE_RIGHT, x];
      case 0xf:
        return [VC.TONE_PORTA, x];
    }
    return [VC.NONE, 0];
  }
  TM.xmConvertVolumeColumn = convertVolumeColumn;

  /* XM effect -> canonical.  XM keeps MOD's numbering and bolts G..X on. */
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
        return [EFX.PATTERN_BREAK, Math.min(255, x * 10 + y)];
      case 0xe:
        switch (x) {
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
        }
        return [EFX.NONE, 0];
      case 0xf:
        if (param === 0) return [EFX.NONE, 0];
        return param < 0x20 ? [EFX.SET_SPEED, param] : [EFX.SET_TEMPO, param];
      case 0x10:
        return [EFX.GLOBAL_VOLUME, Math.min(64, param)]; // G
      case 0x11:
        return [EFX.GLOBAL_VOLSLIDE, param]; // H
      case 0x14:
        return [EFX.KEY_OFF, param]; // K
      case 0x15:
        return [EFX.SET_ENV_POSITION, param]; // L
      case 0x19:
        return [EFX.PANNING_SLIDE_XM, param]; // P
      case 0x1b:
        return [EFX.RETRIG, param]; // R multi retrigger
      case 0x1d:
        return [EFX.TREMOR, param]; // T
      case 0x21: // X
        if (x === 1) return [EFX.EXTRA_FINE_PORTA_UP, y];
        if (x === 2) return [EFX.EXTRA_FINE_PORTA_DOWN, y];
        return [EFX.NONE, 0];
    }
    return [EFX.NONE, 0];
  }
  TM.xmConvertEffect = convertEffect;
})(typeof globalThis !== 'undefined' ? globalThis : this);
