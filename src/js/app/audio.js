/* =====================================================================
 * audio.js -- the bridge between the DOM and the audio thread.
 *
 * Responsibilities:
 *   1. Build the AudioWorklet from the inlined worklet source (no network,
 *      so the single-file requirement survives).
 *   2. Fall back to a ScriptProcessorNode running the *same* TrackerCore
 *      on the main thread when AudioWorklet is unavailable (older Safari,
 *      file:// on some browsers, insecure origins).
 *   3. Own the AnalyserNode the visualisers read from.
 *   4. Marshal commands to, and playback state from, the engine.
 *
 * Everything below is message passing; no audio ever crosses this file.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;

  function AudioEngine() {
    this.ctx = null;
    this.node = null;
    this.analyser = null;
    this.gain = null;
    this.mode = 'none';
    this.ready = false;
    this.onState = null;
    this.onLoaded = null;
    this.state = null;
    this.pendingSong = null;
    this.core = null; // only used by the fallback path
  }

  /** The worklet source is stored in the page as inert text. */
  AudioEngine.prototype.workletSource = function () {
    var el = document.getElementById('worklet-src');
    return el ? el.textContent : '';
  };

  AudioEngine.prototype.init = function () {
    var self = this;
    if (this.ctx) return Promise.resolve(this);
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('This browser has no Web Audio support.'));
    this.ctx = new AC({ latencyHint: 'interactive' });

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.72;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.8;
    this.analyser.connect(this.gain);
    this.gain.connect(this.ctx.destination);

    var src = this.workletSource();
    var canWorklet = !!(this.ctx.audioWorklet && root.Blob && root.URL && root.URL.createObjectURL && src);

    if (!canWorklet) return this.initFallback().then(function () { return self; });

    var url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    return this.ctx.audioWorklet
      .addModule(url)
      .then(function () {
        URL.revokeObjectURL(url);
        self.node = new AudioWorkletNode(self.ctx, 'tracker-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });
        self.node.port.onmessage = function (e) {
          self.handleMessage(e.data);
        };
        self.node.connect(self.analyser);
        self.mode = 'worklet';
        self.ready = true;
        if (self.pendingSong) {
          self.loadSong(self.pendingSong);
          self.pendingSong = null;
        }
        return self;
      })
      .catch(function () {
        return self.initFallback().then(function () { return self; });
      });
  };

  /* ScriptProcessorNode fallback: deprecated but universally available,
   * and it keeps the app usable rather than silent. */
  AudioEngine.prototype.initFallback = function () {
    var self = this;
    if (!this.ctx.createScriptProcessor) return Promise.reject(new Error('No audio output available.'));
    var node = this.ctx.createScriptProcessor(4096, 0, 2);
    this.core = new root.TrackerCore(this.ctx.sampleRate, function (m) {
      self.handleMessage(m);
    });
    node.onaudioprocess = function (e) {
      var out = e.outputBuffer;
      self.core.process(out.getChannelData(0), out.getChannelData(1), out.length);
    };
    node.connect(this.analyser);
    this.node = node;
    this.mode = 'scriptprocessor';
    this.ready = true;
    if (this.pendingSong) {
      this.loadSong(this.pendingSong);
      this.pendingSong = null;
    }
    return Promise.resolve(this);
  };

  AudioEngine.prototype.handleMessage = function (msg) {
    if (!msg) return;
    if (msg.type === 'state') {
      this.state = msg;
      if (this.onState) this.onState(msg);
    } else if (msg.type === 'loaded') {
      if (this.onLoaded) this.onLoaded(msg);
    }
  };

  AudioEngine.prototype.send = function (msg) {
    if (!this.ready) return;
    if (this.mode === 'worklet') this.node.port.postMessage(msg);
    else if (this.core) this.core.handle(msg);
  };

  AudioEngine.prototype.loadSong = function (song) {
    if (!this.ready) {
      this.pendingSong = song;
      return;
    }
    // The worklet gets a structured clone; the fallback shares the object,
    // which is fine because it runs on this very thread.
    this.send({ type: 'load', song: this.mode === 'worklet' ? song : song });
  };

  AudioEngine.prototype.resume = function () {
    if (this.ctx && this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  };

  AudioEngine.prototype.setMasterVolume = function (v) {
    if (this.gain) this.gain.gain.value = v;
  };

  AudioEngine.prototype.play = function () {
    var self = this;
    this.resume().then(function () { self.send({ type: 'play' }); });
  };
  AudioEngine.prototype.pause = function () { this.send({ type: 'pause' }); };
  AudioEngine.prototype.stop = function () { this.send({ type: 'stop' }); };
  AudioEngine.prototype.setPosition = function (order, row) { this.send({ type: 'setPosition', order: order, row: row }); };
  AudioEngine.prototype.setMutes = function (values) { this.send({ type: 'muteAll', values: values }); };
  AudioEngine.prototype.setSolos = function (values) { this.send({ type: 'solo', values: values }); };
  AudioEngine.prototype.setLoop = function (v) { this.send({ type: 'loop', value: v }); };
  AudioEngine.prototype.setInterpolation = function (v) { this.send({ type: 'interpolation', value: v }); };
  AudioEngine.prototype.setStereoSeparation = function (v) { this.send({ type: 'stereoSeparation', value: v }); };
  AudioEngine.prototype.pushPattern = function (index, pat) {
    // Copy: the worklet takes ownership of a structured clone anyway, and
    // the fallback must not alias the editor's live buffer.
    this.send({ type: 'patternData', index: index, rows: pat.rows, data: new Uint8Array(pat.data) });
  };
  AudioEngine.prototype.pushOrders = function (orders) { this.send({ type: 'orders', orders: orders.slice() }); };
  AudioEngine.prototype.noteOn = function (note, instrument, volume) {
    var self = this;
    this.resume().then(function () {
      self.send({ type: 'noteOn', note: note, instrument: instrument, volume: volume });
    });
  };
  AudioEngine.prototype.noteOff = function () { this.send({ type: 'noteOff' }); };

  root.AudioEngine = AudioEngine;
  TM.AudioEngine = AudioEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
