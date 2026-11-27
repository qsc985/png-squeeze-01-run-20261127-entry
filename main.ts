// png-squeeze-01: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
// Pipeline: decode the stored PNG, reduce the colour type (palette / grey /
// RGB(A) with a tRNS key where it holds the image exactly), choose filters per
// row from a small set of strategies screened by zlib, then compress the
// filtered data with an own optimal-parsing DEFLATE (hash-chain LZ77 +
// shortest-path parse + dynamic Huffman, in the manner of zopfli).
// Deterministic: every choice is a function of the input bytes only, budgeted
// by fixed work counts, never by the wall clock. Node 22, built-ins only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const WIDTH = 1280;
const HEIGHT = 720;

// ---------------------------------------------------------------------------
// PNG container: CRC-32, chunk assembly, decoding.
// ---------------------------------------------------------------------------
const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ASCII = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = PNG_SIG.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(PNG_SIG, 0);
  let at = PNG_SIG.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ASCII(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG file to RGBA (4 bytes a pixel). Supports colour types 0, 2, 3, 4, 6 at bit depth 8. */
function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = PNG_SIG.length;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      colourType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
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
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
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
// Image analysis: opaque / grey / colours (<=256) / single transparent key.
// ---------------------------------------------------------------------------
type Colour = { rgba: [number, number, number, number]; word: number; count: number };

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]] as [number, number, number, number], word: c, count: counts.get(c) as number };
    });
  }
  return { opaque, grey, colours };
}

/** The one fully transparent value the image may key by tRNS instead of an alpha channel. */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const lum = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

type Form = {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: (number | string)[];
};

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        colourType: 3,
        bpp: 1,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        filters: order === 'count' ? [0] : [0, 'minsum'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 4, 'minsum', 'pairs'] });
  return forms;
}

// ---------------------------------------------------------------------------
// Filtering.
// ---------------------------------------------------------------------------
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/** Filter `samples` by `choice` (a fixed type, 'minsum' or 'pairs') into a fresh raw buffer. */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const cost = choice === 'minsum' ? signedSum(trial[t]) : pairsOf(trial[t], seen, ++stamp);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Optimal-parsing DEFLATE (own implementation, in the manner of zopfli).
// ---------------------------------------------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const LEN_SYM = new Uint8Array(259);
for (let s = 0; s < 29; s++) {
  const end = s === 28 ? 258 : LEN_BASE[s + 1] - 1;
  for (let l = LEN_BASE[s]; l <= end; l++) LEN_SYM[l] = s;
}
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const DIST_SYM = new Uint16Array(32769);
for (let s = 0; s < 30; s++) {
  const end = s === 29 ? 32768 : DIST_BASE[s + 1] - 1;
  for (let d = DIST_BASE[s]; d <= end; d++) DIST_SYM[d] = s;
}
// Candidate match lengths: the maximum length of each length-symbol range.
const CANDIDATES: number[] = [];
for (let s = 0; s < 29; s++) CANDIDATES.push(s === 28 ? 258 : LEN_BASE[s + 1] - 1);
const FIXED_LITLEN = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LITLEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_DIST = new Uint8Array(30).fill(5);

const HASH_BITS = 17;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

function hash3(data: Uint8Array, i: number): number {
  const h = (data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2];
  return (Math.imul(h, 2654435761) >>> (32 - HASH_BITS)) & HASH_MASK;
}

/** Longest match (length, distance) at every position; window 32768, chain cap 32, early exit at length 64. */
function findMatches(data: Uint8Array): { len: Uint16Array; dist: Uint16Array } {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const len = new Uint16Array(n);
  const dist = new Uint16Array(n);
  const chain = 32;
  const good = 128;
  const maxLen = 258;
  for (let i = 0; i < n; i++) {
    if (i + 3 > n) break;
    const h = hash3(data, i);
    let cand = head[h];
    head[h] = i;
    prev[i] = cand;
    let best = 0;
    let bestDist = 0;
    const limit = Math.max(0, i - 32768);
    let tries = 0;
    let steps = 0;
    const maxPossible = Math.min(maxLen, n - i);
    const maxSteps = chain * 8;
    while (cand >= limit && tries < chain && steps < maxSteps) {
      steps++;
      // The hash only guarantees equal hashes, not equal bytes.
      if (data[cand] !== data[i] || data[cand + 1] !== data[i + 1] || data[cand + 2] !== data[i + 2]) {
        cand = prev[cand];
        continue;
      }
      tries++;
      let l = 3;
      const d = i - cand;
      const end = i + maxPossible;
      while (i + l < end && data[cand + l] === data[i + l]) l++;
      if (l > best) {
        best = l;
        bestDist = d;
        if (l >= maxPossible || l >= good) break;
      }
      cand = prev[cand];
    }
    if (best >= 3) {
      len[i] = best;
      dist[i] = bestDist;
    }
  }
  return { len, dist };
}

/** Optimal code lengths (max `maxBits`) from frequencies. */
function huffmanLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lens = new Uint8Array(n);
  let count = 0;
  let only = -1;
  for (let i = 0; i < n; i++) if (freq[i] > 0) { count++; only = i; }
  if (count === 0) return lens;
  if (count === 1) {
    lens[only] = 1;
    lens[only === 0 ? 1 : 0] = 1;
    return lens;
  }
  const heapF: number[] = [];
  const heapS: number[] = [];
  const push = (f: number, s: number): void => {
    heapF.push(f);
    heapS.push(s);
    let i = heapF.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
      [heapS[p], heapS[i]] = [heapS[i], heapS[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const topF = heapF[0];
    const topS = heapS[0];
    const lastF = heapF.pop() as number;
    const lastS = heapS.pop() as number;
    if (heapF.length > 0) {
      heapF[0] = lastF;
      heapS[0] = lastS;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
        [heapS[m], heapS[i]] = [heapS[i], heapS[m]];
        i = m;
      }
    }
    return [topF, topS];
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) push(freq[i], i);
  const children = new Map<number, [number, number]>();
  let nextId = n;
  while (heapF.length > 1) {
    const [f1, s1] = pop();
    const [f2, s2] = pop();
    const id = nextId++;
    children.set(id, [s1, s2]);
    push(f1 + f2, id);
  }
  const root = heapS[0];
  const stack: [number, number][] = [[root, 0]];
  while (stack.length > 0) {
    const [node, d] = stack.pop() as [number, number];
    if (node < n) {
      lens[node] = d;
      continue;
    }
    const ch = children.get(node) as [number, number];
    stack.push([ch[0], d + 1], [ch[1], d + 1]);
  }
  // Limit lengths to maxBits (zlib gen_bitlen's overflow fix, on the counts).
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (lens[i] > maxLen) maxLen = lens[i];
  if (maxLen > maxBits) {
    const bl = new Uint32Array(maxBits + 1);
    for (let i = 0; i < n; i++) {
      if (lens[i] > 0) bl[lens[i] > maxBits ? maxBits : lens[i]]++;
    }
    // Scaled Kraft sum; valid when <= 2^maxBits. Each move lowers it by one.
    let kraft = 0;
    for (let b = 1; b <= maxBits; b++) kraft += bl[b] * (1 << (maxBits - b));
    const target = 1 << maxBits;
    while (kraft > target) {
      let bits = maxBits - 1;
      while (bits > 0 && bl[bits] === 0) bits--;
      if (bits === 0 || bl[maxBits] === 0) break;
      bl[bits]--;
      bl[bits + 1] += 2;
      bl[maxBits]--;
      kraft -= 1;
    }
    const order: number[] = [];
    for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
    order.sort((a, b) => freq[b] - freq[a] || a - b);
    lens.fill(0);
    let idx = 0;
    for (let b = 1; b <= maxBits; b++) {
      for (let k = 0; k < bl[b]; k++) lens[order[idx++]] = b;
    }
  }
  return lens;
}

/** Canonical Huffman codes from lengths (bit-reversed for LSB-first packing). */
function canonicalCodes(lens: Uint8Array): { codes: Uint32Array; lens: Uint8Array } {
  const n = lens.length;
  const maxBits = Math.max(0, ...lens);
  const blCount = new Uint32Array(maxBits + 1);
  for (let i = 0; i < n; i++) blCount[lens[i]]++;
  blCount[0] = 0;
  const nextCode = new Uint32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const l = lens[i];
    if (l > 0) {
      let c = nextCode[l]++;
      let r = 0;
      for (let b = 0; b < l; b++) {
        r = (r << 1) | (c & 1);
        c >>>= 1;
      }
      codes[i] = r;
    }
  }
  return { codes, lens };
}

class BitWriter {
  bytes: number[] = [];
  acc = 0;
  nbits = 0;
  bits(value: number, len: number): void {
    this.acc |= (value & ((1 << len) - 1)) << this.nbits;
    this.nbits += len;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  result(): Uint8Array {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

type Ops = { starts: number[]; lens: number[]; dists: number[]; cost: number };

function costTables(litLens: Uint8Array, distLens: Uint8Array): { litCost: Float64Array; lenCost: Float64Array; distCost: Float64Array } {
  // A symbol the tree does not use costs the longest code in its tree, never zero.
  let maxLit = 1;
  for (let i = 0; i < 288; i++) if (litLens[i] > maxLit) maxLit = litLens[i];
  let maxDist = 1;
  for (let i = 0; i < 30; i++) if (distLens[i] > maxDist) maxDist = distLens[i];
  const litCost = new Float64Array(288);
  for (let i = 0; i < 288; i++) litCost[i] = litLens[i] === 0 ? maxLit : litLens[i];
  const lenCost = new Float64Array(259);
  lenCost[0] = lenCost[1] = lenCost[2] = Infinity;
  for (let l = 3; l <= 258; l++) {
    const s = LEN_SYM[l];
    lenCost[l] = (litLens[257 + s] === 0 ? maxLit : litLens[257 + s]) + LEN_EXTRA[s];
  }
  const distCost = new Float64Array(30);
  for (let i = 0; i < 30; i++) distCost[i] = (distLens[i] === 0 ? maxDist : distLens[i]) + DIST_EXTRA[i];
  return { litCost, lenCost, distCost };
}

/** Shortest-path parse of data[s..e): cheapest literal/match sequence.
 *  `allLengths` also tries every length 3..maxL (not only the symbol-range
 *  maxima), so a match can end exactly where the next good match starts. */
function optimalParse(data: Uint8Array, mlen: Uint16Array, mdist: Uint16Array, s: number, e: number, litCost: Float64Array, lenCost: Float64Array, distCost: Float64Array, allLengths = false): Ops {
  const n = e - s;
  const costs = new Float64Array(n + 1);
  costs.fill(Infinity);
  costs[0] = 0;
  const opLen = new Int16Array(n + 1);
  const opDist = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const base = costs[i];
    if (base === Infinity) continue;
    const pos = s + i;
    const lc = base + litCost[data[pos]];
    if (lc < costs[i + 1]) {
      costs[i + 1] = lc;
      opLen[i + 1] = 1;
      opDist[i + 1] = 0;
    }
    const L = mlen[pos];
    if (L >= 3) {
      const dc = distCost[DIST_SYM[mdist[pos]]];
      const maxL = Math.min(L, n - i);
      if (maxL >= 3) {
        if (allLengths) {
          for (let l = 3; l <= maxL; l++) {
            const nc = base + lenCost[l] + dc;
            if (nc < costs[i + l]) {
              costs[i + l] = nc;
              opLen[i + l] = l;
              opDist[i + l] = mdist[pos];
            }
          }
        } else {
          for (let c = 0; c < CANDIDATES.length; c++) {
            const l = CANDIDATES[c];
            if (l > maxL) break;
            const nc = base + lenCost[l] + dc;
            if (nc < costs[i + l]) {
              costs[i + l] = nc;
              opLen[i + l] = l;
              opDist[i + l] = mdist[pos];
            }
          }
          if (maxL !== CANDIDATES[CANDIDATES.length - 1] && !CANDIDATES.includes(maxL)) {
            const nc = base + lenCost[maxL] + dc;
            if (nc < costs[i + maxL]) {
              costs[i + maxL] = nc;
              opLen[i + maxL] = maxL;
              opDist[i + maxL] = mdist[pos];
            }
          }
        }
      }
    }
  }
  const starts: number[] = [];
  const lens: number[] = [];
  const dists: number[] = [];
  let j = n;
  while (j > 0) {
    const l = opLen[j];
    const d = opDist[j];
    starts.push(j - l);
    lens.push(l);
    dists.push(d);
    j -= l;
  }
  starts.reverse();
  lens.reverse();
  dists.reverse();
  return { starts, lens, dists, cost: costs[n] };
}

function frequencies(data: Uint8Array, s: number, ops: Ops): { litFreq: Uint32Array; distFreq: Uint32Array } {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let k = 0; k < ops.lens.length; k++) {
    const l = ops.lens[k];
    if (l === 1) litFreq[data[s + ops.starts[k]]]++;
    else {
      litFreq[257 + LEN_SYM[l]]++;
      distFreq[DIST_SYM[ops.dists[k]]]++;
    }
  }
  litFreq[256] = 1;
  return { litFreq, distFreq };
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitDynamic(w: BitWriter, data: Uint8Array, s: number, ops: Ops, litLens: Uint8Array, distLens: Uint8Array): void {
  const { codes: litCodes } = canonicalCodes(litLens);
  const { codes: distCodes } = canonicalCodes(distLens);
  let hlit = 29;
  while (hlit > 0 && litLens[256 + hlit] === 0) hlit--;
  let hdist = 29;
  while (hdist > 0 && distLens[hdist] === 0) hdist--;
  const hlitN = 257 + hlit;
  const hdistN = 1 + hdist;
  const all = new Uint8Array(hlitN + hdistN);
  all.set(litLens.subarray(0, hlitN), 0);
  all.set(distLens.subarray(0, hdistN), hlitN);
  const clFreq = new Uint32Array(19);
  const items: { sym: number; extra: number; extraBits: number }[] = [];
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        items.push({ sym: 18, extra: take - 11, extraBits: 7 });
        clFreq[18]++;
        r -= take;
      }
      if (r >= 3) {
        items.push({ sym: 17, extra: r - 3, extraBits: 3 });
        clFreq[17]++;
        r = 0;
      }
      while (r > 0) {
        items.push({ sym: 0, extra: 0, extraBits: 0 });
        clFreq[0]++;
        r--;
      }
    } else {
      items.push({ sym: v, extra: 0, extraBits: 0 });
      clFreq[v]++;
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        items.push({ sym: 16, extra: take - 3, extraBits: 2 });
        clFreq[16]++;
        r -= take;
      }
      while (r > 0) {
        items.push({ sym: v, extra: 0, extraBits: 0 });
        clFreq[v]++;
        r--;
      }
    }
    i += run;
  }
  const clLens = huffmanLengths(clFreq, 7);
  const { codes: clCodes } = canonicalCodes(clLens);
  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.bits(hlitN - 257, 5);
  w.bits(hdistN - 1, 5);
  w.bits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.bits(clLens[CL_ORDER[k]], 3);
  for (const it of items) {
    w.bits(clCodes[it.sym], clLens[it.sym]);
    if (it.extraBits > 0) w.bits(it.extra, it.extraBits);
  }
  for (let k = 0; k < ops.lens.length; k++) {
    const l = ops.lens[k];
    if (l === 1) {
      const sym = data[s + ops.starts[k]];
      w.bits(litCodes[sym], litLens[sym]);
    } else {
      const ls = LEN_SYM[l];
      w.bits(litCodes[257 + ls], litLens[257 + ls]);
      if (LEN_EXTRA[ls] > 0) w.bits(l - LEN_BASE[ls], LEN_EXTRA[ls]);
      const d = ops.dists[k];
      const ds = DIST_SYM[d];
      w.bits(distCodes[ds], distLens[ds]);
      if (DIST_EXTRA[ds] > 0) w.bits(d - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.bits(litCodes[256], litLens[256]);
}

function emitFixed(w: BitWriter, data: Uint8Array, s: number, ops: Ops): void {
  const { codes: litCodes } = canonicalCodes(FIXED_LITLEN);
  const { codes: distCodes } = canonicalCodes(FIXED_DIST);
  for (let k = 0; k < ops.lens.length; k++) {
    const l = ops.lens[k];
    if (l === 1) {
      const sym = data[s + ops.starts[k]];
      w.bits(litCodes[sym], FIXED_LITLEN[sym]);
    } else {
      const ls = LEN_SYM[l];
      w.bits(litCodes[257 + ls], FIXED_LITLEN[257 + ls]);
      if (LEN_EXTRA[ls] > 0) w.bits(l - LEN_BASE[ls], LEN_EXTRA[ls]);
      const d = ops.dists[k];
      const ds = DIST_SYM[d];
      w.bits(distCodes[ds], FIXED_DIST[ds]);
      if (DIST_EXTRA[ds] > 0) w.bits(d - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.bits(litCodes[256], FIXED_LITLEN[256]);
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Compress `data` to a zlib stream with optimal parsing (200 KB blocks, one refinement pass). */
function deflateOptimal(data: Uint8Array): Uint8Array {
  const blockSize = 200000;
  const { len: mlen, dist: mdist } = findMatches(data);
  const bw = new BitWriter();
  const fixedTables = costTables(FIXED_LITLEN, FIXED_DIST);
  for (let s = 0; s < data.length; s += blockSize) {
    const e = Math.min(data.length, s + blockSize);
    const last = e === data.length;
    let ops = optimalParse(data, mlen, mdist, s, e, fixedTables.litCost, fixedTables.lenCost, fixedTables.distCost);
    const { litFreq, distFreq } = frequencies(data, s, ops);
    const litLens = huffmanLengths(litFreq, 15);
    const distLens = huffmanLengths(distFreq, 15);
    const t = costTables(litLens, distLens);
    // Refinement pass with dynamic costs: here alone, try every match length,
    // so a match can end exactly where the next good match starts. The first
    // pass and the fixed-cost comparison stay on the cheap candidate lengths.
    ops = optimalParse(data, mlen, mdist, s, e, t.litCost, t.lenCost, t.distCost, true);
    const f2 = frequencies(data, s, ops);
    const ll2 = huffmanLengths(f2.litFreq, 15);
    const dl2 = huffmanLengths(f2.distFreq, 15);
    const fixedOps = optimalParse(data, mlen, mdist, s, e, fixedTables.litCost, fixedTables.lenCost, fixedTables.distCost);
    const dynCost = ops.cost + 274;
    const fixedCost = fixedOps.cost + 3;
    bw.bits(last ? 1 : 0, 1);
    if (dynCost <= fixedCost) {
      bw.bits(2, 2);
      emitDynamic(bw, data, s, ops, ll2, dl2);
    } else {
      bw.bits(1, 2);
      emitFixed(bw, data, s, fixedOps);
    }
  }
  const deflated = bw.result();
  const out = new Uint8Array(2 + deflated.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(deflated, 2);
  const ad = adler32(data);
  out[2 + deflated.length] = (ad >>> 24) & 0xff;
  out[2 + deflated.length + 1] = (ad >>> 16) & 0xff;
  out[2 + deflated.length + 2] = (ad >>> 8) & 0xff;
  out[2 + deflated.length + 3] = ad & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Entry: screen forms/filters with zlib, write the winner with own deflate.
// ---------------------------------------------------------------------------
const SCREEN = { level: 6, memLevel: 8 };

function chunkBytes(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

function encodeImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  let best: { form: Form; data: Uint8Array; bytes: number } | null = null;
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  const winner = best as { form: Form; data: Uint8Array; bytes: number };
  const idat = deflateOptimal(winner.data);
  return pngOfForm(width, height, winner.form, idat);
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), encodeImage(image.rgba, image.width, image.height));
}
