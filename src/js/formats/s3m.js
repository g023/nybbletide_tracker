/* =====================================================================
 * s3m.js -- Scream Tracker 3 (.s3m) loader
 *
 * S3M introduced the letter-command scheme (Axx speed, Dxy volume slide,
 * Sxy specials ...) that IT later inherited and that this project uses as
 * its canonical effect vocabulary, so the transcoding here is nearly 1:1.
 *
 * Notable format traits handled below:
 *   - Everything is addressed by "parapointers": 16 byte paragraphs.
 *   - Pattern data is run-length packed with a per-cell presence mask.
 *   - Samples are unsigned 8 bit by default (the ffi field says which).
 *   - Notes are stored as octave/semitone nibbles, and pitch is derived
 *     from the sample's C2Spd rather than a finetune value.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;
  var EFX = TM.EFX;

  TM.detectS3M = function (bytes) {
    return bytes.length > 100 && TM.readString(bytes, 44, 4) === 'SCRM';
  };

  TM.parseS3M = function (bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var song = TM.makeSong();
    song.type = 's3m';
    song.typeName = 'Scream Tracker 3 (.s3m)';
    song.title = TM.readString(bytes, 0, 28);

    var ordNum = dv.getUint16(32, true);
    var insNum = dv.getUint16(34, true);
    var patNum = dv.getUint16(36, true);
    var flags = dv.getUint16(38, true);
    var cwtv = dv.getUint16(40, true);
    var ffi = dv.getUint16(42, true);

    song.tracker = 'Scream Tracker 3.' + ((cwtv & 0xff).toString(16));
    if ((cwtv >> 12) === 1) song.tracker = 'Scream Tracker 3.' + (cwtv & 0xfff).toString(16);
    else if ((cwtv >> 12) === 2) song.tracker = 'Imago Orpheus';
    else if ((cwtv >> 12) === 3) song.tracker = 'Impulse Tracker';
    else if ((cwtv >> 12) === 5) song.tracker = 'OpenMPT';

    song.globalVolume = Math.min(128, bytes[48] * 2);
    song.initialSpeed = bytes[49] || 6;
    song.initialTempo = Math.max(32, bytes[50] || 125);
    var master = bytes[51];
    song.mixVolume = Math.max(16, master & 0x7f);
    var stereo = (master & 0x80) !== 0;
    var defaultPanPresent = bytes[53] === 252;

    // ST3 applies Dxy volume slides on tick 0 as well as later ticks; the
    // "fast volume slides" flag and old ST3 versions both force it.
    song.flags.fastVolSlides = (flags & 0x40) !== 0 || cwtv === 0x1300;
    song.flags.st3Portas = true;
    song.flags.amigaLimits = (flags & 0x10) !== 0;
    song.flags.instrumentMode = false;
    song.flags.linearSlides = false;
    song.flags.gvScale = 2; // S3M Vxx is 0..64


    /* ---- channel map ------------------------------------------------ */
    var chanRemap = []; // file channel index -> song channel index
    var chanPan = [];
    var used = 0;
    for (var i = 0; i < 32; i++) {
      var cs = bytes[64 + i];
      if (cs === 255 || (cs & 0x80) !== 0) {
        chanRemap.push(-1); // disabled channel
        continue;
      }
      if (cs >= 16 && cs <= 31) {
        // Adlib/OPL channel: we cannot synthesise FM, but the channel must
        // still exist so that pattern data lines up.
        chanRemap.push(used);
        chanPan.push(128);
        used++;
        continue;
      }
      chanRemap.push(used);
      chanPan.push(stereo ? (cs < 8 ? 64 : 192) : 128);
      used++;
    }
    if (!used) {
      // Degenerate file: assume 4 usable channels.
      for (i = 0; i < 4; i++) {
        chanRemap[i] = i;
        chanPan[i] = i % 2 ? 192 : 64;
      }
      used = 4;
    }
    song.channels = used;

    /* ---- orders ------------------------------------------------------ */
    var off = 96;
    // Markers (254 = "+++" skip, 255 = "---" end) are kept in place: Bxx
    // jumps address the *original* order index, so compacting the list here
    // would silently break every position jump in the song.
    for (i = 0; i < ordNum; i++) song.orders.push(bytes[off + i]);
    while (song.orders.length && song.orders[song.orders.length - 1] === TM.ORDER_END) song.orders.pop();
    if (!song.orders.length) song.orders.push(0);
    off += ordNum;

    var insPtr = [];
    for (i = 0; i < insNum; i++) insPtr.push(dv.getUint16(off + i * 2, true) * 16);
    off += insNum * 2;
    var patPtr = [];
    for (i = 0; i < patNum; i++) patPtr.push(dv.getUint16(off + i * 2, true) * 16);
    off += patNum * 2;

    if (defaultPanPresent) {
      for (i = 0; i < 32; i++) {
        var pv = bytes[off + i];
        if (pv & 0x20 && chanRemap[i] >= 0) chanPan[chanRemap[i]] = Math.round(((pv & 0x0f) * 256) / 15);
      }
    }

    for (i = 0; i < used; i++) {
      song.panning.push(chanPan[i] === undefined ? 128 : chanPan[i]);
      song.chanVolume.push(64);
      song.chanMuted.push(false);
    }

    /* ---- instruments / samples --------------------------------------- */
    for (i = 0; i < insNum; i++) {
      var p = insPtr[i];
      var smp = TM.makeSample();
      var ins = TM.makeInstrument();
      if (p > 0 && p + 80 <= bytes.length) {
        var type = bytes[p];
        smp.filename = TM.readString(bytes, p + 1, 12);
        smp.name = TM.readString(bytes, p + 48, 28);
        ins.name = smp.name;
        if (type === 1) {
          var memseg = (bytes[p + 13] << 16) | (bytes[p + 15] << 8) | bytes[p + 14];
          var dataOff = memseg * 16;
          var len = dv.getUint32(p + 16, true);
          var loopBeg = dv.getUint32(p + 20, true);
          var loopEnd = dv.getUint32(p + 24, true);
          smp.volume = Math.min(64, bytes[p + 28]);
          var pack = bytes[p + 30];
          var sflags = bytes[p + 31];
          smp.c5speed = dv.getUint32(p + 32, true) || 8363;
          var is16 = (sflags & 4) !== 0;
          var isStereo = (sflags & 2) !== 0;
          len = Math.min(len, 0x1000000);
          if ((sflags & 1) && loopEnd > loopBeg) {
            smp.loopType = TM.LOOP_FORWARD;
            smp.loopStart = loopBeg;
            smp.loopEnd = Math.min(loopEnd, len);
          }
          if (pack === 0 && len > 0 && dataOff > 0 && dataOff < bytes.length) {
            smp.data = readPCM(bytes, dataOff, len, is16, ffi !== 1, isStereo);
            smp.length = len;
          } else {
            smp.data = new Float32Array(0);
            smp.length = 0;
            smp.loopType = TM.LOOP_NONE;
          }
        } else {
          // Adlib instrument: keep the slot (and its name) but silent.
          smp.data = new Float32Array(0);
          smp.length = 0;
        }
      }
      if (!smp.data) smp.data = new Float32Array(0);
      song.samples.push(smp);
      for (var n = 0; n < 120; n++) ins.sampleMap[n] = i + 1;
      song.instruments.push(ins);
    }

    /* ---- patterns ----------------------------------------------------- */
    for (var pi = 0; pi < patNum; pi++) {
      var pat = TM.makePattern(64, used);
      song.patterns.push(pat);
      var pp = patPtr[pi];
      if (!pp || pp + 2 > bytes.length) continue;
      var packedLen = dv.getUint16(pp, true);
      var q = pp + 2;
      var end = Math.min(bytes.length, pp + 2 + packedLen);
      var row = 0;
      while (row < 64 && q < end) {
        var b = bytes[q++];
        if (b === 0) {
          row++;
          continue;
        }
        var fileChan = b & 31;
        var ch = chanRemap[fileChan];
        var note = 0,
          inst = 0,
          volcmd = 0,
          volparam = 0,
          fx = 0,
          fxparam = 0;
        if (b & 32) {
          var nb = bytes[q++];
          inst = bytes[q++];
          if (nb === 255) note = 0;
          else if (nb === 254) note = TM.NOTE_CUT;
          else note = TM.clamp((nb >> 4) * 12 + (nb & 0x0f) + 13, 1, 120);
        }
        if (b & 64) {
          var vb = bytes[q++];
          volcmd = TM.VC.VOLUME;
          volparam = Math.min(64, vb);
        }
        if (b & 128) {
          var cb = bytes[q++];
          var pb = bytes[q++];
          var conv = TM.s3mConvertEffect(cb, pb);
          fx = conv[0];
          fxparam = conv[1];
        }
        if (ch >= 0 && ch < used && row < 64) {
          var o2 = TM.cellOffset(pat, row, ch);
          pat.data[o2 + TM.C_NOTE] = note;
          pat.data[o2 + TM.C_INST] = inst;
          pat.data[o2 + TM.C_VOLCMD] = volcmd;
          pat.data[o2 + TM.C_VOLPARAM] = volparam;
          pat.data[o2 + TM.C_EFX] = fx;
          pat.data[o2 + TM.C_EFXPARAM] = fxparam;
        }
      }
    }

    return song;
  };

  /** Decode raw PCM into normalised mono Float32. */
  function readPCM(bytes, off, len, is16, unsigned, stereo) {
    var out = new Float32Array(len);
    var i;
    if (is16) {
      var avail = Math.min(len, (bytes.length - off) >> 1);
      for (i = 0; i < avail; i++) {
        var lo = bytes[off + i * 2],
          hi = bytes[off + i * 2 + 1];
        var v = (hi << 8) | lo;
        if (unsigned) v -= 32768;
        else if (v > 32767) v -= 65536;
        out[i] = v / 32768;
      }
      if (stereo) {
        // Right channel follows the left; fold to mono by averaging.
        var roff = off + len * 2;
        for (i = 0; i < avail && roff + i * 2 + 1 < bytes.length; i++) {
          var v2 = (bytes[roff + i * 2 + 1] << 8) | bytes[roff + i * 2];
          if (unsigned) v2 -= 32768;
          else if (v2 > 32767) v2 -= 65536;
          out[i] = (out[i] + v2 / 32768) * 0.5;
        }
      }
    } else {
      var avail8 = Math.min(len, bytes.length - off);
      for (i = 0; i < avail8; i++) {
        var b = bytes[off + i];
        out[i] = (unsigned ? b - 128 : b < 128 ? b : b - 256) / 128;
      }
      if (stereo) {
        var roff8 = off + len;
        for (i = 0; i < avail8 && roff8 + i < bytes.length; i++) {
          var b2 = bytes[roff8 + i];
          out[i] = (out[i] + (unsigned ? b2 - 128 : b2 < 128 ? b2 : b2 - 256) / 128) * 0.5;
        }
      }
    }
    return out;
  }
  TM.readPCM = readPCM;

  /* S3M/IT letter command -> canonical effect.  IT reuses this table and
   * then patches the few commands where its meaning differs. */
  TM.s3mConvertEffect = function (cmd, param) {
    var x = param >> 4,
      y = param & 0x0f;
    switch (cmd) {
      case 1:
        return [EFX.SET_SPEED, param]; // A
      case 2:
        return [EFX.POSITION_JUMP, param]; // B
      case 3:
        return [EFX.PATTERN_BREAK, param]; // C
      case 4:
        return [EFX.VOLUME_SLIDE, param]; // D
      case 5:
        return [EFX.PORTA_DOWN, param]; // E
      case 6:
        return [EFX.PORTA_UP, param]; // F
      case 7:
        return [EFX.TONE_PORTA, param]; // G
      case 8:
        return [EFX.VIBRATO, param]; // H
      case 9:
        return [EFX.TREMOR, param]; // I
      case 10:
        return [EFX.ARPEGGIO, param]; // J
      case 11:
        return [EFX.VIBRATO_VOLSLIDE, param]; // K
      case 12:
        return [EFX.TONEPORTA_VOLSLIDE, param]; // L
      case 13:
        return [EFX.SET_CHANNEL_VOLUME, param]; // M
      case 14:
        return [EFX.CHANNEL_VOLSLIDE, param]; // N
      case 15:
        return [EFX.SAMPLE_OFFSET, param]; // O
      case 16:
        return [EFX.PANNING_SLIDE, param]; // P
      case 17:
        return [EFX.RETRIG, param]; // Q
      case 18:
        return [EFX.TREMOLO, param]; // R
      case 19: // S - special
        switch (x) {
          case 0x0:
            return [EFX.NONE, 0];
          case 0x1:
            return [EFX.SET_GLISSANDO, y];
          case 0x2:
            return [EFX.SET_FINETUNE, y];
          case 0x3:
            return [EFX.SET_VIBRATO_WAVE, y];
          case 0x4:
            return [EFX.SET_TREMOLO_WAVE, y];
          case 0x5:
            return [EFX.SET_PANBRELLO_WAVE, y];
          case 0x6:
            return [EFX.FINE_PATTERN_DELAY, y];
          case 0x7:
            return [EFX.SET_NNA, y];
          case 0x8:
            return [EFX.SET_PANNING_16, y];
          case 0x9:
            return [EFX.SOUND_CONTROL, y];
          case 0xa:
            return [EFX.HIGH_OFFSET, y];
          case 0xb:
            return [EFX.PATTERN_LOOP, y];
          case 0xc:
            return [EFX.NOTE_CUT, y];
          case 0xd:
            return [EFX.NOTE_DELAY, y];
          case 0xe:
            return [EFX.PATTERN_DELAY, y];
          case 0xf:
            return [EFX.SET_ACTIVE_MACRO, y];
        }
        return [EFX.NONE, 0];
      case 20:
        return [EFX.SET_TEMPO, param]; // T
      case 21:
        return [EFX.FINE_VIBRATO, param]; // U
      case 22:
        return [EFX.GLOBAL_VOLUME, param]; // V
      case 23:
        return [EFX.GLOBAL_VOLSLIDE, param]; // W
      case 24:
        return [EFX.SET_PANNING, param >= 0x80 ? 255 : param * 2]; // X (0..80h)
      case 25:
        return [EFX.PANBRELLO, param]; // Y
      case 26:
        return [EFX.MIDI_MACRO, param]; // Z
    }
    return [EFX.NONE, 0];
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
