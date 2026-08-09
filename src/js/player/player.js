/* =====================================================================
 * player.js -- the replay engine (runs on the audio thread)
 *
 * ARCHITECTURE
 * ------------
 * One engine plays all four formats.  Everything format specific was
 * already normalised by the loaders (see common.js); what remains here is
 * a handful of behavioural switches read from song.flags.
 *
 * Two clocks drive everything:
 *     row      = `speed` ticks
 *     tick     = 2.5 / tempo  seconds
 * render() therefore never mixes across a tick boundary: it mixes up to
 * the boundary, runs one tick of the state machine, and continues.
 *
 * Voices vs. channels
 * -------------------
 * A *channel* is a column in the pattern and owns all effect memory.
 * A *voice* is a sounding note.  Normally a channel has exactly one voice,
 * but Impulse Tracker's New Note Actions let the previous note keep
 * sounding when a new one starts, so voices live in a pool and may outlive
 * their channel's ownership.  This is also what makes NNA=continue,
 * fadeout and duplicate-check actions expressible at all.
 *
 * This file is a plain script (no imports/exports): tools/build.js injects
 * its text both into the AudioWorklet blob and into the main bundle, so the
 * exact same engine can run on the audio thread, in the ScriptProcessor
 * fallback, and in the offline WAV renderer / test harness under Node.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;
  var EFX = TM.EFX;
  var VC = TM.VC;

  var MAX_BG_VOICES = 64; // extra voices available for NNA / DNA
  var RAMP_MS = 1.0; // volume ramp length; kills the classic tracker click
  var DEFAULT_FADEOUT = 2048; // ~32 ticks, used when the instrument declares none

  /* ------------------------------------------------------------------ */
  function Voice() {
    this.reset();
  }
  /* Every field a voice can ever carry has to be listed here.  A voice slot
   * is recycled for the lifetime of the song, so any property that reset()
   * forgets survives into the *next* note that lands in this slot.  That is
   * how a single note-cut used to silence a slot permanently, and how stale
   * pan/volume state leaked between unrelated notes. */
  Voice.prototype.reset = function () {
    this.active = false;
    this.owner = -1; // channel index that currently controls this voice
    this.origin = -1; // channel the note was born on (survives NNA release)
    this.background = false; // true once released by NNA
    this.smp = null;
    this.sampleIndex = -1;
    this.instIndex = -1;
    this.note = 0;
    this.pos = 0;
    this.inc = 0;
    this.dir = 1;
    this.inSustainLoop = false;
    this.volL = 0;
    this.volR = 0;
    this.tgtL = 0;
    this.tgtR = 0;
    this.fadeVol = 65536;
    this.fading = false;
    this.keyOff = false;
    this.volEnvPos = 0;
    this.volEnvValue = 64;
    this.volEnvDone = false;
    this.panEnvPos = 0;
    this.panEnvValue = 32;
    this.panEnvDone = false;
    this.pitchEnvPos = 0;
    this.pitchEnvValue = 32;
    this.pitchEnvDone = false;
    this.autoVibPos = 0;
    this.autoVibSweep = 0;
    this.peak = 0;
    /* `cut` is a latch, not a level.  Zeroing tgtL/tgtR is not enough to
     * stop a note: updateVoices() recomputes both from the channel (or, for
     * a released voice, from lastVol/lastPan) on the very next tick and
     * would hand the voice its volume straight back.  Anything that means
     * "this note is over" must latch cut, which updateVoices honours and
     * the mixer uses to retire the slot once the ramp has run out. */
    this.cut = false;
    this.volEnvOff = false;
    this.surround = false;
    this.chanVolume = 64;
    this.lastVol = 64; // carried over when the owning channel lets go
    this.lastPan = 128;
    this.lastPeriod = 0;
  };

  /* ------------------------------------------------------------------ */
  function Channel(index) {
    this.index = index;
    this.reset();
  }
  Channel.prototype.reset = function () {
    this.voice = -1;
    this.note = 0; // last triggered note (after instrument note map)
    this.rawNote = 0; // note as written in the pattern
    this.instrument = 0; // 1-based
    this.sampleIndex = -1;
    this.period = 0;
    this.targetPeriod = 0;
    this.portaDest = 0;
    this.volume = 64; // 0..64 note volume
    this.channelVolume = 64;
    this.panning = 128; // 0..256
    this.surround = false;
    this.muted = false;
    this.newNoteDelayed = false;

    // effect memories
    this.memPortaUp = 0;
    this.memPortaDown = 0;
    this.memTonePorta = 0;
    this.memVolSlide = 0;
    this.memChanVolSlide = 0;
    this.memGlobalVolSlide = 0;
    this.memPanSlide = 0;
    this.memOffset = 0;
    this.memHighOffset = 0;
    this.memArp = 0;
    this.memRetrig = 0;
    this.memTremor = 0;
    this.memFineVolSlide = 0;
    this.memSpecial = 0;

    this.vibPos = 0;
    this.vibSpeed = 0;
    this.vibDepth = 0;
    this.vibWave = 0;
    this.vibRetrig = true;
    this.tremPos = 0;
    this.tremSpeed = 0;
    this.tremDepth = 0;
    this.tremWave = 0;
    this.panbPos = 0;
    this.panbSpeed = 0;
    this.panbDepth = 0;
    this.panbWave = 0;
    this.tremorCount = 0;
    this.tremorOn = true;
    this.arpTick = 0;
    this.glissando = false;

    this.patLoopStart = 0;
    this.patLoopCount = 0;

    this.noteDelayTicks = -1;
    this.delayedCell = null;
    this.cutTicks = -1;
    this.vuMeter = 0;
    this.keyOffTick = -1;
    this.retrigCount = 0;
    this.nnaOverride = -1;
    this.clearRowEffects();
  };

  /* ------------------------------------------------------------------ *
   * Per-row effect *activity*.
   *
   * Tracker effects split into two kinds of state: the parameter memory
   * (mem*, which deliberately survives until the next row that supplies a
   * parameter) and the "is this effect running right now" flag, which is
   * only true for rows whose cell actually carries the command.  Conflating
   * the two is the classic replayer bug: a single vibrato, arpeggio or
   * portamento anywhere in the song would then keep modulating that channel
   * for every remaining row, and the errors pile up channel by channel
   * until the mix is an unrecognisable warble slammed into the limiter.
   *
   * So: memories persist, activity is rebuilt from scratch every row.
   * ------------------------------------------------------------------ */
  Channel.prototype.clearRowEffects = function () {
    this.lastFx = 0;
    this.lastFxParam = 0;
    this.lastVolCmd = 0;
    this.lastVolParam = 0;
    this.tonePortaActive = false;
    this.vibActive = false;
    this.vibFine = false;
    this.tremActive = false;
    this.panbActive = false;
    this.arpActive = false;
    this.tremorActive = false;
    this.pendingPorta = 0;
  };

  /* ================================================================== */
  function TrackerPlayer(sampleRate) {
    this.sampleRate = sampleRate || 44100;
    this.song = null;
    this.playing = false;
    this.masterVolume = 0.7;
    this.interpolation = 1; // 0 = none, 1 = linear, 2 = cubic
    this.stereoSeparation = 1.0;
    this.loopSong = true;
    this.channels = [];
    this.voices = [];
    this.soloMask = null;
    this.muteMask = [];
    this.chanVU = [];
    this.chanNote = [];
    this.chanInst = [];
    // One reusable cell object: processRow used to allocate one per channel
    // per row, i.e. tens of thousands of short-lived objects a second, which
    // is exactly the GC pressure an audio thread cannot afford.
    this.cellScratch = { note: 0, inst: 0, volcmd: 0, volparam: 0, fx: 0, fxparam: 0 };
    this.reset();
  }

  TrackerPlayer.prototype.setSong = function (song) {
    this.song = song;
    this.channels = [];
    for (var i = 0; i < song.channels; i++) this.channels.push(new Channel(i));
    this.voices = [];
    var total = song.channels + MAX_BG_VOICES;
    for (i = 0; i < total; i++) this.voices.push(new Voice());
    this.muteMask = [];
    this.chanVU = [];
    this.chanNote = [];
    this.chanInst = [];
    for (i = 0; i < song.channels; i++) {
      this.muteMask.push(!!song.chanMuted[i]);
      this.chanVU.push(0);
      this.chanNote.push(0);
      this.chanInst.push(0);
    }
    this.amigaK = song.type === 'mod' ? TM.AMIGA_K_MOD * 4 : TM.AMIGA_K_ST3;
    this.gvScale = song.flags.gvScale || 1;
    this.reset();
  };

  TrackerPlayer.prototype.reset = function () {
    this.order = 0;
    this.row = 0;
    this.tick = 0;
    this.patternIndex = 0;
    this.samplesUntilTick = 0;
    this.speed = this.song ? this.song.initialSpeed : 6;
    this.tempo = this.song ? this.song.initialTempo : 125;
    this.globalVolume = this.song ? this.song.globalVolume : 128;
    this.patternDelay = 0;
    this.frameDelay = 0;
    this.rowRepeat = false;
    this.pendingJump = -1;
    this.pendingBreak = -1;
    this.pendingLoopRow = -1;
    this.loopCount = 0;
    this.ended = false;
    this.playedFrames = 0;
    this.rampSamples = Math.max(1, Math.round((RAMP_MS * this.sampleRate) / 1000));
    if (this.song) {
      for (var i = 0; i < this.channels.length; i++) {
        var c = this.channels[i];
        c.reset();
        c.panning = this.song.panning[i] === undefined ? 128 : this.song.panning[i];
        c.channelVolume = this.song.chanVolume[i] === undefined ? 64 : this.song.chanVolume[i];
      }
      for (i = 0; i < this.voices.length; i++) this.voices[i].reset();
      this.patternIndex = this.resolveOrder(0);
    }
  };

  /** Follow skip/end markers starting at an order index. */
  TrackerPlayer.prototype.resolveOrder = function (ord) {
    var song = this.song;
    if (!song) return 0;
    var guard = 0;
    while (guard++ < song.orders.length + 2) {
      if (ord >= song.orders.length) {
        ord = this.loopSong ? song.restartPos || 0 : song.orders.length - 1;
        this.loopCount++;
        this.ended = !this.loopSong;
        if (this.ended) return this.patternIndex;
      }
      var p = song.orders[ord];
      if (p === TM.ORDER_SKIP) {
        ord++;
        continue;
      }
      if (p === TM.ORDER_END) {
        ord = this.loopSong ? song.restartPos || 0 : ord;
        this.loopCount++;
        this.ended = !this.loopSong;
        if (this.ended) return this.patternIndex;
        if (song.orders[ord] === TM.ORDER_END) return 0;
        continue;
      }
      this.order = ord;
      return p < song.patterns.length ? p : 0;
    }
    return 0;
  };

  TrackerPlayer.prototype.setPosition = function (order, row) {
    if (!this.song) return;
    this.order = TM.clamp(order, 0, Math.max(0, this.song.orders.length - 1));
    this.patternIndex = this.resolveOrder(this.order);
    var pat = this.song.patterns[this.patternIndex];
    this.row = TM.clamp(row || 0, 0, (pat ? pat.rows : 64) - 1);
    this.tick = 0;
    this.samplesUntilTick = 0;
    this.patternDelay = 0;
    this.frameDelay = 0;
    this.rowRepeat = false;
    this.pendingJump = this.pendingBreak = -1;
    this.ended = false;
    for (var i = 0; i < this.voices.length; i++) {
      this.voices[i].tgtL = this.voices[i].tgtR = 0;
      this.voices[i].active = false;
      this.voices[i].volL = this.voices[i].volR = 0;
    }
    for (i = 0; i < this.channels.length; i++) {
      this.channels[i].voice = -1;
      this.channels[i].noteDelayTicks = -1;
      this.channels[i].cutTicks = -1;
    }
  };

  /* ------------------------------------------------------------------ *
   * Pitch helpers
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.notePeriod = function (note, smp) {
    if (!smp) return 0;
    var n = note + (smp.relativeNote || 0);
    if (this.song.flags.linearSlides) {
      // 64 period units per semitone, decreasing with pitch.
      return 7680 - (n - 13) * 64;
    }
    var c5 = smp.c5speed || 8363;
    var hz = c5 * Math.pow(2, (n - 61) / 12);
    if (hz < 1) hz = 1;
    return this.amigaK / hz;
  };

  TrackerPlayer.prototype.periodToHz = function (period, smp) {
    if (this.song.flags.linearSlides) {
      var c5 = smp && smp.c5speed ? smp.c5speed : 8363;
      return c5 * Math.pow(2, (4608 - period) / 768);
    }
    if (period < 1) period = 1;
    return this.amigaK / period;
  };

  TrackerPlayer.prototype.clampPeriod = function (p) {
    if (this.song.flags.linearSlides) return TM.clamp(p, 1, 9000);
    if (this.song.flags.amigaLimits) return TM.clamp(p, 452, 3424); // PT 113..856 on the x4 scale
    return TM.clamp(p, 28, 54784);
  };

  /* ------------------------------------------------------------------ *
   * Voice management
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.allocVoice = function (chanIndex) {
    var v,
      i,
      best = -1,
      bestVol = 1e9;
    // The first `channels` voices are reserved 1:1 for the channels so a
    // normal module never has to hunt for a slot.  An inactive slot is free
    // no matter how it got that way - the old test also required
    // !background, which meant that once a channel's reserved voice had been
    // released by an NNA it was never reclaimed and every subsequent note in
    // the song came out of the 64-slot background pool.
    v = this.voices[chanIndex];
    if (!v.active) return chanIndex;
    if (v.owner === chanIndex && !v.background) return chanIndex;
    for (i = this.channels.length; i < this.voices.length; i++) {
      if (!this.voices[i].active) return i;
    }
    for (i = this.channels.length; i < this.voices.length; i++) {
      var vol = this.voices[i].volL + this.voices[i].volR;
      if (this.voices[i].background && vol < bestVol) {
        bestVol = vol;
        best = i;
      }
    }
    return best >= 0 ? best : chanIndex;
  };

  /** Apply the instrument's New Note Action to the channel's current voice. */
  TrackerPlayer.prototype.applyNNA = function (ch, inst) {
    if (ch.voice < 0) return;
    var v = this.voices[ch.voice];
    if (!v.active) return;
    var nna = inst ? inst.nna : TM.NNA_CUT;
    if (!this.song.flags.instrumentMode) nna = TM.NNA_CUT;
    if (nna === TM.NNA_CUT) {
      v.cut = true;
      v.tgtL = v.tgtR = 0;
      v.background = true;
      v.owner = -1;
      return;
    }
    v.background = true;
    v.owner = -1;
    if (nna === TM.NNA_OFF) {
      v.keyOff = true;
      if (!inst || !inst.volEnv.enabled) v.fading = true;
    } else if (nna === TM.NNA_FADE) {
      v.fading = true;
    }
  };

  /** Duplicate check: silence older voices from this channel that match. */
  TrackerPlayer.prototype.applyDCT = function (ch, inst, note, sampleIndex, instIndex) {
    if (!inst || inst.dct === TM.DCT_NONE) return;
    for (var i = 0; i < this.voices.length; i++) {
      var v = this.voices[i];
      if (!v.active || !v.background || v.origin !== ch.index) continue;
      var match = false;
      if (inst.dct === TM.DCT_NOTE) match = v.note === note && v.instIndex === instIndex;
      else if (inst.dct === TM.DCT_SAMPLE) match = v.sampleIndex === sampleIndex;
      else if (inst.dct === TM.DCT_INSTRUMENT) match = v.instIndex === instIndex;
      if (!match) continue;
      if (inst.dca === TM.DCA_CUT) {
        v.cut = true;
        v.tgtL = v.tgtR = 0;
      } else if (inst.dca === TM.DCA_OFF) v.keyOff = true;
      else v.fading = true;
    }
  };

  /* ------------------------------------------------------------------ *
   * Note triggering
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.triggerNote = function (ch, note, instNum, keepPos, offset) {
    var song = this.song;
    var inst = null,
      sampleIndex = -1;
    var instIndex = (instNum || ch.instrument) - 1;
    if (instIndex >= 0 && instIndex < song.instruments.length) inst = song.instruments[instIndex];

    var mappedNote = note;
    if (inst) {
      var idx = TM.clamp(note - 1, 0, 119);
      sampleIndex = inst.sampleMap[idx] - 1;
      if (song.flags.instrumentMode) mappedNote = inst.noteMap[idx] || note;
    }
    if (sampleIndex < 0 || sampleIndex >= song.samples.length) {
      // No sample mapped: kill the note rather than play garbage.
      if (ch.voice >= 0) {
        this.voices[ch.voice].cut = true;
        this.voices[ch.voice].tgtL = this.voices[ch.voice].tgtR = 0;
      }
      ch.note = note;
      return;
    }
    var smp = song.samples[sampleIndex];

    if (!keepPos) {
      this.applyDCT(ch, inst, mappedNote, sampleIndex, instIndex);
      this.applyNNA(ch, inst);
    }

    var vi = keepPos && ch.voice >= 0 ? ch.voice : this.allocVoice(ch.index);
    if (vi < 0) return;
    var v = this.voices[vi];
    var oldPos = keepPos && v.smp === smp ? v.pos : 0;
    v.reset();
    v.active = true;
    v.owner = ch.index;
    v.origin = ch.index;
    v.background = false;
    v.smp = smp;
    v.sampleIndex = sampleIndex;
    v.instIndex = instIndex;
    v.note = mappedNote;
    v.pos = keepPos ? oldPos : offset || 0;
    v.dir = 1;
    v.inSustainLoop = smp.susLoopType !== TM.LOOP_NONE;
    v.fadeVol = 65536;
    v.volEnvValue = 64;
    v.panEnvValue = 32;
    v.pitchEnvValue = 32;
    v.autoVibPos = 0;
    v.autoVibSweep = 0;
    if (v.pos >= smp.length && smp.length) {
      // ITs use O beyond the sample end to silence a note.
      v.pos = 0;
      v.active = smp.loopType !== TM.LOOP_NONE;
      if (!v.active) v.tgtL = v.tgtR = 0;
    }
    ch.voice = vi;
    ch.sampleIndex = sampleIndex;
    ch.note = mappedNote;

    if (inst && inst.panning >= 0) ch.panning = inst.panning;
    if (smp.panning >= 0) ch.panning = smp.panning;
    if (inst && song.flags.instrumentMode && inst.pitchPanSep) {
      ch.panning = TM.clamp(ch.panning + ((mappedNote - 1 - inst.pitchPanCenter) * inst.pitchPanSep) / 4, 0, 256);
    }

    var p = this.notePeriod(mappedNote, smp);
    ch.period = this.clampPeriod(p);
    ch.targetPeriod = ch.period;
    if (ch.vibRetrig) ch.vibPos = 0;
    ch.tremPos = 0;
    ch.tremorCount = 0;
  };

  /* ------------------------------------------------------------------ *
   * Row processing
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.processRow = function () {
    var song = this.song;
    var pat = song.patterns[this.patternIndex];
    if (!pat) return;
    if (this.row >= pat.rows) this.row = 0;
    var data = pat.data;
    this.pendingJump = -1;
    this.pendingBreak = -1;

    // Every channel starts the row with no effect running, including the
    // ones this pattern is too narrow to address.
    for (var i = 0; i < this.channels.length; i++) {
      var c = this.channels[i];
      c.clearRowEffects();
      c.noteDelayTicks = -1;
      c.cutTicks = -1;
      c.keyOffTick = -1;
      c.arpTick = 0;
    }

    var cell = this.cellScratch; // reused: one row-sized object, not 32/row
    for (i = 0; i < this.channels.length && i < pat.channels; i++) {
      var ch = this.channels[i];
      var o = (this.row * pat.channels + i) * TM.CELL_SIZE;
      cell.note = data[o + TM.C_NOTE];
      cell.inst = data[o + TM.C_INST];
      cell.volcmd = data[o + TM.C_VOLCMD];
      cell.volparam = data[o + TM.C_VOLPARAM];
      cell.fx = data[o + TM.C_EFX];
      cell.fxparam = data[o + TM.C_EFXPARAM];

      // Note delay defers the whole cell to a later tick.  That one needs a
      // private copy, because the scratch cell is about to be overwritten.
      if (cell.fx === EFX.NOTE_DELAY && cell.fxparam > 0) {
        ch.noteDelayTicks = cell.fxparam;
        ch.delayedCell = {
          note: cell.note,
          inst: cell.inst,
          volcmd: cell.volcmd,
          volparam: cell.volparam,
          fx: cell.fx,
          fxparam: cell.fxparam
        };
        continue;
      }
      this.processCell(ch, cell, true);
    }
  };

  TrackerPlayer.prototype.processCell = function (ch, cell, tick0) {
    var song = this.song;
    var note = cell.note;
    var isTonePorta =
      cell.fx === EFX.TONE_PORTA || cell.fx === EFX.TONEPORTA_VOLSLIDE || cell.volcmd === VC.TONE_PORTA;

    if (cell.inst) {
      ch.instrument = cell.inst;
      // A bare instrument number resets volume/pan to the sample defaults.
      var ii = cell.inst - 1;
      var smpIdx = -1;
      if (ii >= 0 && ii < song.instruments.length) {
        var inst = song.instruments[ii];
        var ni = TM.clamp((note >= 1 && note <= 120 ? note : ch.note || 61) - 1, 0, 119);
        smpIdx = inst.sampleMap[ni] - 1;
      }
      if (smpIdx >= 0 && smpIdx < song.samples.length) {
        ch.volume = song.samples[smpIdx].volume;
        if (song.samples[smpIdx].panning >= 0) ch.panning = song.samples[smpIdx].panning;
      }
      if (song.flags.instrumentMode && !note && ch.voice >= 0 && this.voices[ch.voice].active) {
        // Instrument alone retriggers the envelopes on IT/XM.  MOD and S3M
        // have no envelopes, and doing this there resurrected notes that a
        // previous row had already faded out.
        var v = this.voices[ch.voice];
        v.volEnvPos = v.panEnvPos = v.pitchEnvPos = 0;
        v.volEnvDone = v.panEnvDone = v.pitchEnvDone = false;
        v.fadeVol = 65536;
        v.fading = false;
        v.keyOff = false;
      }
    }

    if (note) {
      if (note === TM.NOTE_CUT) {
        if (ch.voice >= 0) {
          this.voices[ch.voice].cut = true;
          this.voices[ch.voice].tgtL = this.voices[ch.voice].tgtR = 0;
        }
        ch.volume = 0;
      } else if (note === TM.NOTE_OFF) {
        this.keyOffChannel(ch);
      } else if (note === TM.NOTE_FADE) {
        if (ch.voice >= 0) this.voices[ch.voice].fading = true;
      } else if (isTonePorta && ch.voice >= 0 && this.voices[ch.voice].active) {
        // Slide towards the new note instead of retriggering.
        var smp = this.voices[ch.voice].smp;
        var mapped = note;
        var instIdx = ch.instrument - 1;
        if (song.flags.instrumentMode && instIdx >= 0 && instIdx < song.instruments.length) {
          mapped = song.instruments[instIdx].noteMap[TM.clamp(note - 1, 0, 119)] || note;
        }
        ch.rawNote = note;
        ch.portaDest = this.clampPeriod(this.notePeriod(mapped, smp));
      } else {
        ch.rawNote = note;
        var off = 0;
        if (cell.fx === EFX.SAMPLE_OFFSET) {
          var op = cell.fxparam || ch.memOffset;
          ch.memOffset = op;
          off = op * 256 + ch.memHighOffset * 65536;
        }
        this.triggerNote(ch, note, cell.inst, false, off);
        ch.portaDest = ch.period;
        if (cell.inst === 0 && ch.instrument) {
          // Note without instrument keeps the current volume (tracker rule).
        }
      }
    }

    // Volume column.  The command is remembered so that its slide forms can
    // keep running on ticks 1..speed-1 (they used to fire on tick 0 only,
    // which made every volume-column slide a no-op).
    ch.lastVolCmd = cell.volcmd;
    ch.lastVolParam = cell.volparam;
    if (cell.volcmd) this.processVolumeColumn(ch, cell.volcmd, cell.volparam, true);

    // Effect column (tick 0 part)
    if (cell.fx || cell.fxparam) this.processEffectTick0(ch, cell);
    ch.lastFx = cell.fx;
    ch.lastFxParam = cell.fxparam;
  };

  TrackerPlayer.prototype.keyOffChannel = function (ch) {
    if (ch.voice < 0) return;
    var v = this.voices[ch.voice];
    if (!v.active) return;
    v.keyOff = true;
    var inst = v.instIndex >= 0 ? this.song.instruments[v.instIndex] : null;
    if (this.song.flags.instrumentMode) {
      if (!inst || !inst.volEnv.enabled) {
        if (this.song.type === 'xm') {
          v.tgtL = v.tgtR = 0; // FT2: no envelope means an instant stop
          ch.volume = 0;
        } else v.fading = true;
      } else v.fading = true;
    } else {
      v.fading = true;
      if (this.song.type === 'xm' || this.song.type === 'mod') {
        v.tgtL = v.tgtR = 0;
        ch.volume = 0;
      }
    }
    // Leaving the sustain loop is part of "key off" for IT samples.
    if (v.smp && v.inSustainLoop) {
      v.inSustainLoop = false;
      if (v.smp.loopType === TM.LOOP_NONE && v.pos > v.smp.length) v.active = false;
    }
  };

  TrackerPlayer.prototype.processVolumeColumn = function (ch, cmd, param, tick0) {
    switch (cmd) {
      case VC.VOLUME:
        if (tick0) ch.volume = TM.clamp(param, 0, 64);
        break;
      case VC.PAN:
        if (tick0) ch.panning = TM.clamp(param * 4, 0, 256);
        break;
      case VC.VOLSLIDE_UP:
        if (!tick0) ch.volume = TM.clamp(ch.volume + param, 0, 64);
        break;
      case VC.VOLSLIDE_DOWN:
        if (!tick0) ch.volume = TM.clamp(ch.volume - param, 0, 64);
        break;
      case VC.FINE_VOLSLIDE_UP:
        if (tick0) ch.volume = TM.clamp(ch.volume + param, 0, 64);
        break;
      case VC.FINE_VOLSLIDE_DOWN:
        if (tick0) ch.volume = TM.clamp(ch.volume - param, 0, 64);
        break;
      case VC.VIBRATO_SPEED:
        if (tick0) ch.vibSpeed = param;
        break;
      case VC.VIBRATO_DEPTH:
        if (tick0) {
          if (param) ch.vibDepth = param;
          ch.vibActive = true;
        }
        break;
      case VC.PAN_SLIDE_LEFT:
        if (!tick0) ch.panning = TM.clamp(ch.panning - param * 4, 0, 256);
        break;
      case VC.PAN_SLIDE_RIGHT:
        if (!tick0) ch.panning = TM.clamp(ch.panning + param * 4, 0, 256);
        break;
      case VC.PORTA_UP:
        if (!tick0) ch.period = this.clampPeriod(ch.period - param * 4);
        break;
      case VC.PORTA_DOWN:
        if (!tick0) ch.period = this.clampPeriod(ch.period + param * 4);
        break;
      case VC.TONE_PORTA:
        if (tick0) {
          // IT stores the speed as an index into a fixed table.
          var table = [0, 1, 4, 8, 16, 32, 64, 96, 128, 255];
          var sp = this.song.type === 'it' ? table[TM.clamp(param, 0, 9)] : param * 16;
          if (sp) ch.memTonePorta = sp;
          ch.tonePortaActive = true;
        }
        break;
    }
  };

  /* Tick-0 half of the effect column. */
  TrackerPlayer.prototype.processEffectTick0 = function (ch, cell) {
    var song = this.song;
    var fx = cell.fx,
      param = cell.fxparam;
    var x = param >> 4,
      y = param & 0x0f;

    switch (fx) {
      case EFX.SET_SPEED:
        if (param) this.speed = param;
        break;
      case EFX.SET_TEMPO:
        if (param >= 0x20) this.tempo = TM.clamp(param, 32, 512);
        else if (param) ch.tempoSlide = param; // T0x/T1x slide on later ticks
        break;
      case EFX.POSITION_JUMP:
        this.pendingJump = param;
        break;
      case EFX.PATTERN_BREAK:
        this.pendingBreak = param;
        if (this.pendingJump < 0) this.pendingJump = this.order + 1;
        break;
      case EFX.SET_VOLUME:
        ch.volume = TM.clamp(param, 0, 64);
        break;
      case EFX.VOLUME_SLIDE:
        if (param) ch.memVolSlide = param;
        this.doVolumeSlide(ch, ch.memVolSlide, true);
        break;
      case EFX.FINE_VOLSLIDE_UP:
        if (param) ch.memFineVolSlide = param;
        ch.volume = TM.clamp(ch.volume + ch.memFineVolSlide, 0, 64);
        break;
      case EFX.FINE_VOLSLIDE_DOWN:
        if (param) ch.memFineVolSlide = param;
        ch.volume = TM.clamp(ch.volume - ch.memFineVolSlide, 0, 64);
        break;
      case EFX.PORTA_UP:
        if (param) ch.memPortaUp = param;
        this.doPortaTick0(ch, ch.memPortaUp, -1);
        break;
      case EFX.PORTA_DOWN:
        if (param) ch.memPortaDown = param;
        this.doPortaTick0(ch, ch.memPortaDown, 1);
        break;
      case EFX.FINE_PORTA_UP:
        if (param) ch.memPortaUp = param;
        ch.period = this.clampPeriod(ch.period - ch.memPortaUp * 4);
        break;
      case EFX.FINE_PORTA_DOWN:
        if (param) ch.memPortaDown = param;
        ch.period = this.clampPeriod(ch.period + ch.memPortaDown * 4);
        break;
      case EFX.EXTRA_FINE_PORTA_UP:
        if (param) ch.memPortaUp = param;
        ch.period = this.clampPeriod(ch.period - ch.memPortaUp);
        break;
      case EFX.EXTRA_FINE_PORTA_DOWN:
        if (param) ch.memPortaDown = param;
        ch.period = this.clampPeriod(ch.period + ch.memPortaDown);
        break;
      case EFX.TONE_PORTA:
        if (param) ch.memTonePorta = param;
        ch.tonePortaActive = true;
        break;
      case EFX.TONEPORTA_VOLSLIDE:
        if (param) ch.memVolSlide = param;
        ch.tonePortaActive = true;
        this.doVolumeSlide(ch, ch.memVolSlide, true);
        break;
      case EFX.VIBRATO:
        if (x) ch.vibSpeed = x;
        if (y) ch.vibDepth = y;
        ch.vibActive = true;
        ch.vibFine = false;
        break;
      case EFX.FINE_VIBRATO:
        if (x) ch.vibSpeed = x;
        if (y) ch.vibDepth = y;
        ch.vibActive = true;
        ch.vibFine = true;
        break;
      case EFX.VIBRATO_VOLSLIDE:
        if (param) ch.memVolSlide = param;
        ch.vibActive = true;
        this.doVolumeSlide(ch, ch.memVolSlide, true);
        break;
      case EFX.TREMOLO:
        if (x) ch.tremSpeed = x;
        if (y) ch.tremDepth = y;
        ch.tremActive = true;
        break;
      case EFX.PANBRELLO:
        if (x) ch.panbSpeed = x;
        if (y) ch.panbDepth = y;
        ch.panbActive = true;
        break;
      case EFX.ARPEGGIO:
        if (param) ch.memArp = param;
        ch.arpActive = true;
        break;
      case EFX.SAMPLE_OFFSET:
        // handled at note trigger; remember for later rows
        if (param) ch.memOffset = param;
        break;
      case EFX.HIGH_OFFSET:
        ch.memHighOffset = param;
        break;
      case EFX.SET_PANNING:
        ch.panning = TM.clamp(Math.round((param * 256) / 255), 0, 256);
        ch.surround = false;
        break;
      case EFX.SET_PANNING_16:
        ch.panning = TM.clamp(param * 17, 0, 256);
        ch.surround = false;
        break;
      case EFX.PANNING_SLIDE:
      case EFX.PANNING_SLIDE_XM:
        if (param) ch.memPanSlide = param;
        break;
      case EFX.SET_CHANNEL_VOLUME:
        ch.channelVolume = TM.clamp(param, 0, 64);
        break;
      case EFX.CHANNEL_VOLSLIDE:
        if (param) ch.memChanVolSlide = param;
        break;
      case EFX.GLOBAL_VOLUME:
        this.globalVolume = TM.clamp(param * this.gvScale, 0, 128);
        break;
      case EFX.GLOBAL_VOLSLIDE:
        if (param) ch.memGlobalVolSlide = param;
        this.doGlobalVolSlide(ch, ch.memGlobalVolSlide, true);
        break;
      case EFX.RETRIG:
      case EFX.OLD_RETRIG:
        if (fx === EFX.RETRIG) {
          if (param) ch.memRetrig = param;
        } else ch.memRetrig = param & 0x0f;
        ch.retrigCount = 0;
        break;
      case EFX.TREMOR:
        if (param) ch.memTremor = param;
        ch.tremorActive = true;
        break;
      case EFX.NOTE_CUT:
        ch.cutTicks = param;
        if (param === 0) {
          ch.volume = 0;
          if (ch.voice >= 0) this.voices[ch.voice].tgtL = this.voices[ch.voice].tgtR = 0;
        }
        break;
      case EFX.PATTERN_DELAY:
        if (!this.rowRepeat && param) this.patternDelay = param;
        break;
      case EFX.FINE_PATTERN_DELAY:
        this.frameDelay = param;
        break;
      case EFX.PATTERN_LOOP:
        this.doPatternLoop(ch, param);
        break;
      case EFX.SET_GLISSANDO:
        ch.glissando = param !== 0;
        break;
      case EFX.SET_VIBRATO_WAVE:
        ch.vibWave = param & 3;
        ch.vibRetrig = (param & 4) === 0;
        break;
      case EFX.SET_TREMOLO_WAVE:
        ch.tremWave = param & 3;
        break;
      case EFX.SET_PANBRELLO_WAVE:
        ch.panbWave = param & 3;
        break;
      case EFX.SET_FINETUNE:
        if (ch.sampleIndex >= 0 && song.samples[ch.sampleIndex]) {
          var smp = song.samples[ch.sampleIndex];
          var ft = (param & 0x0f) - 8;
          smp.c5speed = Math.round((song.type === 'mod' ? TM.AMIGA_K_MOD / 428 : 8363) * Math.pow(2, ft / 96));
          if (ch.note) ch.period = this.clampPeriod(this.notePeriod(ch.note, smp));
        }
        break;
      case EFX.KEY_OFF:
        if (param === 0) this.keyOffChannel(ch);
        else ch.keyOffTick = param;
        break;
      case EFX.SET_ENV_POSITION:
        if (ch.voice >= 0) {
          var v = this.voices[ch.voice];
          v.volEnvPos = param;
          v.panEnvPos = param;
        }
        break;
      case EFX.SET_NNA:
        this.doNNACommand(ch, param);
        break;
      case EFX.SOUND_CONTROL:
        if (param === 0 || param === 1) ch.surround = param === 1;
        break;
    }
  };

  TrackerPlayer.prototype.doNNACommand = function (ch, param) {
    var v = ch.voice >= 0 ? this.voices[ch.voice] : null;
    switch (param) {
      case 0: // past note cut
        for (var i = 0; i < this.voices.length; i++)
          if (this.voices[i].background && this.voices[i].origin === ch.index) {
            this.voices[i].cut = true;
            this.voices[i].tgtL = this.voices[i].tgtR = 0;
          }
        break;
      case 1:
        for (i = 0; i < this.voices.length; i++)
          if (this.voices[i].background && this.voices[i].origin === ch.index) this.voices[i].keyOff = true;
        break;
      case 2:
        for (i = 0; i < this.voices.length; i++)
          if (this.voices[i].background && this.voices[i].origin === ch.index) this.voices[i].fading = true;
        break;
      case 3:
        ch.nnaOverride = TM.NNA_CUT;
        break;
      case 4:
        ch.nnaOverride = TM.NNA_CONTINUE;
        break;
      case 5:
        ch.nnaOverride = TM.NNA_OFF;
        break;
      case 6:
        ch.nnaOverride = TM.NNA_FADE;
        break;
      case 7:
        if (v) v.volEnvOff = true;
        break;
      case 8:
        if (v) v.volEnvOff = false;
        break;
    }
  };

  TrackerPlayer.prototype.doPatternLoop = function (ch, param) {
    if (param === 0) {
      ch.patLoopStart = this.row;
      return;
    }
    if (ch.patLoopCount === 0) ch.patLoopCount = param;
    else ch.patLoopCount--;
    if (ch.patLoopCount > 0) {
      this.pendingLoopRow = ch.patLoopStart;
    }
  };

  TrackerPlayer.prototype.doPortaTick0 = function (ch, param, sign) {
    // MOD/XM encode fine and extra-fine slides in the parameter nibbles.
    var x = param >> 4,
      y = param & 0x0f;
    if (x === 0xf && this.song.type !== 'mod') {
      ch.period = this.clampPeriod(ch.period + sign * y * 4);
      ch.pendingPorta = 0;
    } else if (x === 0xe && this.song.type !== 'mod') {
      ch.period = this.clampPeriod(ch.period + sign * y);
      ch.pendingPorta = 0;
    } else {
      ch.pendingPorta = sign * param * 4;
    }
  };

  TrackerPlayer.prototype.doVolumeSlide = function (ch, param, tick0) {
    var x = param >> 4,
      y = param & 0x0f;
    var fastMode = this.song.flags.fastVolSlides;
    if (x === 0x0f && y !== 0) {
      // DFy: fine slide down, tick 0 only
      if (tick0) ch.volume = TM.clamp(ch.volume - y, 0, 64);
      return;
    }
    if (y === 0x0f && x !== 0) {
      if (tick0) ch.volume = TM.clamp(ch.volume + x, 0, 64);
      return;
    }
    if (tick0 && !fastMode) return;
    if (x > 0) ch.volume = TM.clamp(ch.volume + x, 0, 64);
    else if (y > 0) ch.volume = TM.clamp(ch.volume - y, 0, 64);
  };

  TrackerPlayer.prototype.doChannelVolSlide = function (ch, param, tick0) {
    var x = param >> 4,
      y = param & 0x0f;
    if (x === 0x0f && y !== 0) {
      if (tick0) ch.channelVolume = TM.clamp(ch.channelVolume - y, 0, 64);
      return;
    }
    if (y === 0x0f && x !== 0) {
      if (tick0) ch.channelVolume = TM.clamp(ch.channelVolume + x, 0, 64);
      return;
    }
    if (tick0) return;
    if (x > 0) ch.channelVolume = TM.clamp(ch.channelVolume + x, 0, 64);
    else if (y > 0) ch.channelVolume = TM.clamp(ch.channelVolume - y, 0, 64);
  };

  TrackerPlayer.prototype.doGlobalVolSlide = function (ch, param, tick0) {
    var x = param >> 4,
      y = param & 0x0f;
    var s = this.gvScale;
    if (x === 0x0f && y !== 0) {
      if (tick0) this.globalVolume = TM.clamp(this.globalVolume - y * s, 0, 128);
      return;
    }
    if (y === 0x0f && x !== 0) {
      if (tick0) this.globalVolume = TM.clamp(this.globalVolume + x * s, 0, 128);
      return;
    }
    if (tick0) return;
    if (x > 0) this.globalVolume = TM.clamp(this.globalVolume + x * s, 0, 128);
    else if (y > 0) this.globalVolume = TM.clamp(this.globalVolume - y * s, 0, 128);
  };

  TrackerPlayer.prototype.doPanSlide = function (ch, param, xmStyle) {
    var x = param >> 4,
      y = param & 0x0f;
    if (x === 0x0f && y !== 0) return; // fine forms handled on tick 0 only
    if (y === 0x0f && x !== 0) return;
    var delta = 0;
    if (xmStyle) delta = x > 0 ? x * 4 : -y * 4;
    else delta = x > 0 ? -x * 4 : y * 4;
    ch.panning = TM.clamp(ch.panning + delta, 0, 256);
  };

  /* Ticks 1..speed-1 of the effect column. */
  TrackerPlayer.prototype.processEffectTick = function (ch) {
    var fx = ch.lastFx,
      param = ch.lastFxParam;
    var x = param >> 4,
      y = param & 0x0f;

    // Volume-column slides are per-tick effects too.
    if (ch.lastVolCmd) this.processVolumeColumn(ch, ch.lastVolCmd, ch.lastVolParam, false);

    // pendingPorta is armed by Exx/Fxx on tick 0 and disarmed by the next
    // row.  Applying it unconditionally (as this used to) meant one
    // portamento anywhere in the song detuned that channel forever.
    if (ch.pendingPorta && (fx === EFX.PORTA_UP || fx === EFX.PORTA_DOWN)) {
      ch.period = this.clampPeriod(ch.period + ch.pendingPorta);
    }

    switch (fx) {
      case EFX.VOLUME_SLIDE:
        this.doVolumeSlide(ch, ch.memVolSlide, false);
        break;
      case EFX.TONEPORTA_VOLSLIDE:
        this.doVolumeSlide(ch, ch.memVolSlide, false);
        break;
      case EFX.VIBRATO_VOLSLIDE:
        this.doVolumeSlide(ch, ch.memVolSlide, false);
        break;
      case EFX.CHANNEL_VOLSLIDE:
        this.doChannelVolSlide(ch, ch.memChanVolSlide, false);
        break;
      case EFX.GLOBAL_VOLSLIDE:
        this.doGlobalVolSlide(ch, ch.memGlobalVolSlide, false);
        break;
      case EFX.PANNING_SLIDE:
        this.doPanSlide(ch, ch.memPanSlide, false);
        break;
      case EFX.PANNING_SLIDE_XM:
        this.doPanSlide(ch, ch.memPanSlide, true);
        break;
      case EFX.RETRIG:
      case EFX.OLD_RETRIG:
        this.doRetrig(ch, fx === EFX.RETRIG);
        break;
      case EFX.NOTE_CUT:
        break;
      case EFX.SET_TEMPO:
        if (param < 0x20 && param > 0) {
          if (x === 0) this.tempo = TM.clamp(this.tempo - y, 32, 512);
          else if (x === 1) this.tempo = TM.clamp(this.tempo + y, 32, 512);
        }
        break;
      case EFX.KEY_OFF:
        if (ch.keyOffTick === this.tick) this.keyOffChannel(ch);
        break;
    }

    if (ch.cutTicks >= 0 && this.tick >= ch.cutTicks) {
      ch.volume = 0;
      if (ch.voice >= 0) this.voices[ch.voice].tgtL = this.voices[ch.voice].tgtR = 0;
      ch.cutTicks = -1;
    }
  };

  TrackerPlayer.prototype.doRetrig = function (ch, withVolume) {
    var param = ch.memRetrig;
    var interval = param & 0x0f;
    if (!interval) return;
    if (this.tick % interval !== 0) return;
    var vfx = param >> 4;
    if (withVolume && vfx) {
      switch (vfx) {
        case 1:
          ch.volume -= 1;
          break;
        case 2:
          ch.volume -= 2;
          break;
        case 3:
          ch.volume -= 4;
          break;
        case 4:
          ch.volume -= 8;
          break;
        case 5:
          ch.volume -= 16;
          break;
        case 6:
          ch.volume = (ch.volume * 2) / 3;
          break;
        case 7:
          ch.volume = ch.volume / 2;
          break;
        case 9:
          ch.volume += 1;
          break;
        case 0xa:
          ch.volume += 2;
          break;
        case 0xb:
          ch.volume += 4;
          break;
        case 0xc:
          ch.volume += 8;
          break;
        case 0xd:
          ch.volume += 16;
          break;
        case 0xe:
          ch.volume = (ch.volume * 3) / 2;
          break;
        case 0xf:
          ch.volume = ch.volume * 2;
          break;
      }
      ch.volume = TM.clamp(Math.round(ch.volume), 0, 64);
    }
    if (ch.note && ch.note <= 120) this.triggerNote(ch, ch.rawNote || ch.note, ch.instrument, false, 0);
  };

  /* ------------------------------------------------------------------ *
   * Envelopes
   * ------------------------------------------------------------------ */
  function envValueAt(env, pos) {
    var pts = env.points;
    if (!pts.length) return -1;
    if (pos <= pts[0].x) return pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var a = pts[i],
        b = pts[i + 1];
      if (pos >= a.x && pos <= b.x) {
        var dx = b.x - a.x;
        if (dx <= 0) return b.y;
        return a.y + ((b.y - a.y) * (pos - a.x)) / dx;
      }
    }
    return pts[pts.length - 1].y;
  }
  TM.envValueAt = envValueAt;

  TrackerPlayer.prototype.tickEnvelope = function (v, env, posKey, valKey, doneKey, defaultValue) {
    if (!env || !env.enabled || !env.points.length) {
      v[valKey] = defaultValue;
      return;
    }
    var pos = v[posKey];
    v[valKey] = envValueAt(env, pos);
    if (v[doneKey]) return;

    var pts = env.points;
    var last = pts[pts.length - 1].x;

    if (env.sustain && !v.keyOff) {
      var se = pts[Math.min(env.sustainEnd, pts.length - 1)].x;
      var ss = pts[Math.min(env.sustainStart, pts.length - 1)].x;
      if (pos >= se) {
        v[posKey] = ss === se ? se : ss;
        return;
      }
    } else if (env.loop) {
      var le = pts[Math.min(env.loopEnd, pts.length - 1)].x;
      var ls = pts[Math.min(env.loopStart, pts.length - 1)].x;
      if (pos >= le) {
        v[posKey] = ls;
        return;
      }
    }
    if (pos >= last) {
      v[doneKey] = true;
      // End of a volume envelope means the note is finished (IT/XM rule).
      if (posKey === 'volEnvPos' && !env.loop) v.fading = true;
      return;
    }
    v[posKey] = pos + 1;
  };

  /* ------------------------------------------------------------------ *
   * One tick of the state machine
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.doTick = function () {
    var song = this.song;
    if (!song) return;

    if (this.tick === 0) {
      this.pendingLoopRow = -1;
      if (!this.rowRepeat) {
        this.processRow();
      } else {
        this.pendingJump = -1;
        this.pendingBreak = -1;
      }
    } else {
      for (var i = 0; i < this.channels.length; i++) {
        var ch = this.channels[i];
        if (ch.noteDelayTicks >= 0 && this.tick === ch.noteDelayTicks) {
          this.processCell(ch, ch.delayedCell, true);
          ch.noteDelayTicks = -1;
        } else if (ch.noteDelayTicks < 0) {
          this.processEffectTick(ch);
        }
      }
    }

    // Continuous modulation + pitch resolution for every channel.
    for (i = 0; i < this.channels.length; i++) this.updateChannel(this.channels[i]);
    this.updateVoices();

    // ---- advance the clock ------------------------------------------
    this.tick++;
    var ticksPerRow = this.speed + this.frameDelay;
    if (this.tick >= ticksPerRow) {
      this.tick = 0;
      this.frameDelay = 0;
      if (this.patternDelay > 0) {
        this.patternDelay--;
        this.rowRepeat = true;
      } else {
        this.rowRepeat = false;
        this.advanceRow();
      }
    }
  };

  TrackerPlayer.prototype.advanceRow = function () {
    var song = this.song;
    var pat = song.patterns[this.patternIndex];
    var rows = pat ? pat.rows : 64;

    if (this.pendingLoopRow >= 0) {
      this.row = this.pendingLoopRow;
      this.pendingLoopRow = -1;
      return;
    }
    if (this.pendingJump >= 0) {
      var target = this.pendingJump;
      var breakRow = this.pendingBreak >= 0 ? this.pendingBreak : 0;
      this.pendingJump = this.pendingBreak = -1;
      if (target <= this.order) this.loopCount++;
      this.patternIndex = this.resolveOrder(target);
      var np = song.patterns[this.patternIndex];
      this.row = TM.clamp(breakRow, 0, (np ? np.rows : 64) - 1);
      for (var i = 0; i < this.channels.length; i++) this.channels[i].patLoopCount = 0;
      if (!this.loopSong && this.ended) this.playing = false;
      return;
    }
    this.row++;
    if (this.row >= rows) {
      this.row = 0;
      this.patternIndex = this.resolveOrder(this.order + 1);
      for (i = 0; i < this.channels.length; i++) {
        this.channels[i].patLoopCount = 0;
        this.channels[i].patLoopStart = 0;
      }
      if (!this.loopSong && this.ended) this.playing = false;
    }
  };

  /** Per-tick modulation: vibrato, tremolo, arpeggio, tone portamento. */
  TrackerPlayer.prototype.updateChannel = function (ch) {
    var song = this.song;
    var period = ch.period;
    var volume = ch.volume;
    var panning = ch.panning;
    if (!period) {
      ch.finalPeriod = 0;
      ch.finalVolume = 0;
      return;
    }

    // Tone portamento
    if (ch.tonePortaActive && ch.portaDest && this.tick > 0) {
      var step = ch.memTonePorta * 4;
      if (ch.period < ch.portaDest) ch.period = Math.min(ch.portaDest, ch.period + step);
      else if (ch.period > ch.portaDest) ch.period = Math.max(ch.portaDest, ch.period - step);
      period = ch.period;
      if (ch.glissando && ch.sampleIndex >= 0) {
        period = this.snapToSemitone(period, song.samples[ch.sampleIndex]);
      }
    }

    // Vibrato
    if (ch.vibActive && ch.vibDepth) {
      var wave = TM.WAVES[ch.vibWave & 3];
      var vd = wave[ch.vibPos & 63];
      var div = song.type === 'mod' ? 8 : 32;
      if (ch.vibFine) div *= 4;
      if (song.flags.itOldEffects) div /= 2;
      var delta = (vd * ch.vibDepth) / div;
      if (song.flags.linearSlides) delta *= 4 / 3; // keep the audible depth similar
      period += delta;
      if (this.tick > 0 || song.type === 'it' || song.type === 's3m') ch.vibPos = (ch.vibPos + ch.vibSpeed) & 63;
    }

    // Auto (instrument) vibrato from the sample definition
    if (ch.voice >= 0) {
      var v = this.voices[ch.voice];
      if (v.active && v.smp && v.smp.vibDepth) {
        var s = v.smp;
        var awave = TM.WAVES[s.vibType & 3];
        var sweep = s.vibSweep ? Math.min(1, v.autoVibSweep / s.vibSweep) : 1;
        var ad = (awave[v.autoVibPos & 63] * s.vibDepth * sweep) / 64;
        period += ad;
        v.autoVibPos = (v.autoVibPos + Math.max(1, s.vibRate >> 2)) & 63;
        v.autoVibSweep++;
      }
    }

    // Arpeggio
    if (ch.arpActive && ch.memArp && ch.sampleIndex >= 0) {
      var phase = this.tick % 3;
      var semis = phase === 0 ? 0 : phase === 1 ? ch.memArp >> 4 : ch.memArp & 0x0f;
      if (semis) {
        var smp = song.samples[ch.sampleIndex];
        var np = this.notePeriod(TM.clamp(ch.note + semis, 1, 120), smp);
        period = np;
      }
    }

    // Tremolo
    if (ch.tremActive && ch.tremDepth) {
      var tw = TM.WAVES[ch.tremWave & 3];
      volume = TM.clamp(volume + (tw[ch.tremPos & 63] * ch.tremDepth) / 16, 0, 64);
      if (this.tick > 0) ch.tremPos = (ch.tremPos + ch.tremSpeed) & 63;
    }

    // Panbrello
    if (ch.panbActive && ch.panbDepth) {
      var pw = TM.WAVES[ch.panbWave & 3];
      panning = TM.clamp(panning + (pw[ch.panbPos & 63] * ch.panbDepth) / 8, 0, 256);
      ch.panbPos = (ch.panbPos + ch.panbSpeed) & 63;
    }

    // Tremor
    if (ch.tremorActive && ch.memTremor) {
      var onT = (ch.memTremor >> 4) + 1;
      var offT = (ch.memTremor & 0x0f) + 1;
      var cyc = ch.tremorCount % (onT + offT);
      ch.tremorOn = cyc < onT;
      ch.tremorCount++;
      if (!ch.tremorOn) volume = 0;
    }

    ch.finalPeriod = this.clampPeriod(period);
    ch.finalVolume = volume;
    ch.finalPanning = panning;
  };

  TrackerPlayer.prototype.snapToSemitone = function (period, smp) {
    if (!smp) return period;
    if (this.song.flags.linearSlides) return Math.round(period / 64) * 64;
    var hz = this.amigaK / period;
    var n = Math.round(61 + 12 * Math.log2(hz / (smp.c5speed || 8363)));
    return this.notePeriod(TM.clamp(n, 1, 120), smp);
  };

  /** Push channel state into the voices and advance envelopes. */
  TrackerPlayer.prototype.updateVoices = function () {
    var song = this.song;
    var soloActive = false;
    for (var i = 0; i < this.muteMask.length; i++) if (this.soloMask && this.soloMask[i]) soloActive = true;

    for (i = 0; i < this.voices.length; i++) {
      var v = this.voices[i];
      if (!v.active) continue;
      // A cut voice is done deciding: hold the target at zero and let the
      // mixer ramp it out and free the slot.  Recomputing its amplitude here
      // is what used to resurrect every cut note.
      if (v.cut) {
        v.tgtL = v.tgtR = 0;
        continue;
      }
      var inst = v.instIndex >= 0 && v.instIndex < song.instruments.length ? song.instruments[v.instIndex] : null;
      var smp = v.smp;

      // envelopes
      if (song.flags.instrumentMode && inst) {
        this.tickEnvelope(v, inst.volEnv, 'volEnvPos', 'volEnvValue', 'volEnvDone', 64);
        this.tickEnvelope(v, inst.panEnv, 'panEnvPos', 'panEnvValue', 'panEnvDone', 32);
        this.tickEnvelope(v, inst.pitchEnv, 'pitchEnvPos', 'pitchEnvValue', 'pitchEnvDone', 32);
      }
      if (v.fading) {
        /* Fadeout rate.  IT lets an instrument declare fadeout = 0, meaning
         * "the volume envelope decides when this note ends".  If there is no
         * envelope to decide - or it loops forever - a released voice would
         * sound until the pool filled up, so fall back to a short fade.
         * This is the difference between a handful of live voices and all 68
         * of them ringing at once. */
        var fade = song.flags.instrumentMode && inst ? inst.fadeout : 0;
        if (!fade) {
          var envEnds = song.flags.instrumentMode && inst && inst.volEnv.enabled && !inst.volEnv.loop;
          fade = envEnds && !v.volEnvDone ? 0 : DEFAULT_FADEOUT;
        }
        if (fade) {
          v.fadeVol -= fade;
          if (v.fadeVol <= 0) {
            v.fadeVol = 0;
            v.cut = true;
            v.tgtL = v.tgtR = 0;
            continue;
          }
        }
      }

      var ch = v.owner >= 0 ? this.channels[v.owner] : null;
      var vol, pan, period;
      if (ch) {
        vol = ch.finalVolume === undefined ? ch.volume : ch.finalVolume;
        pan = ch.finalPanning === undefined ? ch.panning : ch.finalPanning;
        period = ch.finalPeriod || ch.period;
        v.chanVolume = ch.channelVolume;
        v.lastPeriod = period;
        v.lastVol = vol;
        v.lastPan = pan;
        v.surround = ch.surround;
      } else {
        vol = v.lastVol === undefined ? 64 : v.lastVol;
        pan = v.lastPan === undefined ? 128 : v.lastPan;
        period = v.lastPeriod || 1712;
      }

      // pitch envelope (IT): +/- 32 units = +/- 2 octaves at full scale
      if (song.flags.instrumentMode && inst && inst.pitchEnv.enabled && !inst.pitchEnv.filter) {
        var pe = (v.pitchEnvValue - 32) / 32; // -1..1
        period = period * Math.pow(2, (-pe * 8) / 12);
      }

      var hz = this.periodToHz(period, smp);
      v.inc = hz / this.sampleRate;

      var chanIdx = v.owner >= 0 ? v.owner : v.origin;
      var muted = chanIdx >= 0 && chanIdx < this.muteMask.length ? this.muteMask[chanIdx] : false;
      if (soloActive) muted = !(chanIdx >= 0 && this.soloMask[chanIdx]);

      var amp = vol / 64;
      amp *= (v.chanVolume === undefined ? 64 : v.chanVolume) / 64;
      if (smp) amp *= (smp.volume / 64) * (smp.globalVolume / 64);
      if (inst && song.flags.instrumentMode) amp *= inst.globalVolume / 128;
      if (song.flags.instrumentMode && inst && inst.volEnv.enabled) amp *= v.volEnvValue / 64;
      amp *= v.fadeVol / 65536;
      amp *= this.globalVolume / 128;
      amp *= (song.mixVolume || 48) / 128;
      if (muted) amp = 0;

      var p = pan / 256;
      if (song.flags.instrumentMode && inst && inst.panEnv.enabled) {
        p += ((v.panEnvValue - 32) / 32) * 0.5 * Math.min(p, 1 - p) * 2;
        p = TM.clamp(p, 0, 1);
      }
      // Constant power panning, narrowed by the stereo separation setting.
      p = 0.5 + (p - 0.5) * this.stereoSeparation;
      var l = Math.cos(p * Math.PI * 0.5);
      var r = Math.sin(p * Math.PI * 0.5);
      if (v.surround) {
        v.tgtL = amp * 0.7;
        v.tgtR = -amp * 0.7;
      } else {
        v.tgtL = amp * l;
        v.tgtR = amp * r;
      }
      if (v.fadeVol <= 0) v.tgtL = v.tgtR = 0;
    }
  };

  /* ------------------------------------------------------------------ *
   * Mixing
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.samplesPerTick = function () {
    return (this.sampleRate * 2.5) / this.tempo;
  };

  /**
   * Render `count` frames into outL/outR (Float32Array).  Mixing never
   * crosses a tick boundary, so effects land sample-accurately.
   */
  TrackerPlayer.prototype.render = function (outL, outR, count) {
    var i;
    // fill() is a single memset in every engine; the hand-rolled loop it
    // replaces was two bounds-checked stores per frame.
    if (count === outL.length) {
      outL.fill(0);
      outR.fill(0);
    } else {
      outL.fill(0, 0, count);
      outR.fill(0, 0, count);
    }
    if (!this.song || !this.playing) return;

    /* VU decay used to happen once per mixSegment call, i.e. once per
     * tick-slice, so the meters fell at a rate that depended on the host
     * buffer size and the song tempo.  Tie it to elapsed frames instead:
     * a ~50 ms time constant regardless of how the render is chopped up. */
    var decay = Math.exp(-count / (0.05 * this.sampleRate));
    for (i = 0; i < this.chanVU.length; i++) this.chanVU[i] *= decay;

    var done = 0;
    var guard = 0;
    while (done < count && guard++ < 10000) {
      if (this.samplesUntilTick <= 0) {
        this.doTick();
        this.samplesUntilTick = this.samplesPerTick();
        if (!this.playing) break;
      }
      var n = Math.min(count - done, Math.ceil(this.samplesUntilTick));
      if (n <= 0) n = 1;
      this.mixSegment(outL, outR, done, n);
      this.samplesUntilTick -= n;
      done += n;
    }
    // Elapsed time comes from rendered frames, not wall time, so it stays
    // exact across pauses, buffer underruns and offline rendering.
    this.playedFrames += done;

    // Master gain + soft clipping.  Modules routinely sum well past 0 dBFS;
    // a gentle knee keeps that musical instead of buzzy.
    var g = this.masterVolume * 2;
    var rest = 1 - KNEE;
    for (i = 0; i < count; i++) {
      // softClip() inlined by hand: it is called twice per output frame and
      // the overwhelmingly common case is "below the knee, pass through",
      // which is one compare rather than a call.
      var x = outL[i] * g;
      var a = x < 0 ? -x : x;
      if (a > KNEE) {
        var ov = a - KNEE;
        var y = KNEE + (rest * ov) / (ov + rest);
        x = x < 0 ? -y : y;
      }
      outL[i] = x;
      x = outR[i] * g;
      a = x < 0 ? -x : x;
      if (a > KNEE) {
        ov = a - KNEE;
        y = KNEE + (rest * ov) / (ov + rest);
        x = x < 0 ? -y : y;
      }
      outR[i] = x;
    }
  };

  /* Soft-clip knee.  Below it the mix passes through untouched; above it the
   * curve is asymptotic, so loud modules compress instead of tearing.  The
   * curve itself is inlined into render() - see the comment there. */
  var KNEE = 0.75;

  /* ------------------------------------------------------------------ *
   * The inner mixing loop.
   *
   * This is the only code in the program that runs per output sample per
   * sounding voice - at 44.1 kHz with a couple of dozen voices that is
   * millions of iterations a second on the audio thread, so everything that
   * can be decided less often is decided less often.  The structure is a
   * run-length loop: each pass computes how many frames can be emitted
   * before *anything* about the inner loop changes (the volume ramp
   * finishes, the sample hits its loop point or its end), then runs a tight
   * loop of exactly that length with no branching in it beyond the
   * interpolator.  The old version re-tested the interpolation mode, four
   * ramp comparisons (with Math.min/Math.max calls) and the loop type on
   * every single sample.
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.mixSegment = function (outL, outR, start, n) {
    var rampStep = 1 / this.rampSamples;
    var interp = this.interpolation;

    for (var vi = 0; vi < this.voices.length; vi++) {
      var v = this.voices[vi];
      if (!v.active || !v.smp || !v.smp.data || !v.smp.length) continue;
      if (v.tgtL === 0 && v.tgtR === 0 && Math.abs(v.volL) < 1e-6 && Math.abs(v.volR) < 1e-6) {
        v.active = false;
        continue;
      }
      var data = v.smp.data;
      var smp = v.smp;
      var len = Math.min(smp.length, data.length);
      var pos = v.pos;
      var inc = v.inc;
      var dir = v.dir;
      var volL = v.volL,
        volR = v.volR;
      var tgtL = v.tgtL,
        tgtR = v.tgtR;
      var useSus = v.inSustainLoop && smp.susLoopType !== TM.LOOP_NONE;
      var loopType = useSus ? smp.susLoopType : smp.loopType;
      var loopStart = useSus ? smp.susLoopStart : smp.loopStart;
      var loopEnd = useSus ? smp.susLoopEnd : smp.loopEnd;
      if (loopEnd > len) loopEnd = len;
      if (loopType !== TM.LOOP_NONE && loopEnd <= loopStart) loopType = TM.LOOP_NONE;
      var peak = 0;
      // Index the interpolator reads one past the end of the sample: back to
      // the loop start if it loops, otherwise hold the last frame.
      var wrapIdx = loopType === TM.LOOP_FORWARD ? loopStart : len - 1;
      if (wrapIdx < 0) wrapIdx = 0;

      var o = start;
      var left = n;
      if (pos < 0) pos = 0;

      while (left > 0) {
        if (pos >= len) {
          // Past the end with no loop to come back from: the voice is done.
          pos = len;
          volL = volR = 0;
          tgtL = tgtR = 0;
          v.active = false;
          break;
        }

        /* --- how many frames until the volume ramp changes shape? ------
         * volL and volR ramp independently, so a run may only last until
         * whichever of them lands on its target first; the next pass picks
         * up the other one.  That is at most two runs, versus n clamped
         * comparisons in the old loop. */
        var stepL = 0,
          stepR = 0,
          run = left;
        var dL = tgtL - volL,
          dR = tgtR - volR;
        if (dL !== 0) {
          var aL = dL > 0 ? dL : -dL;
          if (aL <= rampStep) {
            // Within one step of the target: land on it now, exactly as the
            // per-sample Math.min/Math.max clamp used to.
            volL = tgtL;
          } else {
            stepL = dL > 0 ? rampStep : -rampStep;
            // floor, not ceil: the run must stop *before* the frame that
            // would overshoot, so no emitted sample is ever past target.
            var kL = Math.floor(aL / rampStep);
            if (kL < run) run = kL;
          }
        }
        if (dR !== 0) {
          var aR = dR > 0 ? dR : -dR;
          if (aR <= rampStep) {
            volR = tgtR;
          } else {
            stepR = dR > 0 ? rampStep : -rampStep;
            var kR = Math.floor(aR / rampStep);
            if (kR < run) run = kR;
          }
        }

        /* --- how many frames until we hit a sample boundary? ----------- */
        var pinc = inc * dir;
        if (pinc !== 0) {
          var avail;
          if (pinc > 0) {
            var limit = loopType === TM.LOOP_NONE ? len : loopEnd;
            avail = Math.ceil((limit - pos) / pinc);
          } else {
            avail = Math.ceil((pos - loopStart) / -pinc);
          }
          if (avail < 1) avail = 1;
          if (avail < run) run = avail;
        }
        if (run < 1) run = 1;
        left -= run;

        /* --- the tight part ------------------------------------------- */
        var i, ip, s, a;
        if (interp === 0) {
          for (i = 0; i < run; i++) {
            ip = pos | 0;
            s = ip < len ? data[ip] : 0;
            volL += stepL;
            volR += stepR;
            outL[o] += s * volL;
            outR[o] += s * volR;
            o++;
            a = s < 0 ? -s : s;
            if (a > peak) peak = a;
            pos += pinc;
          }
        } else if (interp === 2) {
          /* Catmull-Rom: four taps, C1-continuous, no overshoot worth
           * worrying about on musical material.  Costs roughly three times
           * a linear tap, which is why it is a user-selectable quality
           * setting rather than the default. */
          for (i = 0; i < run; i++) {
            ip = pos | 0;
            var f = pos - ip;
            var im1 = ip - 1;
            if (im1 < 0) im1 = loopType === TM.LOOP_FORWARD ? loopEnd - 1 : 0;
            var ia = ip + 1;
            if (ia >= len) ia = wrapIdx;
            var ib = ip + 2;
            if (ib >= len) ib = wrapIdx;
            var y0 = data[im1],
              y1 = ip < len ? data[ip] : 0,
              y2 = data[ia],
              y3 = data[ib];
            var c0 = y1;
            var c1 = 0.5 * (y2 - y0);
            var c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
            var c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
            s = ((c3 * f + c2) * f + c1) * f + c0;
            volL += stepL;
            volR += stepR;
            outL[o] += s * volL;
            outR[o] += s * volR;
            o++;
            a = s < 0 ? -s : s;
            if (a > peak) peak = a;
            pos += pinc;
          }
        } else {
          for (i = 0; i < run; i++) {
            ip = pos | 0;
            var i1 = ip + 1;
            if (i1 >= len) i1 = wrapIdx;
            var s0 = ip < len ? data[ip] : 0;
            s = s0 + (data[i1] - s0) * (pos - ip);
            volL += stepL;
            volR += stepR;
            outL[o] += s * volL;
            outR[o] += s * volR;
            o++;
            a = s < 0 ? -s : s;
            if (a > peak) peak = a;
            pos += pinc;
          }
        }

        // The ramp may have stepped a hair past its target on the last
        // frame of the run; the per-sample clamp lived here all along.
        if (stepL > 0 ? volL > tgtL : stepL < 0 && volL < tgtL) volL = tgtL;
        if (stepR > 0 ? volR > tgtR : stepR < 0 && volR < tgtR) volR = tgtR;

        /* --- boundary handling, once per run, not once per sample ----- */
        if (loopType === TM.LOOP_FORWARD) {
          if (pos >= loopEnd) pos = loopStart + ((pos - loopEnd) % (loopEnd - loopStart));
        } else if (loopType === TM.LOOP_PINGPONG) {
          if (dir > 0 && pos >= loopEnd) {
            pos = loopEnd - (pos - loopEnd) - 1;
            dir = -1;
            if (pos < loopStart) pos = loopStart;
          } else if (dir < 0 && pos <= loopStart) {
            pos = loopStart + (loopStart - pos);
            dir = 1;
            if (pos >= loopEnd) pos = loopEnd - 1;
          }
        }
      }
      v.pos = pos;
      v.dir = dir;
      v.volL = volL;
      v.volR = volR;
      var chIdx = v.owner >= 0 ? v.owner : v.origin;
      if (chIdx >= 0 && chIdx < this.chanVU.length) {
        var level = peak * (Math.abs(volL) + Math.abs(volR));
        if (level > this.chanVU[chIdx]) this.chanVU[chIdx] = Math.min(1, level * 2);
      }
    }
  };

  /* ------------------------------------------------------------------ *
   * Introspection for the UI
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.getState = function () {
    var notes = [],
      insts = [],
      vus = [];
    for (var i = 0; i < this.channels.length; i++) {
      var ch = this.channels[i];
      var v = ch.voice >= 0 ? this.voices[ch.voice] : null;
      notes.push(v && v.active && v.owner === i ? ch.note : 0);
      insts.push(ch.instrument);
      vus.push(this.chanVU[i] || 0);
    }
    var active = 0;
    for (i = 0; i < this.voices.length; i++) if (this.voices[i].active) active++;
    return {
      playing: this.playing,
      order: this.order,
      pattern: this.patternIndex,
      row: this.row,
      tick: this.tick,
      speed: this.speed,
      tempo: this.tempo,
      globalVolume: this.globalVolume,
      time: this.playedFrames / this.sampleRate,
      loopCount: this.loopCount,
      ended: this.ended,
      activeVoices: active,
      notes: notes,
      instruments: insts,
      vu: vus
    };
  };

  /* ------------------------------------------------------------------ *
   * Offline helpers: song duration and WAV rendering.
   * ------------------------------------------------------------------ */
  TrackerPlayer.prototype.estimateDuration = function (maxSeconds) {
    if (!this.song) return 0;
    maxSeconds = maxSeconds || 3600;
    var saveState = this.snapshotPosition();
    var saveLoop = this.loopSong,
      savePlaying = this.playing;
    this.reset();
    this.playing = true;
    this.loopSong = false;
    var seconds = 0;
    var visited = {};
    var guard = 0;
    while (seconds < maxSeconds && guard++ < 500000) {
      var key = this.order * 1024 + this.row;
      if (this.tick === 0) {
        if (visited[key]) break;
        visited[key] = 1;
      }
      this.doTickDry();
      seconds += 2.5 / this.tempo;
      if (this.ended || !this.playing) break;
    }
    this.loopSong = saveLoop;
    this.reset();
    this.restorePosition(saveState);
    this.playing = savePlaying;
    return seconds;
  };

  /* A tick that runs the state machine without touching the voices - used
   * by the duration estimator, which must be fast and side-effect free. */
  TrackerPlayer.prototype.doTickDry = function () {
    this.doTick();
  };

  TrackerPlayer.prototype.snapshotPosition = function () {
    return { order: this.order, row: this.row };
  };
  TrackerPlayer.prototype.restorePosition = function (s) {
    if (s) this.setPosition(s.order, s.row);
  };

  root.TrackerPlayer = TrackerPlayer;
  if (typeof TM !== 'undefined') TM.TrackerPlayer = TrackerPlayer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
