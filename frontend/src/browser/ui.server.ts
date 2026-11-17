// Server build: the browser-only screens of ui.ts do not exist (see vite.config.ts, "virtual:browser-ui").
import type * as Ui from "./ui";

const none = () => null;
export const CapturePage: typeof Ui.CapturePage = none as never;
export const InboxPage: typeof Ui.InboxPage = none as never;
export const DrivePanel: typeof Ui.DrivePanel = none as never;
export const DriveStatus: typeof Ui.DriveStatus = none as never;
export const SaveExperimentButton: typeof Ui.SaveExperimentButton = none as never;
export function initCloud() { /* no cloud features in the server build */ }
