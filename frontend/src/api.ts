// API used by the pages. Two implementations, chosen at build time:
//  * server  (default)        -> http.ts: FastAPI backend, httpOnly-cookie authentication
//  * browser (--mode browser) -> browser/localApi.ts: everything runs in the user's browser
//    (OpenCV.js in a Web Worker, data in IndexedDB)

export interface User { id: number; email: string; name: string; lab: string; city: string; country: string }
export interface Standard {
  id: number; name: string; version: string; valid_from: string | null;
  susceptible_op: ">=" | ">"; resistant_op: "<" | "<="; is_default: boolean;
}
export interface Family { id: number; name: string }
export interface Antibiotic { id: number; name: string; drug_class: string; disk_content: string; code: string }
export interface Breakpoint {
  id: number; standard_id: number; family_id: number; antibiotic_id: number; case: string;
  available: boolean; susceptible: number | null; resistant: number | null; comments: string;
}
export interface Circle { cx: number; cy: number; r: number }

export interface Measurement {
  id: number; antibiotic: Antibiotic; breakpoint: Breakpoint | null; standard_id: number;
  disk_cx: number; disk_cy: number; disk_r: number; halo_r: number; diameter_mm: number;
  category: string; microcolonies: boolean; interpretation: string;
  /** Set on the measurements of a reinterpretation: the first interpretation (standard, category, set by hand). */
  original_standard_id?: number | null; original_category?: string | null; original_overridden?: boolean | null;
}
export interface Plate {
  id: number; antibiogram_id: number; experiment_id: number; original_filename: string; disk_mm: number; px_per_mm: number;
  created_at: string; measurements: Measurement[];
}
export interface Antibiogram {
  id: number; experiment_id: number; family: Family; genus: string; species: string; strain: string;
  sample: string; comments: string; created_at: string; plates: Plate[];
  /** Results of supplementary tests used by the expert system (see expertRules.ts), e.g. {"d_test": "positive"}. */
  supplementary_tests: Record<string, string>;
  /** EUCAST QC strain (e.g. "ATCC 25922", see qc.ts) or "" for a clinical isolate. */
  qc_strain: string;
}
export interface ExperimentSummary {
  id: number; name: string; comments: string; standard_id: number; created_at: string;
  /** "<name> (<standard> <version>)" of the experiment this one reinterprets with another standard. */
  reinterpreted_from?: string | null;
  antibiogram_count: number; plate_count: number;
}
export interface ExperimentDetail extends Omit<ExperimentSummary, "antibiogram_count" | "plate_count"> {
  standard: Standard; antibiograms: Antibiogram[];
}

export interface QualityMetrics {
  plate_found: boolean; plate_diameter_px: number | null; plate_fraction: number | null;
  outside_fraction: number; sharpness: number; glare_fraction: number; width: number; height: number;
}
/** Photo quality checks of the upload: warning codes (texts in components/PhotoQuality.tsx). */
export interface PhotoQuality { warnings: string[]; metrics: QualityMetrics }
export interface UploadResult { upload_id: string; width: number; height: number; plate: Circle | null; quality: PhotoQuality }
export interface HaloResult {
  halo_r: number; diameter_mm: number; breakpoints: Breakpoint[]; breakpoint_id: number | null; category: string;
}
export interface BacteriaIn {
  family_id: number; genus: string; species: string; strain: string; sample: string; comments: string; qc_strain: string;
}
export interface AntibiogramUpdate {
  genus: string; species: string; strain: string; sample: string; comments: string;
  supplementary_tests: Record<string, string>; qc_strain: string;
}
export interface MeasurementIn {
  antibiotic_id: number; breakpoint_id: number | null; disk: Circle; halo_r: number;
  category: string | null; microcolonies: boolean; interpretation: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface Download { url: string; filename: string }

export interface Api {
  me(): Promise<User>;
  login(email: string, password: string): Promise<User>;
  register(data: { email: string; password: string; name: string; lab: string; city: string; country: string }): Promise<User>;
  logout(): Promise<void>;

  standards(): Promise<Standard[]>;
  families(): Promise<Family[]>;
  antibiotics(): Promise<Antibiotic[]>;

  experiments(): Promise<ExperimentSummary[]>;
  experiment(id: number): Promise<ExperimentDetail>;
  createExperiment(data: { name: string; comments: string; standard_id: number | null }): Promise<ExperimentSummary>;
  deleteExperiment(id: number): Promise<void>;
  deleteAntibiogram(id: number): Promise<void>;
  updateAntibiogram(id: number, data: AntibiogramUpdate): Promise<void>;
  plate(id: number): Promise<Plate>;
  deletePlate(id: number): Promise<void>;
  plateImage(id: number, annotated: boolean): Promise<string>;
  exportExperiment(id: number, name: string): Promise<Download>;
  /** Copy of the experiment with the measured diameters categorised with another standard (the original is kept). */
  reinterpretExperiment(id: number, data: { standard_id: number; name: string | null }): Promise<ExperimentSummary>;

  upload(file: File): Promise<UploadResult>;
  uploadImage(id: string, stage: "original" | "working", version?: number): Promise<string>;
  process(id: string, crop: Circle | null, autoContrast: boolean): Promise<{ width: number; height: number }>;
  detectDisks(id: string): Promise<{ disks: Circle[] }>;
  identify(id: string, disks: Circle[]): Promise<{ results: { antibiotic_id: number | null; score: number }[] }>;
  halos(id: string, data: { disks: Circle[]; antibiotic_ids: number[]; family_id: number; standard_id: number; disk_mm: number }):
    Promise<{ px_per_mm: number; results: HaloResult[] }>;
  savePlate(data: {
    upload_id: string; antibiogram_id: number | null; experiment_id: number | null;
    bacteria: BacteriaIn | null; disk_mm: number; measurements: MeasurementIn[];
  }): Promise<Plate>;

  /** Browser mode only: all data as one file, and restoring it. */
  exportBackup?(): Promise<Download>;
  importBackup?(file: File): Promise<number>;
}

export const MODE: "server" | "browser" = import.meta.env.VITE_BACKEND === "browser" ? "browser" : "server";

// "virtual:api-impl" is resolved in vite.config.ts to http.ts or browser/localApi.ts,
// so each build contains only its own implementation.
const implementation: Promise<Api> = import("virtual:api-impl").then((m) => m.default);

/** Every method waits for the implementation module (loaded lazily, so only one is bundled). */
export const api = new Proxy({} as Required<Api>, {
  get: (_, key: string) => async (...args: unknown[]) => {
    const impl = (await implementation) as unknown as Record<string, (...a: unknown[]) => unknown>;
    if (!impl[key]) throw new Error(`${key} is not available in ${MODE} mode`);
    return impl[key](...args);
  },
});

/** Trigger the download of a URL (object URL or same-origin link). */
export function download({ url, filename }: Download): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Same rules as backend/app/standards.py::categorise.
export function categorise(diameter: number, bp: Breakpoint | null | undefined, std: Standard): string {
  if (!bp || !bp.available || bp.susceptible === null || bp.resistant === null) return "Not available";
  const s = bp.susceptible, r = bp.resistant;
  if ((std.susceptible_op === ">=" && diameter >= s) || (std.susceptible_op === ">" && diameter > s)) return "Susceptible";
  if ((std.resistant_op === "<" && diameter < r) || (std.resistant_op === "<=" && diameter <= r)) return "Resistant";
  return "Intermediate";
}

export const CATEGORIES = ["Susceptible", "Intermediate", "Resistant", "Not available"];

/**
 * Since 2019 (v 9.0) EUCAST defines I as "Susceptible, increased exposure". The category is stored as
 * "Intermediate" (the value of the desktop application and of CLSI) and shown with the meaning of the standard.
 */
export function increasedExposure(standard: Pick<Standard, "name" | "valid_from"> | null | undefined): boolean {
  return !!standard && standard.name.toUpperCase() === "EUCAST" && (standard.valid_from ?? "") >= "2019-01-01";
}

export function categoryLabel(category: string, standard: Pick<Standard, "name" | "valid_from"> | null | undefined): string {
  return category === "Intermediate" && increasedExposure(standard) ? "Susceptible, increased exposure" : category;
}

// Names the standards adopted later (EUCAST and CLSI since 2019) for groups stored with their original names,
// which every standard shares. Same as backend/app/standards.py::family_label.
const RENAMED_FAMILIES: [string, string][] = [["Enterobacteriaceae", "Enterobacterales"], ["Clostridium difficile", "Clostridioides difficile"]];

export function familyLabel(name: string, standard: Pick<Standard, "valid_from"> | null | undefined): string {
  if ((standard?.valid_from ?? "") < "2019-01-01") return name;
  return RENAMED_FAMILIES.reduce((n, [old, renamed]) => n.replace(old, renamed), name);
}

export function standardLabel(standard: Pick<Standard, "name" | "version"> | null | undefined): string {
  return standard ? `${standard.name} ${standard.version}` : "unknown standard";
}

/** The breakpoint of the same case (e.g. "Uncomplicated UTI") as before, otherwise the first one. */
export function pickBreakpoint(candidates: Breakpoint[], previousCase: string | null | undefined): Breakpoint | null {
  return candidates.find((b) => previousCase && b.case === previousCase) ?? candidates[0] ?? null;
}

export function bacteriaLabel(a: Pick<Antibiogram, "genus" | "species" | "strain" | "sample">): string {
  const name = [a.genus, a.species].filter(Boolean).join(" ") || "Unnamed organism";
  const extra = [a.strain && `strain ${a.strain}`, a.sample && `sample ${a.sample}`].filter(Boolean).join(", ");
  return extra ? `${name} (${extra})` : name;
}
