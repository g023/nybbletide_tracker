/* =====================================================================
 * loader.js -- format detection and dispatch.
 *
 * Detection is by content, never by file extension: renamed modules are
 * extremely common in the wild.  MOD is tried last because its 15-sample
 * variant has no magic bytes at all and would happily "detect" anything.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;

  TM.detectFormat = function (bytes) {
    if (TM.detectIT(bytes)) return 'it';
    if (TM.detectS3M(bytes)) return 's3m';
    if (TM.detectXM(bytes)) return 'xm';
    if (TM.detectMOD(bytes)) return 'mod';
    return null;
  };

  /**
   * Parse a module from an ArrayBuffer / Uint8Array.
   * Returns the canonical song object; throws with a readable message.
   */
  TM.loadModule = function (buffer, filename) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.length < 64) throw new Error('File is too small to be a module.');
    var fmt = TM.detectFormat(bytes);
    if (!fmt) {
      throw new Error(
        'Unrecognised file format. Supported: .mod, .s3m, .xm, .it' +
          (filename ? ' (got "' + filename + '")' : '')
      );
    }
    var song;
    if (fmt === 'it') song = TM.parseIT(bytes);
    else if (fmt === 's3m') song = TM.parseS3M(bytes);
    else if (fmt === 'xm') song = TM.parseXM(bytes);
    else song = TM.parseMOD(bytes);

    if (!song.patterns.length) {
      song.patterns.push(TM.makePattern(64, song.channels));
    }
    if (!song.orders.length) song.orders.push(0);
    song.filename = filename || '';
    TM.finalizeSong(song);
    return song;
  };

  /**
   * Post-parse sanity pass shared by all loaders.  Doing it once here
   * means the engine can assume well-formed data everywhere else.
   */
  TM.finalizeSong = function (song) {
    var i, j;
    if (!song.channels || song.channels < 1) song.channels = 4;
    if (song.channels > 64) song.channels = 64;

    // Per-channel defaults
    for (i = 0; i < song.channels; i++) {
      if (song.panning[i] === undefined || song.panning[i] === null) {
        song.panning[i] = i % 4 === 0 || i % 4 === 3 ? 64 : 192;
      }
      song.panning[i] = TM.clamp(song.panning[i] | 0, 0, 256);
      if (song.chanVolume[i] === undefined) song.chanVolume[i] = 64;
      if (song.chanMuted[i] === undefined) song.chanMuted[i] = false;
    }
    song.panning.length = song.channels;
    song.chanVolume.length = song.channels;
    song.chanMuted.length = song.channels;

    // Samples: clamp loops so the mixer can trust them.
    for (i = 0; i < song.samples.length; i++) {
      var s = song.samples[i];
      if (!s.data) {
        s.data = new Float32Array(0);
        s.length = 0;
      }
      if (s.length > s.data.length) s.length = s.data.length;
      s.loopStart = TM.clamp(s.loopStart, 0, s.length);
      s.loopEnd = TM.clamp(s.loopEnd, 0, s.length);
      if (s.loopEnd <= s.loopStart + 1) s.loopType = TM.LOOP_NONE;
      s.susLoopStart = TM.clamp(s.susLoopStart, 0, s.length);
      s.susLoopEnd = TM.clamp(s.susLoopEnd, 0, s.length);
      if (s.susLoopEnd <= s.susLoopStart + 1) s.susLoopType = TM.LOOP_NONE;
      if (!(s.c5speed > 0)) s.c5speed = 8363;
      s.volume = TM.clamp(s.volume, 0, 64);
      s.globalVolume = TM.clamp(s.globalVolume, 0, 64);
    }

    // Instruments: guarantee one exists per sample for sample-based formats.
    if (!song.instruments.length) {
      for (i = 0; i < song.samples.length; i++) {
        var ins = TM.makeInstrument();
        ins.name = song.samples[i].name;
        for (j = 0; j < 120; j++) ins.sampleMap[j] = i + 1;
        song.instruments.push(ins);
      }
    }

    // Orders must reference existing patterns (or be markers).
    for (i = 0; i < song.orders.length; i++) {
      var o = song.orders[i];
      if (o === TM.ORDER_SKIP || o === TM.ORDER_END) continue;
      if (o >= song.patterns.length) song.orders[i] = TM.ORDER_SKIP;
    }
    if (song.restartPos >= song.orders.length) song.restartPos = 0;

    song.initialSpeed = TM.clamp(song.initialSpeed || 6, 1, 255);
    song.initialTempo = TM.clamp(song.initialTempo || 125, 32, 512);
    song.globalVolume = TM.clamp(song.globalVolume, 0, 128);
    song.mixVolume = TM.clamp(song.mixVolume || 48, 1, 128);

    // Cheap statistics the UI likes to show.
    var used = 0;
    for (i = 0; i < song.orders.length; i++) if (song.orders[i] < song.patterns.length) used++;
    song.songLength = used;
    return song;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
