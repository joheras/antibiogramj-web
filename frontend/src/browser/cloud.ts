// Google Drive features of the in-browser version: backups of experiments, auto-save, the phone capture
// outbox and the computer inbox, plus the local (no cloud) import queue. Data only goes to the user's own
// Google Drive, in the folder "AntibiogramJ"; the app can only see the files it created there (scope drive.file).

import { useSyncExternalStore } from "react";
import { ApiError, type BacteriaIn } from "../api";
import { onPlateSaved, setHandoff } from "../handoff";
import { qcStrain } from "../qc";
import * as q from "./captureDb";
import type { LocalItem, Organism, OutboxItem } from "./captureDb";
import {
  DriveClient, DriveError, ensureFolders, listBackups, listInbox, markProcessed, saveExperiment, saveFullBackup,
  uploadCapture, type DriveFile, type Folders, type InboxItem, type SyncRecord,
} from "./drive";
import * as auth from "./googleAuth";
import { backupBlob, experimentUid, experimentUids, importBackupFile } from "./localApi";

export { DriveError, type DriveFile, type InboxItem };
export const driveConfigured = !!auth.CLIENT_ID;

const client = new DriveClient({ getToken: auth.getToken, onAuthError: auth.expire });

// ------------------------------------------------------------ small storage
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

const K_SYNC = "aj.drive.sync", K_DIRTY = "aj.drive.dirty", K_AUTO = "aj.drive.autosave", K_DONE = "aj.drive.processed";

/** A readable name of this device for conflict copies and captures. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Windows/.test(ua)) return "Windows computer";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Linux/.test(ua)) return "Linux computer";
  return "browser";
}

// ------------------------------------------------------------- status store
export interface SyncStatus {
  /** Plates/experiments waiting to be saved to Drive (auto-save). */
  dirty: number;
  busy: string | null;
  message: { kind: "ok" | "error" | "warn"; text: string } | null;
}
let status: SyncStatus = { dirty: load<number[]>(K_DIRTY, []).length, busy: null, message: null };
const statusListeners = new Set<() => void>();
function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l());
}
const subscribeStatus = (l: () => void) => { statusListeners.add(l); return () => { statusListeners.delete(l); }; };

export function useDrive() {
  const authState = useSyncExternalStore(auth.subscribe, auth.authState);
  const sync = useSyncExternalStore(subscribeStatus, () => status);
  return { auth: authState, sync };
}

export const clearMessage = () => setStatus({ message: null });

export function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------ connection
let foldersPromise: Promise<Folders> | null = null;
function folders(): Promise<Folders> {
  foldersPromise ??= ensureFolders(client).catch((e) => { foldersPromise = null; throw e; });
  return foldersPromise;
}

/** Retries once when a folder was deleted in Drive meanwhile. */
async function withFolders<T>(fn: (f: Folders) => Promise<T>): Promise<T> {
  try {
    return await fn(await folders());
  } catch (e) {
    if (!(e instanceof DriveError && e.kind === "notFound")) throw e;
    foldersPromise = null;
    return fn(await folders());
  }
}

/** Opens Google's sign-in (call from a click), then sends whatever was waiting. */
export async function connect(): Promise<void> {
  await auth.connect(async () => (await client.about()).email);
  foldersPromise = null;
  void flushAll();
}

export const disconnect = () => auth.disconnect();

const connected = () => auth.authState().status === "connected";

async function flushAll() {
  await processOutbox();
  if (autosaveEnabled()) await flushDirty();
}

// ------------------------------------------------------------ backups
const syncRecords = () => load<Record<string, SyncRecord>>(K_SYNC, {});
function setSyncRecord(uid: string, file: DriveFile) {
  save(K_SYNC, { ...syncRecords(), [uid]: { fileId: file.id, version: file.version ?? "" } });
}

/** Saves one experiment into its own file in AntibiogramJ/Backups. */
export async function saveExperimentToDrive(id: number): Promise<{ conflict: boolean; name: string }> {
  const exp = await experimentUid(id);
  const body = await backupBlob([id]);
  const r = await withFolders((f) => saveExperiment(client, f.backups, exp, body, syncRecords()[exp.uid], deviceName()));
  setSyncRecord(exp.uid, r.file);
  return { conflict: r.conflict, name: r.conflict ? r.file.name : exp.name };
}

/** A new file with every experiment and the learned disk templates. */
export async function saveAllToDrive(count: number): Promise<DriveFile> {
  const body = await backupBlob();
  return withFolders((f) => saveFullBackup(client, f.backups, body, count));
}

export const listDriveBackups = () => withFolders((f) => listBackups(client, f.backups));

export interface BackupPreview { file: DriveFile; blob: Blob; experiments: { name: string; exists: boolean }[] }

export async function previewDriveBackup(file: DriveFile): Promise<BackupPreview> {
  const blob = await client.download(file.id);
  let parsed: { format?: string; experiments?: { name: string; uid?: string }[] };
  try {
    parsed = JSON.parse(await blob.text());
  } catch {
    throw new Error("The file is not an AntibiogramJ backup");
  }
  if (parsed.format !== "antibiogramj-backup" || !Array.isArray(parsed.experiments)) throw new Error("The file is not an AntibiogramJ backup");
  const local = await experimentUids();
  return { file, blob, experiments: parsed.experiments.map((e) => ({ name: e.name, exists: !!e.uid && local.has(e.uid) })) };
}

export async function importDriveBackup(p: BackupPreview): Promise<number> {
  const r = await importBackupFile(p.blob);
  // Later saves of this experiment update the same file (unless it changes in Drive meanwhile).
  if (p.file.appProperties?.aj === "experiment" && !p.file.appProperties.conflict) {
    for (const uid of r.kept) if (uid === p.file.appProperties.uid) setSyncRecord(uid, p.file);
  }
  return r.count;
}

// ------------------------------------------------------------ auto-save
export const autosaveEnabled = () => load<boolean>(K_AUTO, false);
export function setAutosave(on: boolean) {
  save(K_AUTO, on);
  setStatus({});
  if (on) void flushDirty();
}

function markDirty(experimentId: number) {
  const dirty = new Set(load<number[]>(K_DIRTY, []));
  dirty.add(experimentId);
  save(K_DIRTY, [...dirty]);
  setStatus({ dirty: dirty.size });
}

let flushing: Promise<void> | null = null;
/** Saves the experiments changed since the last auto-save; they stay pending if Drive cannot be reached. */
export function flushDirty(): Promise<void> {
  flushing ??= (async () => {
    try {
      for (const id of load<number[]>(K_DIRTY, [])) {
        if (!connected()) return; // DriveStatus offers to reconnect while experiments are waiting
        setStatus({ busy: "Saving to Google Drive…" });
        try {
          const r = await saveExperimentToDrive(id);
          setStatus({ message: r.conflict
            ? { kind: "warn", text: `"${r.name}" was changed in Google Drive from another device, so this version was saved as a separate copy.` }
            : { kind: "ok", text: `Saved to Google Drive at ${new Date().toLocaleTimeString()}.` } });
        } catch (e) {
          // An experiment deleted in this browser meanwhile is dropped; anything else stays pending.
          if (!(e instanceof ApiError && e.status === 404)) {
            setStatus({ message: { kind: "error", text: `Auto-save to Google Drive failed: ${describe(e)}` } });
            return;
          }
        }
        const rest = load<number[]>(K_DIRTY, []).filter((x) => x !== id);
        save(K_DIRTY, rest);
        setStatus({ dirty: rest.length });
      }
    } finally {
      setStatus({ busy: null });
      flushing = null;
    }
  })();
  return flushing;
}

onPlateSaved((experimentId) => {
  if (!driveConfigured || !autosaveEnabled()) return;
  markDirty(experimentId);
  void flushDirty();
});

// ------------------------------------------------------------ images
async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This image format cannot be read by the browser; use JPEG or PNG.");
  }
}

function canvasBlob(bmp: ImageBitmap, maxSide: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale), height = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve({ blob: b, width, height }) : reject(new Error("Cannot encode the image"))), "image/jpeg", quality));
}

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result as string);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Upload size of the photos: enough for the analysis (the plate is cropped and worked at 1600 px). */
const CAPTURE_MAX_SIDE = 3000;

export async function thumbnail(file: Blob): Promise<string | null> {
  try {
    const bmp = await decode(file);
    const t = await canvasBlob(bmp, 240, 0.7);
    bmp.close();
    return blobToDataUrl(t.blob);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ phone outbox
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Prepares the photos (downscaled JPEG, thumbnail) and queues them for upload to the Drive inbox. */
export async function queueCaptures(files: File[], organism: Organism, includeOriginal: boolean): Promise<void> {
  for (const file of files) {
    const bmp = await decode(file);
    const img = await canvasBlob(bmp, CAPTURE_MAX_SIDE, 0.9);
    const thumb = await canvasBlob(bmp, 240, 0.7);
    bmp.close();
    const id = newId();
    const item: OutboxItem = {
      id, created_at: new Date().toISOString(),
      meta: {
        format: "antibiogramj-capture", version: 1, id, captured_at: new Date(file.lastModified || Date.now()).toISOString(),
        device: deviceName(), ...organism, width: img.width, height: img.height, thumbnail: await blobToDataUrl(thumb.blob),
      },
      image: img.blob, original: includeOriginal ? { blob: file, name: file.name } : null,
      status: "pending", error: null, attempts: 0,
    };
    await q.put("outbox", item);
  }
  void processOutbox();
}

let processing: Promise<void> | null = null;
/** Uploads the queued captures one by one; stops (keeping them queued) when offline or not connected. */
export function processOutbox(): Promise<void> {
  processing ??= (async () => {
    try {
      const items = (await q.all<OutboxItem>("outbox")).filter((i) => i.status !== "done")
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const item of items) {
        if (!connected() || !navigator.onLine) return;
        await q.put("outbox", { ...item, status: "uploading", error: null });
        try {
          if (!item.image) throw new Error("The photo is missing");
          await withFolders((f) => uploadCapture(client, f.inbox, { meta: item.meta, image: item.image!, original: item.original }));
          // Keep a light record (thumbnail and organism) so the user sees what was sent; drop the photos.
          await q.put("outbox", { ...item, status: "done", error: null, image: null, original: null, attempts: item.attempts + 1 });
        } catch (e) {
          const transient = e instanceof DriveError && (e.kind === "offline" || e.kind === "auth" || e.kind === "rateLimit");
          await q.put("outbox", { ...item, status: transient ? "pending" : "error", error: describe(e), attempts: item.attempts + 1 });
          if (transient) return;
        }
      }
    } finally {
      processing = null;
    }
  })();
  return processing;
}

export async function retryCapture(id: string) {
  const item = await q.get<OutboxItem>("outbox", id);
  if (item) await q.put("outbox", { ...item, status: "pending", error: null });
  void processOutbox();
}

export const removeCapture = (id: string) => q.remove("outbox", id);
export async function clearSentCaptures() {
  for (const i of await q.all<OutboxItem>("outbox")) if (i.status === "done") await q.remove("outbox", i.id);
}
export const outbox = () => q.all<OutboxItem>("outbox").then((xs) => xs.sort((a, b) => b.created_at.localeCompare(a.created_at)));
export const subscribeQueues = q.subscribe;

// Retry when the connection comes back, when the page becomes visible again and every minute.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flushAll());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void flushAll(); });
  setInterval(() => { if (connected()) void flushAll(); }, 60_000);
}

// ------------------------------------------------------------ computer inbox
const organismOf = (m: Organism, families: { id: number }[]): Partial<BacteriaIn> => ({
  family_id: m.family_id && families.some((f) => f.id === m.family_id) ? m.family_id : 0,
  genus: m.genus ?? "", species: m.species ?? "", strain: m.strain ?? "", sample: m.sample ?? "", comments: m.notes ?? "",
  qc_strain: qcStrain(m.qc_strain) ? m.qc_strain : "",
});

/** Captures moved to Processed only locally so far (the move failed); retried when the inbox is listed. */
const processedPending = () => load<{ sidecarId: string; image: string; original: string | null }[]>(K_DONE, []);

export async function inboxItems(): Promise<InboxItem[]> {
  const pendingMoves = processedPending();
  if (pendingMoves.length) {
    const left: typeof pendingMoves = [];
    for (const p of pendingMoves) {
      try { await withFolders((f) => markProcessed(client, f, p)); } catch { left.push(p); }
    }
    save(K_DONE, left);
  }
  const hidden = new Set(processedPending().map((p) => p.sidecarId));
  return (await withFolders((f) => listInbox(client, f.inbox))).filter((i) => !hidden.has(i.sidecar.id));
}

export async function markInboxProcessed(item: InboxItem): Promise<void> {
  const p = { sidecarId: item.sidecar.id, image: item.meta.image, original: item.meta.original };
  try {
    await withFolders((f) => markProcessed(client, f, p));
  } catch {
    save(K_DONE, [...processedPending(), p]);
  }
}

/** Downloads the photo (the original when there is one) and hands it to the wizard. */
export async function prepareInboxAnalysis(item: InboxItem, families: { id: number }[]): Promise<void> {
  const m = item.meta;
  let blob: Blob, name: string;
  if (m.original) {
    try {
      blob = await client.download(m.original);
      name = `capture-${m.id.slice(0, 8)}-original`;
    } catch {
      blob = await client.download(m.image);
      name = `capture-${m.id.slice(0, 8)}.jpg`;
    }
  } else {
    blob = await client.download(m.image);
    name = `capture-${m.id.slice(0, 8)}.jpg`;
  }
  const ext = blob.type === "image/png" ? ".png" : blob.type === "image/tiff" ? ".tif" : /jpe?g/.test(blob.type) ? ".jpg" : "";
  if (!/\.[a-z]{3,4}$/i.test(name)) name += ext;
  setHandoff({
    file: new File([blob], name, { type: blob.type || "image/jpeg" }),
    bacteria: organismOf(m, families),
    label: `Photo from the Google Drive inbox, taken ${new Date(m.captured_at).toLocaleString()} on ${m.device}.`,
    onSaved: () => markInboxProcessed(item),
  });
}

// ------------------------------------------------------------ local import queue
const IMAGE_RE = /\.(jpe?g|png|tiff?|webp|bmp|heic)$/i;
const stem = (name: string) => name.replace(/\.[^.]+$/, "").replace(/ original$/, "");

/**
 * Adds photos to this computer's queue. JSON sidecars of captures (from a downloaded Drive inbox) are matched to
 * the photo with the same name and give its organism data.
 */
export async function addLocalFiles(files: File[]): Promise<number> {
  const sidecars = new Map<string, Organism>();
  for (const f of files.filter((f) => /\.json$/i.test(f.name))) {
    try {
      const m = JSON.parse(await f.text());
      if (m?.format === "antibiogramj-capture") sidecars.set(stem(f.name), m);
    } catch { /* not a sidecar */ }
  }
  const images = files.filter((f) => f.type.startsWith("image/") || IMAGE_RE.test(f.name));
  for (const file of images) {
    const item: LocalItem = {
      id: newId(), added_at: new Date().toISOString(), file, organism: sidecars.get(stem(file.name)) ?? null,
      thumbnail: /\.tiff?$/i.test(file.name) ? null : await thumbnail(file),
    };
    await q.put("local", item);
  }
  return images.length;
}

export const localQueue = () => q.all<LocalItem>("local").then((xs) => xs.sort((a, b) => a.added_at.localeCompare(b.added_at)));
export const removeLocal = (id: string) => q.remove("local", id);

export function prepareLocalAnalysis(item: LocalItem, families: { id: number }[]) {
  setHandoff({
    file: item.file,
    bacteria: item.organism ? organismOf(item.organism, families) : {},
    label: `Photo from the import queue of this computer: ${item.file.name}.`,
    onSaved: () => removeLocal(item.id).catch(() => undefined),
  });
}
