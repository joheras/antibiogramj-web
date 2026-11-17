/* Image-processing algorithms of AntibiogramJ for the browser (OpenCV.js + TypeScript).
 *
 * Same algorithms as backend/app/cv/processing.py and matching.py, which are
 * themselves ports of the Java desktop application. Images are RGB, 8 bits per
 * channel, row-major (`Rgb`). This module has no DOM dependency so it can run
 * in a Web Worker or in Node (for validation against the Python version).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type CV = any;

export interface Rgb { width: number; height: number; data: Uint8Array } // length = w*h*3
export interface Circle { cx: number; cy: number; r: number }

const round2 = (x: number) => Math.round(x * 100) / 100;
export const asCircle = (cx: number, cy: number, r: number): Circle => ({ cx: round2(cx), cy: round2(cy), r: round2(r) });

// ------------------------------------------------------------------ Mat helpers
export function toMat(cv: CV, img: Rgb): any {
  const m = new cv.Mat(img.height, img.width, cv.CV_8UC3);
  m.data.set(img.data);
  return m;
}

export function fromMat(m: any): Rgb {
  return { width: m.cols, height: m.rows, data: new Uint8Array(m.data) };
}

function withMats<T>(fn: (track: <M>(m: M) => M) => T): T {
  const mats: any[] = [];
  try {
    return fn((m) => { mats.push(m); return m; });
  } finally {
    for (const m of mats) m.delete();
  }
}

export function resizeRgb(cv: CV, img: Rgb, width: number, height: number): Rgb {
  return withMats((t) => {
    const dst = t(new cv.Mat());
    cv.resize(t(toMat(cv, img)), dst, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
    return fromMat(dst);
  });
}

function downscale(cv: CV, img: Rgb, maxSide: number): { img: Rgb; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) return { img, scale: 1 };
  return { img: resizeRgb(cv, img, Math.round(img.width * scale), Math.round(img.height * scale)), scale };
}

// ------------------------------------------------------- mean-shift filtering
/* Port of cv::pyrMeanShiftFiltering(src, dst, sp, sr, maxLevel=1, termcrit(5 iterations, eps 1))
 * (opencv/modules/imgproc/src/segmentation.cpp), which OpenCV.js does not include.
 * The coarse level (half resolution, half spatial radius) is filtered entirely; at
 * full resolution only pixels near colour edges of the coarse result are filtered
 * again, the rest keep the up-sampled colour. */

/** OpenCV's cvRound: round half to even. */
function cvRound(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function meanShiftPixels(src: Uint8Array, w: number, h: number, sp: number, sr: number,
                         dst: Uint8Array, mask: Uint8Array | null): void {
  const isr2 = cvRound(sr * sr);
  const maxIter = 5, eps = 1;
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const p = i * w + j;
      if (mask && !mask[p]) continue;
      let x0 = j, y0 = i;
      let c0 = src[p * 3], c1 = src[p * 3 + 1], c2 = src[p * 3 + 2];
      for (let iter = 0; iter < maxIter; iter++) {
        const minx = Math.max(cvRound(x0 - sp), 0), miny = Math.max(cvRound(y0 - sp), 0);
        const maxx = Math.min(cvRound(x0 + sp), w - 1), maxy = Math.min(cvRound(y0 + sp), h - 1);
        let s0 = 0, s1 = 0, s2 = 0, sx = 0, sy = 0, count = 0;
        for (let y = miny; y <= maxy; y++) {
          let q = (y * w + minx) * 3;
          for (let x = minx; x <= maxx; x++, q += 3) {
            const t0 = src[q], t1 = src[q + 1], t2 = src[q + 2];
            const d0 = t0 - c0, d1 = t1 - c1, d2 = t2 - c2;
            if (d0 * d0 + d1 * d1 + d2 * d2 <= isr2) {
              s0 += t0; s1 += t1; s2 += t2; sx += x; sy += y; count++;
            }
          }
        }
        if (count === 0) break;
        const icount = 1 / count;
        const x1 = cvRound(sx * icount), y1 = cvRound(sy * icount);
        const n0 = cvRound(s0 * icount), n1 = cvRound(s1 * icount), n2 = cvRound(s2 * icount);
        const stop = (x0 === x1 && y0 === y1) || Math.abs(x1 - x0) + Math.abs(y1 - y0)
          + (n0 - c0) ** 2 + (n1 - c1) ** 2 + (n2 - c2) ** 2 <= eps;
        x0 = x1; y0 = y1; c0 = n0; c1 = n1; c2 = n2;
        if (stop) break;
      }
      dst[p * 3] = c0; dst[p * 3 + 1] = c1; dst[p * 3 + 2] = c2;
    }
  }
}

export function pyrMeanShiftFiltering(cv: CV, img: Rgb, sp = 11, sr = 21): Rgb {
  return withMats((t) => {
    const src0 = t(toMat(cv, img));
    const w = img.width, h = img.height;
    const src1 = t(new cv.Mat());
    cv.pyrDown(src0, src1, new cv.Size(Math.floor((w + 1) / 2), Math.floor((h + 1) / 2)));
    const coarse = fromMat(src1);
    const cw = coarse.width, ch = coarse.height;
    const cd = new Uint8Array(coarse.data.length);
    meanShiftPixels(coarse.data, cw, ch, Math.max(sp / 2, 1), sr, cd, null);

    const up = t(new cv.Mat());
    cv.pyrUp(t(toMat(cv, { ...coarse, data: cd })), up, new cv.Size(w, h));
    const out = new Uint8Array(up.data);

    // Coarse pixels whose colour differs from one of their 8 neighbours mark the full-resolution pixel
    // (2i+1, 2j-1), as OpenCV does (checked pixel by pixel against cv2).
    const isr22 = Math.max(cvRound(sr * sr), 16);
    const mask = t(cv.Mat.zeros(h, w, cv.CV_8UC1));
    const md = mask.data as Uint8Array;
    const offsets = [-3, 3, -cw * 3 - 3, -cw * 3, -cw * 3 + 3, cw * 3 - 3, cw * 3, cw * 3 + 3];
    for (let i = 1; i < ch - 1; i++) {
      for (let j = 1; j < cw - 1; j++) {
        const q = (i * cw + j) * 3;
        const c0 = cd[q], c1 = cd[q + 1], c2 = cd[q + 2];
        for (const o of offsets) {
          if ((c0 - cd[q + o]) ** 2 + (c1 - cd[q + o + 1]) ** 2 + (c2 - cd[q + o + 2]) ** 2 >= isr22) {
            const fy = 2 * i + 1, fx = 2 * j - 1;
            if (fy < h && fx < w) md[fy * w + fx] = 1;
            break;
          }
        }
      }
    }
    const dilated = t(new cv.Mat());
    cv.dilate(mask, dilated, t(cv.Mat.ones(3, 3, cv.CV_8U)));
    meanShiftPixels(img.data, w, h, sp, sr, out, dilated.data as Uint8Array);
    return { width: w, height: h, data: out };
  });
}

/** Mean-shift + Gaussian blur + V channel of HSV. */
function smoothedValueChannel(cv: CV, img: Rgb): any {
  const shifted = pyrMeanShiftFiltering(cv, img);
  return withMats((t) => {
    const blurred = t(new cv.Mat());
    cv.GaussianBlur(t(toMat(cv, shifted)), blurred, new cv.Size(11, 11), 0);
    return valueChannel(cv, blurred);
  });
}

function valueChannel(cv: CV, rgbMat: any): any {
  return withMats((t) => {
    const hsv = t(new cv.Mat());
    cv.cvtColor(rgbMat, hsv, cv.COLOR_RGB2HSV);
    const channels = t(new cv.MatVector());
    cv.split(hsv, channels);
    return channels.get(2); // caller owns it
  });
}

// ------------------------------------------------------------------ plate / crop
export function detectPlate(cv: CV, img: Rgb): Circle | null {
  const { img: small, scale } = downscale(cv, img, 800);
  return withMats((t) => {
    const v = t(smoothedValueChannel(cv, small));
    const circles = t(new cv.Mat());
    const minRadius = Math.floor(Math.min(v.rows, v.cols) / 4);
    cv.HoughCircles(v, circles, cv.HOUGH_GRADIENT, 1.2, 100, 100, 100, minRadius, 0);
    if (circles.cols === 0) return null;
    const [cx, cy, r] = circles.data32F;
    return asCircle(cx / scale, cy / scale, r / scale);
  });
}

export function crop(img: Rgb, x: number, y: number, w: number, h: number): Rgb {
  const x0 = Math.max(0, Math.trunc(x)), y0 = Math.max(0, Math.trunc(y));
  const x1 = Math.min(img.width, Math.trunc(x + w)), y1 = Math.min(img.height, Math.trunc(y + h));
  if (x1 - x0 < 10 || y1 - y0 < 10) throw new Error("Crop region is too small or outside the image");
  const out = new Uint8Array((x1 - x0) * (y1 - y0) * 3);
  for (let row = y0; row < y1; row++) {
    out.set(img.data.subarray((row * img.width + x0) * 3, (row * img.width + x1) * 3), (row - y0) * (x1 - x0) * 3);
  }
  return { width: x1 - x0, height: y1 - y0, data: out };
}

// --------------------------------------------------------------------- contrast
/** ImageJ "Enhance Contrast" (saturated=0.35) on an RGB image. */
export function enhanceContrast(img: Rgb, saturated = 0.35): Rgb {
  const n = img.width * img.height, d = img.data;
  const hist = new Float64Array(256);
  for (let p = 0; p < n; p++) {
    // OpenCV RGB2GRAY weights (fixed point as in cvtColor)
    hist[(d[p * 3] * 4899 + d[p * 3 + 1] * 9617 + d[p * 3 + 2] * 1868 + 8192) >> 14]++;
  }
  const threshold = (n * saturated) / 200;
  let lo = 0, hi = 255, cum = 0;
  for (lo = 0; lo < 256; lo++) { cum += hist[lo]; if (cum > threshold) break; }
  cum = 0;
  for (hi = 0; hi < 256; hi++) { cum += hist[hi]; if (cum >= n - threshold) break; }
  if (hi <= lo) return { ...img, data: new Uint8Array(d) };
  const lut = new Uint8Array(256);
  // np.clip(...).astype(np.uint8) truncates
  for (let i = 0; i < 256; i++) lut[i] = Math.trunc(Math.max(0, Math.min(255, ((i - lo) * 255) / (hi - lo))));
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = lut[d[i]];
  return { ...img, data: out };
}

// ----------------------------------------------------------------------- disks
export function detectDisks(cv: CV, img: Rgb): Circle[] {
  const { img: small, scale } = downscale(cv, img, 1200);
  return withMats((t) => {
    const v = t(smoothedValueChannel(cv, small));
    const mean = t(new cv.Mat()), std = t(new cv.Mat());
    cv.meanStdDev(v, mean, std);
    const tValue = Math.trunc(mean.data64F[0]) + Math.trunc(std.data64F[0]);
    const thresh = t(new cv.Mat());
    cv.threshold(v, thresh, tValue, 255, cv.THRESH_BINARY);
    const contours = t(new cv.MatVector()), hierarchy = t(new cv.Mat());
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const w = v.cols;
    const disks: Circle[] = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const rect = cv.boundingRect(c);
      if (rect.height > 0 && rect.width / rect.height > 0.8 && rect.width / rect.height < 1.2) {
        const { center, radius } = cv.minEnclosingCircle(c);
        if (radius > w * 0.03 && radius < w * 0.05) disks.push(asCircle(center.x / scale, center.y / scale, radius / scale));
      }
      c.delete();
    }
    disks.sort((a, b) => Math.round(a.cy / (a.r * 2)) - Math.round(b.cy / (b.r * 2)) || a.cx - b.cx);
    return disks;
  });
}

export function diskCrop(img: Rgb, d: Circle): Rgb | null {
  const x = Math.round(d.cx - d.r), y = Math.round(d.cy - d.r), s = Math.round(2 * d.r);
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(img.width, x + s), y1 = Math.min(img.height, y + s);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return crop(img, x0, y0, x1 - x0, y1 - y0);
}

// ------------------------------------------------------------ letters on disks
function goodContour(x: number, y: number, w: number, h: number, wi: number, hi: number): boolean {
  if (h + y > 0.95 * hi || w + x > 0.95 * wi || y < 0.05 * hi || x < 0.05 * wi) return false;
  return !(w < 0.1 * wi && h < 0.1 * hi);
}

/** Keep only the code printed on an antibiotic disk (Processing.keepOnlyLetters). */
export function keepOnlyLetters(cv: CV, img: Rgb): Rgb {
  return withMats((t) => {
    const src = t(toMat(cv, img));
    const w = img.width, h = img.height;
    const v = t(valueChannel(cv, src));
    const mask = t(cv.Mat.zeros(h, w, cv.CV_8UC1));
    cv.circle(mask, new cv.Point(Math.floor(w / 2), Math.floor(h / 2)), Math.trunc((Math.min(w, h) / 2) * 0.95),
      new cv.Scalar(255), -1);
    cv.bitwise_and(v, mask, v);
    cv.adaptiveThreshold(v, v, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, 5);
    const contours = t(new cv.MatVector()), hierarchy = t(new cv.Mat());
    cv.findContours(t(v.clone()), contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const candidates = t(cv.Mat.zeros(h, w, cv.CV_8UC3));
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      if (goodContour(r.x, r.y, r.width, r.height, w, h)) {
        const hull = new cv.Mat();
        cv.convexHull(c, hull);
        const hulls = new cv.MatVector();
        hulls.push_back(hull);
        cv.drawContours(candidates, hulls, -1, new cv.Scalar(255, 255, 255), -1);
        hulls.delete();
        hull.delete();
      }
      c.delete();
    }
    const out = t(new cv.Mat());
    cv.bitwise_and(src, candidates, out);
    return fromMat(out);
  });
}

// ---------------------------------------------------------------------- matching
export type Descriptors = any; // cv.Mat (CV_32F) or null

export function descriptors(cv: CV, lettersOnly: Rgb): Descriptors | null {
  return withMats((t) => {
    const v = t(valueChannel(cv, t(toMat(cv, lettersOnly))));
    const orb = t(new cv.ORB());
    const kp = t(new cv.KeyPointVector());
    const desc = t(new cv.Mat());
    orb.detect(v, kp, t(new cv.Mat()));
    orb.compute(v, kp, desc);
    if (desc.rows === 0) return null;
    const f = new cv.Mat();
    desc.convertTo(f, cv.CV_32F);
    return f;
  });
}

const RATIO = 0.7, MIN_MATCHES = 10;

export function countGoodMatches(cv: CV, d1: Descriptors | null, d2: Descriptors | null): number {
  if (!d1 || !d2 || d1.rows === 0 || d2.rows < 2) return 0;
  return withMats((t) => {
    const matcher = t(new cv.BFMatcher(cv.NORM_L1, false));
    const matches = t(new cv.DMatchVectorVector());
    matcher.knnMatch(d1, d2, matches, 2);
    let good = 0;
    for (let i = 0; i < matches.size(); i++) {
      const pair = matches.get(i);
      if (pair.size() >= 2) {
        const a = pair.get(0).distance, b = pair.get(1).distance;
        if (b !== 0 && a / b < RATIO) good++;
      }
      pair.delete();
    }
    return good > MIN_MATCHES ? good : 0;
  });
}

export interface Template { antibioticId: number; desc: Descriptors | null }

export function bestMatch(cv: CV, disk: Rgb, templates: Template[]): { antibioticId: number | null; score: number } {
  const desc = descriptors(cv, keepOnlyLetters(cv, disk));
  try {
    const scores = new Map<number, number>();
    for (const tpl of templates) {
      const n = countGoodMatches(cv, desc, tpl.desc);
      if (n) scores.set(tpl.antibioticId, (scores.get(tpl.antibioticId) ?? 0) + n);
    }
    let best: number | null = null, score = 0;
    for (const [id, s] of scores) if (s > score) { best = id; score = s; }
    return { antibioticId: best, score };
  } finally {
    desc?.delete();
  }
}

// -------------------------------------------------------------------- halos
/** HSB brightness (= max(R, G, B)) of every pixel. */
export function brightness(img: Rgb): Uint8Array {
  const n = img.width * img.height, d = img.data, out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = Math.max(d[p * 3], d[p * 3 + 1], d[p * 3 + 2]);
  return out;
}

export function meanOf(values: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

/** Inhibition-zone detection (Processing.haloDetection); see processing.py::detect_halo. */
export function detectHalo(bright: Uint8Array, w: number, h: number, disk: Circle, globalMean: number,
                           step = 5, maxIter = 50): Circle {
  const m = Math.min(w, h);
  const pc = Math.trunc(0.05 * m + 0.425 * m), pr = Math.trunc(0.425 * m); // plate mask (ellipse == circle)
  let r = disk.r * 1.05;
  let oldMean = 0;
  for (let i = 0; i < maxIter; i++) {
    const outer = r + step;
    const x0 = Math.max(0, Math.floor(disk.cx - outer)), x1 = Math.min(w - 1, Math.ceil(disk.cx + outer));
    const y0 = Math.max(0, Math.floor(disk.cy - outer)), y1 = Math.min(h - 1, Math.ceil(disk.cy + outer));
    let sum = 0, count = 0;
    const r2 = r * r, o2 = outer * outer;
    for (let y = y0; y <= y1; y++) {
      const dy = y - disk.cy, py = y - pc;
      for (let x = x0; x <= x1; x++) {
        const dx = x - disk.cx, d2 = dx * dx + dy * dy;
        if (d2 >= r2 && d2 < o2) {
          const px = x - pc;
          if (px * px + py * py <= pr * pr) { sum += bright[y * w + x]; count++; }
        }
      }
    }
    if (count === 0) break;
    const mean2 = sum / count;
    if (i === 0) {
      oldMean = mean2;
      if (globalMean + 20 < mean2) return { ...disk };
    } else if (mean2 - oldMean > 2) {
      return { cx: disk.cx, cy: disk.cy, r: Math.max(disk.r, r - step) };
    }
    r += step;
    oldMean = mean2;
  }
  return { cx: disk.cx, cy: disk.cy, r };
}

// ------------------------------------------------------------- photo quality
/* Photo quality checks right after the upload; see backend/app/cv/quality.py (same algorithm,
 * thresholds and rounding). */
export interface QualityMetrics {
  plate_found: boolean; plate_diameter_px: number | null; plate_fraction: number | null;
  outside_fraction: number; sharpness: number; glare_fraction: number; width: number; height: number;
}

const QUALITY = {
  analysisDiameter: 800, inner: 0.85, minSharpness: 19, maxGlare: 0.003, saturated: 250,
  minPlateDiameter: 700, minPlateFraction: 0.6, maxOutside: 0.08, diskFraction: 6 / 90,
};

const roundTo = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/** numpy.percentile (linear interpolation) of sorted values. */
function percentileSorted(sorted: ArrayLike<number>, q: number): number {
  if (!sorted.length) return 0;
  const pos = (q / 100) * (sorted.length - 1), lo = Math.floor(pos), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Saturated pixels outside round, disk-sized blobs (8-connected components), as a fraction of ``area``. */
function glareFraction(sat: Uint8Array, w: number, h: number, area: number, plateR: number): number {
  const diskArea = Math.PI * (QUALITY.diskFraction * plateR) ** 2;
  const seen = new Uint8Array(w * h), stack: number[] = [];
  let glare = 0;
  for (let start = 0; start < w * h; start++) {
    if (!sat[start] || seen[start]) continue;
    let a = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p - x) / w;
      a++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, q = ny * w + nx;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && sat[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
    if (a <= 1.5 * diskArea && a / (Math.PI * (side / 2) ** 2) > 0.5) continue; // an over-exposed disk
    glare += a;
  }
  return area ? glare / area : 0;
}

export function photoQuality(cv: CV, img: Rgb, plate: Circle | null): { warnings: string[]; metrics: QualityMetrics } {
  const { width: w, height: h } = img;
  const [cx, cy, r] = plate ? [plate.cx, plate.cy, plate.r] : [w / 2, h / 2, Math.min(w, h) / 2];
  const scale = Math.min(1, QUALITY.analysisDiameter / (2 * r));
  const small = scale >= 1 ? img : resizeRgb(cv, img, Math.round(w * scale), Math.round(h * scale));
  const sw = small.width, sh = small.height, d = small.data;
  const rr = QUALITY.inner * r * scale, scx = cx * scale, scy = cy * scale;

  const gray = new Uint8Array(sw * sh);
  for (let p = 0; p < sw * sh; p++) gray[p] = (d[p * 3] * 4899 + d[p * 3 + 1] * 9617 + d[p * 3 + 2] * 1868 + 8192) >> 14;
  const magnitudes: number[] = [], levels: number[] = [];
  const sat = new Uint8Array(sw * sh);
  let area = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      if ((x - scx) ** 2 + (y - scy) ** 2 >= rr * rr) continue;
      const p = y * sw + x;
      area++;
      const g = (o: number) => gray[p + o];
      const gx = g(-sw + 1) - g(-sw - 1) + 2 * (g(1) - g(-1)) + g(sw + 1) - g(sw - 1);
      const gy = g(sw - 1) - g(-sw - 1) + 2 * (g(sw) - g(-sw)) + g(sw + 1) - g(-sw + 1);
      magnitudes.push(Math.sqrt(gx * gx + gy * gy));
      levels.push(gray[p]);
      if (Math.min(d[p * 3], d[p * 3 + 1], d[p * 3 + 2]) >= QUALITY.saturated) sat[p] = 1;
    }
  }
  const byValue = (a: number, b: number) => a - b;
  levels.sort(byValue);
  magnitudes.sort(byValue);
  const contrast = Math.max(1, percentileSorted(levels, 99) - percentileSorted(levels, 1));
  const sharpness = (10 * percentileSorted(magnitudes, 99.9)) / contrast;
  const glare = glareFraction(sat, sw, sh, area, rr / QUALITY.inner);
  const outside = plate ? Math.max(0, r - cx, r - cy, cx + r - w, cy + r - h) / r : 0;

  const metrics: QualityMetrics = {
    plate_found: !!plate, plate_diameter_px: plate ? Math.round(2 * r) : null,
    plate_fraction: plate ? roundTo((2 * r) / Math.min(w, h), 3) : null, outside_fraction: roundTo(outside, 3),
    sharpness: roundTo(sharpness, 2), glare_fraction: roundTo(glare, 4), width: w, height: h,
  };
  return { warnings: qualityWarnings(metrics), metrics };
}

export function qualityWarnings(m: QualityMetrics): string[] {
  const out: string[] = [];
  if (!m.plate_found) out.push("plate_not_found");
  else {
    if (m.outside_fraction > QUALITY.maxOutside) out.push("plate_cut");
    if (m.plate_fraction! < QUALITY.minPlateFraction) out.push("plate_small");
  }
  if ((m.plate_diameter_px ?? Math.min(m.width, m.height)) < QUALITY.minPlateDiameter) out.push("low_resolution");
  if (m.sharpness < QUALITY.minSharpness) out.push("blur");
  if (m.glare_fraction > QUALITY.maxGlare) out.push("glare");
  return out;
}
