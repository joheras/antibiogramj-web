// Queues of photos waiting to be analysed, in their own IndexedDB database (separate from the experiments):
//  * outbox: photos taken on this device in Capture mode, waiting to be uploaded to the Google Drive inbox;
//  * local:  photos added to this computer's import queue (copied by cable, AirDrop…), waiting to be analysed.

import type { CaptureMeta, CaptureUpload } from "./drive";

const DB_NAME = "antibiogramj-capture";
const VERSION = 1;
type Store = "outbox" | "local";

export type Organism = Pick<CaptureMeta, "family_id" | "genus" | "species" | "strain" | "sample" | "notes" | "qc_strain">;

export interface OutboxItem {
  id: string; created_at: string; meta: CaptureUpload["meta"];
  image: Blob | null; original: { blob: Blob; name: string } | null;
  status: "pending" | "uploading" | "done" | "error"; error: string | null; attempts: number;
}

export interface LocalItem {
  id: string; added_at: string; file: File; organism: Organism | null; thumbnail: string | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("outbox", { keyPath: "id" });
      req.result.createObjectStore("local", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Cannot open the browser database"));
  });
  return dbPromise;
}

function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  }));
}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export const all = <T>(store: Store) => run<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
export const get = <T>(store: Store, id: string) => run<T | undefined>(store, "readonly", (s) => s.get(id) as IDBRequest<T | undefined>);
export const put = (store: Store, value: OutboxItem | LocalItem) => run(store, "readwrite", (s) => s.put(value)).then(changed);
export const remove = (store: Store, id: string) => run(store, "readwrite", (s) => s.delete(id)).then(changed);
