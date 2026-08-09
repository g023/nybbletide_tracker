/* =====================================================================
 * visualizer.js -- AnalyserNode-driven oscilloscope and spectrum.
 *
 * Both read the *same* AnalyserNode: getByteTimeDomainData for the scope
 * and getByteFrequencyData for the spectrum.  The FFT bins are laid out
 * linearly in frequency but music is logarithmic, so the spectrum maps
 * bins onto a log axis and takes the peak of each band - otherwise the
 * left tenth of the display holds everything you can actually hear.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;

  function Visualizer(analyser, scopeCanvas, spectrumCanvas) {
    this.analyser = analyser;
    this.scope = scopeCanvas;
    this.spectrum = spectrumCanvas;
    this.timeData = new Uint8Array(analyser.fftSize);
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
    this.peaks = new Float32Array(96);
    this.colors = {};
    this.readColors();
  }

  Visualizer.prototype.readColors = function () {
    var cs = getComputedStyle(document.documentElement);
    var g = function (n) { return cs.getPropertyValue(n).trim(); };
    this.colors = {
      bg: g('--bg-sunken'),
      grid: g('--border'),
      line: g('--scope'),
      line2: g('--scope2'),
      dim: g('--fg-faint')
    };
  };

  function prep(canvas) {
    var dpr = root.devicePixelRatio || 1;
    var w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  Visualizer.prototype.drawScope = function () {
    var p = prep(this.scope);
    if (!p) return;
    var ctx = p.ctx,
      w = p.w,
      h = p.h;
    var C = this.colors;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    this.analyser.getByteTimeDomainData(this.timeData);
    var d = this.timeData;
    var n = d.length;

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2 + 0.5);
    ctx.lineTo(w, h / 2 + 0.5);
    ctx.stroke();

    // Trigger on a rising zero crossing so the waveform stops sliding.
    var start = 0;
    for (var i = 1; i < n / 2; i++) {
      if (d[i - 1] < 128 && d[i] >= 128) { start = i; break; }
    }
    var span = Math.min(n - start, Math.floor(n / 2));

    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (i = 0; i < span; i++) {
      var v = (d[start + i] - 128) / 128;
      var x = (i / (span - 1)) * w;
      var y = h / 2 - v * (h / 2 - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  Visualizer.prototype.drawSpectrum = function (sampleRate) {
    var p = prep(this.spectrum);
    if (!p) return;
    var ctx = p.ctx,
      w = p.w,
      h = p.h;
    var C = this.colors;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    this.analyser.getByteFrequencyData(this.freqData);
    var d = this.freqData;
    var bins = d.length;
    var nyquist = (sampleRate || 44100) / 2;

    var bands = Math.max(24, Math.min(96, Math.floor(w / 6)));
    var fMin = 40,
      fMax = Math.min(18000, nyquist);
    var logMin = Math.log(fMin),
      logMax = Math.log(fMax);
    var barW = w / bands;

    for (var b = 0; b < bands; b++) {
      var f0 = Math.exp(logMin + ((logMax - logMin) * b) / bands);
      var f1 = Math.exp(logMin + ((logMax - logMin) * (b + 1)) / bands);
      var i0 = Math.max(0, Math.floor((f0 / nyquist) * bins));
      var i1 = Math.min(bins - 1, Math.max(i0, Math.ceil((f1 / nyquist) * bins) - 1));
      var peak = 0;
      for (var i = i0; i <= i1; i++) if (d[i] > peak) peak = d[i];
      var v = peak / 255;

      if (v > this.peaks[b]) this.peaks[b] = v;
      else this.peaks[b] = Math.max(v, this.peaks[b] - 0.02);

      var bh = v * (h - 4);
      var x = b * barW;
      var grad = ctx.createLinearGradient(0, h, 0, h - bh);
      grad.addColorStop(0, C.line2);
      grad.addColorStop(1, C.line);
      ctx.fillStyle = grad;
      ctx.fillRect(x + 0.5, h - bh, Math.max(1, barW - 1.5), bh);

      var py = h - this.peaks[b] * (h - 4);
      ctx.fillStyle = C.dim;
      ctx.fillRect(x + 0.5, py, Math.max(1, barW - 1.5), 1.5);
    }
  };

  Visualizer.prototype.draw = function (sampleRate) {
    this.drawScope();
    this.drawSpectrum(sampleRate);
  };

  root.Visualizer = Visualizer;
  TM.Visualizer = Visualizer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
