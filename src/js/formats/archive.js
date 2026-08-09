/* =====================================================================
 * archive.js -- read modules straight out of archives.
 *
 * Tracker music has always travelled in containers: ZIPs on BBSes and
 * ModArchive, ARJ on DOS boards, LHA on Aminet.  Asking the user to
 * unpack first is a pointless step, so this file implements the readers
 * end to end.  There is no dependency to add: the brief demands one
 * self-contained file, which rules out a library, and DecompressionStream
 * only covers deflate (and only asynchronously), so the decoders below are
 * written out in full.
 *
 * Supported:
 *   .zip  store (0) and deflate (8)
 *   .arj  stored (0), methods 1-3 (LZH) and method 4 (ARJ's own LZ77)
 *   .lha/.lzh  -lh0-/-lz4- stored, -lh4- -lh5- -lh6- -lh7-
 *   .gz   single member, and .tar / .tar.gz / .tgz
 *
 * The three decompressors are deliberately plain and allocation-light:
 * module archives are measured in hundreds of KB, so a bit-at-a-time
 * canonical Huffman decoder is far below the noise floor next to the
 * audio engine, and it is the version that is obviously correct.
 * ===================================================================== */
(function (root) {
  'use strict';
  var TM = root.TM;

  /* ------------------------------------------------------------ bytes */
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  /* Archive names are 8-bit: CP437 on DOS, Latin-1 on Amiga.  Only the
   * ASCII range matters for picking a file out of a list, so map the rest
   * straight through rather than shipping a code page table. */
  function latin1(b, from, to) {
    var s = '';
    for (var i = from; i < to; i++) {
      var c = b[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function utf8(b, from, to) {
    try {
      return new TextDecoder('utf-8').decode(b.subarray(from, to)).replace(/\0[\s\S]*$/, '');
    } catch (e) {
      return latin1(b, from, to);
    }
  }

  /* Zero-terminated string plus the offset just past the terminator. */
  function cstr(b, from, limit) {
    var i = from;
    while (i < limit && b[i] !== 0) i++;
    return { text: latin1(b, from, i), next: i + 1 };
  }

  var CRC32_TABLE = null;
  function crc32(bytes, from, to) {
    var i, j, c;
    if (!CRC32_TABLE) {
      CRC32_TABLE = new Int32Array(256);
      for (i = 0; i < 256; i++) {
        c = i;
        for (j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC32_TABLE[i] = c;
      }
    }
    c = -1;
    for (i = from; i < to; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  /* LHA verifies with CRC-16/ARC, not CRC-32. */
  function crc16(bytes, from, to) {
    var c = 0;
    for (var i = from; i < to; i++) {
      c ^= bytes[i];
      for (var j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    }
    return c & 0xffff;
  }

  function fail(msg) { throw new Error(msg); }

  /* ===================================================================
   * Bit readers.
   *
   * DEFLATE packs bits low-to-high inside each byte; the LZH and ARJ
   * streams pack them high-to-low.  Two tiny readers is less error-prone
   * than one reader with a mode flag.
   * =================================================================== */

  function BitsLSB(src, pos, end) {
    this.s = src; this.p = pos; this.e = end; this.b = 0; this.n = 0;
  }
  BitsLSB.prototype.bit = function () {
    if (this.n === 0) {
      if (this.p >= this.e) fail('Compressed data ended early.');
      this.b = this.s[this.p++];
      this.n = 8;
    }
    var v = this.b & 1;
    this.b >>= 1;
    this.n--;
    return v;
  };
  BitsLSB.prototype.bits = function (count) {
    var v = 0;
    for (var i = 0; i < count; i++) v |= this.bit() << i;
    return v;
  };
  BitsLSB.prototype.align = function () { this.n = 0; };

  /* MSB-first reader with peek/skip, mirroring the read-ahead style the
   * LZH and ARJ formats are specified in.  Reads past the end yield zero
   * bits, which is what the reference decoders rely on to flush the last
   * few symbols of a stream. */
  function BitsMSB(src, pos, end) {
    this.s = src; this.p = pos; this.e = end; this.b = 0; this.n = 0; this.over = 0;
  }
  BitsMSB.prototype.peek = function (count) {
    while (this.n < count) {
      var byteVal = 0;
      if (this.p < this.e) byteVal = this.s[this.p++];
      else this.over++;
      this.b = ((this.b << 8) | byteVal) >>> 0;
      this.n += 8;
    }
    return (this.b >>> (this.n - count)) & ((1 << count) - 1);
  };
  BitsMSB.prototype.skip = function (count) {
    this.n -= count;
    this.b = this.b & (this.n >= 32 ? 0xffffffff : (1 << this.n) - 1);
  };
  BitsMSB.prototype.bits = function (count) {
    if (count === 0) return 0;
    var v = this.peek(count);
    this.skip(count);
    return v;
  };
  /* Number of whole bytes consumed, used only for sanity checks. */
  BitsMSB.prototype.used = function () { return this.p - (this.n >> 3); };

  /* ===================================================================
   * Canonical Huffman decoding, shared by DEFLATE and LZH.
   *
   * Both formats assign codes by (length, symbol) order, so one builder
   * and one bit-at-a-time walker serve both.  Decoding a symbol per bit
   * costs a few million operations on a big archive - irrelevant next to
   * the parse and mix that follow.
   * =================================================================== */
  function Huffman(lengths, count, maxBits) {
    var i;
    this.counts = new Int32Array(maxBits + 1);
    this.symbols = new Int32Array(count);
    for (i = 0; i < count; i++) this.counts[lengths[i]]++;
    this.counts[0] = 0;
    /* Symbols are laid out by (length, symbol) order; `next` walks the
     * first free slot of each length as the table is filled. */
    var next = new Int32Array(maxBits + 1);
    var run = 0;
    for (i = 1; i <= maxBits; i++) {
      next[i] = run;
      run += this.counts[i];
      /* An over-subscribed set means the table is corrupt; catching it
       * here turns a hang into a readable error. */
      if (run > count) fail('Corrupt Huffman table in archive.');
    }
    for (i = 0; i < count; i++) if (lengths[i]) this.symbols[next[lengths[i]]++] = i;
    this.maxBits = maxBits;
  }

  function decodeLSB(br, huff) {
    var code = 0, first = 0, index = 0, len, count;
    for (len = 1; len <= huff.maxBits; len++) {
      code |= br.bit();
      count = huff.counts[len];
      if (code - first < count) return huff.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    fail('Bad Huffman code in compressed data.');
  }

  function decodeMSB(br, huff) {
    var code = 0, first = 0, index = 0, len, count;
    for (len = 1; len <= huff.maxBits; len++) {
      code |= br.bits(1);
      count = huff.counts[len];
      if (code - first < count) return huff.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    fail('Bad Huffman code in compressed data.');
  }

  /* ===================================================================
   * Output window.
   *
   * Every format here stores the uncompressed size up front, so the
   * buffer is exact and back-references can be copied in place - no
   * ring buffer, no wrap-around arithmetic.
   * =================================================================== */
  function Out(size) {
    this.buf = new Uint8Array(size);
    this.pos = 0;
    this.size = size;
  }
  Out.prototype.byte = function (v) {
    if (this.pos >= this.size) fail('Archive member is larger than its header claims.');
    this.buf[this.pos++] = v;
  };
  Out.prototype.copy = function (distance, length) {
    var from = this.pos - distance;
    if (from < 0) fail('Back-reference before start of archive member.');
    if (this.pos + length > this.size) fail('Archive member is larger than its header claims.');
    var b = this.buf, p = this.pos;
    for (var i = 0; i < length; i++) b[p + i] = b[from + i];
    this.pos = p + length;
  };
  Out.prototype.done = function () {
    if (this.pos !== this.size) fail('Archive member ended early (truncated file?).');
    return this.buf;
  };

  /* ===================================================================
   * DEFLATE (RFC 1951) -- ZIP method 8 and gzip.
   * =================================================================== */
  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35,
    43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
    4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
    9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  var FIXED_LIT = null, FIXED_DIST = null;

  function fixedTables() {
    if (FIXED_LIT) return;
    var lens = new Uint8Array(288), i;
    for (i = 0; i < 144; i++) lens[i] = 8;
    for (; i < 256; i++) lens[i] = 9;
    for (; i < 280; i++) lens[i] = 7;
    for (; i < 288; i++) lens[i] = 8;
    FIXED_LIT = new Huffman(lens, 288, 15);
    var dl = new Uint8Array(30);
    for (i = 0; i < 30; i++) dl[i] = 5;
    FIXED_DIST = new Huffman(dl, 30, 15);
  }

  /**
   * Raw DEFLATE (no zlib wrapper) from src[from..from+packed) into a
   * buffer of exactly outSize bytes.
   */
  TM.inflateRaw = function (src, from, packed, outSize) {
    var br = new BitsLSB(src, from, from + packed);
    var out = new Out(outSize);
    var last = 0;

    while (!last) {
      last = br.bit();
      var type = br.bits(2);

      if (type === 0) {
        /* Stored: byte-aligned length/complement pair, then raw bytes. */
        br.align();
        if (br.p + 4 > br.e) fail('Compressed data ended early.');
        var len = u16(src, br.p);
        br.p += 4;
        if (br.p + len > br.e) fail('Compressed data ended early.');
        for (var i = 0; i < len; i++) out.byte(src[br.p + i]);
        br.p += len;
        continue;
      }

      var lit, dist;
      if (type === 1) {
        fixedTables();
        lit = FIXED_LIT;
        dist = FIXED_DIST;
      } else if (type === 2) {
        var hlit = br.bits(5) + 257;
        var hdist = br.bits(5) + 1;
        var hclen = br.bits(4) + 4;
        var clens = new Uint8Array(19);
        for (var c = 0; c < hclen; c++) clens[CLEN_ORDER[c]] = br.bits(3);
        var clTable = new Huffman(clens, 19, 7);
        var lens = new Uint8Array(hlit + hdist);
        var n = 0;
        while (n < hlit + hdist) {
          var sym = decodeLSB(br, clTable);
          if (sym < 16) lens[n++] = sym;
          else if (sym === 16) {
            if (n === 0) fail('Corrupt DEFLATE stream.');
            var prev = lens[n - 1];
            for (var r = br.bits(2) + 3; r > 0 && n < lens.length; r--) lens[n++] = prev;
          } else if (sym === 17) {
            for (var r2 = br.bits(3) + 3; r2 > 0 && n < lens.length; r2--) lens[n++] = 0;
          } else {
            for (var r3 = br.bits(7) + 11; r3 > 0 && n < lens.length; r3--) lens[n++] = 0;
          }
        }
        lit = new Huffman(lens.subarray(0, hlit), hlit, 15);
        dist = new Huffman(lens.subarray(hlit), hdist, 15);
      } else {
        fail('Unsupported DEFLATE block type.');
      }

      for (;;) {
        var s = decodeLSB(br, lit);
        if (s < 256) { out.byte(s); continue; }
        if (s === 256) break;
        s -= 257;
        if (s >= 29) fail('Corrupt DEFLATE stream.');
        var length = LEN_BASE[s] + br.bits(LEN_EXTRA[s]);
        var ds = decodeLSB(br, dist);
        if (ds >= 30) fail('Corrupt DEFLATE stream.');
        out.copy(DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]), length);
      }
    }
    return out.done();
  };

  /* ===================================================================
   * LZH -- LHA's -lh4-..-lh7- and ARJ methods 1-3.
   *
   * The two formats share one algorithm: blocks of Huffman-coded
   * literal/length symbols with a second tree for match distances, and a
   * pre-tree that codes the code lengths themselves.  Only the dictionary
   * size differs, which in turn selects the width of the distance-tree
   * length field (4 bits for a dictionary of 16K or less, else 5).
   * =================================================================== */
  var LZH_MIN_MATCH = 3;
  var LZH_NC = 256 + 256 - LZH_MIN_MATCH + 1; /* 510 literals+lengths */
  var LZH_NT = 19;
  var LZH_NPT = 26;

  /* Reads either the pre-tree or the distance tree.  A block that uses a
   * single symbol throughout stores it literally instead of a tree; that
   * case returns the symbol, otherwise -1 and a built table in `slot`. */
  function lzhReadTP(br, slot, num, numBits, spec) {
    var n = br.bits(numBits);
    if (n === 0) {
      var single = br.bits(numBits);
      if (single >= num) fail('Corrupt LZH stream.');
      return single;
    }
    if (n > num) fail('Corrupt LZH stream.');
    var lens = new Uint8Array(LZH_NPT);
    var i = 0;
    do {
      var val = br.peek(16);
      var c = val >>> 13;
      var mov = 3;
      if (c === 7) {
        /* Lengths above 6 are unary-extended through bit 12. */
        while (val & (1 << 12)) { val += val; c++; }
        if (c > 16) fail('Corrupt LZH stream.');
        mov = c - 3;
      }
      lens[i++] = c;
      br.skip(mov);
      /* Position 3 of the pre-tree carries a 2-bit skip count. */
      if (i === spec) i += br.bits(2);
    } while (i < n);
    slot.table = new Huffman(lens, LZH_NPT, 16);
    return -1;
  }

  /* Reads the literal/length tree, whose code lengths are themselves
   * coded with the pre-tree (0/1/2 are run-of-zero escapes). */
  function lzhReadC(br, pre, preSymbol, slot) {
    var n = br.bits(9);
    if (n === 0) {
      var single = br.bits(9);
      if (single >= LZH_NC) fail('Corrupt LZH stream.');
      return single;
    }
    if (n > LZH_NC) fail('Corrupt LZH stream.');
    var lens = new Uint8Array(LZH_NC);
    var i = 0;
    do {
      var c = preSymbol >= 0 ? preSymbol : decodeMSB(br, pre.table);
      if (c <= 2) {
        if (c === 0) c = 1;
        else if (c === 1) c = br.bits(4) + 3;
        else c = br.bits(9) + 20;
        if (i + c > n) fail('Corrupt LZH stream.');
        while (c--) lens[i++] = 0;
      } else {
        lens[i++] = c - 2;
      }
    } while (i < n);
    slot.table = new Huffman(lens, LZH_NC, 16);
    return -1;
  }

  function lzhDecode(src, from, packed, outSize, dictSize) {
    var br = new BitsMSB(src, from, from + packed);
    var out = new Out(outSize);
    var pbit = dictSize <= 1 << 14 ? 4 : 5;
    var treeT = { table: null };  /* pre-tree, then re-used for distances */
    var treeC = { table: null };
    var symT = -1, symC = -1;
    var blockSize = 0;

    while (out.pos < outSize) {
      if (blockSize === 0) {
        blockSize = br.bits(16);
        if (blockSize === 0) fail('Corrupt LZH stream (empty block).');
        symT = lzhReadTP(br, treeT, LZH_NT, 5, 3);
        symC = lzhReadC(br, treeT, symT, treeC);
        symT = lzhReadTP(br, treeT, LZH_NPT, pbit, -1);
      }
      blockSize--;

      var sym = symC >= 0 ? symC : decodeMSB(br, treeC.table);
      if (sym < 256) {
        out.byte(sym);
      } else {
        var length = sym - 256 + LZH_MIN_MATCH;
        var dist = symT >= 0 ? symT : decodeMSB(br, treeT.table);
        if (dist > 1) dist = (1 << (dist - 1)) + br.bits(dist - 1);
        if (dist >= dictSize) fail('Corrupt LZH stream (distance out of range).');
        out.copy(dist + 1, length);
      }
      if (br.over > 4) fail('Compressed data ended early.');
    }
    return out.done();
  }

  /* ===================================================================
   * ARJ method 4 -- LZ77 with fixed, self-delimiting codes.
   *
   * A leading 0 bit introduces an 8-bit literal.  Otherwise a unary run
   * of up to seven 1s selects the width of the match-length field, and a
   * second unary prefix selects a distance field 9 to 13 bits wide.
   * =================================================================== */
  function arjDecode4(src, from, packed, outSize) {
    var br = new BitsMSB(src, from, from + packed);
    var out = new Out(outSize);

    while (out.pos < outSize) {
      var val = br.peek(14);
      if ((val & (1 << 13)) === 0) {
        out.byte((val >>> 5) & 0xff);
        br.skip(9);
        continue;
      }
      var w, flag = 1 << 12;
      for (w = 1; w < 7; w++, flag >>= 1) if ((val & flag) === 0) break;
      var readBits = (w !== 7 ? 1 : 0) + w * 2;
      var mask = (1 << w) - 1;
      var length = mask + LZH_MIN_MATCH - 1 + ((val >>> (14 - readBits)) & mask);
      br.skip(readBits);

      val = br.peek(17);
      readBits = 1;
      if ((val & (1 << 16)) === 0) w = 9;
      else if ((val & (1 << 15)) === 0) w = 10;
      else if ((val & (1 << 14)) === 0) w = 11;
      else if ((val & (1 << 13)) === 0) w = 12;
      else { w = 13; readBits = 0; }
      readBits += w + w - 9;
      var dist = (1 << w) - (1 << 9) + ((val >>> (17 - readBits)) & ((1 << w) - 1));
      br.skip(readBits);

      out.copy(dist + 1, length);
      if (br.over > 4) fail('Compressed data ended early.');
    }
    return out.done();
  }

  /* ===================================================================
   * ZIP
   * =================================================================== */
  var ZIP_EOCD = 0x06054b50;
  var ZIP_EOCD64 = 0x06064b50;
  var ZIP_LOCATOR64 = 0x07064b50;
  var ZIP_CENTRAL = 0x02014b50;
  var ZIP_LOCAL = 0x04034b50;

  function zipMethodName(m) {
    if (m === 0) return 'stored';
    if (m === 8) return 'deflate';
    if (m === 9) return 'deflate64';
    if (m === 12) return 'bzip2';
    if (m === 14) return 'lzma';
    if (m === 93) return 'zstd';
    if (m === 98) return 'ppmd';
    return 'method ' + m;
  }

  function zipInflate(bytes, entry) {
    var start = entry.dataOffset;
    if (entry.encrypted) fail('"' + entry.name + '" is password protected.');
    if (entry.method === 0) {
      if (start + entry.size > bytes.length) fail('Archive is truncated.');
      return bytes.slice(start, start + entry.size);
    }
    if (entry.method !== 8) {
      fail('"' + entry.name + '" uses ' + zipMethodName(entry.method) + ' compression, which is not supported.');
    }
    return TM.inflateRaw(bytes, start, entry.packSize, entry.size);
  }

  /* Local headers repeat the name and extra field, and their extra field
   * frequently differs in length from the central one, so the data offset
   * can only be resolved here. */
  function zipResolveData(bytes, entry) {
    var lho = entry.localOffset;
    if (lho + 30 > bytes.length || u32(bytes, lho) !== ZIP_LOCAL) fail('Broken ZIP entry header.');
    entry.dataOffset = lho + 30 + u16(bytes, lho + 26) + u16(bytes, lho + 28);
    return entry;
  }

  function zipReadZip64Extra(bytes, from, len, entry) {
    var p = from, end = from + len;
    while (p + 4 <= end) {
      var id = u16(bytes, p), sz = u16(bytes, p + 2);
      if (id === 0x0001) {
        var q = p + 4;
        /* Fields appear only for the ones that overflowed, in order. */
        if (entry.size === 0xffffffff && q + 8 <= end) { entry.size = u32(bytes, q) + u32(bytes, q + 4) * 4294967296; q += 8; }
        if (entry.packSize === 0xffffffff && q + 8 <= end) { entry.packSize = u32(bytes, q) + u32(bytes, q + 4) * 4294967296; q += 8; }
        if (entry.localOffset === 0xffffffff && q + 8 <= end) { entry.localOffset = u32(bytes, q) + u32(bytes, q + 4) * 4294967296; q += 8; }
      }
      p += 4 + sz;
    }
  }

  function findEOCD(bytes) {
    var max = Math.min(bytes.length, 0xffff + 22);
    for (var i = bytes.length - 22; i >= bytes.length - max && i >= 0; i--) {
      if (u32(bytes, i) === ZIP_EOCD) return i;
    }
    return -1;
  }

  function zipList(bytes) {
    var entries = [];
    var eocd = findEOCD(bytes);
    var count = -1, cdOffset = -1;

    if (eocd >= 0) {
      count = u16(bytes, eocd + 10);
      cdOffset = u32(bytes, eocd + 16);
      /* ZIP64: the real values live in a separate record pointed at by a
       * locator that sits immediately before the classic EOCD. */
      if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && u32(bytes, eocd - 20) === ZIP_LOCATOR64) {
        var z64 = u32(bytes, eocd - 20 + 8) + u32(bytes, eocd - 20 + 12) * 4294967296;
        if (z64 + 56 <= bytes.length && u32(bytes, z64) === ZIP_EOCD64) {
          count = u32(bytes, z64 + 32) + u32(bytes, z64 + 36) * 4294967296;
          cdOffset = u32(bytes, z64 + 48) + u32(bytes, z64 + 52) * 4294967296;
        }
      }
    }

    if (cdOffset >= 0 && cdOffset < bytes.length && u32(bytes, cdOffset) === ZIP_CENTRAL) {
      var p = cdOffset;
      while (p + 46 <= bytes.length && u32(bytes, p) === ZIP_CENTRAL && (count < 0 || entries.length < count)) {
        var flags = u16(bytes, p + 8);
        var nameLen = u16(bytes, p + 28);
        var extraLen = u16(bytes, p + 30);
        var commentLen = u16(bytes, p + 32);
        var e = {
          name: (flags & 0x800 ? utf8 : latin1)(bytes, p + 46, p + 46 + nameLen),
          method: u16(bytes, p + 10),
          crc: u32(bytes, p + 16),
          packSize: u32(bytes, p + 20),
          size: u32(bytes, p + 24),
          localOffset: u32(bytes, p + 42),
          encrypted: !!(flags & 1)
        };
        zipReadZip64Extra(bytes, p + 46 + nameLen, extraLen, e);
        e.methodName = zipMethodName(e.method);
        e.isDir = /[/\\]$/.test(e.name) || (e.size === 0 && e.packSize === 0 && /[/\\]$/.test(e.name));
        entries.push(e);
        p += 46 + nameLen + extraLen + commentLen;
      }
    } else {
      /* No usable directory (self-extracting stub, truncated download,
       * concatenated data): walk the local headers instead. */
      var q = 0;
      while (q + 30 <= bytes.length && u32(bytes, q) === ZIP_LOCAL) {
        var f2 = u16(bytes, q + 6);
        var nl = u16(bytes, q + 26), el = u16(bytes, q + 28);
        var ent = {
          name: (f2 & 0x800 ? utf8 : latin1)(bytes, q + 30, q + 30 + nl),
          method: u16(bytes, q + 8),
          crc: u32(bytes, q + 14),
          packSize: u32(bytes, q + 18),
          size: u32(bytes, q + 22),
          localOffset: q,
          encrypted: !!(f2 & 1)
        };
        ent.methodName = zipMethodName(ent.method);
        ent.isDir = /[/\\]$/.test(ent.name);
        /* Streamed entries put the sizes in a trailing descriptor, which
         * cannot be found without decompressing - skip those. */
        if (f2 & 0x08) break;
        entries.push(ent);
        q = q + 30 + nl + el + ent.packSize;
      }
      if (!entries.length) fail('This ZIP file has no readable directory.');
    }

    entries.forEach(function (e) {
      e.extract = function () {
        zipResolveData(bytes, e);
        var data = zipInflate(bytes, e);
        if (e.crc && crc32(data, 0, data.length) !== e.crc) {
          fail('"' + e.name + '" failed its checksum - the archive is damaged.');
        }
        return data;
      };
    });
    return entries;
  }

  /* ===================================================================
   * ARJ
   *
   * Every block is: 60 EA, u16 size, size bytes, u32 CRC, then a chain of
   * extended headers (u16 size + data + CRC) terminated by a zero size.
   * The first block describes the archive, each later one a file, whose
   * compressed bytes follow immediately.
   * =================================================================== */
  var ARJ_METHODS = ['stored', 'ARJ m1', 'ARJ m2', 'ARJ m3', 'ARJ m4'];

  function arjSkipExtHeaders(bytes, p) {
    for (;;) {
      if (p + 2 > bytes.length) fail('ARJ archive is truncated.');
      var size = u16(bytes, p);
      p += 2;
      if (size === 0) return p;
      p += size + 4;
    }
  }

  function arjReadBlock(bytes, p) {
    if (p + 4 > bytes.length) return null;
    if (bytes[p] !== 0x60 || bytes[p + 1] !== 0xea) fail('ARJ archive is damaged (lost block sync).');
    var size = u16(bytes, p + 2);
    if (size === 0) return null;                 /* end-of-archive marker */
    if (size < 30 || p + 4 + size + 4 > bytes.length) fail('ARJ archive is truncated.');
    var body = p + 4;
    return { body: body, size: size, next: arjSkipExtHeaders(bytes, body + size + 4) };
  }

  function arjList(bytes) {
    var head = arjReadBlock(bytes, 0);
    if (!head) fail('Not a readable ARJ archive.');
    if (bytes[head.body + 6] !== 2) fail('Not a readable ARJ archive (bad main header).');

    var entries = [];
    var p = head.next;
    for (;;) {
      var blk = arjReadBlock(bytes, p);
      if (!blk) break;
      var b = blk.body;
      var headerSize = bytes[b];
      if (headerSize < 30 || headerSize > blk.size) fail('ARJ archive is damaged.');
      var flags = bytes[b + 4];
      var name = cstr(bytes, b + headerSize, b + blk.size);
      var e = {
        name: name.text.replace(/\\/g, '/'),
        method: bytes[b + 5],
        fileType: bytes[b + 6],
        packSize: u32(bytes, b + 12),
        size: u32(bytes, b + 16),
        crc: u32(bytes, b + 20),
        encrypted: !!(flags & 1),
        dataOffset: blk.next
      };
      e.methodName = ARJ_METHODS[e.method] || 'method ' + e.method;
      e.isDir = e.fileType === 3;
      if (e.dataOffset + e.packSize > bytes.length) fail('ARJ archive is truncated.');
      e.extract = function (entry) {
        return function () {
          if (entry.encrypted) fail('"' + entry.name + '" is password protected.');
          var data;
          if (entry.method === 0) data = bytes.slice(entry.dataOffset, entry.dataOffset + entry.size);
          else if (entry.method >= 1 && entry.method <= 3) {
            data = lzhDecode(bytes, entry.dataOffset, entry.packSize, entry.size, 26624);
          } else if (entry.method === 4) {
            data = arjDecode4(bytes, entry.dataOffset, entry.packSize, entry.size);
          } else {
            fail('"' + entry.name + '" uses ' + entry.methodName + ', which is not supported.');
          }
          if (crc32(data, 0, data.length) !== entry.crc) {
            fail('"' + entry.name + '" failed its checksum - the archive is damaged.');
          }
          return data;
        };
      }(e);
      /* File type 2 is an archive comment block, not a member. */
      if (e.fileType !== 2) entries.push(e);
      p = blk.next + e.packSize;
    }
    return entries;
  }

  /* ===================================================================
   * LHA / LZH
   *
   * Three header levels are in the wild; they agree on the first 22 bytes
   * and differ in how the name and the size of the header itself are
   * stored.  Amiga archives are almost always level 0 or 1 with -lh5-.
   * =================================================================== */
  var LHA_DICT = { '-lh4-': 1 << 12, '-lh5-': 1 << 13, '-lh6-': 1 << 15, '-lh7-': 1 << 16 };

  function lhaList(bytes) {
    var entries = [];
    var p = 0;
    while (p + 21 < bytes.length && bytes[p] !== 0) {
      var method = latin1(bytes, p + 2, p + 7);
      if (!/^-(lh[0-7]|lzs|lz4|lhd)-$/.test(method)) {
        if (!entries.length) fail('Not a readable LHA archive.');
        break;
      }
      var level = bytes[p + 20];
      var packSize = u32(bytes, p + 7);
      var size = u32(bytes, p + 11);
      var crc = 0, name = '', dataOffset = 0, next = 0;

      if (level === 0 || level === 1) {
        var headerSize = bytes[p];
        var nameLen = bytes[p + 21];
        name = latin1(bytes, p + 22, p + 22 + nameLen);
        crc = u16(bytes, p + 22 + nameLen);
        if (level === 0) {
          dataOffset = p + 2 + headerSize;
          next = dataOffset + packSize;
        } else {
          /* Level 1 chains extension headers after the base header.  Two
           * quirks: the base header size already covers the first chain
           * link's size word, and the packed size field counts the whole
           * chain, so the real compressed size is field - chain + 2. */
          var q = p + headerSize;
          for (;;) {
            if (q + 2 > bytes.length) fail('LHA archive is truncated.');
            var extSize = u16(bytes, q);
            if (extSize === 0) { q += 2; break; }
            if (extSize < 3 || q + extSize > bytes.length) fail('LHA archive is damaged.');
            /* An extension header may carry the real (long) file name. */
            if (bytes[q + 2] === 0x01) name = latin1(bytes, q + 3, q + extSize);
            else if (bytes[q + 2] === 0x02) name = latin1(bytes, q + 3, q + extSize) + '/' + name;
            q += extSize;
          }
          dataOffset = q;
          packSize -= q - (p + headerSize) - 2;
          next = dataOffset + packSize;
        }
      } else if (level === 2) {
        var total = u16(bytes, p);
        crc = u16(bytes, p + 21);
        var r = p + 24;
        var base = '';
        for (;;) {
          if (r + 2 > bytes.length) fail('LHA archive is truncated.');
          var es = u16(bytes, r);
          if (es === 0) break;
          if (bytes[r + 2] === 0x01) name = latin1(bytes, r + 3, r + es);
          else if (bytes[r + 2] === 0x02) base = latin1(bytes, r + 3, r + es);
          r += es;
          if (r > p + total) fail('LHA archive is damaged.');
        }
        if (base) name = base.replace(/\xff/g, '/') + name;
        dataOffset = p + total;
        next = dataOffset + packSize;
      } else {
        fail('LHA header level ' + level + ' is not supported.');
      }

      var e = {
        name: name.replace(/\\/g, '/').replace(/\xff/g, '/'),
        method: method,
        methodName: method,
        packSize: packSize,
        size: size,
        crc: crc,
        encrypted: false,
        dataOffset: dataOffset,
        isDir: method === '-lhd-'
      };
      e.extract = function (entry) {
        return function () {
          var data;
          if (entry.method === '-lh0-' || entry.method === '-lz4-') {
            data = bytes.slice(entry.dataOffset, entry.dataOffset + entry.size);
          } else if (LHA_DICT[entry.method]) {
            data = lzhDecode(bytes, entry.dataOffset, entry.packSize, entry.size, LHA_DICT[entry.method]);
          } else {
            fail('"' + entry.name + '" uses ' + entry.method + ' compression, which is not supported.');
          }
          if (entry.crc && crc16(data, 0, data.length) !== entry.crc) {
            fail('"' + entry.name + '" failed its checksum - the archive is damaged.');
          }
          return data;
        };
      }(e);
      if (!e.isDir) entries.push(e);
      if (next <= p) break;
      p = next;
    }
    if (!entries.length) fail('No files found in this LHA archive.');
    return entries;
  }

  /* ===================================================================
   * gzip and tar
   *
   * A .tar.gz of a module directory is common enough on mirrors to be
   * worth the twenty lines, and both fall out of the code above.
   * =================================================================== */
  function gunzip(bytes) {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) fail('Not a gzip file.');
    var flags = bytes[3];
    var p = 10;
    if (flags & 4) p += 2 + u16(bytes, p);          /* extra field */
    var name = '';
    if (flags & 8) { var n = cstr(bytes, p, bytes.length); name = n.text; p = n.next; }
    if (flags & 16) p = cstr(bytes, p, bytes.length).next;
    if (flags & 2) p += 2;                           /* header CRC */
    var size = u32(bytes, bytes.length - 4);
    var data = TM.inflateRaw(bytes, p, bytes.length - 8 - p, size);
    if (crc32(data, 0, data.length) !== u32(bytes, bytes.length - 8)) {
      fail('The gzip stream failed its checksum.');
    }
    return { name: name, data: data };
  }

  function tarList(bytes) {
    var entries = [];
    var p = 0;
    while (p + 512 <= bytes.length) {
      if (bytes[p] === 0) break;                     /* end-of-archive */
      var name = latin1(bytes, p, p + 100);
      var prefix = latin1(bytes, p + 345, p + 500);
      var sizeStr = latin1(bytes, p + 124, p + 136).replace(/[^0-7]/g, '');
      var size = parseInt(sizeStr, 8) || 0;
      var type = bytes[p + 156];
      var data = p + 512;
      if (prefix) name = prefix + '/' + name;
      if (type === 0 || type === 0x30) {             /* '\0' or '0': a file */
        entries.push({
          name: name, method: 0, methodName: 'stored', packSize: size, size: size,
          crc: 0, encrypted: false, isDir: false, dataOffset: data,
          extract: function (off, len) {
            return function () { return bytes.slice(off, off + len); };
          }(data, size)
        });
      }
      p = data + Math.ceil(size / 512) * 512;
    }
    if (!entries.length) fail('No files found in this tar archive.');
    return entries;
  }

  function looksLikeTar(bytes) {
    return bytes.length >= 512 && latin1(bytes, 257, 262) === 'ustar';
  }

  /* ===================================================================
   * Public surface
   * =================================================================== */

  /**
   * Sniff the container type by content.  Returns 'zip' | 'arj' | 'lha' |
   * 'gz' | 'tar' | null.  As with the module loaders, extensions are not
   * trusted - archives get renamed constantly.
   */
  TM.detectArchive = function (bytes) {
    if (!bytes || bytes.length < 22) return null;
    var sig = u32(bytes, 0);
    if (sig === ZIP_LOCAL || sig === ZIP_CENTRAL || sig === ZIP_EOCD) return 'zip';
    if (bytes[0] === 0x60 && bytes[1] === 0xea) return 'arj';
    if (bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8) return 'gz';
    if (looksLikeTar(bytes)) return 'tar';
    if (bytes.length > 7 && bytes[2] === 0x2d && bytes[6] === 0x2d &&
        /^-(lh[0-7]|lzs|lz4|lhd)-$/.test(latin1(bytes, 2, 7))) return 'lha';
    /* Self-extracting ZIPs bury a normal ZIP behind an .exe stub. */
    if (bytes[0] === 0x4d && bytes[1] === 0x5a && findEOCD(bytes) >= 0) return 'zip';
    return null;
  };

  var ARCHIVE_NAMES = { zip: 'ZIP', arj: 'ARJ', lha: 'LHA', gz: 'gzip', tar: 'tar' };

  /**
   * Enumerate an archive.  Returns { type, typeName, entries } where each
   * entry exposes name/size/methodName and an extract() that yields a
   * Uint8Array (and throws a readable Error if it cannot).  Extraction is
   * lazy: listing a 20 MB archive costs nothing until a file is picked.
   */
  TM.listArchive = function (buffer, filename) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var type = TM.detectArchive(bytes);
    if (!type) fail('Not a recognised archive.');

    var entries;
    if (type === 'zip') entries = zipList(bytes);
    else if (type === 'arj') entries = arjList(bytes);
    else if (type === 'lha') entries = lhaList(bytes);
    else if (type === 'tar') entries = tarList(bytes);
    else {
      /* gzip holds exactly one stream, which is very often a tar. */
      var gz = gunzip(bytes);
      var inner = gz.data;
      if (looksLikeTar(inner)) {
        return { type: 'tar.gz', typeName: 'tar.gz', entries: tarList(inner) };
      }
      var gname = gz.name || (filename || 'file').replace(/\.(gz|tgz)$/i, '');
      entries = [{
        name: gname, method: 8, methodName: 'deflate', packSize: bytes.length,
        size: inner.length, crc: 0, encrypted: false, isDir: false,
        extract: function () { return inner; }
      }];
    }

    entries = entries.filter(function (e) { return !e.isDir; });
    return { type: type, typeName: ARCHIVE_NAMES[type] || type, entries: entries };
  };

  /* Extension test used to pre-select the interesting members of an
   * archive.  Amiga archives use the "mod.songname" prefix convention, so
   * both ends of the name are checked. */
  TM.MODULE_EXT = /\.(mod|s3m|xm|it|nst|wow|mtm|okt|stm|ult|669|far|amf|ptm|dmf|med)$/i;
  TM.MODULE_PREFIX = /^(mod|s3m|xm|it|nst|wow|smp)[.\-_]/i;

  TM.looksLikeModuleName = function (name) {
    var base = String(name || '').split('/').pop();
    return TM.MODULE_EXT.test(base) || TM.MODULE_PREFIX.test(base);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
