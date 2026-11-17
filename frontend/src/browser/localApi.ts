// In-browser implementation of the API: data in IndexedDB, analysis in a Web
// Worker with OpenCV.js. Mirrors backend/app/routers/*.py; nothing leaves the browser.

import {
  ApiError, categorise, CATEGORIES, pickBreakpoint, standardLabel, type Antibiogram, type Antibiotic, type Api, type Breakpoint, type Circle,
  type Download, type ExperimentDetail, type ExperimentSummary, type Family, type HaloResult,
  type Plate, type Standard, type User,
} from "../api";
import catalogJson from "./catalog.json";
import * as db from "./db";
import type { Annotation, Commands } from "./worker";
import { experimentWorkbook } from "../excel";
import { SUPPLEMENTARY_TESTS } from "../expertRules";
import { qcStrain } from "../qc";

// ------------------------------------------------------------------ catalogue
const catalog = catalogJson as unknown as {
  standards: Standard[]; families: Family[]; antibiotics: Antibiotic[]; breakpoints: Breakpoint[];
  templates: { antibiotic_id: number; path: string }[];
};
const standardById = new Map(catalog.standards.map((s) => [s.id, s]));
const familyById = new Map(catalog.families.map((f) => [f.id, f]));
const antibioticById = new Map(catalog.antibiotics.map((a) => [a.id, a]));
const breakpointById = new Map(catalog.breakpoints.map((b) => [b.id, b]));

const WORKING_MAX_SIDE = 1600;
const TEMPLATES_PER_ANTIBIOTIC = 10;

const LOCAL_USER: User = { id: 0, email: "", name: "Local workspace", lab: "", city: "", country: "" };

function breakpointsFor(standardId: number, familyId: number, antibioticId: number): Breakpoint[] {
  return catalog.breakpoints.filter((b) => b.standard_id === standardId && b.family_id === familyId && b.antibiotic_id === antibioticId);
}

const pxPerMm = (disks: Circle[], diskMm: number) => disks.reduce((s, d) => s + 2 * d.r, 0) / disks.length / diskMm;
const diameterMm = (haloR: number, scale: number) => Math.round((20 * haloR) / scale) / 10;
const notFound = () => new ApiError(404, "Not found");
const invalid = (msg: string) => new ApiError(422, msg);
const now = () => new Date().toISOString();
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

// -------------------------------------------------------------------- records
interface ExperimentRec {
  id: number; name: string; comments: string; standard_id: number; created_at: string;
  reinterpreted_from?: string | null; // absent in records saved before reinterpretations existed
}
interface AntibiogramRec {
  id: number; experiment_id: number; family_id: number; genus: string; species: string; strain: string;
  sample: string; comments: string; created_at: string; supplementary_tests?: Record<string, string>;
  qc_strain?: string; // added after the first release
}

/** Only EUCAST QC strains of qc.ts ("" = clinical isolate). */
const cleanQc = (id: string | undefined) => (qcStrain(id) ? id! : "");

/** Only the known tests and options are stored. */
function cleanTests(tests: Record<string, string>): Record<string, string> {
  return Object.fromEntries(SUPPLEMENTARY_TESTS.flatMap((t) => {
    const v = tests[t.key];
    return t.options.some((o) => o.value === v) ? [[t.key, v]] : [];
  }));
}
interface MeasurementRec {
  antibiotic_id: number; breakpoint_id: number | null; standard_id: number; disk_cx: number; disk_cy: number;
  disk_r: number; halo_r: number; diameter_mm: number; category: string; microcolonies: boolean; interpretation: string;
  // Only in reinterpretations: the first interpretation of the measurement (see Measurement in ../api.ts).
  original_standard_id?: number | null; original_category?: string | null; original_overridden?: boolean | null;
}
interface PlateRec {
  id: number; antibiogram_id: number; experiment_id: number; original_filename: string; disk_mm: number;
  px_per_mm: number; created_at: string; image_key: string; annotated_key: string; measurements: MeasurementRec[];
}
interface TemplateRec { id?: number; antibiotic_id: number; blob_key: string }

function toPlate(p: PlateRec): Plate {
  const { image_key: _i, annotated_key: _a, ...rest } = p;
  return {
    ...rest,
    measurements: p.measurements.map((m, i) => ({
      id: p.id * 1000 + i, antibiotic: antibioticById.get(m.antibiotic_id)!,
      breakpoint: m.breakpoint_id !== null ? breakpointById.get(m.breakpoint_id) ?? null : null,
      standard_id: m.standard_id, disk_cx: m.disk_cx, disk_cy: m.disk_cy, disk_r: m.disk_r, halo_r: m.halo_r,
      diameter_mm: m.diameter_mm, category: m.category, microcolonies: m.microcolonies, interpretation: m.interpretation,
      original_standard_id: m.original_standard_id ?? null, original_category: m.original_category ?? null,
      original_overridden: m.original_overridden ?? null,
    })),
  };
}

async function experimentDetail(id: number): Promise<ExperimentDetail> {
  const e = await db.get<ExperimentRec>("experiments", id);
  if (!e) throw notFound();
  const antibiograms = await db.getAll<AntibiogramRec>("antibiograms", "experiment_id", id);
  const result: Antibiogram[] = [];
  for (const a of antibiograms.sort((x, y) => x.id - y.id)) {
    const plates = await db.getAll<PlateRec>("plates", "antibiogram_id", a.id);
    const { family_id, supplementary_tests, qc_strain, ...rest } = a;
    result.push({ ...rest, supplementary_tests: supplementary_tests ?? {}, qc_strain: qc_strain ?? "", family: familyById.get(family_id)!, plates: plates.sort((x, y) => x.id - y.id).map(toPlate) });
  }
  return { ...e, reinterpreted_from: e.reinterpreted_from ?? null, standard: standardById.get(e.standard_id)!, antibiograms: result };
}

// Antibiotics with the same name and disk may be listed under another drug class in each standard.
const sameDisk = new Map<string, number[]>();
for (const a of [...catalog.antibiotics].sort((x, y) => x.id - y.id)) {
  const key = `${a.name.toLowerCase()}|${a.disk_content}`;
  sameDisk.set(key, [...(sameDisk.get(key) ?? []), a.id]);
}

/** The measurements of a plate categorised with another standard (same as backend reinterpret_experiment). */
function reinterpretPlate(p: PlateRec, familyId: number, standard: Standard): { measurements: MeasurementRec[]; annotations: Annotation[] } {
  const used = new Set(p.measurements.map((m) => m.antibiotic_id));
  const measurements: MeasurementRec[] = [], annotations: Annotation[] = [];
  for (const m of p.measurements) {
    const antibiotic = antibioticById.get(m.antibiotic_id)!;
    let antibioticId = m.antibiotic_id, candidates = breakpointsFor(standard.id, familyId, antibioticId);
    if (!candidates.length) {
      for (const other of sameDisk.get(`${antibiotic.name.toLowerCase()}|${antibiotic.disk_content}`) ?? []) {
        const found = used.has(other) ? [] : breakpointsFor(standard.id, familyId, other);
        if (found.length) {
          used.delete(antibioticId);
          used.add(other);
          antibioticId = other;
          candidates = found;
          break;
        }
      }
    }
    const previous = m.breakpoint_id !== null ? breakpointById.get(m.breakpoint_id) ?? null : null;
    const bp = pickBreakpoint(candidates, previous?.case);
    const category = categorise(m.diameter_mm, bp, standard);
    const firstStandard = standardById.get(m.standard_id);
    const original = m.original_standard_id != null
      ? { original_standard_id: m.original_standard_id, original_category: m.original_category ?? null, original_overridden: m.original_overridden ?? null }
      : { original_standard_id: m.standard_id, original_category: m.category,
          original_overridden: firstStandard ? m.category !== categorise(m.diameter_mm, previous, firstStandard) : null };
    measurements.push({ ...m, antibiotic_id: antibioticId, breakpoint_id: bp?.id ?? null, standard_id: standard.id, category, ...original });
    annotations.push({ disk: { cx: m.disk_cx, cy: m.disk_cy, r: m.disk_r }, halo_r: m.halo_r, code: antibiotic.code, category,
      s_r: bp?.susceptible ? (bp.susceptible * p.px_per_mm) / 2 : null, r_r: bp?.resistant ? (bp.resistant * p.px_per_mm) / 2 : null });
  }
  return { measurements, annotations };
}

// ---------------------------------------------------------------- blob URLs
const urlCache = new Map<string, string>();

async function blobUrl(key: string): Promise<string> {
  const cached = urlCache.get(key);
  if (cached) return cached;
  const blob = await db.get<Blob>("blobs", key);
  if (!blob) throw notFound();
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

function forgetUrl(key: string) {
  const url = urlCache.get(key);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(key);
}

async function deletePlates(tx: IDBTransaction, plates: PlateRec[]) {
  for (const p of plates) {
    await db.del(tx, "plates", p.id);
    await db.del(tx, "blobs", p.image_key);
    await db.del(tx, "blobs", p.annotated_key);
  }
}

// ------------------------------------------------------------------- worker
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function call<K extends keyof Commands>(cmd: K, args: Parameters<Commands[K]>[0]): ReturnType<Commands[K]> {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (e.data.error !== undefined) p?.reject(new ApiError(422, e.data.error));
      else p?.resolve(e.data.result);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "The analysis engine failed to load"));
      pending.clear();
    };
  }
  const id = ++seq;
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, cmd, args });
  }) as ReturnType<Commands[K]>;
}

let templatesReady: Promise<number> | null = null;
function loadTemplates(): Promise<number> {
  templatesReady ??= (async () => {
    const base = new URL(import.meta.env.BASE_URL, document.baseURI);
    const learned: { antibioticId: number; blob: Blob }[] = [];
    for (const t of await db.getAll<TemplateRec>("templates")) {
      const blob = await db.get<Blob>("blobs", t.blob_key);
      if (blob) learned.push({ antibioticId: t.antibiotic_id, blob });
    }
    return call("loadTemplates", {
      shared: catalog.templates.map((t) => ({ antibioticId: t.antibiotic_id, url: new URL(t.path, base).href })),
      learned,
    });
  })().catch((e) => { templatesReady = null; throw e; });
  return templatesReady;
}

// Images of the plate being analysed (lost on reload, like an unsaved wizard).
const uploads = new Map<string, { filename: string; original: string; working?: string }>();

// ---------------------------------------------------------------- backup
interface Backup {
  format: "antibiogramj-backup"; version: 1; exported_at: string;
  experiments: ExperimentRec[]; antibiograms: AntibiogramRec[]; plates: PlateRec[]; templates: TemplateRec[];
  blobs: Record<string, string>; // data URLs
}

const toDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result as string);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const fromDataUrl = async (url: string) => {
  if (!url.startsWith("data:image/")) throw invalid("Invalid image in the backup file");
  return (await fetch(url)).blob();
};

// ------------------------------------------------------------------- the API
export const localApi: Api = {
  me: async () => LOCAL_USER,
  login: async () => LOCAL_USER,
  register: async () => LOCAL_USER,
  logout: async () => undefined,

  standards: async () => [...catalog.standards].sort((a, b) => Number(b.is_default) - Number(a.is_default)),
  families: async () => [...catalog.families].sort((a, b) => a.name.localeCompare(b.name)),
  antibiotics: async () => [...catalog.antibiotics].sort((a, b) => a.name.localeCompare(b.name) || a.disk_content.localeCompare(b.disk_content)),

  async experiments() {
    const [experiments, antibiograms, plates] = await Promise.all([
      db.getAll<ExperimentRec>("experiments"), db.getAll<AntibiogramRec>("antibiograms"), db.getAll<PlateRec>("plates")]);
    return experiments.map((e): ExperimentSummary => ({
      ...e,
      antibiogram_count: antibiograms.filter((a) => a.experiment_id === e.id).length,
      plate_count: plates.filter((p) => p.experiment_id === e.id).length,
    })).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  experiment: experimentDetail,

  async createExperiment(data) {
    const standard = data.standard_id === null ? catalog.standards.find((s) => s.is_default) : standardById.get(data.standard_id);
    if (!standard) throw invalid("Unknown standard");
    if (!data.name.trim()) throw invalid("The name is required");
    const rec: Omit<ExperimentRec, "id"> = { name: data.name.slice(0, 100), comments: data.comments.slice(0, 1000), standard_id: standard.id, created_at: now() };
    const id = await db.write(["experiments"], (tx) => db.put(tx, "experiments", rec));
    return { ...rec, id, antibiogram_count: 0, plate_count: 0 };
  },

  async deleteExperiment(id) {
    await db.write(["experiments", "antibiograms", "plates", "blobs"], async (tx) => {
      for (const a of await db.txGetAll<AntibiogramRec>(tx, "antibiograms", "experiment_id", id)) {
        await deletePlates(tx, await db.txGetAll<PlateRec>(tx, "plates", "antibiogram_id", a.id));
        await db.del(tx, "antibiograms", a.id);
      }
      await db.del(tx, "experiments", id);
    });
  },

  async updateAntibiogram(id, data) {
    await db.write(["antibiograms"], async (tx) => {
      const a = await db.txGet<AntibiogramRec>(tx, "antibiograms", id);
      if (!a) throw notFound();
      await db.put(tx, "antibiograms", {
        ...a, genus: data.genus.slice(0, 100), species: data.species.slice(0, 100), strain: data.strain.slice(0, 100),
        sample: data.sample.slice(0, 100), comments: data.comments.slice(0, 1000),
        supplementary_tests: cleanTests(data.supplementary_tests), qc_strain: cleanQc(data.qc_strain),
      });
    });
  },

  async deleteAntibiogram(id) {
    await db.write(["antibiograms", "plates", "blobs"], async (tx) => {
      await deletePlates(tx, await db.txGetAll<PlateRec>(tx, "plates", "antibiogram_id", id));
      await db.del(tx, "antibiograms", id);
    });
  },

  async plate(id) {
    const p = await db.get<PlateRec>("plates", id);
    if (!p) throw notFound();
    return toPlate(p);
  },

  async deletePlate(id) {
    const p = await db.get<PlateRec>("plates", id);
    if (!p) throw notFound();
    await db.write(["antibiograms", "plates", "blobs"], async (tx) => {
      await deletePlates(tx, [p]);
      const remaining = await db.txGetAll<PlateRec>(tx, "plates", "antibiogram_id", p.antibiogram_id);
      if (!remaining.length) await db.del(tx, "antibiograms", p.antibiogram_id);
    });
    forgetUrl(p.image_key);
    forgetUrl(p.annotated_key);
  },

  async plateImage(id, annotated) {
    const p = await db.get<PlateRec>("plates", id);
    if (!p) throw notFound();
    return blobUrl(annotated ? p.annotated_key : p.image_key);
  },

  async reinterpretExperiment(id, data) {
    const source = await db.get<ExperimentRec>("experiments", id);
    if (!source) throw notFound();
    const standard = standardById.get(data.standard_id);
    if (!standard) throw invalid("Unknown standard");
    if (standard.id === source.standard_id) throw invalid("The experiment already uses this standard");
    // Everything is prepared first: an IndexedDB transaction cannot wait for the worker.
    const copies: { a: AntibiogramRec; plates: { p: PlateRec; image: Blob; annotated: Blob; measurements: MeasurementRec[] }[] }[] = [];
    for (const a of (await db.getAll<AntibiogramRec>("antibiograms", "experiment_id", id)).sort((x, y) => x.id - y.id)) {
      const plates = [];
      for (const p of (await db.getAll<PlateRec>("plates", "antibiogram_id", a.id)).sort((x, y) => x.id - y.id)) {
        const image = await db.get<Blob>("blobs", p.image_key);
        if (!image) throw notFound();
        const { measurements, annotations } = reinterpretPlate(p, a.family_id, standard);
        plates.push({ p, image, measurements, annotated: await call("annotate", { image, annotations }) });
      }
      copies.push({ a, plates });
    }
    // "E. coli (EUCAST 6.0)" -> "E. coli (EUCAST 16.1)", not "E. coli (EUCAST 6.0) (EUCAST 16.1)"
    const sourceSuffix = ` (${standardLabel(standardById.get(source.standard_id))})`;
    const base = (source.name.endsWith(sourceSuffix) && source.name.slice(0, -sourceSuffix.length)) || source.name;
    const rec: Omit<ExperimentRec, "id"> = {
      name: (data.name?.trim() || `${base} (${standardLabel(standard)})`).slice(0, 100), comments: source.comments,
      standard_id: standard.id, created_at: now(), reinterpreted_from: `${base}${sourceSuffix}`.slice(0, 250),
    };
    const newId = await db.write(["experiments", "antibiograms", "plates", "blobs"], async (tx) => {
      const experimentId = await db.put<number>(tx, "experiments", rec);
      for (const { a: { id: _a, ...a }, plates } of copies) {
        const antibiogramId = await db.put<number>(tx, "antibiograms", { ...a, experiment_id: experimentId });
        for (const { p: { id: _p, ...p }, image, annotated, measurements } of plates) {
          const imageKey = newKey(), annotatedKey = newKey();
          await db.put(tx, "blobs", image, imageKey);
          await db.put(tx, "blobs", annotated, annotatedKey);
          await db.put(tx, "plates", { ...p, antibiogram_id: antibiogramId, experiment_id: experimentId, image_key: imageKey,
            annotated_key: annotatedKey, measurements } satisfies Omit<PlateRec, "id">);
        }
      }
      return experimentId;
    });
    return { ...rec, id: newId, antibiogram_count: copies.length, plate_count: copies.reduce((n, c) => n + c.plates.length, 0) };
  },

  async exportExperiment(id, name) {
    return experimentWorkbook(await experimentDetail(id), name, catalog.standards);
  },

  // ------------------------------------------------------------- analysis
  async upload(file) {
    const uploadId = newKey();
    const res = await call("open", { uploadId, file });
    for (const u of uploads.values()) { URL.revokeObjectURL(u.original); if (u.working) URL.revokeObjectURL(u.working); }
    uploads.clear();
    uploads.set(uploadId, { filename: file.name.slice(0, 255), original: URL.createObjectURL(res.png) });
    loadTemplates().catch(() => undefined); // warm up while the user adjusts the crop
    return { upload_id: uploadId, width: res.width, height: res.height, plate: res.plate, quality: res.quality };
  },

  async uploadImage(id, stage) {
    const u = uploads.get(id);
    const url = stage === "working" ? u?.working : u?.original;
    if (!url) throw notFound();
    return url;
  },

  async process(id, crop, autoContrast) {
    const u = uploads.get(id);
    if (!u) throw notFound();
    const res = await call("process", { uploadId: id, crop, autoContrast, maxSide: WORKING_MAX_SIDE });
    if (u.working) URL.revokeObjectURL(u.working);
    u.working = URL.createObjectURL(res.png);
    return { width: res.width, height: res.height };
  },

  detectDisks: async (id) => ({ disks: await call("disks", { uploadId: id }) }),

  async identify(id, disks) {
    await loadTemplates();
    const res = await call("identify", { uploadId: id, disks });
    return { results: res.map((r) => ({ antibiotic_id: r.antibioticId, score: r.score })) };
  },

  async halos(id, data) {
    if (!data.disks.length || data.disks.length !== data.antibiotic_ids.length) throw invalid("One antibiotic is required for every disk");
    const standard = standardById.get(data.standard_id);
    if (!standard || !familyById.has(data.family_id)) throw notFound();
    if (data.antibiotic_ids.some((a) => !antibioticById.has(a))) throw invalid("Unknown antibiotic");
    const scale = pxPerMm(data.disks, data.disk_mm);
    const radii = await call("halos", { uploadId: id, disks: data.disks });
    const results: HaloResult[] = radii.map((haloR, i) => {
      const candidates = breakpointsFor(standard.id, data.family_id, data.antibiotic_ids[i]);
      const chosen = candidates[0] ?? null;
      const diameter = diameterMm(haloR, scale);
      return { halo_r: haloR, diameter_mm: diameter, breakpoints: candidates, breakpoint_id: chosen?.id ?? null,
        category: categorise(diameter, chosen, standard) };
    });
    return { px_per_mm: scale, results };
  },

  async savePlate(body) {
    const upload = uploads.get(body.upload_id);
    if (!upload?.working) throw invalid("The image has not been pre-processed yet");

    let antibiogram: Omit<AntibiogramRec, "id"> & { id?: number };
    if (body.antibiogram_id !== null) {
      const a = await db.get<AntibiogramRec>("antibiograms", body.antibiogram_id);
      if (!a) throw notFound();
      antibiogram = a;
    } else if (body.experiment_id !== null && body.bacteria) {
      if (!(await db.get("experiments", body.experiment_id))) throw notFound();
      if (!familyById.has(body.bacteria.family_id)) throw invalid("Unknown bacteria family");
      antibiogram = { experiment_id: body.experiment_id, ...body.bacteria, qc_strain: cleanQc(body.bacteria.qc_strain), created_at: now() };
    } else {
      throw invalid("Give an antibiogram, or an experiment and the bacteria data");
    }
    const experiment = await db.get<ExperimentRec>("experiments", antibiogram.experiment_id);
    const standard = experiment && standardById.get(experiment.standard_id);
    if (!standard) throw notFound();

    const ids = body.measurements.map((m) => m.antibiotic_id);
    if (!ids.length) throw invalid("The plate has no antibiotics");
    if (new Set(ids).size !== ids.length) throw invalid("Each antibiotic can appear only once per plate");
    if (ids.some((a) => !antibioticById.has(a))) throw invalid("Unknown antibiotic");

    const scale = pxPerMm(body.measurements.map((m) => m.disk), body.disk_mm);
    const measurements: MeasurementRec[] = [];
    const annotations: Annotation[] = [];
    for (const m of body.measurements) {
      const candidates = breakpointsFor(standard.id, antibiogram.family_id, m.antibiotic_id);
      const bp = m.breakpoint_id === null ? candidates[0] ?? null : candidates.find((b) => b.id === m.breakpoint_id);
      if (bp === undefined) throw invalid("Breakpoint does not apply");
      const diameter = diameterMm(m.halo_r, scale);
      const category = m.category && CATEGORIES.includes(m.category) ? m.category : categorise(diameter, bp, standard);
      measurements.push({ antibiotic_id: m.antibiotic_id, breakpoint_id: bp?.id ?? null, standard_id: standard.id,
        disk_cx: m.disk.cx, disk_cy: m.disk.cy, disk_r: m.disk.r, halo_r: m.halo_r, diameter_mm: diameter, category,
        microcolonies: m.microcolonies, interpretation: m.interpretation.slice(0, 1000) });
      annotations.push({ disk: m.disk, halo_r: m.halo_r, code: antibioticById.get(m.antibiotic_id)!.code, category,
        s_r: bp?.susceptible ? (bp.susceptible * scale) / 2 : null, r_r: bp?.resistant ? (bp.resistant * scale) / 2 : null });
    }

    // Learn the confirmed disk codes (at most N templates per antibiotic).
    const counts = new Map<number, number>();
    for (const t of await db.getAll<TemplateRec>("templates")) counts.set(t.antibiotic_id, (counts.get(t.antibiotic_id) ?? 0) + 1);
    const learn = body.measurements.filter((m) => (counts.get(m.antibiotic_id) ?? 0) < TEMPLATES_PER_ANTIBIOTIC)
      .map((m) => ({ antibioticId: m.antibiotic_id, disk: m.disk }));

    const out = await call("finish", { uploadId: body.upload_id, annotations, learn });

    const plateId = await db.write(["antibiograms", "plates", "blobs", "templates"], async (tx) => {
      const antibiogramId: number = antibiogram.id ?? await db.put<number>(tx, "antibiograms", antibiogram);
      const imageKey = newKey(), annotatedKey = newKey();
      await db.put(tx, "blobs", out.image, imageKey);
      await db.put(tx, "blobs", out.annotated, annotatedKey);
      for (const l of out.letters) {
        const key = newKey();
        await db.put(tx, "blobs", l.blob, key);
        await db.put(tx, "templates", { antibiotic_id: l.antibioticId, blob_key: key } satisfies TemplateRec);
      }
      const plate: Omit<PlateRec, "id"> = {
        antibiogram_id: antibiogramId, experiment_id: antibiogram.experiment_id, original_filename: upload.filename,
        disk_mm: body.disk_mm, px_per_mm: scale, created_at: now(), image_key: imageKey, annotated_key: annotatedKey,
        measurements,
      };
      return db.put(tx, "plates", plate);
    });
    URL.revokeObjectURL(upload.original);
    URL.revokeObjectURL(upload.working);
    uploads.delete(body.upload_id);
    return localApi.plate(plateId);
  },

  // ---------------------------------------------------------------- backup
  async exportBackup(): Promise<Download> {
    const [experiments, antibiograms, plates, templates] = await Promise.all([
      db.getAll<ExperimentRec>("experiments"), db.getAll<AntibiogramRec>("antibiograms"),
      db.getAll<PlateRec>("plates"), db.getAll<TemplateRec>("templates")]);
    const blobs: Record<string, string> = {};
    const keys = [...plates.flatMap((p) => [p.image_key, p.annotated_key]), ...templates.map((t) => t.blob_key)];
    for (const key of keys) {
      const blob = await db.get<Blob>("blobs", key);
      if (blob) blobs[key] = await toDataUrl(blob);
    }
    const backup: Backup = { format: "antibiogramj-backup", version: 1, exported_at: now(), experiments, antibiograms, plates, templates, blobs };
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    return { url: URL.createObjectURL(blob), filename: `antibiogramj-backup-${now().slice(0, 10)}.json` };
  },

  /** Adds the experiments of a backup to the current data (never overwrites). Returns how many were added. */
  async importBackup(file) {
    let backup: Backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      throw invalid("The file is not an AntibiogramJ backup");
    }
    if (backup?.format !== "antibiogramj-backup" || backup.version !== 1) throw invalid("The file is not an AntibiogramJ backup");
    for (const p of backup.plates) {
      for (const m of p.measurements) {
        if (!antibioticById.has(m.antibiotic_id) || !standardById.has(m.standard_id)
          || (m.original_standard_id != null && !standardById.has(m.original_standard_id))) throw invalid("The backup uses an unknown catalogue");
      }
    }
    const blobs = new Map<string, Blob>();
    for (const [key, url] of Object.entries(backup.blobs)) blobs.set(key, await fromDataUrl(url));

    const existingTemplates = await db.getAll<TemplateRec>("templates");
    const counts = new Map<number, number>();
    for (const t of existingTemplates) counts.set(t.antibiotic_id, (counts.get(t.antibiotic_id) ?? 0) + 1);

    await db.write(["experiments", "antibiograms", "plates", "blobs", "templates"], async (tx) => {
      const expIds = new Map<number, number>(), abgIds = new Map<number, number>();
      const putBlob = async (key: string) => {
        const blob = blobs.get(key);
        if (!blob) throw invalid("The backup is incomplete");
        const newBlobKey = newKey();
        await db.put(tx, "blobs", blob, newBlobKey);
        return newBlobKey;
      };
      for (const { id, ...e } of backup.experiments) expIds.set(id, await db.put(tx, "experiments", e));
      for (const { id, ...a } of backup.antibiograms) {
        const experimentId = expIds.get(a.experiment_id);
        if (experimentId !== undefined) abgIds.set(id, await db.put(tx, "antibiograms", { ...a, experiment_id: experimentId }));
      }
      for (const { id: _id, ...p } of backup.plates) {
        const antibiogramId = abgIds.get(p.antibiogram_id);
        if (antibiogramId === undefined) continue;
        await db.put(tx, "plates", { ...p, antibiogram_id: antibiogramId, experiment_id: expIds.get(p.experiment_id)!,
          image_key: await putBlob(p.image_key), annotated_key: await putBlob(p.annotated_key) });
      }
      for (const t of backup.templates) {
        if (!antibioticById.has(t.antibiotic_id) || (counts.get(t.antibiotic_id) ?? 0) >= TEMPLATES_PER_ANTIBIOTIC) continue;
        counts.set(t.antibiotic_id, (counts.get(t.antibiotic_id) ?? 0) + 1);
        await db.put(tx, "templates", { antibiotic_id: t.antibiotic_id, blob_key: await putBlob(t.blob_key) });
      }
    });
    templatesReady = null; // reload with the imported templates
    return backup.experiments.length;
  },
};

export default localApi;
