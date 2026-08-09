/* =====================================================================
 * common.js  --  Shared vocabulary between the parsers (main thread) and
 *                the replay engine (audio thread).
 *
 * ARCHITECTURE NOTE
 * -----------------
 * The single hardest design decision in a multi-format tracker is where to
 * put the format differences.  Writing one replayer per format (MOD, S3M,
 * XM, IT) means four state machines that drift apart and four sets of bugs.
 * Instead this project transcodes *at parse time* into one canonical model:
 *
 *   - Notes are normalised so that note 61 == C-5 == 8363 Hz for every
 *     format (this is the OpenMPT convention).  A MOD's period-table index,
 *     an S3M's octave/semitone nibble pair, an XM's 1..96 note and an IT's
 *     0..119 note all land on the same scale.
 *   - Effects are transcoded into the EFX enum below, which is essentially
 *     the Impulse Tracker command set (the richest of the four) plus a few
 *     codes for things only MOD/XM can express.
 *   - Anything that cannot be transcoded (linear vs. Amiga pitch, ST3's
 *     odd volume-slide-on-tick-0 rule, IT's Gxx memory) is recorded as a
 *     boolean in song.flags and consulted by the one engine.
 *
 * This file is deliberately dependency-free and written as a plain script
 * (no ES modules) because its text is injected verbatim into both the main
 * bundle and the AudioWorklet source blob by tools/build.js.
 * ===================================================================== */
(function (root) {
  'use strict';

  var TM = root.TM || (root.TM = {});

  /* ---------------------------------------------------------------- *
   * Note values.  0 = empty cell.  1..120 = C-0 .. B-9.
   * 61 = C-5 = the pitch at which a sample plays back at its C5 speed.
   * ---------------------------------------------------------------- */
  TM.NOTE_NONE = 0;
  TM.NOTE_MIN = 1;
  TM.NOTE_MAX = 120;
  TM.NOTE_FADE = 253; // IT: trigger the volume fadeout ("~~~")
  TM.NOTE_CUT = 254; // "^^^" - stop the voice immediately
  TM.NOTE_OFF = 255; // "===" - key off (release envelopes)

  TM.NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

  /** Render a note byte as the classic three character tracker string. */
  TM.noteName = function (n) {
    if (!n) return '...';
    if (n === TM.NOTE_CUT) return '^^^';
    if (n === TM.NOTE_OFF) return '===';
    if (n === TM.NOTE_FADE) return '~~~';
    if (n < TM.NOTE_MIN || n > TM.NOTE_MAX) return '...';
    var i = n - 1;
    return TM.NOTE_NAMES[i % 12] + ((i / 12) | 0);
  };

  /** Parse "C-5" / "c#4" back into a note byte (0 when unparseable). */
  TM.parseNote = function (s) {
    if (!s) return 0;
    s = String(s).trim().toUpperCase();
    if (s === '^^^' || s === '^^') return TM.NOTE_CUT;
    if (s === '===' || s === '==') return TM.NOTE_OFF;
    if (s === '~~~') return TM.NOTE_FADE;
    var m = /^([A-G])([#B-]?)(-?\d)$/.exec(s);
    if (!m) return 0;
    var base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
    if (m[2] === '#') base++;
    else if (m[2] === 'B') base--;
    var oct = parseInt(m[3], 10);
    var n = oct * 12 + base + 1;
    return n >= TM.NOTE_MIN && n <= TM.NOTE_MAX ? n : 0;
  };

  /* ---------------------------------------------------------------- *
   * Pattern cell layout.  Patterns are stored as one flat Uint8Array of
   * rows * channels * 6 bytes.  Flat typed arrays keep the structured
   * clone to the AudioWorklet cheap and make undo snapshots trivial.
   * ---------------------------------------------------------------- */
  TM.CELL_SIZE = 6;
  TM.C_NOTE = 0;
  TM.C_INST = 1; // 0 = none, 1..n = instrument/sample number
  TM.C_VOLCMD = 2; // VC enum below, 0 = none
  TM.C_VOLPARAM = 3;
  TM.C_EFX = 4; // EFX enum below, 0 = none
  TM.C_EFXPARAM = 5;

  /* Volume column commands.  Kept as (command, parameter) rather than the
   * packed single byte the file formats use, because XM and IT pack them
   * differently and unpacking once at parse time is simpler than forever. */
  var VC = (TM.VC = {
    NONE: 0,
    VOLUME: 1, // set volume 0..64
    PAN: 2, // set panning 0..64
    VOLSLIDE_UP: 3,
    VOLSLIDE_DOWN: 4,
    FINE_VOLSLIDE_UP: 5,
    FINE_VOLSLIDE_DOWN: 6,
    VIBRATO_SPEED: 7,
    VIBRATO_DEPTH: 8,
    PAN_SLIDE_LEFT: 9,
    PAN_SLIDE_RIGHT: 10,
    PORTA_UP: 11,
    PORTA_DOWN: 12,
    TONE_PORTA: 13
  });

  /* Single letter shown in the pattern grid's volume column. */
  TM.VC_LETTER = { 1: 'v', 2: 'p', 3: 'c', 4: 'd', 5: 'a', 6: 'b', 7: 'u', 8: 'h', 9: 'l', 10: 'r', 11: 'f', 12: 'e', 13: 'g' };

  /* ---------------------------------------------------------------- *
   * Canonical effect enum (an Impulse Tracker superset).
   * ---------------------------------------------------------------- */
  var EFX = (TM.EFX = {
    NONE: 0,
    SET_SPEED: 1, // Axx  ticks per row
    POSITION_JUMP: 2, // Bxx
    PATTERN_BREAK: 3, // Cxx
    VOLUME_SLIDE: 4, // Dxy (+ DxF / DFy fine forms)
    PORTA_DOWN: 5, // Exx (pitch down; EFx/EEx fine forms folded in)
    PORTA_UP: 6, // Fxx
    TONE_PORTA: 7, // Gxx
    VIBRATO: 8, // Hxy
    TREMOR: 9, // Ixy
    ARPEGGIO: 10, // Jxy
    VIBRATO_VOLSLIDE: 11, // Kxy
    TONEPORTA_VOLSLIDE: 12, // Lxy
    SET_CHANNEL_VOLUME: 13, // Mxx
    CHANNEL_VOLSLIDE: 14, // Nxy
    SAMPLE_OFFSET: 15, // Oxx
    PANNING_SLIDE: 16, // Pxy
    RETRIG: 17, // Qxy (volume-modifying retrigger)
    TREMOLO: 18, // Rxy
    SET_PANNING: 19, // Xxx 0..255
    SET_TEMPO: 20, // Txx (and T0x/T1x tempo slides)
    FINE_VIBRATO: 21, // Uxy
    GLOBAL_VOLUME: 22, // Vxx 0..128
    GLOBAL_VOLSLIDE: 23, // Wxy
    PANBRELLO: 24, // Yxy
    MIDI_MACRO: 25, // Zxx (parsed, not synthesised)
    // --- S-command family, expanded to first class effects -----------
    SET_GLISSANDO: 26, // S1x
    SET_FINETUNE: 27, // S2x / E5x
    SET_VIBRATO_WAVE: 28, // S3x / E4x
    SET_TREMOLO_WAVE: 29, // S4x / E7x
    SET_PANBRELLO_WAVE: 30, // S5x
    FINE_PATTERN_DELAY: 31, // S6x  (delay by x ticks)
    SET_NNA: 32, // S7x family (NNA / envelope switches)
    SET_PANNING_16: 33, // S8x / E8x  coarse pan 0..15
    SOUND_CONTROL: 34, // S9x (surround etc.)
    HIGH_OFFSET: 35, // SAx  high bits of sample offset
    PATTERN_LOOP: 36, // SBx / E6x
    NOTE_CUT: 37, // SCx / ECx
    NOTE_DELAY: 38, // SDx / EDx
    PATTERN_DELAY: 39, // SEx / EEx
    SET_ACTIVE_MACRO: 40, // SFx
    // --- codes that only MOD / XM need -------------------------------
    FINE_PORTA_UP: 41, // E1x / XM
    FINE_PORTA_DOWN: 42, // E2x
    EXTRA_FINE_PORTA_UP: 43, // X1x
    EXTRA_FINE_PORTA_DOWN: 44, // X2x
    FINE_VOLSLIDE_UP: 45, // EAx
    FINE_VOLSLIDE_DOWN: 46, // EBx
    SET_VOLUME: 47, // MOD Cxx / XM Cxx
    KEY_OFF: 48, // XM Kxx
    SET_ENV_POSITION: 49, // XM Lxx
    OLD_RETRIG: 50, // E9x - plain retrigger, no volume change
    INVERT_LOOP: 51, // EFx (funk repeat) - accepted, not synthesised
    PANNING_SLIDE_XM: 52 // XM Pxy has inverted nibble semantics vs IT
  });

  /* Letter shown in the editor for each effect.  Chosen to match what an
   * OpenMPT user expects to see for an IT module. */
  TM.EFX_LETTER = (function () {
    var m = {};
    m[EFX.NONE] = '.';
    m[EFX.SET_SPEED] = 'A';
    m[EFX.POSITION_JUMP] = 'B';
    m[EFX.PATTERN_BREAK] = 'C';
    m[EFX.VOLUME_SLIDE] = 'D';
    m[EFX.PORTA_DOWN] = 'E';
    m[EFX.PORTA_UP] = 'F';
    m[EFX.TONE_PORTA] = 'G';
    m[EFX.VIBRATO] = 'H';
    m[EFX.TREMOR] = 'I';
    m[EFX.ARPEGGIO] = 'J';
    m[EFX.VIBRATO_VOLSLIDE] = 'K';
    m[EFX.TONEPORTA_VOLSLIDE] = 'L';
    m[EFX.SET_CHANNEL_VOLUME] = 'M';
    m[EFX.CHANNEL_VOLSLIDE] = 'N';
    m[EFX.SAMPLE_OFFSET] = 'O';
    m[EFX.PANNING_SLIDE] = 'P';
    m[EFX.PANNING_SLIDE_XM] = 'P';
    m[EFX.RETRIG] = 'Q';
    m[EFX.TREMOLO] = 'R';
    m[EFX.SET_PANNING] = 'X';
    m[EFX.SET_TEMPO] = 'T';
    m[EFX.FINE_VIBRATO] = 'U';
    m[EFX.GLOBAL_VOLUME] = 'V';
    m[EFX.GLOBAL_VOLSLIDE] = 'W';
    m[EFX.PANBRELLO] = 'Y';
    m[EFX.MIDI_MACRO] = 'Z';
    m[EFX.SET_GLISSANDO] = 'S';
    m[EFX.SET_FINETUNE] = 'S';
    m[EFX.SET_VIBRATO_WAVE] = 'S';
    m[EFX.SET_TREMOLO_WAVE] = 'S';
    m[EFX.SET_PANBRELLO_WAVE] = 'S';
    m[EFX.FINE_PATTERN_DELAY] = 'S';
    m[EFX.SET_NNA] = 'S';
    m[EFX.SET_PANNING_16] = 'S';
    m[EFX.SOUND_CONTROL] = 'S';
    m[EFX.HIGH_OFFSET] = 'S';
    m[EFX.PATTERN_LOOP] = 'S';
    m[EFX.NOTE_CUT] = 'S';
    m[EFX.NOTE_DELAY] = 'S';
    m[EFX.PATTERN_DELAY] = 'S';
    m[EFX.SET_ACTIVE_MACRO] = 'S';
    m[EFX.FINE_PORTA_UP] = 'F';
    m[EFX.FINE_PORTA_DOWN] = 'E';
    m[EFX.EXTRA_FINE_PORTA_UP] = 'X';
    m[EFX.EXTRA_FINE_PORTA_DOWN] = 'X';
    m[EFX.FINE_VOLSLIDE_UP] = 'D';
    m[EFX.FINE_VOLSLIDE_DOWN] = 'D';
    m[EFX.SET_VOLUME] = 'v';
    m[EFX.KEY_OFF] = 'K';
    m[EFX.SET_ENV_POSITION] = 'L';
    m[EFX.OLD_RETRIG] = 'Q';
    m[EFX.INVERT_LOOP] = 'E';
    return m;
  })();

  /* The S-family effects share the letter 'S'; the editor needs to show the
   * right high nibble, so record it here. */
  TM.EFX_SUBCODE = (function () {
    var m = {};
    m[EFX.SET_GLISSANDO] = 0x1;
    m[EFX.SET_FINETUNE] = 0x2;
    m[EFX.SET_VIBRATO_WAVE] = 0x3;
    m[EFX.SET_TREMOLO_WAVE] = 0x4;
    m[EFX.SET_PANBRELLO_WAVE] = 0x5;
    m[EFX.FINE_PATTERN_DELAY] = 0x6;
    m[EFX.SET_NNA] = 0x7;
    m[EFX.SET_PANNING_16] = 0x8;
    m[EFX.SOUND_CONTROL] = 0x9;
    m[EFX.HIGH_OFFSET] = 0xa;
    m[EFX.PATTERN_LOOP] = 0xb;
    m[EFX.NOTE_CUT] = 0xc;
    m[EFX.NOTE_DELAY] = 0xd;
    m[EFX.PATTERN_DELAY] = 0xe;
    m[EFX.SET_ACTIVE_MACRO] = 0xf;
    return m;
  })();

  /** Human readable name for the effect help tooltip / status bar. */
  TM.EFX_NAME = (function () {
    var m = {};
    m[EFX.SET_SPEED] = 'Set speed (ticks/row)';
    m[EFX.POSITION_JUMP] = 'Jump to order';
    m[EFX.PATTERN_BREAK] = 'Break to row of next pattern';
    m[EFX.VOLUME_SLIDE] = 'Volume slide';
    m[EFX.PORTA_DOWN] = 'Portamento down';
    m[EFX.PORTA_UP] = 'Portamento up';
    m[EFX.TONE_PORTA] = 'Tone portamento (slide to note)';
    m[EFX.VIBRATO] = 'Vibrato';
    m[EFX.TREMOR] = 'Tremor (on/off gate)';
    m[EFX.ARPEGGIO] = 'Arpeggio';
    m[EFX.VIBRATO_VOLSLIDE] = 'Vibrato + volume slide';
    m[EFX.TONEPORTA_VOLSLIDE] = 'Tone portamento + volume slide';
    m[EFX.SET_CHANNEL_VOLUME] = 'Set channel volume';
    m[EFX.CHANNEL_VOLSLIDE] = 'Channel volume slide';
    m[EFX.SAMPLE_OFFSET] = 'Sample offset (x*256)';
    m[EFX.PANNING_SLIDE] = 'Panning slide';
    m[EFX.PANNING_SLIDE_XM] = 'Panning slide';
    m[EFX.RETRIG] = 'Retrigger with volume change';
    m[EFX.TREMOLO] = 'Tremolo';
    m[EFX.SET_PANNING] = 'Set panning';
    m[EFX.SET_TEMPO] = 'Set tempo (BPM)';
    m[EFX.FINE_VIBRATO] = 'Fine vibrato';
    m[EFX.GLOBAL_VOLUME] = 'Set global volume';
    m[EFX.GLOBAL_VOLSLIDE] = 'Global volume slide';
    m[EFX.PANBRELLO] = 'Panbrello';
    m[EFX.MIDI_MACRO] = 'MIDI macro (not synthesised)';
    m[EFX.SET_GLISSANDO] = 'Glissando control';
    m[EFX.SET_FINETUNE] = 'Set finetune';
    m[EFX.SET_VIBRATO_WAVE] = 'Set vibrato waveform';
    m[EFX.SET_TREMOLO_WAVE] = 'Set tremolo waveform';
    m[EFX.SET_PANBRELLO_WAVE] = 'Set panbrello waveform';
    m[EFX.FINE_PATTERN_DELAY] = 'Fine pattern delay (ticks)';
    m[EFX.SET_NNA] = 'New note action / envelope switch';
    m[EFX.SET_PANNING_16] = 'Set panning (coarse)';
    m[EFX.SOUND_CONTROL] = 'Sound control (surround)';
    m[EFX.HIGH_OFFSET] = 'Sample offset high bits';
    m[EFX.PATTERN_LOOP] = 'Pattern loop';
    m[EFX.NOTE_CUT] = 'Note cut after x ticks';
    m[EFX.NOTE_DELAY] = 'Note delay by x ticks';
    m[EFX.PATTERN_DELAY] = 'Pattern delay (rows)';
    m[EFX.SET_ACTIVE_MACRO] = 'Set active MIDI macro';
    m[EFX.FINE_PORTA_UP] = 'Fine portamento up';
    m[EFX.FINE_PORTA_DOWN] = 'Fine portamento down';
    m[EFX.EXTRA_FINE_PORTA_UP] = 'Extra fine portamento up';
    m[EFX.EXTRA_FINE_PORTA_DOWN] = 'Extra fine portamento down';
    m[EFX.FINE_VOLSLIDE_UP] = 'Fine volume slide up';
    m[EFX.FINE_VOLSLIDE_DOWN] = 'Fine volume slide down';
    m[EFX.SET_VOLUME] = 'Set volume';
    m[EFX.KEY_OFF] = 'Key off';
    m[EFX.SET_ENV_POSITION] = 'Set envelope position';
    m[EFX.OLD_RETRIG] = 'Retrigger note';
    m[EFX.INVERT_LOOP] = 'Invert loop (not synthesised)';
    return m;
  })();

  /* ---------------------------------------------------------------- *
   * Loop / envelope / NNA constants
   * ---------------------------------------------------------------- */
  TM.LOOP_NONE = 0;
  TM.LOOP_FORWARD = 1;
  TM.LOOP_PINGPONG = 2;

  TM.NNA_CUT = 0;
  TM.NNA_CONTINUE = 1;
  TM.NNA_OFF = 2;
  TM.NNA_FADE = 3;

  TM.DCT_NONE = 0;
  TM.DCT_NOTE = 1;
  TM.DCT_SAMPLE = 2;
  TM.DCT_INSTRUMENT = 3;

  TM.DCA_CUT = 0;
  TM.DCA_OFF = 1;
  TM.DCA_FADE = 2;

  /* ---------------------------------------------------------------- *
   * Pitch tables
   * ---------------------------------------------------------------- */

  /* ProTracker period table: 16 finetune settings x 36 notes.
   * Row 0 is finetune 0; rows 1..7 are finetunes +1..+7, rows 8..15 are
   * finetunes -8..-1 (this is the order the finetune nibble indexes).
   * Generated from the canonical ProTracker table. */
  TM.MOD_PERIODS = (function () {
    var base = [
      856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, 428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240,
      226, 214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113
    ];
    var t = new Int16Array(16 * 36);
    for (var ft = 0; ft < 16; ft++) {
      // finetune nibble 0..7 => 0..+7, 8..15 => -8..-1, in 1/8 semitone steps
      var steps = ft < 8 ? ft : ft - 16;
      for (var n = 0; n < 36; n++) {
        // period is inversely proportional to frequency; one finetune unit
        // is 1/8 of a semitone.
        t[ft * 36 + n] = Math.round(base[n] * Math.pow(2, -steps / 96));
      }
    }
    return t;
  })();

  /* FastTracker II Amiga period table: periods for 12 semitones in 16ths of
   * a semitone (the classic 12*8+1 = 97 entry table, doubled resolution by
   * interpolation at runtime). */
  TM.XM_AMIGA_PERIODS = new Int16Array([
    907, 900, 894, 887, 881, 875, 868, 862, 856, 850, 844, 838, 832, 826, 820, 814, 808, 802, 796, 791, 785, 779, 774,
    768, 762, 757, 752, 746, 741, 736, 730, 725, 720, 715, 709, 704, 699, 694, 689, 684, 678, 675, 670, 665, 660, 655,
    651, 646, 640, 636, 632, 628, 623, 619, 614, 610, 604, 601, 597, 592, 588, 584, 580, 575, 570, 567, 563, 559, 555,
    551, 547, 543, 538, 535, 532, 528, 524, 520, 516, 513, 508, 505, 502, 498, 494, 491, 487, 484, 480, 477, 474, 470,
    467, 463, 460, 457, 453
  ]);

  /* Scream Tracker 3 / Impulse Tracker note period table (C..B, octave 0).
   * period = 8363 * 16 * table[n] / (c5speed * 2^octave). */
  TM.ST3_PERIODS = new Int16Array([1712, 1616, 1524, 1440, 1356, 1280, 1208, 1140, 1076, 1016, 960, 907]);

  /* Amiga clock constants: freq = K / period. */
  TM.AMIGA_K_MOD = 3546894.6; // PAL Paula clock / 2
  TM.AMIGA_K_ST3 = 14317456.0; // 8363 * 1712

  /* ---------------------------------------------------------------- *
   * Oscillator tables for vibrato / tremolo / panbrello.
   * Index 0..63, amplitude -64..+64.
   * ---------------------------------------------------------------- */
  TM.WAVE_SINE = (function () {
    var t = new Int8Array(64);
    for (var i = 0; i < 64; i++) t[i] = Math.round(64 * Math.sin((i * 2 * Math.PI) / 64));
    return t;
  })();
  TM.WAVE_RAMPDOWN = (function () {
    var t = new Int8Array(64);
    for (var i = 0; i < 64; i++) t[i] = 64 - i * 2; // +64 .. -62
    return t;
  })();
  TM.WAVE_SQUARE = (function () {
    var t = new Int8Array(64);
    for (var i = 0; i < 64; i++) t[i] = i < 32 ? 64 : -64;
    return t;
  })();
  TM.WAVE_RANDOM = (function () {
    // Deterministic pseudo-random table so playback is reproducible.
    var t = new Int8Array(64),
      s = 0x1234;
    for (var i = 0; i < 64; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      t[i] = ((s >> 16) & 127) - 64;
    }
    return t;
  })();
  TM.WAVES = [TM.WAVE_SINE, TM.WAVE_RAMPDOWN, TM.WAVE_SQUARE, TM.WAVE_RANDOM];

  /* ---------------------------------------------------------------- *
   * Small helpers used by parsers, engine and UI alike
   * ---------------------------------------------------------------- */
  TM.clamp = function (v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  };

  TM.hex2 = function (v) {
    v = v & 0xff;
    return (v < 16 ? '0' : '') + v.toString(16).toUpperCase();
  };

  /** Empty pattern of the given geometry. */
  TM.makePattern = function (rows, channels) {
    return {
      rows: rows,
      channels: channels,
      name: '',
      data: new Uint8Array(rows * channels * TM.CELL_SIZE)
    };
  };

  /** Byte offset of a cell inside pattern.data. */
  TM.cellOffset = function (pat, row, chan) {
    return (row * pat.channels + chan) * TM.CELL_SIZE;
  };

  /** A blank sample record. */
  TM.makeSample = function () {
    return {
      name: '',
      filename: '',
      data: null, // Float32Array, mono, -1..1
      length: 0,
      loopStart: 0,
      loopEnd: 0,
      loopType: TM.LOOP_NONE,
      susLoopStart: 0,
      susLoopEnd: 0,
      susLoopType: TM.LOOP_NONE,
      volume: 64, // 0..64
      globalVolume: 64, // 0..64
      panning: -1, // -1 = use channel panning, else 0..256
      c5speed: 8363, // Hz at note C-5
      relativeNote: 0, // XM: added to the note before pitch lookup
      finetune: 0, // -128..127 (1/128 semitone units after normalisation)
      modFinetune: 0, // 0..15 raw MOD/XM finetune nibble (period table index)
      vibType: 0,
      vibSweep: 0,
      vibDepth: 0,
      vibRate: 0
    };
  };

  /** A blank envelope record. */
  TM.makeEnvelope = function () {
    return {
      enabled: false,
      points: [], // [{x: ticks, y: 0..64}]  (pitch env uses 0..64 with 32 centre)
      sustainStart: 0,
      sustainEnd: 0,
      loopStart: 0,
      loopEnd: 0,
      sustain: false,
      loop: false,
      carry: false,
      filter: false // IT pitch envelope doubling as a filter envelope
    };
  };

  /** A blank instrument record.  MOD and S3M get one auto-generated per
   *  sample so the engine never needs to special-case "no instruments". */
  TM.makeInstrument = function () {
    var inst = {
      name: '',
      filename: '',
      sampleMap: new Uint8Array(120), // note -> sample index+1 (0 = none)
      noteMap: new Uint8Array(120), // note -> transposed note (1..120)
      volEnv: TM.makeEnvelope(),
      panEnv: TM.makeEnvelope(),
      pitchEnv: TM.makeEnvelope(),
      fadeout: 0, // 0..8192 (units of 1/65536 per tick, IT scale)
      globalVolume: 128, // 0..128
      panning: -1, // -1 = none
      nna: TM.NNA_CUT,
      dct: TM.DCT_NONE,
      dca: TM.DCA_CUT,
      pitchPanSep: 0,
      pitchPanCenter: 60,
      randomVolume: 0,
      randomPan: 0,
      filterCutoff: -1,
      filterResonance: -1
    };
    for (var i = 0; i < 120; i++) inst.noteMap[i] = i + 1;
    return inst;
  };

  /** A blank song. */
  TM.makeSong = function () {
    return {
      type: 'mod',
      typeName: 'Amiga Module',
      title: '',
      tracker: '',
      message: '',
      channels: 4,
      orders: [],
      patterns: [],
      instruments: [],
      samples: [],
      initialSpeed: 6,
      initialTempo: 125,
      globalVolume: 128, // 0..128
      mixVolume: 48, // 0..128 (IT pre-amp)
      restartPos: 0,
      panning: [], // per channel 0..256
      chanVolume: [], // per channel 0..64
      chanMuted: [],
      flags: {
        linearSlides: false,
        instrumentMode: false, // true when instruments are meaningful (XM/IT)
        itOldEffects: false,
        itCompatGxx: false,
        amigaLimits: false,
        fastVolSlides: false, // ST3: volume slides run on tick 0 too
        modVolSlideQuirk: false,
        st3Portas: false, // ST3-style portamento/vibrato depth
        xmVolumeRamp: false,
        // Global-volume commands are 0..64 in S3M/XM but 0..128 in IT; the
        // engine works in IT units and scales the others by this factor.
        gvScale: 1
      }
    };
  };

  /* ------------------------------------------------------------------ *
   * Effect display <-> storage.
   *
   * The canonical enum promotes IT's Sxy sub-commands to first-class codes
   * (SET_NNA, NOTE_CUT, ...) because that is what the engine wants to
   * switch on.  Trackers show them as a single "S" column, so the editor
   * needs to fold the sub-code back into the displayed parameter byte.
   * ------------------------------------------------------------------ */
  TM.efxDisplayParam = function (fx, param) {
    var sub = TM.EFX_SUBCODE[fx];
    if (sub === undefined) return param;
    return (sub << 4) | (param & 0x0f);
  };

  /** Inverse of efxDisplayParam: letter + shown parameter -> [fx, param]. */
  TM.efxFromLetter = function (letter, displayParam) {
    if (letter === '.' || letter === '') return [0, 0];
    if (letter === 'S') {
      var sub = (displayParam >> 4) & 0x0f;
      for (var k in TM.EFX_SUBCODE) {
        if (TM.EFX_SUBCODE[k] === sub) return [parseInt(k, 10), displayParam & 0x0f];
      }
      return [EFX.SET_GLISSANDO, displayParam & 0x0f];
    }
    for (var i = 1; i <= 52; i++) {
      if (TM.EFX_LETTER[i] === letter && TM.EFX_SUBCODE[i] === undefined) return [i, displayParam];
    }
    return null;
  };

  TM.ORDER_SKIP = 254;
  TM.ORDER_END = 255;

  /* Read a fixed-length, possibly non-terminated ASCII field. */
  TM.readString = function (bytes, offset, length) {
    var s = '';
    for (var i = 0; i < length; i++) {
      var c = bytes[offset + i];
      if (c === 0) break;
      s += String.fromCharCode(c >= 32 && c < 127 ? c : c > 127 ? c : 32);
    }
    return s.replace(/\s+$/, '');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
