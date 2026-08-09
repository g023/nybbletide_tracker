/* =====================================================================
 * processor.js -- the audio-thread wrapper around TrackerPlayer.
 *
 * WHY A WORKLET
 * -------------
 * Tracker replay is a hard-real-time job: one tick of the state machine has
 * to happen exactly every 2.5/tempo seconds, and the mixer touches every
 * active voice for every output sample.  Running that on the main thread
 * means every layout, every repaint of the pattern grid and every garbage
 * collection turns into an audible dropout.  An AudioWorkletProcessor runs
 * on the audio rendering thread, isolated from all of that.
 *
 * The brief also demands a single index.html, which normally rules out
 * AudioWorklet (addModule() needs a URL).  The build wraps this file's text
 * in a <script type="text/worklet-js"> tag; at runtime the app turns that
 * text into a Blob URL and hands it to addModule().  Same file, no network.
 *
 * The `typeof registerProcessor` guard is what lets the identical text also
 * be evaluated on the main thread for the ScriptProcessorNode fallback and
 * for offline WAV rendering.
 * ===================================================================== */
(function (root) {
  'use strict';

  var STATE_INTERVAL = 1024; // frames between state posts (~23ms @44.1k)

  function TrackerCore(sampleRate, post) {
    this.player = new root.TM.TrackerPlayer(sampleRate);
    this.post = post;
    this.sinceState = 0;
    this.hasSong = false;
  }

  TrackerCore.prototype.handle = function (msg) {
    var p = this.player;
    switch (msg.type) {
      case 'load':
        p.setSong(msg.song);
        this.hasSong = true;
        p.playing = false;
        this.post({ type: 'loaded', duration: p.estimateDuration(3600) });
        break;
      case 'play':
        if (!this.hasSong) break;
        if (p.ended) {
          p.reset();
        }
        p.playing = true;
        break;
      case 'pause':
        p.playing = false;
        break;
      case 'stop':
        p.playing = false;
        p.reset();
        break;
      case 'setPosition':
        p.setPosition(msg.order, msg.row);
        break;
      case 'mute':
        p.muteMask[msg.channel] = !!msg.value;
        break;
      case 'muteAll':
        for (var i = 0; i < p.muteMask.length; i++) p.muteMask[i] = !!msg.values[i];
        break;
      case 'solo':
        p.soloMask = msg.values && msg.values.some(function (v) { return v; }) ? msg.values : null;
        break;
      case 'volume':
        p.masterVolume = msg.value;
        break;
      case 'interpolation':
        p.interpolation = msg.value;
        break;
      case 'stereoSeparation':
        p.stereoSeparation = msg.value;
        break;
      case 'loop':
        p.loopSong = !!msg.value;
        break;
      case 'patternData':
        // A pattern was edited on the main thread; swap in the new bytes.
        if (p.song && p.song.patterns[msg.index]) {
          p.song.patterns[msg.index].data = new Uint8Array(msg.data);
          p.song.patterns[msg.index].rows = msg.rows;
        }
        break;
      case 'patternAdd':
        if (p.song) p.song.patterns[msg.index] = { rows: msg.rows, channels: msg.channels, data: new Uint8Array(msg.data) };
        break;
      case 'orders':
        if (p.song) p.song.orders = msg.orders;
        break;
      case 'sampleData':
        if (p.song && p.song.samples[msg.index]) {
          var s = p.song.samples[msg.index];
          for (var k in msg.props) if (Object.prototype.hasOwnProperty.call(msg.props, k)) s[k] = msg.props[k];
        }
        break;
      case 'noteOn':
        this.previewNote(msg);
        break;
      case 'noteOff':
        this.previewOff();
        break;
    }
  };

  /* Preview voices let the editor audition notes without disturbing the
   * song state: they use the voice pool directly, not a pattern channel. */
  TrackerCore.prototype.previewNote = function (msg) {
    var p = this.player;
    if (!p.song) return;
    var song = p.song;
    var instIndex = (msg.instrument || 1) - 1;
    if (instIndex < 0 || instIndex >= song.instruments.length) return;
    var inst = song.instruments[instIndex];
    var si = inst.sampleMap[Math.max(0, Math.min(119, msg.note - 1))] - 1;
    if (si < 0 || si >= song.samples.length) return;
    var smp = song.samples[si];
    var vi = -1;
    for (var i = song.channels; i < p.voices.length; i++) {
      if (!p.voices[i].active) { vi = i; break; }
    }
    if (vi < 0) vi = p.voices.length - 1;
    this.previewOff();
    var v = p.voices[vi];
    v.reset();
    v.active = true;
    v.background = true;
    v.owner = -1;
    v.origin = -1;
    v.smp = smp;
    v.sampleIndex = si;
    v.instIndex = instIndex;
    v.note = msg.note;
    v.inSustainLoop = smp.susLoopType !== root.TM.LOOP_NONE;
    var period = p.clampPeriod(p.notePeriod(msg.note, smp));
    v.lastPeriod = period;
    v.lastVol = 64;
    v.lastPan = 128;
    v.inc = p.periodToHz(period, smp) / p.sampleRate;
    var amp = ((msg.volume === undefined ? 64 : msg.volume) / 64) * (smp.volume / 64) * (smp.globalVolume / 64) * 0.7;
    v.tgtL = amp * Math.SQRT1_2;
    v.tgtR = amp * Math.SQRT1_2;
    this.previewVoice = vi;
  };

  TrackerCore.prototype.previewOff = function () {
    if (this.previewVoice === undefined || this.previewVoice < 0) return;
    var v = this.player.voices[this.previewVoice];
    // `cut` latches the silence; without it updateVoices() would restore the
    // preview voice's amplitude from lastVol on the next tick.
    if (v) { v.tgtL = 0; v.tgtR = 0; v.fading = true; v.cut = true; }
    this.previewVoice = -1;
  };

  TrackerCore.prototype.process = function (outL, outR, frames) {
    this.player.render(outL, outR, frames);
    this.sinceState += frames;
    if (this.sinceState >= STATE_INTERVAL) {
      this.sinceState = 0;
      var st = this.player.getState();
      st.type = 'state';
      this.post(st);
    }
    return true;
  };

  root.TrackerCore = TrackerCore;

  /* ---- AudioWorklet entry point (skipped on the main thread) -------- */
  /* AudioWorkletProcessor may only be constructed with `new`, so this has
   * to be a real class - the usual ES5 Object.create() inheritance throws
   * "Please use the 'new' operator" the moment the node is instantiated. */
  if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
    class Proc extends AudioWorkletProcessor {
      constructor() {
        super();
        var self = this;
        this.core = new TrackerCore(sampleRate, function (m) {
          self.port.postMessage(m);
        });
        this.port.onmessage = function (e) {
          self.core.handle(e.data);
        };
        this.port.postMessage({ type: 'ready', sampleRate: sampleRate });
      }
      process(inputs, outputs) {
        var out = outputs[0];
        if (!out || !out.length) return true;
        var l = out[0];
        var r = out.length > 1 ? out[1] : out[0];
        this.core.process(l, r, l.length);
        if (out.length > 1 && r !== out[1]) out[1].set(r);
        return true;
      }
    }
    registerProcessor('tracker-processor', Proc);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
