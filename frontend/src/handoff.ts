// Hand-off of a photo to the "Add plate" wizard from the inbox (Google Drive or the local import queue), and a
// notification when a plate has been saved (used by the Google Drive auto-save). No browser-only dependencies.
import type { BacteriaIn } from "./api";

export interface Handoff {
  file: File;
  bacteria: Partial<BacteriaIn>;
  /** Shown in the wizard, e.g. "Photo from the Google Drive inbox (taken 12/11/2026 on Android phone)". */
  label: string;
  /** Called after the plate is saved (marks the photo as processed); must not throw. */
  onSaved?: () => Promise<void>;
}

let pending: Handoff | null = null;

export function setHandoff(h: Handoff) { pending = h; }

/** The photo waiting for the wizard (kept until the plate is saved or another photo is handed off). */
export const currentHandoff = (): Handoff | null => pending;
export function clearHandoff(h: Handoff) { if (pending === h) pending = null; }

const saved = new Set<(experimentId: number) => void>();
export function onPlateSaved(fn: (experimentId: number) => void) {
  saved.add(fn);
  return () => { saved.delete(fn); };
}
export function plateSaved(experimentId: number) { saved.forEach((fn) => fn(experimentId)); }
