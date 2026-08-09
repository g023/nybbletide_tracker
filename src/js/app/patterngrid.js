/* =====================================================================
 * patterngrid.js -- the canvas pattern editor.
 *
 * WHY CANVAS
 * ----------
 * A pattern is up to 256 rows x 64 channels x 4 fields = 65k cells. As DOM
 * that is tens of thousands of nodes to build, style and repaint sixty
 * times a second while the song plays; canvas draws only the ~40 visible
 * rows and costs nothing when idle. It also lets the play-row highlight
 * and the edit cursor share one paint pass, so they can never disagree.
 *
 * The grid owns the *view* (scroll, cursor, colours) and mutates pattern
 * bytes in place; it never talks to the audio engine directly - the app
 * wires onEdit() to the engine so there is exactly one path for changes.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;
  var VC = TM.VC;

  /* Sub-column identifiers within one channel. */
  var COL_NOTE = 0,
    COL_INST_HI = 1,
    COL_INST_LO = 2,
    COL_VOL_HI = 3,
    COL_VOL_LO = 4,
    COL_FX = 5,
    COL_FXP_HI = 6,
    COL_FXP_LO = 7,
    COL_COUNT = 8;

  /* FastTracker / Impulse Tracker style piano layout: two rows of keys,
   * lower octave on ZXCV..., upper on QWERTY... */
  var KEYMAP = {
    KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6, KeyB: 7,
    KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13, Period: 14,
    Semicolon: 15, Slash: 16,
    KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
    KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25,
    KeyO: 26, Digit0: 27, KeyP: 28, BracketLeft: 29, Equal: 30, BracketRight: 31
  };

  function hex(v, n) {
    var s = v.toString(16).toUpperCase();
    while (s.length < n) s = '0' + s;
    return s;
  }

  function PatternGrid(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.song = null;
    this.patternIndex = 0;
    this.row = 0;
    this.channel = 0;
    this.column = COL_NOTE;
    this.scrollRow = 0;
    this.scrollChan = 0;
    this.playRow = -1;
    this.playing = false;
    this.follow = true;
    this.editMode = true;
    this.octave = 4; // base octave for the keyboard; C-5 is note 61
    this.step = 1;
    this.focused = false;
    this.rowHeight = 15;
    this.charWidth = 8;
    this.selection = null;
    this.dirty = true;
    this.colors = {};
    this.bindEvents();
  }

  PatternGrid.prototype.setSong = function (song) {
    this.song = song;
    this.patternIndex = song ? (song.orders.find ? 0 : 0) : 0;
    this.row = 0;
    this.channel = 0;
    this.column = COL_NOTE;
    this.scrollRow = 0;
    this.scrollChan = 0;
    this.dirty = true;
  };

  PatternGrid.prototype.pattern = function () {
    if (!this.song) return null;
    return this.song.patterns[this.patternIndex] || null;
  };

  /* ---------------------------------------------------------- colours */
  PatternGrid.prototype.readColors = function () {
    var cs = getComputedStyle(document.documentElement);
    var g = function (n) { return cs.getPropertyValue(n).trim(); };
    this.colors = {
      bg: g('--bg-sunken'),
      row: g('--bg-row'),
      rowAlt: g('--bg-row-alt'),
      beat: g('--bg-beat'),
      measure: g('--bg-measure'),
      fg: g('--fg'),
      dim: g('--fg-dim'),
      faint: g('--fg-faint'),
      border: g('--border'),
      note: g('--note'),
      inst: g('--inst'),
      vol: g('--vol'),
      fx: g('--fx'),
      cursor: g('--cursor'),
      cursorBg: g('--cursor-bg'),
      playrow: g('--playrow'),
      accent: g('--accent'),
      accentFg: g('--accent-fg')
    };
    this.dirty = true;
  };

  /* ----------------------------------------------------------- layout */
  PatternGrid.prototype.metrics = function (ctx) {
    ctx.font = this.fontSize + 'px ' + getComputedStyle(document.documentElement).getPropertyValue('--mono');
    this.charWidth = ctx.measureText('0').width;
    this.rowNumWidth = this.charWidth * 4;
    // "C-5 01 40 A0F " -> 3 +1+ 2 +1+ 2 +1+ 3 +1 = 14 chars
    this.chanWidth = this.charWidth * 14;
  };

  PatternGrid.prototype.visibleRows = function () {
    return Math.max(1, Math.floor((this.canvas.clientHeight - this.headerHeight) / this.rowHeight));
  };
  PatternGrid.prototype.visibleChannels = function () {
    return Math.max(1, Math.floor((this.canvas.clientWidth - this.rowNumWidth) / this.chanWidth));
  };

  /* ------------------------------------------------------------ paint */
  PatternGrid.prototype.render = function () {
    var canvas = this.canvas;
    var dpr = root.devicePixelRatio || 1;
    var w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      this.dirty = true;
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.colors.bg) this.readColors();

    this.fontSize = 12;
    this.rowHeight = 15;
    this.headerHeight = 18;
    this.metrics(ctx);

    var C = this.colors;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    var pat = this.pattern();
    if (!pat) return;

    var visRows = this.visibleRows();
    var visChans = this.visibleChannels();

    // keep the cursor (or the play row when following) on screen
    var focusRow = this.playing && this.follow ? this.playRow : this.row;
    if (focusRow >= 0) {
      var want = focusRow - Math.floor(visRows / 2);
      if (this.playing && this.follow) this.scrollRow = want;
      else if (focusRow < this.scrollRow) this.scrollRow = focusRow;
      else if (focusRow >= this.scrollRow + visRows) this.scrollRow = focusRow - visRows + 1;
    }
    this.scrollRow = Math.max(0, Math.min(this.scrollRow, Math.max(0, pat.rows - visRows)));
    if (this.channel < this.scrollChan) this.scrollChan = this.channel;
    if (this.channel >= this.scrollChan + visChans) this.scrollChan = this.channel - visChans + 1;
    this.scrollChan = Math.max(0, Math.min(this.scrollChan, Math.max(0, pat.channels - visChans)));

    var x0 = this.rowNumWidth;
    var data = pat.data;

    // ---- channel header ------------------------------------------
    ctx.fillStyle = C.rowAlt;
    ctx.fillRect(0, 0, w, this.headerHeight);
    ctx.textBaseline = 'middle';
    ctx.font = '600 10px ' + getComputedStyle(document.documentElement).getPropertyValue('--ui');
    for (var c = 0; c < visChans && this.scrollChan + c < pat.channels; c++) {
      var ci = this.scrollChan + c;
      var cx = x0 + c * this.chanWidth;
      var muted = this.opts.isMuted && this.opts.isMuted(ci);
      ctx.fillStyle = ci === this.channel ? C.accent : muted ? C.faint : C.dim;
      ctx.fillText('CH ' + (ci + 1) + (muted ? ' (m)' : ''), cx + 4, this.headerHeight / 2);
      ctx.fillStyle = C.border;
      ctx.fillRect(cx - 1, 0, 1, h);
    }
    ctx.fillStyle = C.border;
    ctx.fillRect(0, this.headerHeight - 1, w, 1);

    // ---- rows ------------------------------------------------------
    ctx.font = this.fontSize + 'px ' + getComputedStyle(document.documentElement).getPropertyValue('--mono');
    var highlight = this.song.rowsPerBeat || 4;
    var measure = this.song.rowsPerMeasure || 16;

    for (var r = 0; r < visRows; r++) {
      var ri = this.scrollRow + r;
      if (ri >= pat.rows) break;
      var y = this.headerHeight + r * this.rowHeight;

      ctx.fillStyle =
        ri % measure === 0 ? C.measure : ri % highlight === 0 ? C.beat : ri % 2 ? C.rowAlt : C.row;
      ctx.fillRect(0, y, w, this.rowHeight);

      if (ri === this.playRow && this.playing) {
        ctx.fillStyle = C.playrow;
        ctx.fillRect(0, y, w, this.rowHeight);
      }

      ctx.fillStyle = ri === this.row ? C.fg : C.faint;
      ctx.fillText(hex(ri, 2), 4, y + this.rowHeight / 2);

      for (c = 0; c < visChans && this.scrollChan + c < pat.channels; c++) {
        ci = this.scrollChan + c;
        cx = x0 + c * this.chanWidth + 3;
        var o = TM.cellOffset(pat, ri, ci);
        var dimmed = this.opts.isMuted && this.opts.isMuted(ci) ? 0.45 : 1;
        ctx.globalAlpha = dimmed;

        // note
        var note = data[o + TM.C_NOTE];
        ctx.fillStyle = note ? C.note : C.faint;
        ctx.fillText(TM.noteName(note), cx, y + this.rowHeight / 2);

        // instrument
        var ins = data[o + TM.C_INST];
        ctx.fillStyle = ins ? C.inst : C.faint;
        ctx.fillText(ins ? hex(ins, 2) : '..', cx + this.charWidth * 4, y + this.rowHeight / 2);

        // volume column
        var vcmd = data[o + TM.C_VOLCMD],
          vpar = data[o + TM.C_VOLPARAM];
        ctx.fillStyle = vcmd ? C.vol : C.faint;
        ctx.fillText(volText(vcmd, vpar), cx + this.charWidth * 7, y + this.rowHeight / 2);

        // effect
        var fx = data[o + TM.C_EFX],
          fxp = data[o + TM.C_EFXPARAM];
        ctx.fillStyle = fx ? C.fx : C.faint;
        ctx.fillText(
          fx ? (TM.EFX_LETTER[fx] || '?') + hex(TM.efxDisplayParam(fx, fxp), 2) : '...',
          cx + this.charWidth * 10,
          y + this.rowHeight / 2
        );
        ctx.globalAlpha = 1;
      }
    }

    // ---- cursor ----------------------------------------------------
    if (this.row >= this.scrollRow && this.row < this.scrollRow + visRows &&
        this.channel >= this.scrollChan && this.channel < this.scrollChan + visChans) {
      var cy = this.headerHeight + (this.row - this.scrollRow) * this.rowHeight;
      var ccx = x0 + (this.channel - this.scrollChan) * this.chanWidth;
      ctx.fillStyle = C.cursorBg;
      ctx.fillRect(ccx, cy, this.chanWidth, this.rowHeight);
      var span = this.columnSpan(this.column);
      ctx.strokeStyle = this.focused ? C.cursor : C.faint;
      ctx.lineWidth = this.focused && this.editMode ? 2 : 1;
      ctx.strokeRect(
        ccx + 2 + span[0] * this.charWidth,
        cy + 0.5,
        span[1] * this.charWidth + 2,
        this.rowHeight - 1
      );
    }
  };

  function volText(cmd, par) {
    switch (cmd) {
      case 0: return '..';
      case VC.VOLUME: return hex(Math.min(64, par), 2);
      case VC.PAN: return 'p' + hex(Math.min(15, par >> 2), 1);
      case VC.VOLSLIDE_UP: return 'u' + hex(par & 15, 1);
      case VC.VOLSLIDE_DOWN: return 'd' + hex(par & 15, 1);
      case VC.FINE_VOLSLIDE_UP: return 'U' + hex(par & 15, 1);
      case VC.FINE_VOLSLIDE_DOWN: return 'D' + hex(par & 15, 1);
      case VC.VIBRATO_SPEED: return 's' + hex(par & 15, 1);
      case VC.VIBRATO_DEPTH: return 'v' + hex(par & 15, 1);
      case VC.PAN_SLIDE_LEFT: return 'l' + hex(par & 15, 1);
      case VC.PAN_SLIDE_RIGHT: return 'r' + hex(par & 15, 1);
      case VC.PORTA_UP: return 'f' + hex(par & 15, 1);
      case VC.PORTA_DOWN: return 'e' + hex(par & 15, 1);
      case VC.TONE_PORTA: return 'g' + hex(par & 15, 1);
      default: return '..';
    }
  }
  PatternGrid.volText = volText;

  /* character offset and width of each sub-column inside a channel */
  PatternGrid.prototype.columnSpan = function (col) {
    switch (col) {
      case COL_NOTE: return [0, 3];
      case COL_INST_HI: return [4, 1];
      case COL_INST_LO: return [5, 1];
      case COL_VOL_HI: return [7, 1];
      case COL_VOL_LO: return [8, 1];
      case COL_FX: return [10, 1];
      case COL_FXP_HI: return [11, 1];
      case COL_FXP_LO: return [12, 1];
    }
    return [0, 3];
  };

  /* ------------------------------------------------------------ input */
  PatternGrid.prototype.bindEvents = function () {
    var self = this;
    var cv = this.canvas;
    cv.tabIndex = 0;

    cv.addEventListener('mousedown', function (e) {
      cv.focus();
      var rect = cv.getBoundingClientRect();
      var x = e.clientX - rect.left,
        y = e.clientY - rect.top;
      if (y < self.headerHeight) {
        var c = Math.floor((x - self.rowNumWidth) / self.chanWidth) + self.scrollChan;
        if (c >= 0 && self.opts.onHeaderClick) self.opts.onHeaderClick(c, e);
        return;
      }
      var row = self.scrollRow + Math.floor((y - self.headerHeight) / self.rowHeight);
      var pat = self.pattern();
      if (!pat) return;
      row = Math.max(0, Math.min(pat.rows - 1, row));
      if (x < self.rowNumWidth) {
        self.row = row;
        if (self.opts.onSeekRow) self.opts.onSeekRow(row);
        self.dirty = true;
        return;
      }
      var chan = self.scrollChan + Math.floor((x - self.rowNumWidth) / self.chanWidth);
      chan = Math.max(0, Math.min(pat.channels - 1, chan));
      var within = (x - self.rowNumWidth - (chan - self.scrollChan) * self.chanWidth - 3) / self.charWidth;
      var col = COL_NOTE;
      if (within >= 10.5) col = COL_FXP_HI;
      if (within >= 11.5) col = COL_FXP_LO;
      if (within >= 9.5 && within < 10.5) col = COL_FX;
      else if (within >= 6.5 && within < 9.5) col = within < 7.8 ? COL_VOL_HI : COL_VOL_LO;
      else if (within >= 3.5 && within < 6.5) col = within < 4.8 ? COL_INST_HI : COL_INST_LO;
      else if (within < 3.5) col = COL_NOTE;
      self.row = row;
      self.channel = chan;
      self.column = col;
      self.dirty = true;
      if (self.opts.onCursor) self.opts.onCursor(self);
    });

    cv.addEventListener('focus', function () { self.focused = true; self.dirty = true; });
    cv.addEventListener('blur', function () { self.focused = false; self.dirty = true; });

    cv.addEventListener('wheel', function (e) {
      var pat = self.pattern();
      if (!pat) return;
      e.preventDefault();
      if (e.shiftKey) self.scrollChan += e.deltaY > 0 ? 1 : -1;
      else {
        var d = Math.sign(e.deltaY) * 3;
        if (self.playing && self.follow) {
          self.follow = false;
          if (self.opts.onFollowChange) self.opts.onFollowChange(false);
        }
        self.scrollRow += d;
      }
      self.dirty = true;
    }, { passive: false });

    cv.addEventListener('keydown', function (e) { self.onKey(e); });
  };

  PatternGrid.prototype.moveRow = function (d) {
    var pat = this.pattern();
    if (!pat) return;
    this.row += d;
    while (this.row < 0) this.row += pat.rows;
    this.row %= pat.rows;
    this.dirty = true;
  };

  PatternGrid.prototype.moveColumn = function (d) {
    var pat = this.pattern();
    if (!pat) return;
    var abs = this.channel * COL_COUNT + this.column + d;
    var max = pat.channels * COL_COUNT;
    while (abs < 0) abs += max;
    abs %= max;
    this.channel = Math.floor(abs / COL_COUNT);
    this.column = abs % COL_COUNT;
    this.dirty = true;
  };

  PatternGrid.prototype.cellOffset = function () {
    var pat = this.pattern();
    if (!pat) return -1;
    return TM.cellOffset(pat, this.row, this.channel);
  };

  PatternGrid.prototype.edit = function (fn) {
    var pat = this.pattern();
    if (!pat || !this.editMode) return false;
    if (this.opts.beforeEdit) this.opts.beforeEdit(this.patternIndex);
    fn(pat.data, this.cellOffset(), pat);
    this.dirty = true;
    if (this.opts.onEdit) this.opts.onEdit(this.patternIndex);
    return true;
  };

  PatternGrid.prototype.onKey = function (e) {
    var pat = this.pattern();
    if (!pat) return;
    var key = e.key;
    var code = e.code;
    var handled = true;
    var self = this;
    var visRows = this.visibleRows();

    if (e.ctrlKey || e.metaKey) return; // app-level shortcuts

    switch (code) {
      case 'ArrowUp': this.moveRow(-1); break;
      case 'ArrowDown': this.moveRow(1); break;
      case 'ArrowLeft': this.moveColumn(-1); break;
      case 'ArrowRight': this.moveColumn(1); break;
      case 'PageUp': this.moveRow(-Math.max(1, visRows - 2)); break;
      case 'PageDown': this.moveRow(Math.max(1, visRows - 2)); break;
      case 'Home': this.row = 0; this.dirty = true; break;
      case 'End': this.row = pat.rows - 1; this.dirty = true; break;
      case 'Tab':
        this.channel = (this.channel + (e.shiftKey ? -1 : 1) + pat.channels) % pat.channels;
        this.column = COL_NOTE;
        this.dirty = true;
        break;
      case 'Delete':
      case 'Backspace':
        this.edit(function (d, o) {
          if (self.column === COL_NOTE) { d[o + TM.C_NOTE] = 0; d[o + TM.C_INST] = 0; }
          else if (self.column <= COL_INST_LO) d[o + TM.C_INST] = 0;
          else if (self.column <= COL_VOL_LO) { d[o + TM.C_VOLCMD] = 0; d[o + TM.C_VOLPARAM] = 0; }
          else { d[o + TM.C_EFX] = 0; d[o + TM.C_EFXPARAM] = 0; }
        });
        this.moveRow(this.step);
        break;
      case 'Insert':
        this.insertRow();
        break;
      default:
        handled = false;
    }
    if (handled) { e.preventDefault(); if (this.opts.onCursor) this.opts.onCursor(this); return; }

    // ---- data entry ------------------------------------------------
    if (this.column === COL_NOTE) {
      if (code === 'Backquote' || key === '`') {
        this.edit(function (d, o) { d[o + TM.C_NOTE] = TM.NOTE_OFF; });
        this.moveRow(this.step);
        e.preventDefault();
        return;
      }
      if (code === 'Space') {
        this.edit(function (d, o) { d[o + TM.C_NOTE] = TM.NOTE_CUT; });
        this.moveRow(this.step);
        e.preventDefault();
        return;
      }
      if (KEYMAP[code] !== undefined && !e.repeat) {
        var note = TM.clamp(KEYMAP[code] + this.octave * 12 + 1, 1, 120);
        var ins = this.opts.currentInstrument ? this.opts.currentInstrument() : 1;
        this.edit(function (d, o) {
          d[o + TM.C_NOTE] = note;
          d[o + TM.C_INST] = ins;
        });
        if (this.opts.onPreview) this.opts.onPreview(note, ins);
        this.moveRow(this.step);
        e.preventDefault();
        return;
      }
      return;
    }

    var digit = parseInt(key, 16);
    if (this.column === COL_INST_HI || this.column === COL_INST_LO) {
      if (isNaN(digit) || key.length !== 1) return;
      var col = this.column;
      this.edit(function (d, o) {
        var cur = d[o + TM.C_INST];
        var v = col === COL_INST_HI ? (digit << 4) | (cur & 0x0f) : (cur & 0xf0) | digit;
        d[o + TM.C_INST] = Math.min(99, v);
      });
      this.moveColumn(col === COL_INST_HI ? 1 : -1);
      if (col === COL_INST_LO) this.moveRow(this.step);
      e.preventDefault();
      return;
    }

    if (this.column === COL_VOL_HI || this.column === COL_VOL_LO) {
      if (isNaN(digit) || key.length !== 1) return;
      var vcol = this.column;
      this.edit(function (d, o) {
        if (d[o + TM.C_VOLCMD] !== VC.VOLUME) { d[o + TM.C_VOLCMD] = VC.VOLUME; d[o + TM.C_VOLPARAM] = 0; }
        var cur = d[o + TM.C_VOLPARAM];
        var v = vcol === COL_VOL_HI ? digit * 16 + (cur % 16) : Math.floor(cur / 16) * 16 + digit;
        d[o + TM.C_VOLPARAM] = Math.min(64, v);
      });
      this.moveColumn(vcol === COL_VOL_HI ? 1 : -1);
      if (vcol === COL_VOL_LO) this.moveRow(this.step);
      e.preventDefault();
      return;
    }

    if (this.column === COL_FX) {
      if (key.length !== 1) return;
      // A few canonical effects (the MOD/XM-only ones) carry lower-case
      // letters, so try the key as typed before folding it to upper case.
      this.edit(function (d, o) {
        var shown = TM.efxDisplayParam(d[o + TM.C_EFX], d[o + TM.C_EFXPARAM]);
        var res = key === '.' ? [0, 0] : TM.efxFromLetter(key, shown) || TM.efxFromLetter(key.toUpperCase(), shown);
        if (!res) return;
        d[o + TM.C_EFX] = res[0];
        d[o + TM.C_EFXPARAM] = res[1];
      });
      this.moveColumn(1);
      e.preventDefault();
      return;
    }

    if (this.column === COL_FXP_HI || this.column === COL_FXP_LO) {
      if (isNaN(digit) || key.length !== 1) return;
      var pcol = this.column;
      this.edit(function (d, o) {
        var fxNow = d[o + TM.C_EFX];
        var shown = TM.efxDisplayParam(fxNow, d[o + TM.C_EFXPARAM]);
        var next = pcol === COL_FXP_HI ? (digit << 4) | (shown & 0x0f) : (shown & 0xf0) | digit;
        // Editing the high nibble of an "S" effect selects a different
        // sub-command, so the stored effect code has to change with it.
        var letter = TM.EFX_LETTER[fxNow];
        if (letter === 'S') {
          var res = TM.efxFromLetter('S', next);
          d[o + TM.C_EFX] = res[0];
          d[o + TM.C_EFXPARAM] = res[1];
        } else {
          d[o + TM.C_EFXPARAM] = next;
        }
      });
      this.moveColumn(pcol === COL_FXP_HI ? 1 : -1);
      if (pcol === COL_FXP_LO) this.moveRow(this.step);
      e.preventDefault();
    }
  };

  /** Insert a blank row at the cursor, pushing the channel's rows down. */
  PatternGrid.prototype.insertRow = function () {
    var self = this;
    this.edit(function (d, o, pat) {
      var cs = TM.CELL_SIZE;
      var stride = pat.channels * cs;
      for (var r = pat.rows - 1; r > self.row; r--) {
        var dst = r * stride + self.channel * cs;
        var src = (r - 1) * stride + self.channel * cs;
        for (var k = 0; k < cs; k++) d[dst + k] = d[src + k];
      }
      var here = self.row * stride + self.channel * cs;
      for (k = 0; k < cs; k++) d[here + k] = 0;
    });
  };

  PatternGrid.prototype.deleteRow = function () {
    var self = this;
    this.edit(function (d, o, pat) {
      var cs = TM.CELL_SIZE;
      var stride = pat.channels * cs;
      for (var r = self.row; r < pat.rows - 1; r++) {
        var dst = r * stride + self.channel * cs;
        var src = (r + 1) * stride + self.channel * cs;
        for (var k = 0; k < cs; k++) d[dst + k] = d[src + k];
      }
      var last = (pat.rows - 1) * stride + self.channel * cs;
      for (k = 0; k < cs; k++) d[last + k] = 0;
    });
  };

  PatternGrid.COL_COUNT = COL_COUNT;
  PatternGrid.KEYMAP = KEYMAP;
  root.PatternGrid = PatternGrid;
  TM.PatternGrid = PatternGrid;
})(typeof globalThis !== 'undefined' ? globalThis : this);
