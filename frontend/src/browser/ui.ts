// Browser-build-only screens (Google Drive, phone capture, inbox), loaded on demand. Shared pages import them
// as "virtual:browser-ui", which vite.config.ts resolves to this file or to ui.server.ts (empty stand-ins).
import { lazy } from "react";

export const CapturePage = lazy(() => import("../pages/CapturePage"));
export const InboxPage = lazy(() => import("../pages/InboxPage"));
export const DrivePanel = lazy(() => import("../components/DrivePanel"));
export const DriveStatus = lazy(() => import("../components/DrivePanel").then((m) => ({ default: m.DriveStatus })));
export const SaveExperimentButton = lazy(() => import("../components/DrivePanel").then((m) => ({ default: m.SaveExperimentButton })));

/** Registers the Drive auto-save and resumes pending uploads (no network until the user connects). */
export function initCloud() { void import("./cloud"); }
