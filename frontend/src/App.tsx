import { Suspense, useCallback, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, MODE, type User } from "./api";
import { applyUpdate, promptInstall, usePwa } from "./pwa";
import { type Catalog, SessionContext } from "./session";
import AuthPage from "./pages/AuthPage";
import ExperimentsPage from "./pages/ExperimentsPage";
import ExperimentPage from "./pages/ExperimentPage";
import HelpPage from "./pages/HelpPage";
import PlatePage from "./pages/PlatePage";
import WizardPage from "./pages/WizardPage";
// Google Drive, phone capture and inbox (browser build only; empty in the server build).
import { CapturePage, DriveStatus, InboxPage, initCloud } from "virtual:browser-ui";

async function loadCatalog(): Promise<Catalog> {
  const [standards, families, antibiotics] = await Promise.all([api.standards(), api.families(), api.antibiotics()]);
  return { standards, families, antibiotics, antibioticById: new Map(antibiotics.map((a) => [a.id, a])) };
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pwa = usePwa();

  const onLogin = useCallback(async (u: User) => {
    try {
      setCatalog(await loadCatalog());
      setUser(u);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { if (MODE === "browser") initCloud(); }, []);

  useEffect(() => {
    api.me().then(onLogin).catch((e) => {
      if (e instanceof ApiError && e.status === 401) setUser(null);
      else setError((e as Error).message);
    });
  }, [onLogin]);

  const logout = useCallback(() => {
    api.logout().finally(() => {
      setUser(null);
      setCatalog(null);
    });
  }, []);

  if (error) return <div className="center"><p className="error">Cannot reach the server: {error}</p></div>;
  if (user === undefined) return <div className="center"><p className="muted">Loading…</p></div>;
  if (user === null || !catalog) return <AuthPage onLogin={onLogin} />;

  return (
    <SessionContext.Provider value={{ user, catalog, logout }}>
      <header className="topbar">
        <Link to="/" className="brand"><span className="logo" aria-hidden>◉</span> AntibiogramJ</Link>
        {MODE === "server" ? (
          <div className="topbar-user">
            <Link to="/help" className="topbar-link">Help</Link>
            <span title={user.email}>{user.name || user.email}{user.lab && <span className="muted"> · {user.lab}</span>}</span>
            <button className="ghost" onClick={logout}>Sign out</button>
          </div>
        ) : (
          <div className="topbar-user">
            {pwa.canInstall && <button className="small" onClick={promptInstall} title="Install AntibiogramJ as an app on this device">Install</button>}
            <Link to="/capture" className="topbar-link" title="Take photos with this phone and send them to your Google Drive">Capture</Link>
            <Link to="/inbox" className="topbar-link" title="Photos waiting to be analysed">Inbox</Link>
            <Link to="/help" className="topbar-link">Help</Link>
            <span className="tag topbar-offline" title="Images and results are stored in this browser; they are only sent to your own Google Drive if you connect it.">Data stays in this browser</span>
          </div>
        )}
      </header>
      {pwa.updateAvailable && (
        <div className="update-banner" role="status">
          A new version of AntibiogramJ is available.
          <button className="small primary" onClick={applyUpdate}>Reload</button>
        </div>
      )}
      <main>
        {MODE === "browser" && <Suspense fallback={null}><DriveStatus /></Suspense>}
        <Suspense fallback={<p className="muted">Loading…</p>}>
        <Routes>
          <Route path="/" element={<ExperimentsPage />} />
          <Route path="/experiments/:id" element={<ExperimentPage />} />
          <Route path="/experiments/:id/add-plate" element={<WizardPage />} />
          <Route path="/plates/:id" element={<PlatePage />} />
          <Route path="/help" element={<HelpPage />} />
          {MODE === "browser" && <Route path="/capture" element={<CapturePage />} />}
          {MODE === "browser" && <Route path="/inbox" element={<InboxPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>
      {MODE === "browser" && (
        <footer className="footer muted small">
          AntibiogramJ · <Link to="/help">Help</Link> · <a href="privacy.html">Privacy policy</a>
        </footer>
      )}
    </SessionContext.Provider>
  );
}
