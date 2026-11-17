/// <reference lib="webworker" />
// Web Worker running the image analysis (OpenCV.js) off the main thread.
// It keeps the images of the plate being analysed in memory, keyed by upload id.

import cvModule from "@techstark/opencv-js";
import UTIF from "utif";
import * as C from "./cv";

export interface Annotation { disk: C.Circle; halo_r: number; code: string; category: string; s_r: number | null; r_r: number | null }

const MAX_PIXELS = 40_000_000;
/** Photos are reduced to this size as soon as they are decoded: phone cameras give 12-50 MP
 * images that would exhaust the memory of a phone (and iOS limits canvases to 16.7 MP).
 * The working image is at most 1600 px anyway; 4000 px leaves room to crop a plate that fills
 * only part of the photo without losing resolution (disk-code reading suffers below 1600 px). */
const MAX_SIDE = 4000;

type Report = (message: string) => void;

// The OpenCV.js module object is a "thenable" (Emscripten adds a `then` method), so it
// must never be the resolution value of a promise: resolving with it loops forever.
// It is therefore wrapped in an object.
let cvReady: Promise<{ cv: C.CV }> | null = null;
function loadCv(report?: Report): Promise<{ cv: C.CV }> {
  if (!cvReady && !(cvModule as C.CV).Mat) report?.("Starting the image-analysis engine…");
  cvReady ??= new Promise((resolve) => {
    const cv: C.CV = cvModule;
    if (cv.Mat) resolve({ cv });
    else cv.onRuntimeInitialized = () => resolve({ cv });
  });
  return cvReady;
}

const sessions = new Map<string, { original: C.Rgb; working?: C.Rgb }>();
let templates: C.Template[] | null = null;

// ------------------------------------------------------------------ image I/O
function rgbaToRgb(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): C.Rgb {
  const n = width * height, data = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    data[i * 3] = rgba[i * 4]; data[i * 3 + 1] = rgba[i * 4 + 1]; data[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { width, height, data };
}

function fitSize(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

/** Decodes an image file; with `maxSide`, large images are reduced while decoding. */
async function decode(blob: Blob, maxSide = Infinity): Promise<C.Rgb> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const isTiff = (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a);
  if (isTiff) {
    const buf = await blob.arrayBuffer();
    const ifds = UTIF.decode(buf);
    if (!ifds.length) throw new Error("The TIFF file contains no image");
    const ifd = ifds[0];
    if (ifd.width * ifd.height > MAX_PIXELS) throw new Error("The image resolution is too large");
    UTIF.decodeImage(buf, ifd);
    const rgb = rgbaToRgb(UTIF.toRGBA8(ifd), ifd.width, ifd.height);
    const size = fitSize(rgb.width, rgb.height, maxSide);
    if (size.scale === 1) return rgb;
    const { cv } = await loadCv();
    return C.resizeRgb(cv, rgb, size.width, size.height);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error("The file is not a supported image");
  }
  if (bitmap.width * bitmap.height > 4 * MAX_PIXELS) throw new Error("The image resolution is too large");
  // The full-resolution pixels are never copied: the bitmap is drawn reduced.
  const size = fitSize(bitmap.width, bitmap.height, maxSide);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  return rgbaToRgb(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
}

function toCanvas(img: C.Rgb): OffscreenCanvas {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const data = new ImageData(img.width, img.height);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    data.data[i * 4] = img.data[i * 3]; data.data[i * 4 + 1] = img.data[i * 3 + 1];
    data.data[i * 4 + 2] = img.data[i * 3 + 2]; data.data[i * 4 + 3] = 255;
  }
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  return canvas;
}

const encode = (img: C.Rgb, type = "image/png", quality?: number) => toCanvas(img).convertToBlob({ type, quality });

/** Disks, halos and breakpoint circles, with the colours of AntibiogramJ. */
function renderAnnotations(img: C.Rgb, items: Annotation[]): Promise<Blob> {
  const canvas = toCanvas(img);
  const ctx = canvas.getContext("2d")!;
  const lw = Math.max(2, Math.round(Math.min(img.width, img.height) / 400));
  const font = Math.max(14, Math.round(Math.min(img.width, img.height) / 50));
  const ring = (c: C.Circle, r: number, color: string) => {
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, r, 0, 2 * Math.PI);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.stroke();
  };
  for (const it of items) {
    if (it.r_r) ring(it.disk, it.r_r, "#ff0000");
    if (it.s_r) ring(it.disk, it.s_r, "#0000ff");
    ring(it.disk, it.disk.r, "#ff00ff");
    ring(it.disk, it.halo_r, "#ffff00");
    const label = `${it.code} ${it.category.slice(0, 1)}`.trim();
    ctx.font = `bold ${font}px sans-serif`;
    ctx.lineWidth = lw + 2;
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#fff";
    ctx.strokeText(label, it.disk.cx - it.disk.r, it.disk.cy - it.disk.r - 6);
    ctx.fillText(label, it.disk.cx - it.disk.r, it.disk.cy - it.disk.r - 6);
  }
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

// ------------------------------------------------------------------- commands
function session(id: string) {
  const s = sessions.get(id);
  if (!s) throw new Error("The image is no longer available; start the analysis again");
  return s;
}

function working(id: string): C.Rgb {
  const w = session(id).working;
  if (!w) throw new Error("The image has not been pre-processed yet");
  return w;
}

async function templateFromBlob(cv: C.CV, antibioticId: number, blob: Blob): Promise<C.Template> {
  return { antibioticId, desc: C.descriptors(cv, await decode(blob)) };
}

const commands = {
  async loadTemplates(args: { shared: { antibioticId: number; url: string }[]; learned: { antibioticId: number; blob: Blob }[] }) {
    const { cv } = await loadCv();
    if (templates) for (const t of templates) t.desc?.delete();
    const shared = await Promise.all(args.shared.map(async (t) => {
      const res = await fetch(t.url);
      if (!res.ok) throw new Error(`Cannot load ${t.url}`);
      return templateFromBlob(cv, t.antibioticId, await res.blob());
    }));
    const learned = await Promise.all(args.learned.map((t) => templateFromBlob(cv, t.antibioticId, t.blob)));
    templates = [...shared, ...learned];
    return templates.length;
  },

  async open(args: { uploadId: string; file: Blob }, report: Report) {
    const { cv } = await loadCv(report);
    sessions.clear(); // one plate at a time: free the previous images first
    report("Reading the image…");
    const original = await decode(args.file, MAX_SIDE);
    sessions.set(args.uploadId, { original });
    report("Locating the plate…");
    const plate = C.detectPlate(cv, original);
    report("Checking the photo quality…");
    const quality = C.photoQuality(cv, original, plate);
    // Only displayed (the analysis uses the pixels kept here): JPEG is much faster than PNG.
    return { width: original.width, height: original.height, plate, quality, png: await encode(original, "image/jpeg", 0.9) };
  },

  async process(args: { uploadId: string; crop: C.Circle | null; autoContrast: boolean; maxSide: number }, report: Report) {
    const { cv } = await loadCv(report);
    report("Pre-processing the image…");
    const s = session(args.uploadId);
    let img = s.original;
    if (args.crop) {
      const c = args.crop;
      img = C.crop(img, Math.round(c.cx - c.r), Math.round(c.cy - c.r), Math.round(2 * c.r), Math.round(2 * c.r));
    }
    const scale = args.maxSide / Math.max(img.width, img.height);
    if (scale < 1) img = C.resizeRgb(cv, img, Math.round(img.width * scale), Math.round(img.height * scale));
    if (args.autoContrast) img = C.enhanceContrast(img);
    s.working = img;
    return { width: img.width, height: img.height, png: await encode(img) };
  },

  async disks(args: { uploadId: string }, report: Report) {
    const { cv } = await loadCv(report);
    report("Detecting antibiotic disks…");
    return C.detectDisks(cv, working(args.uploadId));
  },

  async identify(args: { uploadId: string; disks: C.Circle[] }, report: Report) {
    const { cv } = await loadCv(report);
    if (!templates) throw new Error("Templates not loaded");
    const img = working(args.uploadId);
    return args.disks.map((d, i) => {
      report(`Reading the code of disk ${i + 1} of ${args.disks.length}…`);
      const c = C.diskCrop(img, d);
      return c ? C.bestMatch(cv, c, templates!) : { antibioticId: null, score: 0 };
    });
  },

  async halos(args: { uploadId: string; disks: C.Circle[] }) {
    const img = working(args.uploadId);
    const bright = C.brightness(img);
    const mean = C.meanOf(bright);
    return args.disks.map((d) => Math.round(C.detectHalo(bright, img.width, img.height, d, mean).r * 100) / 100);
  },

  /** Final images of a plate and the letters-only disk images to learn from. */
  async finish(args: { uploadId: string; annotations: Annotation[]; learn: { antibioticId: number; disk: C.Circle }[] }) {
    const { cv } = await loadCv();
    const img = working(args.uploadId);
    const letters: { antibioticId: number; blob: Blob }[] = [];
    for (const l of args.learn) {
      const c = C.diskCrop(img, l.disk);
      if (!c) continue;
      const lettersOnly = C.keepOnlyLetters(cv, c);
      templates?.push({ antibioticId: l.antibioticId, desc: C.descriptors(cv, lettersOnly) });
      letters.push({ antibioticId: l.antibioticId, blob: await encode(lettersOnly) });
    }
    const result = { image: await encode(img), annotated: await renderAnnotations(img, args.annotations), letters };
    sessions.delete(args.uploadId);
    return result;
  },
};

export type Commands = typeof commands;

self.onmessage = async (e: MessageEvent<{ id: number; cmd: keyof Commands; args: never }>) => {
  const { id, cmd, args } = e.data;
  const report: Report = (progress) => self.postMessage({ id, progress });
  try {
    const result = await commands[cmd](args, report);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
