/* =====================================================================
 * it.js -- Impulse Tracker (.it) loader
 *
 * IT is the richest of the four formats and the reason the canonical model
 * looks the way it does:
 *   - instruments with volume / panning / pitch envelopes, sustain loops,
 *     fadeout, and New Note Actions (a note can leave the previous voice
 *     playing in the background, which is why the engine uses a voice pool
 *     rather than a fixed array of channels);
 *   - per-sample sustain loops and ping-pong loops;
 *   - IT214/IT215 compressed sample data (implemented below - a large
 *     fraction of real .it files in the wild are compressed, so skipping
 *     this would mean silence for them);
 *   - a run-length pattern packing with per-channel "same as last time"
 *     masks.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;
  var EFX = TM.EFX;
  var VC = TM.VC;

  TM.detectIT = function (bytes) {
    return bytes.length > 192 && TM.readString(bytes, 0, 4) === 'IMPM';
  };

  TM.parseIT = function (bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var song = TM.makeSong();
    song.type = 'it';
    song.typeName = 'Impulse Tracker (.it)';
    song.title = TM.readString(bytes, 4, 26);

    var ordNum = dv.getUint16(32, true);
    var insNum = dv.getUint16(34, true);
    var smpNum = dv.getUint16(36, true);
    var patNum = dv.getUint16(38, true);
    var cwtv = dv.getUint16(40, true);
    var cmwt = dv.getUint16(42, true);
    var flags = dv.getUint16(44, true);
    var special = dv.getUint16(46, true);

    song.tracker = 'Impulse Tracker ' + ((cwtv >> 8) & 0x0f) + '.' + TM.hex2(cwtv & 0xff).toLowerCase();
    if (cwtv >> 12 === 6) song.tracker = 'BeRoTracker';
    else if (cwtv >> 12 === 1 && (cwtv & 0xfff) >= 0x214 && TM.readString(bytes, 0x3c, 4) === '') song.tracker = 'Impulse Tracker 2.14+';
    else if (cwtv >> 12 === 5) song.tracker = 'OpenMPT';
    else if (cwtv >> 12 === 4) song.tracker = 'Schism Tracker';

    song.globalVolume = TM.clamp(bytes[48], 0, 128);
    song.mixVolume = TM.clamp(bytes[49], 0, 128) || 48;
    song.initialSpeed = bytes[50] || 6;
    song.initialTempo = TM.clamp(bytes[51] || 125, 32, 512);
    var panSeparation = bytes[52];

    song.flags.instrumentMode = (flags & 4) !== 0;
    song.flags.linearSlides = (flags & 8) !== 0;
    song.flags.itOldEffects = (flags & 16) !== 0;
    song.flags.itCompatGxx = (flags & 32) !== 0;
    song.flags.itMode = true;

    /* ---- channels ---------------------------------------------------- *
     * IT always stores 64 channel slots.  Trim to the highest channel that
     * any pattern actually uses (computed after patterns are read) so the
     * UI does not show 60 empty columns. */
    var chanPan = [],
      chanVol = [],
      chanMute = [];
    for (var i = 0; i < 64; i++) {
      var p = bytes[64 + i];
      var muted = (p & 128) !== 0;
      p = p & 127;
      var pan;
      if (p === 100) pan = 128; // surround: centred (the engine flags it separately)
      else pan = TM.clamp(p, 0, 64) * 4;
      chanPan.push(pan);
      chanVol.push(TM.clamp(bytes[128 + i], 0, 64));
      chanMute.push(muted);
    }

    var off = 192;
    for (i = 0; i < ordNum; i++) song.orders.push(bytes[off + i]);
    while (song.orders.length && song.orders[song.orders.length - 1] === TM.ORDER_END) song.orders.pop();
    if (!song.orders.length) song.orders.push(0);
    off += ordNum;

    var insOff = [],
      smpOff = [],
      patOff = [];
    for (i = 0; i < insNum; i++) insOff.push(dv.getUint32(off + i * 4, true));
    off += insNum * 4;
    for (i = 0; i < smpNum; i++) smpOff.push(dv.getUint32(off + i * 4, true));
    off += smpNum * 4;
    for (i = 0; i < patNum; i++) patOff.push(dv.getUint32(off + i * 4, true));
    off += patNum * 4;

    /* ---- song message ------------------------------------------------ */
    if (special & 1) {
      var msgLen = dv.getUint16(54, true);
      var msgOff = dv.getUint32(56, true);
      if (msgOff && msgOff + msgLen <= bytes.length) {
        var msg = '';
        for (i = 0; i < msgLen; i++) {
          var c = bytes[msgOff + i];
          msg += c === 13 ? '\n' : c === 0 ? '' : String.fromCharCode(c);
        }
        song.message = msg;
      }
    }

    /* ---- samples ------------------------------------------------------ */
    for (i = 0; i < smpNum; i++) {
      song.samples.push(readSample(bytes, dv, smpOff[i]));
    }

    /* ---- instruments -------------------------------------------------- */
    if (song.flags.instrumentMode) {
      for (i = 0; i < insNum; i++) {
        song.instruments.push(readInstrument(bytes, dv, insOff[i], cmwt));
      }
    } else {
      // Sample mode: one implicit instrument per sample.
      for (i = 0; i < smpNum; i++) {
        var ins = TM.makeInstrument();
        ins.name = song.samples[i] ? song.samples[i].name : '';
        for (var n = 0; n < 120; n++) ins.sampleMap[n] = i + 1;
        song.instruments.push(ins);
      }
    }

    /* ---- patterns ------------------------------------------------------ */
    var maxChannel = 0;
    var rawPatterns = [];
    for (var pi = 0; pi < patNum; pi++) {
      var po = patOff[pi];
      if (!po || po + 8 > bytes.length) {
        rawPatterns.push(null);
        continue;
      }
      var packLen = dv.getUint16(po, true);
      var rows = TM.clamp(dv.getUint16(po + 2, true), 1, 256);
      var res = unpackPattern(bytes, po + 8, Math.min(packLen, bytes.length - po - 8), rows);
      if (res.maxChannel > maxChannel) maxChannel = res.maxChannel;
      rawPatterns.push(res);
    }
    var channels = TM.clamp(maxChannel + 1, 1, 64);
    song.channels = channels;

    for (pi = 0; pi < patNum; pi++) {
      var r = rawPatterns[pi];
      if (!r) {
        song.patterns.push(TM.makePattern(64, channels));
        continue;
      }
      var pat = TM.makePattern(r.rows, channels);
      for (var row = 0; row < r.rows; row++) {
        for (var ch = 0; ch < channels; ch++) {
          var s = (row * 64 + ch) * TM.CELL_SIZE;
          pat.data.set(r.data.subarray(s, s + TM.CELL_SIZE), TM.cellOffset(pat, row, ch));
        }
      }
      song.patterns.push(pat);
    }

    for (i = 0; i < channels; i++) {
      song.panning.push(chanPan[i]);
      song.chanVolume.push(chanVol[i]);
      song.chanMuted.push(chanMute[i]);
    }

    return song;
  };

  /* ------------------------------------------------------------------ */
  function readSample(bytes, dv, off) {
    var smp = TM.makeSample();
    if (!off || off + 80 > bytes.length || TM.readString(bytes, off, 4) !== 'IMPS') {
      smp.data = new Float32Array(0);
      return smp;
    }
    smp.filename = TM.readString(bytes, off + 4, 12);
    smp.globalVolume = TM.clamp(bytes[off + 17], 0, 64);
    var flg = bytes[off + 18];
    smp.volume = TM.clamp(bytes[off + 19], 0, 64);
    smp.name = TM.readString(bytes, off + 20, 26);
    var cvt = bytes[off + 46];
    var dfp = bytes[off + 47];
    if (dfp & 128) smp.panning = TM.clamp(dfp & 127, 0, 64) * 4;
    var length = dv.getUint32(off + 48, true);
    var loopBegin = dv.getUint32(off + 52, true);
    var loopEnd = dv.getUint32(off + 56, true);
    smp.c5speed = dv.getUint32(off + 60, true) || 8363;
    var susBegin = dv.getUint32(off + 64, true);
    var susEnd = dv.getUint32(off + 68, true);
    var dataPtr = dv.getUint32(off + 72, true);
    smp.vibRate = bytes[off + 76];
    smp.vibDepth = bytes[off + 77];
    smp.vibSweep = bytes[off + 78];
    smp.vibType = [0, 1, 2, 3][bytes[off + 79] & 3];

    if (!(flg & 1) || !length || !dataPtr || dataPtr >= bytes.length) {
      smp.data = new Float32Array(0);
      return smp;
    }
    length = Math.min(length, 0x4000000);
    var is16 = (flg & 2) !== 0;
    var stereo = (flg & 4) !== 0;
    var compressed = (flg & 8) !== 0;

    if (flg & 16 && loopEnd > loopBegin) {
      smp.loopType = flg & 64 ? TM.LOOP_PINGPONG : TM.LOOP_FORWARD;
      smp.loopStart = Math.min(loopBegin, length);
      smp.loopEnd = Math.min(loopEnd, length);
    }
    if (flg & 32 && susEnd > susBegin) {
      smp.susLoopType = flg & 128 ? TM.LOOP_PINGPONG : TM.LOOP_FORWARD;
      smp.susLoopStart = Math.min(susBegin, length);
      smp.susLoopEnd = Math.min(susEnd, length);
    }

    if (compressed) {
      var it215 = (cvt & 4) !== 0;
      var dec = decompress(bytes, dataPtr, length, is16, it215, stereo);
      smp.data = dec;
    } else {
      // cvt bit0: 1 = signed, 0 = unsigned.  bit2 = delta encoded.
      var signed = (cvt & 1) !== 0;
      if (cvt & 4) {
        smp.data = deltaPCM(bytes, dataPtr, length, is16, stereo);
      } else {
        smp.data = TM.readPCM(bytes, dataPtr, length, is16, !signed, stereo);
      }
    }
    smp.length = length;
    if (smp.loopEnd > smp.length) smp.loopEnd = smp.length;
    if (smp.susLoopEnd > smp.length) smp.susLoopEnd = smp.length;
    if (smp.loopEnd <= smp.loopStart) smp.loopType = TM.LOOP_NONE;
    if (smp.susLoopEnd <= smp.susLoopStart) smp.susLoopType = TM.LOOP_NONE;
    return smp;
  }

  function deltaPCM(bytes, off, len, is16, stereo) {
    var out = new Float32Array(len),
      old = 0,
      i;
    if (is16) {
      var avail = Math.min(len, (bytes.length - off) >> 1);
      for (i = 0; i < avail; i++) {
        var d = bytes[off + i * 2] | (bytes[off + i * 2 + 1] << 8);
        if (d > 32767) d -= 65536;
        old = (old + d) | 0;
        out[i] = TM.clamp(old, -32768, 32767) / 32768;
      }
    } else {
      var a8 = Math.min(len, bytes.length - off);
      for (i = 0; i < a8; i++) {
        var d8 = bytes[off + i];
        if (d8 > 127) d8 -= 256;
        old = (old + d8) | 0;
        out[i] = TM.clamp(old, -128, 127) / 128;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * IT214 / IT215 sample decompression.
   *
   * Samples are stored in blocks of 0x8000 (8 bit) or 0x4000 (16 bit)
   * samples.  Each block is a bit stream with a variable code width that
   * the stream itself adjusts via escape codes; the decoded values are
   * first-order (IT214) or second-order (IT215) deltas.
   * ------------------------------------------------------------------ */
  function BitReader(bytes, off, end) {
    this.b = bytes;
    this.p = off;
    this.end = end;
    this.buf = 0;
    this.bits = 0;
  }
  // Codes are up to 17 bits wide, so the accumulator can hold 24+ bits.
  // Plain arithmetic (not |= / >>=) keeps that correct past bit 31.
  BitReader.prototype.read = function (n) {
    while (this.bits < n) {
      var byteVal = this.p < this.end ? this.b[this.p++] : 0;
      this.buf += byteVal * Math.pow(2, this.bits);
      this.bits += 8;
    }
    var d = Math.pow(2, n);
    var v = this.buf % d;
    this.buf = Math.floor(this.buf / d);
    this.bits -= n;
    return v;
  };

  function decompress(bytes, off, length, is16, it215, stereo) {
    var out = new Float32Array(length);
    var pos = 0;
    var remaining = length;
    var p = off;
    var maxBlock = is16 ? 0x4000 : 0x8000;
    var startWidth = is16 ? 17 : 9;
    var guard = 0;

    while (remaining > 0 && p + 2 <= bytes.length && guard++ < 100000) {
      var blockLen = Math.min(maxBlock, remaining);
      var compressedSize = bytes[p] | (bytes[p + 1] << 8);
      p += 2;
      var br = new BitReader(bytes, p, Math.min(bytes.length, p + compressedSize));
      p += compressedSize;

      var width = startWidth;
      var d1 = 0,
        d2 = 0;
      var written = 0;
      var innerGuard = 0;
      while (written < blockLen && innerGuard++ < maxBlock * 8) {
        if (width > startWidth) {
          width = startWidth; // corrupt stream; resynchronise rather than hang
        }
        var value = br.read(width);
        var handled = false;
        if (width < 7) {
          if (value === 1 << (width - 1)) {
            value = br.read(is16 ? 4 : 3) + 1;
            width = value < width ? value : value + 1;
            handled = true;
          }
        } else if (width < startWidth) {
          var border = ((is16 ? 0xffff : 0xff) >> (startWidth - width)) - (is16 ? 8 : 4);
          if (value > border && value <= border + (is16 ? 16 : 8)) {
            value -= border;
            width = value < width ? value : value + 1;
            handled = true;
          }
        } else {
          var topBit = is16 ? 0x10000 : 0x100;
          if (value & topBit) {
            width = ((value + 1) & 0xff) || startWidth;
            handled = true;
          }
        }
        if (handled) continue;

        // Sign extend the `width` bit code (capped at the sample width).
        var n = Math.min(width, is16 ? 16 : 8);
        var sh = 32 - n;
        var v = (value << sh) >> sh;
        d1 = (d1 + v) | 0;
        d2 = (d2 + d1) | 0;
        var sample = it215 ? d2 : d1;
        if (is16) {
          sample = ((sample + 32768) & 0xffff) - 32768;
          out[pos] = sample / 32768;
        } else {
          sample = ((sample + 128) & 0xff) - 128;
          out[pos] = sample / 128;
        }
        pos++;
        written++;
      }
      remaining -= blockLen;
      if (pos >= length) break;
    }
    if (stereo) {
      // The right channel is a second compressed stream; we already folded
      // to mono by only decoding the left, which is the usual compromise.
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  function readEnvelope(bytes, dv, off, kind) {
    var env = TM.makeEnvelope();
    var flg = bytes[off];
    env.enabled = (flg & 1) !== 0;
    env.loop = (flg & 2) !== 0;
    env.sustain = (flg & 4) !== 0;
    env.carry = (flg & 8) !== 0;
    env.filter = (flg & 128) !== 0;
    var num = TM.clamp(bytes[off + 1], 0, 25);
    env.loopStart = bytes[off + 2];
    env.loopEnd = bytes[off + 3];
    env.sustainStart = bytes[off + 4];
    env.sustainEnd = bytes[off + 5];
    var lastX = -1;
    for (var i = 0; i < num; i++) {
      var y = bytes[off + 6 + i * 3];
      if (kind !== 'vol') y = (y > 127 ? y - 256 : y) + 32; // -32..32 -> 0..64
      var x = dv.getUint16(off + 7 + i * 3, true);
      if (x <= lastX) x = lastX + 1;
      lastX = x;
      env.points.push({ x: x, y: TM.clamp(y, 0, 64) });
    }
    if (!env.points.length) env.enabled = false;
    var maxIdx = Math.max(0, env.points.length - 1);
    env.loopStart = TM.clamp(env.loopStart, 0, maxIdx);
    env.loopEnd = TM.clamp(env.loopEnd, env.loopStart, maxIdx);
    env.sustainStart = TM.clamp(env.sustainStart, 0, maxIdx);
    env.sustainEnd = TM.clamp(env.sustainEnd, env.sustainStart, maxIdx);
    return env;
  }

  function readInstrument(bytes, dv, off, cmwt) {
    var ins = TM.makeInstrument();
    if (!off || off + 130 > bytes.length || TM.readString(bytes, off, 4) !== 'IMPI') return ins;

    if (cmwt < 0x200) {
      /* Old (IT 1.x) instrument layout: a single 200 byte volume envelope
       * with (tick, value) pairs terminated by 0xFF. */
      ins.filename = TM.readString(bytes, off + 4, 12);
      var flg = bytes[off + 17];
      ins.fadeout = dv.getUint16(off + 24, true) * 64;
      ins.nna = TM.clamp(bytes[off + 26], 0, 3);
      ins.dct = bytes[off + 27] ? TM.DCT_NOTE : TM.DCT_NONE;
      ins.dca = TM.DCA_CUT;
      ins.name = TM.readString(bytes, off + 32, 26);
      readKeyboardTable(bytes, off + 64, ins);
      var env = ins.volEnv;
      env.enabled = (flg & 1) !== 0;
      env.loop = (flg & 2) !== 0;
      env.sustain = (flg & 4) !== 0;
      env.loopStart = bytes[off + 18];
      env.loopEnd = bytes[off + 19];
      env.sustainStart = bytes[off + 20];
      env.sustainEnd = bytes[off + 21];
      var q = off + 304,
        lastX = -1;
      for (var i = 0; i < 25; i++) {
        var x = bytes[q + i * 2],
          y = bytes[q + i * 2 + 1];
        if (x === 0xff) break;
        if (x <= lastX) x = lastX + 1;
        lastX = x;
        env.points.push({ x: x, y: TM.clamp(y, 0, 64) });
      }
      if (!env.points.length) env.enabled = false;
      var mx = Math.max(0, env.points.length - 1);
      env.loopStart = TM.clamp(env.loopStart, 0, mx);
      env.loopEnd = TM.clamp(env.loopEnd, env.loopStart, mx);
      env.sustainStart = TM.clamp(env.sustainStart, 0, mx);
      env.sustainEnd = TM.clamp(env.sustainEnd, env.sustainStart, mx);
      return ins;
    }

    ins.filename = TM.readString(bytes, off + 4, 12);
    ins.nna = TM.clamp(bytes[off + 17], 0, 3);
    ins.dct = TM.clamp(bytes[off + 18], 0, 3);
    ins.dca = TM.clamp(bytes[off + 19], 0, 2);
    ins.fadeout = dv.getUint16(off + 20, true) * 64; // -> per-tick on 65536 scale
    ins.pitchPanSep = bytes[off + 22] > 127 ? bytes[off + 22] - 256 : bytes[off + 22];
    ins.pitchPanCenter = TM.clamp(bytes[off + 23], 0, 119);
    ins.globalVolume = TM.clamp(bytes[off + 24], 0, 128);
    var dfp = bytes[off + 25];
    ins.panning = dfp & 128 ? -1 : TM.clamp(dfp & 127, 0, 64) * 4;
    ins.randomVolume = bytes[off + 26];
    ins.randomPan = bytes[off + 27];
    ins.name = TM.readString(bytes, off + 32, 26);
    var ifc = bytes[off + 58],
      ifr = bytes[off + 59];
    ins.filterCutoff = ifc & 128 ? ifc & 127 : -1;
    ins.filterResonance = ifr & 128 ? ifr & 127 : -1;
    readKeyboardTable(bytes, off + 64, ins);
    ins.volEnv = readEnvelope(bytes, dv, off + 304, 'vol');
    ins.panEnv = readEnvelope(bytes, dv, off + 386, 'pan');
    ins.pitchEnv = readEnvelope(bytes, dv, off + 468, 'pitch');
    return ins;
  }

  function readKeyboardTable(bytes, off, ins) {
    for (var i = 0; i < 120; i++) {
      var note = bytes[off + i * 2];
      var smp = bytes[off + i * 2 + 1];
      ins.noteMap[i] = note < 120 ? note + 1 : i + 1;
      ins.sampleMap[i] = smp;
    }
  }

  /* ------------------------------------------------------------------ *
   * Pattern unpacking.  Always decoded into a full 64 channel buffer;
   * the caller crops to the number of channels actually used.
   * ------------------------------------------------------------------ */
  function unpackPattern(bytes, off, len, rows) {
    var data = new Uint8Array(rows * 64 * TM.CELL_SIZE);
    var lastMask = new Uint8Array(64);
    var lastNote = new Uint8Array(64);
    var lastIns = new Uint8Array(64);
    var lastVolCmd = new Uint8Array(64);
    var lastVolParam = new Uint8Array(64);
    var lastFx = new Uint8Array(64);
    var lastFxParam = new Uint8Array(64);
    var p = off,
      end = off + len;
    var row = 0;
    var maxChannel = 0;

    while (row < rows && p < end) {
      var chanVar = bytes[p++];
      if (chanVar === 0) {
        row++;
        continue;
      }
      var ch = (chanVar - 1) & 63;
      var mask = lastMask[ch];
      if (chanVar & 128) {
        mask = bytes[p++];
        lastMask[ch] = mask;
      }
      if (mask & 1) lastNote[ch] = bytes[p++];
      if (mask & 2) lastIns[ch] = bytes[p++];
      if (mask & 4) {
        var vp = bytes[p++];
        var conv = convertVolumeColumn(vp);
        lastVolCmd[ch] = conv[0];
        lastVolParam[ch] = conv[1];
      }
      if (mask & 8) {
        var cb = bytes[p++];
        var pb = bytes[p++];
        var e = TM.itConvertEffect(cb, pb);
        lastFx[ch] = e[0];
        lastFxParam[ch] = e[1];
      }
      if (ch > maxChannel) maxChannel = ch;

      var o = (row * 64 + ch) * TM.CELL_SIZE;
      if (mask & (1 | 16)) data[o + TM.C_NOTE] = convertNote(lastNote[ch]);
      if (mask & (2 | 32)) data[o + TM.C_INST] = lastIns[ch];
      if (mask & (4 | 64)) {
        data[o + TM.C_VOLCMD] = lastVolCmd[ch];
        data[o + TM.C_VOLPARAM] = lastVolParam[ch];
      }
      if (mask & (8 | 128)) {
        data[o + TM.C_EFX] = lastFx[ch];
        data[o + TM.C_EFXPARAM] = lastFxParam[ch];
      }
    }
    return { data: data, rows: rows, maxChannel: maxChannel };
  }

  function convertNote(n) {
    if (n < 120) return n + 1;
    if (n === 255) return TM.NOTE_OFF;
    if (n === 254) return TM.NOTE_CUT;
    if (n === 253) return TM.NOTE_FADE;
    return 0;
  }

  /* IT volume column: a single 0..212 byte encoding several commands. */
  function convertVolumeColumn(v) {
    if (v <= 64) return [VC.VOLUME, v];
    if (v <= 74) return [VC.FINE_VOLSLIDE_UP, v - 65];
    if (v <= 84) return [VC.FINE_VOLSLIDE_DOWN, v - 75];
    if (v <= 94) return [VC.VOLSLIDE_UP, v - 85];
    if (v <= 104) return [VC.VOLSLIDE_DOWN, v - 95];
    if (v <= 114) return [VC.PORTA_DOWN, (v - 105) * 4];
    if (v <= 124) return [VC.PORTA_UP, (v - 115) * 4];
    if (v >= 128 && v <= 192) return [VC.PAN, v - 128];
    if (v >= 193 && v <= 202) return [VC.TONE_PORTA, v - 193];
    if (v >= 203 && v <= 212) return [VC.VIBRATO_DEPTH, v - 203];
    return [VC.NONE, 0];
  }
  TM.itConvertVolumeColumn = convertVolumeColumn;

  /* IT shares S3M's letter commands; only Xxx (panning) differs, IT using
   * the full 0..255 range where ST3 used 0..0x80. */
  TM.itConvertEffect = function (cmd, param) {
    if (cmd === 24) return [EFX.SET_PANNING, param];
    return TM.s3mConvertEffect(cmd, param);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
