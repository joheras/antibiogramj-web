// Minimal promise wrapper around IndexedDB for the in-browser version.

export type StoreName = "experiments" | "antibiograms" | "plates" | "blobs" | "templates";

const DB_NAME = "antibiogramj";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("experiments", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("antibiograms", { keyPath: "id", autoIncrement: true }).createIndex("experiment_id", "experiment_id");
      db.createObjectStore("plates", { keyPath: "id", autoIncrement: true }).createIndex("antibiogram_id", "antibiogram_id");
      db.createObjectStore("blobs");
      db.createObjectStore("templates", { keyPath: "id", autoIncrement: true }).createIndex("antibiotic_id", "antibiotic_id");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Cannot open the browser database"));
    req.onblocked = () => reject(new Error("The database is open in an older tab; close it and reload"));
  });
  // Ask the browser not to evict our data under storage pressure (best effort).
  navigator.storage?.persist?.().catch(() => undefined);
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await open();
  return done(db.transaction(store).objectStore(store).get(key));
}

export async function getAll<T>(store: StoreName, index?: string, value?: IDBValidKey): Promise<T[]> {
  const db = await open();
  const s = db.transaction(store).objectStore(store);
  return done(index ? s.index(index).getAll(value) : s.getAll());
}

/** Runs ``fn`` in one read-write transaction over ``stores`` and resolves when it commits. */
export async function write<T>(stores: StoreName[], fn: (tx: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await open();
  const tx = db.transaction(stores, "readwrite");
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
  let result: T;
  try {
    result = await fn(tx);
  } catch (e) {
    tx.abort();
    throw e;
  }
  await committed;
  return result;
}

export const put = <K extends IDBValidKey = number>(tx: IDBTransaction, store: StoreName, value: unknown, key?: IDBValidKey) =>
  done(tx.objectStore(store).put(value, key)) as Promise<K>;

export const del = (tx: IDBTransaction, store: StoreName, key: IDBValidKey) => done(tx.objectStore(store).delete(key));

export const txGetAll = <T>(tx: IDBTransaction, store: StoreName, index: string, value: IDBValidKey) =>
  done(tx.objectStore(store).index(index).getAll(value)) as Promise<T[]>;
