// Sign-in to Google Drive with Google Identity Services (token model). The script of accounts.google.com is
// loaded only when the user clicks "Connect Google Drive". The access token (scope drive.file, about 1 hour) is
// kept in memory only: there are no refresh tokens and nothing is stored but a "was connected" flag.

import { DriveError } from "./drive";

export const CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
export const SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_URL = "https://accounts.google.com/gsi/client";
const FLAG = "aj.drive.connected";

interface TokenResponse { access_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }
interface TokenClient { requestAccessToken(o?: { prompt?: string; login_hint?: string }): void }
interface Gis {
  accounts: { oauth2: {
    initTokenClient(c: {
      client_id: string; scope: string; callback: (r: TokenResponse) => void;
      error_callback?: (e: { type: string; message?: string }) => void;
    }): TokenClient;
    revoke(token: string, done?: () => void): void;
    hasGrantedAllScopes(r: TokenResponse, scope: string): boolean;
  } };
}
declare global { interface Window { google?: Gis } }

export type AuthState =
  | { status: "unconfigured" } | { status: "disconnected"; wasConnected: boolean } | { status: "connecting" }
  | { status: "connected"; email: string } | { status: "expired"; email: string };

let state: AuthState = !CLIENT_ID ? { status: "unconfigured" } : { status: "disconnected", wasConnected: readFlag() };
let token: { value: string; expiresAt: number } | null = null;
let email = "";
const listeners = new Set<() => void>();

function readFlag() {
  try { return localStorage.getItem(FLAG) === "1"; } catch { return false; }
}
function writeFlag(on: boolean) {
  try { if (on) localStorage.setItem(FLAG, "1"); else localStorage.removeItem(FLAG); } catch { /* storage blocked */ }
}

function set(s: AuthState) {
  state = s;
  listeners.forEach((l) => l());
}

export const authState = () => state;
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

let gisPromise: Promise<Gis> | null = null;
function loadGis(): Promise<Gis> {
  gisPromise ??= new Promise<Gis>((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google);
    const s = document.createElement("script");
    s.src = GIS_URL;
    s.async = true;
    s.onload = () => (window.google?.accounts?.oauth2 ? resolve(window.google) : reject(new Error("Google sign-in did not load")));
    s.onerror = () => reject(new Error("Cannot load Google sign-in. Check the connection (or an ad/tracker blocker) and try again."));
    document.head.appendChild(s);
  }).catch((e) => { gisPromise = null; throw e; });
  return gisPromise;
}

/**
 * Asks Google for an access token. Must be called from a click: Google opens a pop-up (on the first time to
 * choose the account and accept; later it closes by itself). ``onConnected`` reads the account e-mail.
 */
export async function connect(onConnected: () => Promise<string>): Promise<void> {
  if (!CLIENT_ID) throw new Error("Google Drive is not configured in this build of AntibiogramJ.");
  const previous = state;
  set({ status: "connecting" });
  try {
    const gis = await loadGis();
    const response = await new Promise<TokenResponse>((resolve, reject) => {
      const client = gis.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE,
        callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
        error_callback: (e) => reject(new Error(
          e.type === "popup_closed" ? "The Google window was closed before finishing."
            : e.type === "popup_failed_to_open" ? "The browser blocked the Google window. Allow pop-ups for this site and click Connect again."
              : e.message || e.type)),
      });
      client.requestAccessToken(email ? { prompt: "", login_hint: email } : {});
    });
    if (!response.access_token || !gis.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) {
      throw new Error("Google Drive access was not granted. Tick the Google Drive permission to use these features.");
    }
    token = { value: response.access_token, expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000 };
    email = await onConnected();
    writeFlag(true);
    set({ status: "connected", email });
  } catch (e) {
    token = null;
    set(previous.status === "connecting" ? { status: "disconnected", wasConnected: readFlag() } : previous);
    throw e;
  }
}

/** The current access token, or a DriveError("auth") when there is none or it has expired. */
export async function getToken(): Promise<string> {
  if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
  if (token) expire();
  throw new DriveError("auth", state.status === "unconfigured" || !email
    ? "Connect to Google Drive first." : "The Google Drive session has expired. Click Reconnect.");
}

/** Called when Google rejects the token. */
export function expire() {
  token = null;
  if (state.status === "connected") set({ status: "expired", email });
}

export async function disconnect(): Promise<void> {
  const t = token?.value;
  token = null;
  email = "";
  writeFlag(false);
  set({ status: "disconnected", wasConnected: false });
  if (t && window.google) await new Promise<void>((r) => window.google!.accounts.oauth2.revoke(t, r));
}
