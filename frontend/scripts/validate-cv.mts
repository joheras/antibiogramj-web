// Checks that the in-browser image analysis (src/browser/cv.ts, OpenCV.js, and the disk-code OCR
// src/browser/ocr.ts, onnxruntime-web/WASM) gives the same results as the Python backend on
// backend/tests/images/1.tiff, and reports the OCR time per disk.
//   node --experimental-strip-types scripts/validate-cv.mts
// Regenerate the reference with backend/scripts/cv_reference.py.
import fs from "node:fs";
import { createRequire } from "node:module";
import * as ort from "onnxruntime-web";
import * as C from "../src/browser/cv.ts";
import { DiskReader, type LexiconEntry } from "../src/browser/ocr.ts";

const require = createRequire(import.meta.url);
const UTIF = require("utif");
const cvModule = require("@techstark/opencv-js");
// The module is a thenable: never resolve a promise with it (see src/browser/worker.ts).
const { cv } = await new Promise<{ cv: C.CV }>((resolve) => {
  if (cvModule.Mat) resolve({ cv: cvModule });
  else cvModule.onRuntimeInitialized = () => resolve({ cv: cvModule });
});

const root = new URL("../../", import.meta.url).pathname;
function read(path: string): C.Rgb {
  const buf = fs.readFileSync(path);
  const ifd = UTIF.decode(buf)[0];
  UTIF.decodeImage(buf, ifd);
  const rgba = UTIF.toRGBA8(ifd), n = ifd.width * ifd.height, data = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { data[i * 3] = rgba[i * 4]; data[i * 3 + 1] = rgba[i * 4 + 1]; data[i * 3 + 2] = rgba[i * 4 + 2]; }
  return { width: ifd.width, height: ifd.height, data };
}

const ref = JSON.parse(fs.readFileSync(new URL("./cv-reference.json", import.meta.url), "utf8"));
const tplDir = root + "backend/seed/templates/";
const templates: C.Template[] = fs.readdirSync(tplDir).flatMap((d) =>
  fs.readdirSync(tplDir + d).map((f) => ({ antibioticId: Number(d), desc: C.descriptors(cv, read(`${tplDir}${d}/${f}`)) })));

const failures: string[] = [];
const near = (a: number, b: number, tol: number, what: string) => {
  if (Math.abs(a - b) > tol) failures.push(`${what}: ${a} vs ${b}`);
};

const image = read(root + "backend/tests/images/1.tiff");
const plate = C.detectPlate(cv, image)!;
for (const k of ["cx", "cy", "r"] as const) near(plate[k], ref.plate[k], 2, `plate.${k}`);
// The sample photo is good: no quality warnings, and the same measures as Python.
const quality = C.photoQuality(cv, image, plate);
if (quality.warnings.length || ref.quality.warnings.length) failures.push(`quality warnings: ${quality.warnings} vs ${ref.quality.warnings}`);
near(quality.metrics.sharpness, ref.quality.metrics.sharpness, 0.5, "quality.sharpness");
near(quality.metrics.glare_fraction, ref.quality.metrics.glare_fraction, 0.001, "quality.glare_fraction");
let c = C.crop(image, Math.round(plate.cx - plate.r), Math.round(plate.cy - plate.r), Math.round(2 * plate.r), Math.round(2 * plate.r));
const s = 1600 / Math.max(c.width, c.height);
c = C.enhanceContrast(C.resizeRgb(cv, c, Math.round(c.width * s), Math.round(c.height * s)));
const disks = C.detectDisks(cv, c);
if (disks.length !== ref.disks.length) failures.push(`disks: ${disks.length} vs ${ref.disks.length}`);
const bright = C.brightness(c), mean = C.meanOf(bright);
disks.slice(0, ref.disks.length).forEach((d, i) => {
  for (const k of ["cx", "cy", "r"] as const) near(d[k], ref.disks[i][k], 2, `disk ${i}.${k}`);
  const id = C.bestMatch(cv, C.diskCrop(c, d)!, templates).antibioticId;
  if (id !== ref.legacy_ids[i]) failures.push(`disk ${i} antibiotic: ${id} vs ${ref.legacy_ids[i]}`);
  near(C.detectHalo(bright, c.width, c.height, d, mean).r, ref.halo_r[i], 3, `disk ${i} halo`);
});

// OCR: same codes, in the same order, and nearly the same confidences as onnxruntime + OpenCV in Python.
ort.env.wasm.numThreads = 1; // as on GitHub Pages (no cross-origin isolation)
const session = await ort.InferenceSession.create(fs.readFileSync(root + "backend/seed/models/ppocr_rec.onnx"), { executionProviders: ["wasm"] });
const catalog = JSON.parse(fs.readFileSync(new URL("../src/browser/catalog.json", import.meta.url), "utf8"));
const lexicon: LexiconEntry[] = catalog.disk_codes.lexicon;
const reader = new DiskReader(cv, ort, session, lexicon);
let ms = 0;
for (const [i, d] of disks.slice(0, ref.ocr.length).entries()) {
  const t0 = performance.now();
  const r = await reader.read(C.diskCrop(c, d)!);
  ms += performance.now() - t0;
  const want = ref.ocr[i];
  const codes = r.candidates.map((x) => `${lexicon[x.entry].letters} ${lexicon[x.entry].content}`);
  if (codes[0] !== want.codes[0]) failures.push(`disk ${i} OCR: ${codes.join(", ")} vs ${want.codes.join(", ")}`);
  near(r.candidates[0]?.confidence ?? -99, want.confidence[0], 0.1, `disk ${i} OCR confidence`);
  // Auto-acceptance (confidence >= -2) must not change between the two versions.
  if ((r.candidates[0]?.confidence ?? -99) >= -2 !== want.confidence[0] >= -2) failures.push(`disk ${i} OCR acceptance differs`);
}
const msPerDisk = Math.round(ms / Math.min(disks.length, ref.ocr.length));

if (failures.length) {
  console.error("FAILED\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(`OK: plate, photo quality, ${disks.length} disks, antibiotics, halos and OCR readings match the Python backend`);
console.log(`OCR (onnxruntime-web WASM, 1 thread): ${msPerDisk} ms per disk`);
