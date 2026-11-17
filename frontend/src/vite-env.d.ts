/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND?: "server" | "browser";
  /** OAuth web client ID for Google Drive (browser build); Drive features are hidden without it. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

declare module "virtual:browser-ui" {
  type Ui = typeof import("./browser/ui");
  export const CapturePage: Ui["CapturePage"];
  export const InboxPage: Ui["InboxPage"];
  export const DrivePanel: Ui["DrivePanel"];
  export const DriveStatus: Ui["DriveStatus"];
  export const SaveExperimentButton: Ui["SaveExperimentButton"];
  export const initCloud: Ui["initCloud"];
}

declare module "virtual:api-impl" {
  const api: import("./api").Api;
  export default api;
}
