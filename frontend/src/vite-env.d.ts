/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND?: "server" | "browser";
}

declare module "virtual:api-impl" {
  const api: import("./api").Api;
  export default api;
}
