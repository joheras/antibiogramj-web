// Installable app (in-browser version only): service worker registration, "update available"
// and "install" state for the UI, and persistent storage.
import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

const state = {
  waiting: null as ServiceWorker | null,
  installPrompt: null as InstallPromptEvent | null,
};
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // offered from the Help page and the top bar instead
    state.installPrompt = e as InstallPromptEvent;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    changed();
    navigator.storage?.persist?.().catch(() => undefined);
  });
  window.addEventListener("load", async () => {
    let reg: ServiceWorkerRegistration;
    try {
      reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (e) {
      console.warn("Service worker not registered:", e);
      return;
    }
    const track = (sw: ServiceWorker | null) => {
      if (!sw) return;
      const check = () => {
        // A new version is installed while an older one controls the page.
        if (sw.state === "installed" && navigator.serviceWorker.controller) { state.waiting = sw; changed(); }
      };
      check();
      sw.addEventListener("statechange", check);
    };
    track(reg.waiting);
    track(reg.installing);
    reg.addEventListener("updatefound", () => track(reg.installing));
    // Installed apps can stay open for days: look for updates when they come back to the front.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => undefined);
    });
  });
}

/** Activates the waiting version and reloads the page when it has taken over. */
export function applyUpdate() {
  const sw = state.waiting;
  if (!sw) return location.reload();
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  sw.postMessage("skip-waiting");
}

export async function promptInstall() {
  const e = state.installPrompt;
  if (!e) return;
  await e.prompt();
  await e.userChoice.catch(() => undefined);
  state.installPrompt = null;
  changed();
}

export function usePwa() {
  const [, render] = useState(0);
  useEffect(() => {
    const fn = () => render((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return { updateAvailable: !!state.waiting, canInstall: !!state.installPrompt };
}

export const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** Whether the browser has promised not to evict the data (null: unknown). */
export function usePersistentStorage(): [boolean | null, () => Promise<void>] {
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => { navigator.storage?.persisted?.().then(setPersisted).catch(() => undefined); }, []);
  const request = async () => {
    const ok = await navigator.storage?.persist?.().catch(() => false);
    setPersisted(!!ok);
  };
  return [persisted, request];
}
