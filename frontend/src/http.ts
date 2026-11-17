// Client of the FastAPI backend (server mode). Authentication is an httpOnly cookie.
import { ApiError, type Api, type ExperimentDetail, type Standard } from "./api";
import { experimentWorkbook } from "./excel";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
      else if (Array.isArray(data.detail)) message = data.detail.map((d: { msg: string }) => d.msg).join("; ");
    } catch { /* not JSON */ }
    throw new ApiError(res.status, message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const httpApi: Api = {
  me: () => request("GET", "/api/auth/me"),
  login: (email, password) => request("POST", "/api/auth/login", { email, password }),
  register: (data) => request("POST", "/api/auth/register", data),
  logout: () => request("POST", "/api/auth/logout"),

  standards: () => request("GET", "/api/catalog/standards"),
  families: () => request("GET", "/api/catalog/families"),
  antibiotics: () => request("GET", "/api/catalog/antibiotics"),

  experiments: () => request("GET", "/api/experiments"),
  experiment: (id) => request("GET", `/api/experiments/${id}`),
  createExperiment: (data) => request("POST", "/api/experiments", data),
  deleteExperiment: (id) => request("DELETE", `/api/experiments/${id}`),
  deleteAntibiogram: (id) => request("DELETE", `/api/antibiograms/${id}`),
  updateAntibiogram: (id, data) => request("PATCH", `/api/antibiograms/${id}`, data),
  reinterpretExperiment: (id, data) => request("POST", `/api/experiments/${id}/reinterpret`, data),
  plate: (id) => request("GET", `/api/plates/${id}`),
  deletePlate: (id) => request("DELETE", `/api/plates/${id}`),
  plateImage: async (id, annotated) => `/api/plates/${id}/image?annotated=${annotated}`,
  // Built in the browser so that it includes the expert system (/api/experiments/{id}/export.xlsx has no rules).
  exportExperiment: async (id, name) => experimentWorkbook(await request<ExperimentDetail>("GET", `/api/experiments/${id}`), name,
    await request<Standard[]>("GET", "/api/catalog/standards")),

  upload: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("POST", "/api/analysis/uploads", form);
  },
  uploadImage: async (id, stage, version = 0) => `/api/analysis/uploads/${id}/image?stage=${stage}&v=${version}`,
  process: (id, crop, autoContrast) =>
    request("POST", `/api/analysis/uploads/${id}/process`, { crop, auto_contrast: autoContrast }),
  detectDisks: (id) => request("POST", `/api/analysis/uploads/${id}/disks`),
  identify: (id, disks, context) => request("POST", `/api/analysis/uploads/${id}/identify`, { disks, ...context }),
  halos: (id, data) => request("POST", `/api/analysis/uploads/${id}/halos`, data),
  savePlate: (data) => request("POST", "/api/plates", data),
};

export default httpApi;
