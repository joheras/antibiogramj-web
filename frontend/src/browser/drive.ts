// Google Drive REST API v3 client for the in-browser version, plus the sync steps built on it (folders,
// per-experiment backups with conflict detection, phone captures). It only talks to www.googleapis.com with an
// access token of the scope drive.file (the app sees only the files it created) obtained by googleAuth.ts.
// No imports and no DOM: scripts/test-drive.mts runs it in Node against a mocked fetch.

export const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,version,parents,appProperties,webViewLink";

export type DriveErrorKind = "auth" | "offline" | "quota" | "rateLimit" | "notFound" | "permission" | "other";

export class DriveError extends Error {
  kind: DriveErrorKind;
  status: number;
  constructor(kind: DriveErrorKind, message: string, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface DriveFile {
  id: string; name: string; mimeType: string; size?: string; createdTime?: string; modifiedTime?: string;
  version?: string; parents?: string[]; appProperties?: Record<string, string>; webViewLink?: string;
}

export interface DriveClientOptions {
  /** Returns a valid access token or throws a DriveError("auth"). */
  getToken: () => Promise<string>;
  /** Called when Google rejects the token (expired or revoked). */
  onAuthError?: () => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for rate-limit and server errors (exponential backoff). */
  attempts?: number;
  isOnline?: () => boolean;
}

/** Escapes a value for a Drive query string literal. */
export const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DriveClient {
  private opts: Required<Omit<DriveClientOptions, "onAuthError">> & Pick<DriveClientOptions, "onAuthError">;

  constructor(opts: DriveClientOptions) {
    this.opts = {
      fetch: (...a) => fetch(...a), sleep: sleepMs, attempts: 4,
      isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false, ...opts,
    };
  }

  /** Sends a request with the token; retries rate-limit and server errors; maps failures to DriveError. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      if (!this.opts.isOnline()) throw new DriveError("offline", "You are offline. The data will be sent to Google Drive when the connection is back.");
      const token = await this.opts.getToken();
      let res: Response;
      try {
        res = await this.opts.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
      } catch {
        // fetch only rejects on network failures (or CORS errors, which Google does not cause for valid requests).
        if (attempt < this.opts.attempts) { await this.opts.sleep(500 * 2 ** attempt); continue; }
        throw new DriveError("offline", "Cannot reach Google Drive. Check the connection and try again.");
      }
      if (res.ok) return res;
      const err = await errorOf(res);
      if (err.kind === "auth") this.opts.onAuthError?.();
      const retry = err.kind === "rateLimit" || res.status >= 500;
      if (retry && attempt < this.opts.attempts) {
        await this.opts.sleep(1000 * 2 ** (attempt - 1) + Math.random() * 250);
        continue;
      }
      throw err;
    }
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await this.request(url, init)).json() as Promise<T>;
  }

  async about(): Promise<{ email: string; name: string }> {
    const r = await this.json<{ user?: { emailAddress?: string; displayName?: string } }>(`${API}/about?fields=user(emailAddress,displayName)`);
    return { email: r.user?.emailAddress ?? "", name: r.user?.displayName ?? "" };
  }

  /** All the files matching a query (follows the pages). */
  async list(q: string, orderBy = "modifiedTime desc"): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, orderBy, pageSize: "200", spaces: "drive", fields: `nextPageToken,files(${FILE_FIELDS})` });
      if (pageToken) params.set("pageToken", pageToken);
      const r = await this.json<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`);
      files.push(...r.files);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return files;
  }

  get(id: string): Promise<DriveFile> {
    return this.json(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`);
  }

  async download(id: string): Promise<Blob> {
    return (await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`)).blob();
  }

  createFolder(name: string, parent: string, appProperties?: Record<string, string>): Promise<DriveFile> {
    return this.json(`${API}/files?fields=${FILE_FIELDS}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent], appProperties }),
    });
  }

  /** Creates a file with its content (multipart upload; fine up to a few tens of MB). */
  upload(meta: { name: string; parents: string[]; mimeType: string; appProperties?: Record<string, string> }, body: Blob): Promise<DriveFile> {
    const { boundary, blob } = multipart(meta, body, meta.mimeType);
    return this.json(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: blob,
    });
  }

  /** Replaces the content (and optionally metadata) of a file. */
  update(id: string, body: Blob, mimeType: string, meta: { name?: string; appProperties?: Record<string, string> } = {}): Promise<DriveFile> {
    const { boundary, blob } = multipart(meta, body, mimeType);
    return this.json(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: "PATCH", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: blob,
    });
  }

  move(id: string, addParent: string, removeParent: string): Promise<DriveFile> {
    const params = new URLSearchParams({ addParents: addParent, removeParents: removeParent, fields: FILE_FIELDS });
    return this.json(`${API}/files/${encodeURIComponent(id)}?${params}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}",
    });
  }

  /** The folder ``name`` inside ``parent`` created by this app (the oldest one if there are several), or a new one. */
  async folder(name: string, parent: string, appProperties?: Record<string, string>): Promise<string> {
    const found = await this.list(`name = ${quote(name)} and mimeType = '${FOLDER_MIME}' and ${quote(parent)} in parents and trashed = false`, "createdTime");
    return found[0]?.id ?? (await this.createFolder(name, parent, appProperties)).id;
  }
}

function multipart(meta: object, body: Blob, mimeType: string) {
  const boundary = `antibiogramj-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const blob = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, body, `\r\n--${boundary}--`,
  ]);
  return { boundary, blob };
}

async function errorOf(res: Response): Promise<DriveError> {
  let message = res.statusText, reason = "";
  try {
    const body = await res.json() as { error?: { message?: string; errors?: { reason?: string }[] } };
    message = body.error?.message ?? message;
    reason = body.error?.errors?.[0]?.reason ?? "";
  } catch { /* not JSON */ }
  const s = res.status;
  if (s === 401) return new DriveError("auth", "The Google Drive session has expired. Reconnect to Google Drive.", s);
  if (reason === "storageQuotaExceeded" || reason === "quotaExceeded")
    return new DriveError("quota", "Your Google Drive is full. Free up space in Drive (or buy more storage) and try again.", s);
  if (s === 429 || /rateLimitExceeded|userRateLimitExceeded/.test(reason))
    return new DriveError("rateLimit", "Google Drive is receiving too many requests. Wait a minute and try again.", s);
  if (reason === "dailyLimitExceeded")
    return new DriveError("rateLimit", "The daily Google Drive quota of AntibiogramJ is used up. Try again tomorrow.", s);
  if (s === 404) return new DriveError("notFound", "The file is no longer in Google Drive (it may have been deleted or moved).", s);
  if (s === 403) return new DriveError("permission", `Google Drive refused the request: ${message}`, s);
  return new DriveError("other", `Google Drive error ${s}: ${message}`, s);
}

// ================================================================== sync steps

export interface Folders { root: string; backups: string; inbox: string; processed: string }

/** AntibiogramJ/{Backups, Inbox, Inbox/Processed} in "My Drive". */
export async function ensureFolders(c: DriveClient): Promise<Folders> {
  const root = await c.folder("AntibiogramJ", "root", { aj: "root" });
  const [backups, inbox] = await Promise.all([c.folder("Backups", root), c.folder("Inbox", root)]);
  const processed = await c.folder("Processed", inbox);
  return { root, backups, inbox, processed };
}

/** Where this device last read or wrote an experiment's file: used to detect edits made elsewhere. */
export interface SyncRecord { fileId: string; version: string }

export interface SaveResult { file: DriveFile; conflict: boolean }

/** Local date and time for file names, e.g. "2026-11-17 09h31" (with seconds: "2026-11-17 093105"). */
function stamp(d: Date, seconds = false): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return seconds ? `${day} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` : `${day} ${p(d.getHours())}h${p(d.getMinutes())}`;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "experiment";

/**
 * Saves the backup of one experiment into its own file (found by its uid), updating it in place. When the
 * file changed in Drive since this device last synced it (another computer saved it), it is not overwritten:
 * a separate "conflict" copy is created and ``conflict`` is true.
 */
export async function saveExperiment(c: DriveClient, backupsFolder: string, exp: { uid: string; name: string },
  body: Blob, known: SyncRecord | undefined, device: string, now = new Date()): Promise<SaveResult> {
  const appProperties = { aj: "experiment", uid: exp.uid, name: exp.name.slice(0, 80) };
  const name = `${safeName(exp.name)}.antibiogramj.json`;
  const files = await c.list(`appProperties has { key='uid' and value=${quote(exp.uid)} } and appProperties has { key='aj' and value='experiment' } and ${quote(backupsFolder)} in parents and trashed = false`);
  const current = known && files.find((f) => f.id === known.fileId);
  if (current && current.version === known!.version) {
    // A conflict copy written by this device keeps its name and flag.
    const meta = current.appProperties?.conflict ? { appProperties: { ...appProperties, conflict: "1" } } : { name, appProperties };
    return { file: await c.update(current.id, body, "application/json", meta), conflict: false };
  }
  if (!files.some((f) => !f.appProperties?.conflict)) {
    return { file: await c.upload({ name, parents: [backupsFolder], mimeType: "application/json", appProperties }, body), conflict: false };
  }
  const file = await c.upload({
    name: `${safeName(exp.name)} (conflict, ${safeName(device)} ${stamp(now)}).antibiogramj.json`, parents: [backupsFolder],
    mimeType: "application/json", appProperties: { ...appProperties, conflict: "1" },
  }, body);
  return { file, conflict: true };
}

/** A full backup: a new file every time (never overwritten). */
export function saveFullBackup(c: DriveClient, backupsFolder: string, body: Blob, count: number, now = new Date()): Promise<DriveFile> {
  return c.upload({
    name: `All experiments ${stamp(now)}.antibiogramj.json`, parents: [backupsFolder], mimeType: "application/json",
    appProperties: { aj: "full", count: String(count) },
  }, body);
}

export function listBackups(c: DriveClient, backupsFolder: string): Promise<DriveFile[]> {
  return c.list(`${quote(backupsFolder)} in parents and trashed = false and mimeType = 'application/json'`);
}

// ------------------------------------------------------------- phone captures

/** The JSON sidecar uploaded with each photo. */
export interface CaptureMeta {
  format: "antibiogramj-capture"; version: 1; id: string; captured_at: string; device: string;
  family_id: number | null; genus: string; species: string; strain: string; sample: string; notes: string;
  /** EUCAST QC strain id (src/qc.ts), "" for a clinical isolate; absent in captures of older versions. */
  qc_strain?: string;
  image: string; original: string | null; width: number; height: number;
  /** Small JPEG preview (data URL) so that the inbox can be listed without downloading the photos. */
  thumbnail: string;
}

export interface CaptureUpload {
  meta: Omit<CaptureMeta, "image" | "original">;
  image: Blob;
  original: { blob: Blob; name: string } | null;
}

/**
 * Uploads a capture into the inbox: the photo, the original (optional) and finally the sidecar, whose presence
 * marks the capture as complete. Idempotent: parts already uploaded by an interrupted attempt are reused.
 */
export async function uploadCapture(c: DriveClient, inbox: string, cap: CaptureUpload): Promise<string> {
  const id = cap.meta.id;
  const parts = await c.list(`appProperties has { key='capture' and value=${quote(id)} } and trashed = false`, "createdTime");
  const part = (role: string) => parts.find((f) => f.appProperties?.role === role);
  const sidecar = part("meta");
  if (sidecar) return sidecar.id;
  const base = `${stamp(new Date(cap.meta.captured_at), true)} ${safeName([cap.meta.genus, cap.meta.species, cap.meta.strain, cap.meta.sample].filter(Boolean).join(" ") || "plate")} ${id.slice(0, 8)}`;
  const image = part("image") ?? await c.upload({
    name: `${base}.jpg`, parents: [inbox], mimeType: "image/jpeg", appProperties: { capture: id, role: "image" },
  }, cap.image);
  let original: DriveFile | undefined;
  if (cap.original) {
    const ext = /\.([a-z0-9]{2,5})$/i.exec(cap.original.name)?.[1]?.toLowerCase() ?? "jpg";
    original = part("original") ?? await c.upload({
      name: `${base} original.${ext}`, parents: [inbox], mimeType: cap.original.blob.type || "application/octet-stream",
      appProperties: { capture: id, role: "original" },
    }, cap.original.blob);
  }
  const meta: CaptureMeta = { ...cap.meta, image: image.id, original: original?.id ?? null };
  const file = await c.upload({
    name: `${base}.json`, parents: [inbox], mimeType: "application/json", appProperties: { capture: id, role: "meta", aj: "capture" },
  }, new Blob([JSON.stringify(meta)], { type: "application/json" }));
  return file.id;
}

export interface InboxItem { sidecar: DriveFile; meta: CaptureMeta }

/** Complete captures waiting in the inbox, newest first. */
export async function listInbox(c: DriveClient, inbox: string): Promise<InboxItem[]> {
  const sidecars = await c.list(`${quote(inbox)} in parents and trashed = false and appProperties has { key='aj' and value='capture' }`, "createdTime desc");
  const items: InboxItem[] = [];
  for (let i = 0; i < sidecars.length; i += 6) {
    const batch = await Promise.all(sidecars.slice(i, i + 6).map(async (f) => {
      try {
        const meta = JSON.parse(await (await c.download(f.id)).text()) as CaptureMeta;
        return meta?.format === "antibiogramj-capture" ? { sidecar: f, meta } : null;
      } catch (e) {
        if (e instanceof DriveError && e.kind !== "notFound") throw e;
        return null;
      }
    }));
    items.push(...batch.filter((x): x is InboxItem => x !== null));
  }
  return items;
}

/** Moves the photo, original and sidecar of a capture to Inbox/Processed (missing parts are ignored). */
export async function markProcessed(c: DriveClient, f: Folders, item: { sidecarId: string; image: string; original: string | null }) {
  for (const id of [item.image, item.original, item.sidecarId]) { // the sidecar last: it lists the capture
    if (!id) continue;
    try {
      if ((await c.get(id)).parents?.includes(f.inbox)) await c.move(id, f.processed, f.inbox);
    } catch (e) {
      if (!(e instanceof DriveError && e.kind === "notFound")) throw e;
    }
  }
}
