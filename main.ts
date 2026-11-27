// png-squeeze: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Own implementation, written from the competition spec: a PNG decoder, a
// per-instance colour-type reduction, a filter screening pass, and an
// optimal-parsing DEFLATE encoder (hash-chain LZ77, three-pass shortest-path
// parse, length-limited dynamic Huffman). Each instance's filtered stream is
// encoded twice — once by the own parser and once by the platform zlib at
// level 9 — and the smaller raw DEFLATE stream is kept. Node 22+,
// built-ins only, no network, no wall-clock reads: every choice is a
// function of the input bytes and fixed work budgets, so two runs write
// identical bytes.
//
// Usage: node main.ts — reads /input/<id>/image.png for i001..i008 and writes
// /output/<id>/image.png. MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR override the
// directories for local runs.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < bytes.length) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG decoding (8-bit, colour types 0/2/3/4/6)
// ---------------------------------------------------------------------------

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function decodePng(file: Uint8Array): DecodedImage {
  for (let i = 0; i < 8; i++) {
    if (file[i] !== PNG_SIGNATURE[i]) throw new Error('input is not a PNG');
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  while (at < file.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(file[at + 4], file[at + 5], file[at + 6], file[at + 7]);
    const data = file.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('input bit depth is not 8');
      colourType = data[9];
      if (!(colourType in CHANNELS)) throw new Error('input colour type not supported');
      if (data[12] !== 0) throw new Error('input is interlaced');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const up = o - stride;
    if (filter === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
      }
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (y > 0 ? samples[up + i] : 0);
      }
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? samples[o + i - bpp] : 0;
        const above = y > 0 ? samples[up + i] : 0;
        samples[o + i] = raw[src + i] + ((left + above) >> 1);
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? samples[o + i - bpp] : 0;
        const above = y > 0 ? samples[up + i] : 0;
        const upperLeft = y > 0 && i >= bpp ? samples[up + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(left, above, upperLeft);
      }
    } else {
      throw new Error('input row has filter type ' + filter);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = (palette as Uint8Array).length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = (palette as Uint8Array)[e * 3];
      rgba[d + 1] = (palette as Uint8Array)[e * 3 + 1];
      rgba[d + 2] = (palette as Uint8Array)[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Colour-type reduction
// ---------------------------------------------------------------------------

interface Reduced {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
}

function reduceImage(rgba: Uint8Array): Reduced {
  const n = rgba.length / 4;
  let grey = true;
  let opaque = true;
  let partialAlpha = false;
  let clearRgb = -1;
  let clearMixed = false;
  const counts = new Map<number, number>();
  let tooManyColours = false;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const a = rgba[p + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) {
      opaque = false;
      if (a === 0) {
        const rgb = (r << 16) | (g << 8) | b;
        if (clearRgb < 0) clearRgb = rgb;
        else if (clearRgb !== rgb) clearMixed = true;
      } else {
        partialAlpha = true;
      }
    }
    if (!tooManyColours) {
      const key = r * 0x1000000 + g * 0x10000 + b * 0x100 + a;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (counts.size > 256) tooManyColours = true;
    }
  }

  if (grey && opaque) {
    const samples = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) samples[i] = rgba[p];
    return { colourType: 0, bpp: 1, samples, palette: null, trns: null };
  }
  if (grey) {
    const samples = new Uint8Array(n * 2);
    for (let i = 0, p = 0, s = 0; i < n; i++, p += 4, s += 2) {
      samples[s] = rgba[p];
      samples[s + 1] = rgba[p + 3];
    }
    return { colourType: 4, bpp: 2, samples, palette: null, trns: null };
  }
  if (!tooManyColours) {
    // Palette, most frequent colours first so long runs share low indices.
    const order = [...counts.entries()].sort((x, y) => y[1] - x[1]);
    const indexOf = new Map<number, number>();
    const palette = new Uint8Array(order.length * 3);
    const alphas = new Uint8Array(order.length);
    order.forEach(([key], e) => {
      indexOf.set(key, e);
      palette[e * 3] = Math.floor(key / 0x1000000);
      palette[e * 3 + 1] = Math.floor(key / 0x10000) % 256;
      palette[e * 3 + 2] = Math.floor(key / 0x100) % 256;
      alphas[e] = key % 256;
    });
    const samples = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const key = rgba[p] * 0x1000000 + rgba[p + 1] * 0x10000 + rgba[p + 2] * 0x100 + rgba[p + 3];
      samples[i] = indexOf.get(key) as number;
    }
    let trns: Uint8Array | null = null;
    let lastAlpha = -1;
    for (let e = 0; e < alphas.length; e++) if (alphas[e] !== 255) lastAlpha = e;
    if (lastAlpha >= 0) trns = alphas.subarray(0, lastAlpha + 1);
    return { colourType: 3, bpp: 1, samples, palette, trns };
  }
  if (opaque) {
    const samples = new Uint8Array(n * 3);
    for (let i = 0, p = 0, s = 0; i < n; i++, p += 4, s += 3) {
      samples[s] = rgba[p];
      samples[s + 1] = rgba[p + 1];
      samples[s + 2] = rgba[p + 2];
    }
    return { colourType: 2, bpp: 3, samples, palette: null, trns: null };
  }
  if (!partialAlpha && !clearMixed && clearRgb >= 0) {
    // Every non-opaque pixel is fully transparent and shares one colour:
    // RGB plus a tRNS key holds the alpha channel exactly.
    const samples = new Uint8Array(n * 3);
    for (let i = 0, p = 0, s = 0; i < n; i++, p += 4, s += 3) {
      samples[s] = rgba[p];
      samples[s + 1] = rgba[p + 1];
      samples[s + 2] = rgba[p + 2];
    }
    const trns = new Uint8Array([0, (clearRgb >> 16) & 0xff, 0, (clearRgb >> 8) & 0xff, 0, clearRgb & 0xff]);
    return { colourType: 2, bpp: 3, samples, palette: null, trns };
  }
  return { colourType: 6, bpp: 4, samples: rgba, palette: null, trns: null };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function filterRowInto(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const above = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((left + above) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const above = prev === null ? 0 : prev[i];
      const upperLeft = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(left, above, upperLeft);
    }
  }
}

interface FilteredChoice {
  name: string;
  raw: Uint8Array;
  zSize: number;
}

function screenFilters(samples: Uint8Array, width: number, height: number, bpp: number): FilteredChoice {
  const stride = width * bpp;
  const rowLen = stride + 1;
  const total = height * rowLen;
  const candidates: { name: string; raw: Uint8Array }[] = [];
  for (let t = 0; t < 5; t++) {
    const raw = new Uint8Array(total);
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      raw[y * rowLen] = t;
      filterRowInto(t, cur, prev, bpp, raw.subarray(y * rowLen + 1, (y + 1) * rowLen));
    }
    candidates.push({ name: 'fixed-' + t, raw });
  }
  const trial = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  const rawMinSum = new Uint8Array(total);
  const rawFewestNonZero = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    for (let t = 0; t < 5; t++) filterRowInto(t, cur, prev, bpp, trial[t]);
    let bestSum = Infinity;
    let bestSumType = 0;
    let bestNonZero = Infinity;
    let bestNonZeroType = 0;
    for (let t = 0; t < 5; t++) {
      let sum = 0;
      let nonZero = 0;
      const row = trial[t];
      for (let i = 0; i < stride; i++) {
        const v = row[i];
        sum += v < 128 ? v : 256 - v;
        if (v !== 0) nonZero++;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestSumType = t;
      }
      if (nonZero < bestNonZero) {
        bestNonZero = nonZero;
        bestNonZeroType = t;
      }
    }
    rawMinSum[y * rowLen] = bestSumType;
    rawMinSum.set(trial[bestSumType], y * rowLen + 1);
    rawFewestNonZero[y * rowLen] = bestNonZeroType;
    rawFewestNonZero.set(trial[bestNonZeroType], y * rowLen + 1);
  }
  candidates.push({ name: 'minsum', raw: rawMinSum });
  candidates.push({ name: 'fewest-nonzero', raw: rawFewestNonZero });
  let best: FilteredChoice | null = null;
  for (const c of candidates) {
    const size = deflateSync(c.raw, { level: 6 }).length;
    if (best === null || size < best.zSize) best = { name: c.name, raw: c.raw, zSize: size };
  }
  return best as FilteredChoice;
}

// ---------------------------------------------------------------------------
// DEFLATE: optimal-parsing encoder
// ---------------------------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenSymbolOf(len: number): number {
  let s = 0;
  while (s + 1 < LEN_BASE.length && LEN_BASE[s + 1] <= len) s++;
  return s;
}

function distSymbolOf(dist: number): number {
  let s = 0;
  while (s + 1 < DIST_BASE.length && DIST_BASE[s + 1] <= dist) s++;
  return s;
}

const FIXED_LIT_LEN: number[] = (() => {
  const a = new Array<number>(288).fill(8);
  for (let i = 144; i < 256; i++) a[i] = 9;
  for (let i = 256; i < 280; i++) a[i] = 7;
  return a;
})();
const FIXED_DIST_LEN: number[] = new Array<number>(30).fill(5);

class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private nbits = 0;
  writeBits(value: number, count: number): void {
    this.acc |= (value & ((1 << count) - 1)) << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  alignByte(): void {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
  }
  finish(): Uint8Array {
    this.alignByte();
    return Uint8Array.from(this.bytes);
  }
}

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

/** Canonical Huffman codes for a set of code lengths (index = symbol). */
function canonicalCodes(lengths: number[]): number[] {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Array<number>(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array<number>(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Array<number>(lengths.length).fill(0);
  for (let s = 0; s < lengths.length; s++) {
    if (lengths[s] > 0) {
      codes[s] = nextCode[lengths[s]];
      nextCode[lengths[s]]++;
    }
  }
  return codes;
}

/**
 * Code lengths from symbol frequencies, capped at maxLen. Builds a Huffman
 * tree by repeated merging, then applies the standard overflow fix: lengths
 * past the cap are folded back down and the shortest lengths are handed to
 * the most frequent symbols.
 */
function buildLengths(freqs: number[], maxLen: number): number[] {
  const n = freqs.length;
  const lengths = new Array<number>(n).fill(0);
  interface HNode {
    freq: number;
    sym: number;
    left: HNode | null;
    right: HNode | null;
  }
  const leaves: HNode[] = [];
  for (let s = 0; s < n; s++) {
    if (freqs[s] > 0) leaves.push({ freq: freqs[s], sym: s, left: null, right: null });
  }
  if (leaves.length === 0) return lengths;
  if (leaves.length === 1) {
    lengths[leaves[0].sym] = 1;
    return lengths;
  }
  const pool = leaves.slice();
  while (pool.length > 1) {
    let i1 = 0;
    let i2 = 1;
    if (pool[i2].freq < pool[i1].freq) {
      const t = i1;
      i1 = i2;
      i2 = t;
    }
    for (let i = 2; i < pool.length; i++) {
      if (pool[i].freq < pool[i1].freq) {
        i2 = i1;
        i1 = i;
      } else if (pool[i].freq < pool[i2].freq) {
        i2 = i;
      }
    }
    const a = pool[i1];
    const b = pool[i2];
    pool.splice(Math.max(i1, i2), 1);
    pool.splice(Math.min(i1, i2), 1);
    pool.push({ freq: a.freq + b.freq, sym: -1, left: a, right: b });
  }
  const depths = new Map<number, number>();
  const walk = (nd: HNode, d: number): void => {
    if (nd.sym >= 0) {
      depths.set(nd.sym, d);
      return;
    }
    walk(nd.left as HNode, d + 1);
    walk(nd.right as HNode, d + 1);
  };
  walk(pool[0], 0);
  let overflow = 0;
  for (const d of depths.values()) if (d > maxLen) overflow++;
  if (overflow === 0) {
    for (const [s, d] of depths) lengths[s] = d;
    return lengths;
  }
  const blCount = new Array<number>(maxLen + 1).fill(0);
  for (const d of depths.values()) blCount[Math.min(d, maxLen)]++;
  let ov = overflow;
  while (ov > 0) {
    let bits = maxLen - 1;
    while (bits > 0 && blCount[bits] === 0) bits--;
    if (bits === 0) break;
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxLen]--;
    ov -= 2;
  }
  const byFreq = [...depths.keys()].sort((a, b) => freqs[b] - freqs[a]);
  let idx = 0;
  for (let d = 1; d <= maxLen; d++) {
    for (let k = 0; k < blCount[d] && idx < byFreq.length; k++) lengths[byFreq[idx++]] = d;
  }
  return lengths;
}

/** Hash-chain LZ77 match search over one block. */
function findMatches(data: Uint8Array): { bestLen: Int32Array; bestDist: Int32Array } {
  const n = data.length;
  const bestLen = new Int32Array(n);
  const bestDist = new Int32Array(n);
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (i + 3 > n) continue;
    const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 32767;
    let cand = head[h];
    let best = 0;
    let bestD = 0;
    let steps = 0;
    const maxLen = Math.min(258, n - i);
    while (cand >= 0 && steps < 64) {
      const dist = i - cand;
      if (dist > 32768) break;
      let len = 0;
      while (len < maxLen && data[cand + len] === data[i + len]) len++;
      if (len > best) {
        best = len;
        bestD = dist;
        if (len >= 128) break;
      }
      cand = prev[cand];
      steps++;
    }
    if (best >= 3) {
      bestLen[i] = best;
      bestDist[i] = bestD;
    }
    prev[i] = head[h];
    head[h] = i;
  }
  return { bestLen, bestDist };
}

interface ParseResult {
  opLen: Int32Array;
  opDist: Int32Array;
  opCount: number;
  litFreq: number[];
  distFreq: number[];
}

/**
 * Shortest-path parse of a block. litCost is indexed by literal/length
 * symbol, lenCost by match length, distCostByDist by distance. When refine
 * is false only lengths 3 and the longest match are tried at each position;
 * when true every length up to the longest (a capped set for very long
 * matches) is tried.
 */
function parseBlock(
  data: Uint8Array,
  bestLen: Int32Array,
  bestDist: Int32Array,
  litCost: number[],
  lenCost: number[],
  distCostByDist: Int32Array,
  refine: boolean,
): ParseResult {
  const n = data.length;
  const dp = new Float64Array(n + 1).fill(Infinity);
  dp[0] = 0;
  const choiceLen = new Int32Array(n + 1);
  const choiceDist = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const base = dp[i];
    if (base === Infinity) continue;
    const lit = base + litCost[data[i]];
    if (lit < dp[i + 1]) {
      dp[i + 1] = lit;
      choiceLen[i + 1] = 0;
    }
    const bl = bestLen[i];
    if (bl >= 3) {
      const dcost = distCostByDist[bestDist[i]];
      if (refine) {
        if (bl <= 128) {
          for (let l = 3; l <= bl; l++) {
            const c = base + lenCost[l] + dcost;
            if (c < dp[i + l]) {
              dp[i + l] = c;
              choiceLen[i + l] = l;
              choiceDist[i + l] = bestDist[i];
            }
          }
        } else {
          for (const l of [3, 32, 64, 96, 128, bl]) {
            const c = base + lenCost[l] + dcost;
            if (c < dp[i + l]) {
              dp[i + l] = c;
              choiceLen[i + l] = l;
              choiceDist[i + l] = bestDist[i];
            }
          }
        }
      } else {
        for (const l of [3, bl]) {
          const c = base + lenCost[l] + dcost;
          if (c < dp[i + l]) {
            dp[i + l] = c;
            choiceLen[i + l] = l;
            choiceDist[i + l] = bestDist[i];
          }
        }
      }
    }
  }
  const opLen = new Int32Array(n + 1);
  const opDist = new Int32Array(n + 1);
  const litFreq = new Array<number>(288).fill(0);
  const distFreq = new Array<number>(30).fill(0);
  let count = 0;
  let pos = n;
  while (pos > 0) {
    const l = choiceLen[pos];
    if (l === 0) {
      opLen[count] = 0;
      opDist[count] = data[pos - 1];
      litFreq[data[pos - 1]]++;
      pos -= 1;
    } else {
      opLen[count] = l;
      opDist[count] = choiceDist[pos];
      litFreq[257 + lenSymbolOf(l)]++;
      distFreq[distSymbolOf(choiceDist[pos])]++;
      pos -= l;
    }
    count++;
  }
  litFreq[256]++;
  for (let a = 0, b = count - 1; a < b; a++, b--) {
    const tl = opLen[a];
    const td = opDist[a];
    opLen[a] = opLen[b];
    opDist[a] = opDist[b];
    opLen[b] = tl;
    opDist[b] = td;
  }
  return { opLen, opDist, opCount: count, litFreq, distFreq };
}

function costsFromLengths(litLen: number[], distLen: number[]): {
  litCost: number[];
  lenCost: number[];
  distCostByDist: Int32Array;
} {
  const litCost = litLen.slice();
  const lenCost = new Array<number>(259).fill(0);
  for (let l = 3; l <= 258; l++) {
    const s = lenSymbolOf(l);
    lenCost[l] = litLen[257 + s] + LEN_EXTRA[s];
  }
  const distCostByDist = new Int32Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const s = distSymbolOf(d);
    distCostByDist[d] = distLen[s] + DIST_EXTRA[s];
  }
  return { litCost, lenCost, distCostByDist };
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Run-length encode a run of code lengths for a dynamic header. */
function rleCodeLengths(seq: number[]): { symbols: number[]; extras: number[] } {
  const symbols: number[] = [];
  const extras: number[] = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        symbols.push(18);
        extras.push(take - 11);
        left -= take;
      }
      if (left >= 3) {
        symbols.push(17);
        extras.push(left - 3);
        left = 0;
      }
      while (left > 0) {
        symbols.push(0);
        extras.push(0);
        left--;
      }
    } else {
      symbols.push(v);
      extras.push(0);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        symbols.push(16);
        extras.push(take - 3);
        left -= take;
      }
      while (left > 0) {
        symbols.push(v);
        extras.push(0);
        left--;
      }
    }
    i += run;
  }
  return { symbols, extras };
}

function emitDynamicBlock(
  bw: BitWriter,
  isLast: boolean,
  parsed: ParseResult,
  litLen: number[],
  distLen: number[],
): void {
  let hlit = 257;
  for (let i = 287; i >= 257; i--) {
    if (litLen[i] > 0) {
      hlit = i + 1;
      break;
    }
  }
  let hdist = 1;
  for (let i = 29; i >= 1; i--) {
    if (distLen[i] > 0) {
      hdist = i + 1;
      break;
    }
  }
  const seq = litLen.slice(0, hlit).concat(distLen.slice(0, hdist));
  const rle = rleCodeLengths(seq);
  const clFreq = new Array<number>(19).fill(0);
  for (const s of rle.symbols) clFreq[s]++;
  const clLen = buildLengths(clFreq, 7);
  let hclen = 4;
  for (let i = 18; i >= 4; i--) {
    if (clLen[CL_ORDER[i]] > 0) {
      hclen = i + 1;
      break;
    }
  }
  const clCode = canonicalCodes(clLen);
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  bw.writeBits(isLast ? 1 : 0, 1);
  bw.writeBits(2, 2);
  bw.writeBits(hlit - 257, 5);
  bw.writeBits(hdist - 1, 5);
  bw.writeBits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) bw.writeBits(clLen[CL_ORDER[i]], 3);
  for (let k = 0; k < rle.symbols.length; k++) {
    const s = rle.symbols[k];
    bw.writeBits(reverseBits(clCode[s], clLen[s]), clLen[s]);
    if (s === 16) bw.writeBits(rle.extras[k], 2);
    else if (s === 17) bw.writeBits(rle.extras[k], 3);
    else if (s === 18) bw.writeBits(rle.extras[k], 7);
  }
  for (let k = 0; k < parsed.opCount; k++) {
    const l = parsed.opLen[k];
    if (l === 0) {
      const sym = parsed.opDist[k];
      bw.writeBits(reverseBits(litCode[sym], litLen[sym]), litLen[sym]);
    } else {
      const s = lenSymbolOf(l);
      const sym = 257 + s;
      bw.writeBits(reverseBits(litCode[sym], litLen[sym]), litLen[sym]);
      if (LEN_EXTRA[s] > 0) bw.writeBits(l - LEN_BASE[s], LEN_EXTRA[s]);
      const d = parsed.opDist[k];
      const ds = distSymbolOf(d);
      bw.writeBits(reverseBits(distCode[ds], distLen[ds]), distLen[ds]);
      if (DIST_EXTRA[ds] > 0) bw.writeBits(d - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.writeBits(reverseBits(litCode[256], litLen[256]), litLen[256]);
}

function emitFixedBlock(bw: BitWriter, isLast: boolean, parsed: ParseResult): void {
  const litCode = canonicalCodes(FIXED_LIT_LEN);
  const distCode = canonicalCodes(FIXED_DIST_LEN);
  bw.writeBits(isLast ? 1 : 0, 1);
  bw.writeBits(1, 2);
  for (let k = 0; k < parsed.opCount; k++) {
    const l = parsed.opLen[k];
    if (l === 0) {
      const sym = parsed.opDist[k];
      bw.writeBits(reverseBits(litCode[sym], FIXED_LIT_LEN[sym]), FIXED_LIT_LEN[sym]);
    } else {
      const s = lenSymbolOf(l);
      const sym = 257 + s;
      bw.writeBits(reverseBits(litCode[sym], FIXED_LIT_LEN[sym]), FIXED_LIT_LEN[sym]);
      if (LEN_EXTRA[s] > 0) bw.writeBits(l - LEN_BASE[s], LEN_EXTRA[s]);
      const d = parsed.opDist[k];
      const ds = distSymbolOf(d);
      bw.writeBits(reverseBits(distCode[ds], FIXED_DIST_LEN[ds]), FIXED_DIST_LEN[ds]);
      if (DIST_EXTRA[ds] > 0) bw.writeBits(d - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  bw.writeBits(reverseBits(litCode[256], FIXED_LIT_LEN[256]), FIXED_LIT_LEN[256]);
}

/**
 * One DEFLATE block, written into the shared bit stream: parse twice (fixed
 * costs, then dynamic costs from the first parse), emit the smaller of the
 * dynamic and fixed forms, or a stored block when neither compresses.
 */
function encodeBlockInto(bw: BitWriter, data: Uint8Array, isLast: boolean): void {
  const { bestLen, bestDist } = findMatches(data);
  const fixed = costsFromLengths(FIXED_LIT_LEN, FIXED_DIST_LEN);
  const first = parseBlock(data, bestLen, bestDist, fixed.litCost, fixed.lenCost, fixed.distCostByDist, false);
  const litLen1 = buildLengths(first.litFreq, 15);
  const distLen1 = buildLengths(first.distFreq, 15);
  if (first.distFreq.every((f) => f === 0)) distLen1[0] = 1;
  const second = costsFromLengths(litLen1, distLen1);
  const refined = parseBlock(data, bestLen, bestDist, second.litCost, second.lenCost, second.distCostByDist, true);
  const litLen2 = buildLengths(refined.litFreq, 15);
  const distLen2 = buildLengths(refined.distFreq, 15);
  if (refined.distFreq.every((f) => f === 0)) distLen2[0] = 1;
  // A third parse with the refined costs: the code lengths and the parse
  // settle toward each other, which is where the remaining points are.
  const third = costsFromLengths(litLen2, distLen2);
  const polished = parseBlock(data, bestLen, bestDist, third.litCost, third.lenCost, third.distCostByDist, true);
  const litLen = buildLengths(polished.litFreq, 15);
  const distLen = buildLengths(polished.distFreq, 15);
  if (polished.distFreq.every((f) => f === 0)) distLen[0] = 1;

  const dynWriter = new BitWriter();
  emitDynamicBlock(dynWriter, isLast, polished, litLen, distLen);
  const dyn = dynWriter.finish();
  const fixWriter = new BitWriter();
  emitFixedBlock(fixWriter, isLast, polished);
  const fix = fixWriter.finish();
  const storedLen = data.length + 5 * Math.max(1, Math.ceil(data.length / 65535)) + 1;
  if (storedLen < dyn.length && storedLen < fix.length) {
    bw.writeBits(isLast ? 1 : 0, 1);
    bw.writeBits(0, 2);
    bw.alignByte();
    let at = 0;
    do {
      const len = Math.min(65535, data.length - at);
      const lastPiece = at + len >= data.length;
      bw.bytes.push(lastPiece ? 1 : 0);
      bw.bytes.push(len & 0xff);
      bw.bytes.push((len >> 8) & 0xff);
      bw.bytes.push(~len & 0xff);
      bw.bytes.push((~len >> 8) & 0xff);
      for (let i = 0; i < len; i++) bw.bytes.push(data[at + i]);
      at += len;
    } while (at < data.length);
    return;
  }
  if (dyn.length <= fix.length) {
    emitDynamicBlock(bw, isLast, polished, litLen, distLen);
  } else {
    emitFixedBlock(bw, isLast, polished);
  }
}

const BLOCK_BYTES = 1048576;

/** Raw DEFLATE stream for a filtered image, split into fixed-size blocks. */
function deflateOptimal(raw: Uint8Array): Uint8Array {
  const bw = new BitWriter();
  let at = 0;
  while (at < raw.length) {
    const end = Math.min(raw.length, at + BLOCK_BYTES);
    encodeBlockInto(bw, raw.subarray(at, end), end >= raw.length);
    at = end;
  }
  return bw.finish();
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

function chunkOf(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function encodePng(width: number, height: number, rep: Reduced, deflated: Uint8Array, filtered: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = rep.colourType;
  const zlib = new Uint8Array(2 + deflated.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x9c;
  zlib.set(deflated, 2);
  new DataView(zlib.buffer).setUint32(2 + deflated.length, adler32(filtered));
  const chunks: Uint8Array[] = [chunkOf('IHDR', ihdr)];
  if (rep.palette !== null) chunks.push(chunkOf('PLTE', rep.palette));
  if (rep.trns !== null) chunks.push(chunkOf('tRNS', rep.trns));
  chunks.push(chunkOf('IDAT', zlib));
  chunks.push(chunkOf('IEND', new Uint8Array(0)));
  let size = 8;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function main(): void {
  const ids = readdirSync(INPUT_DIR)
    .sort()
    .filter((id) => /^i\d{3}$/.test(id));
  for (const id of ids) {
    const file = readFileSync(join(INPUT_DIR, id, 'image.png'));
    const { width, height, rgba } = decodePng(new Uint8Array(file));
    const rep = reduceImage(rgba);
    const best = screenFilters(rep.samples, width, height, rep.bpp);
    const own = deflateOptimal(best.raw);
    // A second candidate for the same filtered stream: the platform zlib at
    // level 9. Keep whichever raw DEFLATE stream is smaller. (zlib's output
    // is a zlib stream, so its 2-byte header and 4-byte Adler-32 trailer
    // are dropped to get the raw DEFLATE stream; the PNG writer adds its
    // own zlib wrapper and Adler-32.)
    const zipped = deflateSync(best.raw, { level: 9 });
    const zraw = zipped.subarray(2, zipped.length - 4);
    const useZlib = zraw.length < own.length;
    const deflated = useZlib ? zraw : own;
    const png = encodePng(width, height, rep, deflated, best.raw);
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
    console.log(`${id} type=${rep.colourType} filter=${best.name} encoder=${useZlib ? 'zlib-9' : 'own'} bytes=${png.length}`);
  }
}

main();
