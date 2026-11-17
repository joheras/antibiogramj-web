/* Reading the code printed on an antibiotic disk with a text recogniser (OCR) in the browser.
 *
 * Port of backend/app/cv/reading.py (see docs/disk-reading.md): same preprocessing
 * (OpenCV.js), same model (PP-OCRv3 recogniser, run with onnxruntime-web) and same
 * lexicon-constrained CTC decoding, so both versions give the same readings. Like
 * cv.ts it has no DOM dependency: it runs in the Web Worker and in Node (validation).
 */

import type { InferenceSession, Tensor } from "onnxruntime-web";
import type { CV, Rgb } from "./cv";

/* eslint-disable @typescript-eslint/no-explicit-any */
const SIZE = 400;          // disks are resampled to SIZE x SIZE pixels
const LINE_HEIGHT = 48;    // recogniser input height
const LENGTH_WEIGHT = 1;
const GLYPH_FRACTION = 0.2;
const STOP_AT = -0.5;      // stop the coarse orientation sweep at a reading this good
// Output classes of seed/models/ppocr_rec.onnx (backend/scripts/build_ocr_model.py): CTC blank + these.
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface LexiconEntry { name: string; letters: string; content: string }
export interface OcrCandidate { entry: number; confidence: number } // index into the lexicon
export interface OcrReading { candidates: OcrCandidate[]; freeText: string; angle: number }

/** The bits of onnxruntime-web used here (the browser and Node builds are loaded differently). */
export interface Ort {
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => Tensor;
}

type Mask = Uint8Array; // SIZE*SIZE, 1 = ink

// ------------------------------------------------------------------ numerics as numpy
/** Python's round(): half to even. */
const roundHalfEven = (x: number) => {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

function logaddexp(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));
}

function median(values: Float32Array): number {
  const s = Float32Array.from(values).sort();
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** numpy.percentile with linear interpolation on sorted data. */
function percentile(sorted: Float32Array, q: number): number {
  const pos = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ------------------------------------------------------------------ preprocessing
function withMats<T>(fn: (track: <M>(m: M) => M) => T): T {
  const mats: any[] = [];
  try {
    return fn((m) => { mats.push(m); return m; });
  } finally {
    for (const m of mats) m.delete();
  }
}

/** min(G, B) resampled to SIZE x SIZE (bilinear), as float32; and its morphological-closing background. */
function minGb(cv: CV, img: Rgb, blur: boolean): { g: Float32Array; bg: Float32Array } {
  return withMats((t) => {
    const n = img.width * img.height, small = new Uint8Array(n);
    for (let i = 0; i < n; i++) small[i] = Math.min(img.data[i * 3 + 1], img.data[i * 3 + 2]);
    const src = t(new cv.Mat(img.height, img.width, cv.CV_8UC1));
    src.data.set(small);
    const resized = t(new cv.Mat()), g = t(new cv.Mat());
    cv.resize(src, resized, new cv.Size(SIZE, SIZE), 0, 0, cv.INTER_LINEAR); // uint8 bilinear: bit-exact with OpenCV-Python (cubic is not)
    resized.convertTo(g, cv.CV_32F);
    if (blur) cv.GaussianBlur(g, g, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    const bg = t(new cv.Mat()), kernel = t(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(41, 41)));
    cv.morphologyEx(g, bg, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    return { g: Float32Array.from(g.data32F), bg: Float32Array.from(bg.data32F) };
  });
}

function circleMask(cv: CV, fraction: number): Uint8Array {
  return withMats((t) => {
    const m = t(cv.Mat.zeros(SIZE, SIZE, cv.CV_8UC1));
    cv.circle(m, new cv.Point(SIZE / 2, SIZE / 2), Math.trunc(SIZE * fraction), new cv.Scalar(255), -1);
    return Uint8Array.from(m.data, (v: number) => (v ? 1 : 0));
  });
}

/** Ink (1): darker than the disk's median by k robust standard deviations (MAD), after flat-fielding. */
export function robustBinary(cv: CV, img: Rgb, k = 3): Mask {
  const { g, bg } = minGb(cv, img, true);
  const inside = circleMask(cv, 0.43);
  const flat = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < flat.length; i++) flat[i] = (g[i] / Math.max(bg[i], 1)) * 255;
  const v = flat.filter((_, i) => inside[i]);
  const med = median(v);
  const mad = median(v.map((x) => Math.abs(x - med))) * 1.4826;
  const thr = med - Math.max(k * mad, 12);
  return Uint8Array.from(flat, (x, i) => (x < thr && inside[i] ? 1 : 0));
}

/** Flat-fielded, contrast-stretched grey disk (what the recogniser sees), white outside the disk. */
export function flatGray(cv: CV, img: Rgb): Uint8Array {
  const { g, bg } = minGb(cv, img, false);
  const flat = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < flat.length; i++) flat[i] = Math.min(255, Math.max(0, (g[i] / Math.max(bg[i], 1)) * 255));
  const sorted = Float32Array.from(flat).sort();
  const lo = percentile(sorted, 1), hi = percentile(sorted, 99);
  const circle = circleMask(cv, 0.45);
  return Uint8Array.from(flat, (x, i) => (circle[i] ? Math.trunc(Math.min(255, Math.max(0, ((x - lo) * 255) / Math.max(hi - lo, 1)))) : 255));
}

/** Ink components of the code: no specks, no orientation bar, near the centre. */
export function textMask(cv: CV, ink: Mask, maxDist = 0.36): Mask {
  return withMats((t) => {
    const src = t(new cv.Mat(SIZE, SIZE, cv.CV_8UC1));
    src.data.set(ink);
    const labels = t(new cv.Mat()), stats = t(new cv.Mat()), cents = t(new cv.Mat());
    const n: number = cv.connectedComponentsWithStats(src, labels, stats, cents, 8, cv.CV_32S);
    const lab: Int32Array = labels.data32S, st: Int32Array = stats.data32S, ce: Float64Array = cents.data64F;
    const keep = new Uint8Array(n);
    for (let i = 1; i < n; i++) {
      const [x, y, w, h, area] = st.subarray(i * 5, i * 5 + 5);
      if (area < SIZE * SIZE * 0.0005) continue;
      if (Math.hypot(ce[i * 2] - SIZE / 2, ce[i * 2 + 1] - SIZE / 2) >= maxDist * SIZE) continue;
      // Orientation bar: elongated component (minimum-area rectangle of its outer contour).
      const comp = t(cv.Mat.zeros(h + 2, w + 2, cv.CV_8UC1));
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++)
        if (lab[(y + yy) * SIZE + x + xx] === i) comp.data[(yy + 1) * (w + 2) + xx + 1] = 1;
      const contours = t(new cv.MatVector()), hierarchy = t(new cv.Mat());
      cv.findContours(comp, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const rect = cv.minAreaRect(t(contours.get(0)));
      const rw = rect.size.width, rh = rect.size.height;
      if (Math.max(rw, rh) / Math.max(1, Math.min(rw, rh)) > 3.5 && Math.max(rw, rh) > SIZE * 0.12) continue;
      keep[i] = 1;
    }
    return Uint8Array.from(lab, (l) => keep[l]);
  });
}

/** Number of glyphs: ink components that are not small fragments of a larger one. */
function countGlyphs(cv: CV, mask: Mask): number {
  return withMats((t) => {
    const src = t(new cv.Mat(SIZE, SIZE, cv.CV_8UC1));
    src.data.set(mask);
    const labels = t(new cv.Mat()), stats = t(new cv.Mat()), cents = t(new cv.Mat());
    const n: number = cv.connectedComponentsWithStats(src, labels, stats, cents, 8, cv.CV_32S);
    const areas: number[] = [];
    for (let i = 1; i < n; i++) areas.push(stats.data32S[i * 5 + 4]);
    const max = Math.max(0, ...areas);
    return areas.filter((a) => a >= GLYPH_FRACTION * max).length;
  });
}

function rotate(cv: CV, im: Uint8Array, angle: number, border: number): Uint8Array {
  return withMats((t) => {
    const src = t(new cv.Mat(SIZE, SIZE, cv.CV_8UC1)), dst = t(new cv.Mat());
    src.data.set(im);
    const m = t(cv.getRotationMatrix2D(new cv.Point(SIZE / 2, SIZE / 2), angle, 1));
    cv.warpAffine(src, dst, m, new cv.Size(SIZE, SIZE), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(border, border, border, border));
    return Uint8Array.from(dst.data);
  });
}

interface Crop { data: Uint8Array; width: number; height: number }

/** Line crops of the text block: as one line, and as two lines split at the row-profile valley. */
function layouts(mRot: Uint8Array, gRot: Uint8Array): Crop[][] {
  let count = 0, y0 = SIZE, y1 = -1, x0 = SIZE, x1 = -1;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (mRot[y * SIZE + x]) {
    count++;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  if (count < 20) return [];
  y1 += 1; x1 += 1;
  const h = y1 - y0;
  const pad = Math.max(4, Math.trunc(0.15 * h));
  const xa = Math.max(0, x0 - pad), xb = Math.min(SIZE, x1 + pad);
  const crop = (a: number, b: number, pa: number, pb: number): Crop => {
    const ya = Math.max(0, a - pa), yb = Math.min(SIZE, b + pb);
    const data = new Uint8Array((yb - ya) * (xb - xa));
    for (let y = ya; y < yb; y++) data.set(gRot.subarray(y * SIZE + xa, y * SIZE + xb), (y - ya) * (xb - xa));
    return { data, width: xb - xa, height: yb - ya };
  };
  const out = [[crop(y0, y1, pad, pad)]];
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < SIZE; x++) rows[y] += mRot[(y0 + y) * SIZE + x];
  // np.convolve(rows, ones(5) / 5, "same")
  const smooth = new Float64Array(h);
  for (let i = 0; i < h; i++) for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < h) smooth[i] += rows[j] / 5;
  const a = Math.trunc(0.25 * h), b = Math.trunc(0.75 * h);
  if (b - a > 3) {
    let best = a;
    for (let i = a; i < b; i++) if (smooth[i] < smooth[best]) best = i;
    const cut = y0 + best;
    out.push([crop(y0, cut, Math.floor(pad / 2), 2), crop(cut, y1, 2, Math.floor(pad / 2))]);
  }
  return out;
}

// ------------------------------------------------------------------ recogniser + CTC
type LogProbs = { T: number; C: number; data: Float64Array }; // (T, C) log-probabilities

/** CTC forward algorithm (blank = 0): log P(label | logp) for every label. */
export function ctcBatch(lp: LogProbs, labels: number[][]): Float64Array {
  const out = new Float64Array(labels.length);
  const maxS = 2 * Math.max(0, ...labels.map((l) => l.length)) + 1;
  let alpha = new Float64Array(maxS), next = new Float64Array(maxS);
  const ext = new Int32Array(maxS);
  labels.forEach((lab, k) => {
    if (lab.length === 0) {
      let s = 0;
      for (let t = 0; t < lp.T; t++) s += lp.data[t * lp.C];
      out[k] = s;
      return;
    }
    const S = 2 * lab.length + 1;
    ext.fill(0);
    for (let i = 0; i < lab.length; i++) ext[2 * i + 1] = lab[i];
    alpha.fill(-Infinity);
    alpha[0] = lp.data[0];
    alpha[1] = lp.data[ext[1]];
    for (let t = 1; t < lp.T; t++) {
      const row = t * lp.C;
      for (let s = 0; s < S; s++) {
        let a = alpha[s];
        if (s >= 1) a = logaddexp(a, alpha[s - 1]);
        if (s >= 2 && ext[s] !== 0 && ext[s] !== ext[s - 2]) a = logaddexp(a, alpha[s - 2]);
        next[s] = a + lp.data[row + ext[s]];
      }
      [alpha, next] = [next, alpha];
    }
    out[k] = logaddexp(alpha[S - 1], alpha[S - 2]);
  });
  return out;
}

export class DiskReader {
  private cv: CV;
  private ort: Ort;
  private session: InferenceSession;
  private lexicon: LexiconEntry[];
  private labels: number[][];
  private lengths: number[];
  private entries: number[]; // lexicon indices with a valid label

  // (no parameter properties: Node's type stripping, used by scripts/validate-cv.mts, does not support them)
  constructor(cv: CV, ort: Ort, session: InferenceSession, lexicon: LexiconEntry[]) {
    this.cv = cv; this.ort = ort; this.session = session; this.lexicon = lexicon;
    this.entries = [];
    this.labels = [];
    lexicon.forEach((e, i) => {
      const label = this.label(e.letters.replace("/", "") + e.content);
      if (label) { this.entries.push(i); this.labels.push(label); }
    });
    this.lengths = this.labels.map((l) => l.length);
  }

  private label(text: string): number[] | null {
    if (!text) return null;
    const ids = [...text].map((c) => CHARS.indexOf(c) + 1);
    return ids.some((i) => i === 0) ? null : ids;
  }

  private greedy(lp: LogProbs): string {
    let s = "", prev = 0;
    for (let t = 0; t < lp.T; t++) {
      let best = 0;
      for (let c = 1; c < lp.C; c++) if (lp.data[t * lp.C + c] > lp.data[t * lp.C + best]) best = c;
      if (best !== prev && best !== 0) s += CHARS[best - 1];
      prev = best;
    }
    return s;
  }

  /** Per line: (T, 1 + 36) log-probabilities. */
  private async logits(lines: Crop[]): Promise<LogProbs[]> {
    const { cv } = this;
    const widths = lines.map((im) => Math.max(1, Math.ceil((LINE_HEIGHT * im.width) / im.height)));
    const width = Math.max(...widths, LINE_HEIGHT);
    const plane = LINE_HEIGHT * width;
    const batch = new Float32Array(lines.length * 3 * plane);
    lines.forEach((im, k) => withMats((t) => {
      const src = t(new cv.Mat(im.height, im.width, cv.CV_8UC1)), dst = t(new cv.Mat());
      src.data.set(im.data);
      cv.resize(src, dst, new cv.Size(widths[k], LINE_HEIGHT), 0, 0, cv.INTER_LINEAR);
      for (let y = 0; y < LINE_HEIGHT; y++) for (let x = 0; x < widths[k]; x++) {
        const v = (Math.fround(dst.data[y * widths[k] + x] / 255) - 0.5) / 0.5;
        for (let c = 0; c < 3; c++) batch[(k * 3 + c) * plane + y * width + x] = v;
      }
    }));
    const input = new this.ort.Tensor("float32", batch, [lines.length, 3, LINE_HEIGHT, width]);
    const result = await this.session.run({ [this.session.inputNames[0]]: input });
    const out = result[this.session.outputNames[0]];
    const [, T, C] = out.dims as number[];
    const probs = out.data as Float32Array;
    return widths.map((w, k) => {
      const tk = Math.max(1, roundHalfEven((T * w) / width));
      const data = new Float64Array(tk * C);
      for (let t = 0; t < tk; t++) {
        let sum = 0;
        for (let c = 0; c < C; c++) sum += probs[(k * T + t) * C + c];
        for (let c = 0; c < C; c++) data[t * C + c] = Math.log(Math.max(probs[(k * T + t) * C + c] / Math.max(sum, 1e-9), 1e-9));
      }
      return { T: tk, C, data };
    });
  }

  async read(disk: Rgb, step = 20, top = 3): Promise<OcrReading> {
    const { cv } = this;
    if (!this.entries.length || !disk.width || !disk.height) return { candidates: [], freeText: "", angle: 0 };
    const mask = textMask(cv, robustBinary(cv, disk));
    const mask255 = Uint8Array.from(mask, (v) => v * 255);
    const gray = flatGray(cv, disk);
    const nGlyphs = countGlyphs(cv, mask);
    const prior = this.lengths.map((l) => -LENGTH_WEIGHT * Math.max(0, Math.abs(l - nGlyphs) - 1));
    const best = new Map<string, { score: number; j: number; angle: number; free: string }>();

    const evaluate = async (angle: number): Promise<number> => {
      const rotated = rotate(cv, mask255, angle, 0);
      const mRot = Uint8Array.from(rotated, (v) => (v > 127 ? 1 : 0));
      const gRot = rotate(cv, gray, angle, 255);
      let here = -Infinity;
      for (const lines of layouts(mRot, gRot)) {
        const logits = await this.logits(lines);
        const T = logits.reduce((s, l) => s + l.T, 0), C = logits[0].C;
        const seq: LogProbs = { T, C, data: new Float64Array(T * C) };
        let offset = 0;
        for (const l of logits) { seq.data.set(l.data, offset); offset += l.data.length; }
        const free = logits.map((l) => this.greedy(l)).join(" ");
        const ref = ctcBatch(seq, [this.label(free.replace(/ /g, "")) ?? []])[0];
        const ctc = ctcBatch(seq, this.labels);
        const scores = Array.from(ctc, (v, j) => v - ref + prior[j]);
        const order = scores.map((_, j) => j).sort((x, y) => scores[y] - scores[x]).slice(0, 5);
        for (const j of order) {
          const name = this.lexicon[this.entries[j]].name;
          const cur = best.get(name);
          if (!cur || scores[j] > cur.score) best.set(name, { score: scores[j], j, angle, free });
        }
        here = Math.max(here, ...scores);
      }
      return here;
    };

    let a0 = 0, bestCoarse = -Infinity;
    for (let a = 0; a < 360; a += step) {
      const s = await evaluate(a);
      if (s > bestCoarse) { bestCoarse = s; a0 = a; }
      if (s >= STOP_AT) break;
    }
    for (const d of [-step / 3, step / 3]) await evaluate((((a0 + d) % 360) + 360) % 360);
    if (!best.size) return { candidates: [], freeText: "", angle: 0 };
    const ranked = [...best.values()].sort((x, y) => y.score - x.score);
    return {
      candidates: ranked.slice(0, top).map((r) => ({ entry: this.entries[r.j], confidence: Math.round(Math.min(0, r.score) * 100) / 100 })),
      freeText: ranked[0].free,
      angle: ranked[0].angle,
    };
  }
}
