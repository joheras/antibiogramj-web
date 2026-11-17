// Progress messages of long computations (the in-browser analysis reports them from its worker).

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function onProgress(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function reportProgress(message: string) {
  for (const fn of listeners) fn(message);
}
