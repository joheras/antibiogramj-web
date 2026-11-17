// Google Drive connection, backups and auto-save (browser build only; loaded lazily).
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  autosaveEnabled, clearMessage, connect, describe, disconnect, driveConfigured, importDriveBackup, listDriveBackups,
  previewDriveBackup, saveAllToDrive, saveExperimentToDrive, setAutosave, useDrive, type BackupPreview, type DriveFile,
} from "../browser/cloud";

export function DriveStatus() {
  const { auth, sync } = useDrive();
  const [error, setError] = useState<string | null>(null);
  if (auth.status === "unconfigured") return null;
  const reconnect = () => { setError(null); connect().catch((e) => setError(describe(e))); };
  return (
    <>
      {(auth.status === "expired" || (auth.status === "disconnected" && sync.dirty > 0)) && (
        <p className="warn drive-banner">
          {auth.status === "expired" ? "The Google Drive session has expired" : "Google Drive is not connected"}
          {sync.dirty ? ` (${sync.dirty} experiment(s) waiting to be saved)` : ""}.{" "}
          <button className="small" onClick={reconnect}>Reconnect</button>
        </p>
      )}
      {sync.busy && <p className="muted small">{sync.busy}</p>}
      {sync.message && (
        <p className={`${sync.message.kind === "ok" ? "ok" : sync.message.kind === "warn" ? "warn" : "error"} drive-banner`}>
          {sync.message.text} <button className="link small" onClick={clearMessage}>Dismiss</button>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

/** "Connect Google Drive" or, when connected, the account and the backup actions. */
export default function DrivePanel({ experimentCount, onImported }: { experimentCount: number; onImported: (n: number) => void }) {
  const { auth } = useDrive();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [backups, setBackups] = useState<DriveFile[] | null>(null);
  const [autosave, setAuto] = useState(autosaveEnabled());

  if (!driveConfigured) return null;

  async function run(message: string, fn: () => Promise<void>) {
    setBusy(message);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  }

  const doConnect = () => run("Connecting to Google Drive…", connect);

  const load = (b: DriveFile) => run(`Downloading ${b.name}…`, async () => {
    const p: BackupPreview = await previewDriveBackup(b);
    const existing = p.experiments.filter((e) => e.exists);
    const names = p.experiments.map((e) => `• ${e.name}${e.exists ? " (already here: added as a copy)" : ""}`).join("\n");
    if (!confirm(`Add ${p.experiments.length} experiment(s) from Google Drive to this browser?\n\n${names}`
      + (existing.length ? "\n\nExperiments already in this browser are not overwritten." : ""))) return;
    const n = await importDriveBackup(p);
    setNotice(`${n} experiment(s) loaded from Google Drive.`);
    onImported(n);
  });

  const connectedOrExpired = auth.status === "connected" || auth.status === "expired";

  return (
    <section className="card drive-panel">
      <div className="section-head">
        <div>
          <h2>Google Drive</h2>
          {connectedOrExpired ? (
            <p className="muted small">Connected as <b>{auth.email}</b>. AntibiogramJ only sees the files it creates in the
              folder <i>AntibiogramJ</i> of your Drive.</p>
          ) : (
            <p className="muted small">Optional: save experiments to your own Google Drive, load them on another computer and
              receive photos taken with your phone. Nothing is sent anywhere else. <a href="privacy.html" target="_blank" rel="noreferrer">Privacy</a></p>
          )}
        </div>
        <div className="actions">
          {auth.status === "connecting" && <span className="muted small">Waiting for Google…</span>}
          {auth.status === "disconnected" && (
            <button className="primary" onClick={doConnect} disabled={!!busy}>{auth.wasConnected ? "Reconnect Google Drive" : "Connect Google Drive"}</button>
          )}
          {auth.status === "expired" && <button className="primary" onClick={doConnect} disabled={!!busy}>Reconnect</button>}
          {auth.status === "connected" && (
            <>
              <button onClick={() => run("Saving all experiments to Google Drive…", async () => {
                const f = await saveAllToDrive(experimentCount);
                setNotice(`Saved "${f.name}" in AntibiogramJ/Backups.`);
              })} disabled={!!busy || experimentCount === 0}>Save all to Drive</button>
              <button onClick={() => run("Listing backups…", async () => setBackups(backups ? null : await listDriveBackups()))} disabled={!!busy}>
                {backups ? "Close list" : "Load from Drive"}</button>
              <Link className="button" to="/inbox">Inbox</Link>
            </>
          )}
          {connectedOrExpired && <button className="ghost small" onClick={() => { setBackups(null); void disconnect(); }}>Disconnect</button>}
        </div>
      </div>
      {connectedOrExpired && (
        <label className="check small">
          <input type="checkbox" checked={autosave} onChange={(e) => { setAuto(e.target.checked); setAutosave(e.target.checked); }} />
          Save the experiment to Google Drive automatically every time a plate is saved
        </label>
      )}
      {busy && <p className="muted small">{busy}</p>}
      {notice && <p className="ok">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {backups && (
        backups.length === 0 ? <p className="muted">There are no backups in AntibiogramJ/Backups yet.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Backup</th><th>Saved</th><th className="num">Size</th><th /></tr></thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.appProperties?.aj === "full" ? <><b>All experiments</b> <span className="muted">({b.appProperties.count ?? "?"})</span></>
                        : <b>{b.appProperties?.name ?? b.name}</b>}
                      {b.appProperties?.conflict && <span className="tag tag-warn">conflict copy</span>}
                      <div className="muted small">{b.name}</div>
                    </td>
                    <td>{b.modifiedTime ? new Date(b.modifiedTime).toLocaleString() : ""}</td>
                    <td className="num">{b.size ? `${(Number(b.size) / 1e6).toFixed(1)} MB` : ""}</td>
                    <td className="actions"><button className="small" onClick={() => load(b)} disabled={!!busy}>Load</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}

/** "Save to Drive" for one experiment (shown when connected). */
export function SaveExperimentButton({ experimentId }: { experimentId: number }) {
  const { auth } = useDrive();
  const [state, setState] = useState<{ busy?: boolean; text?: string; kind?: "ok" | "warn" | "error" }>({});
  if (auth.status !== "connected" && auth.status !== "expired") return null;
  const save = async () => {
    setState({ busy: true });
    try {
      const r = await saveExperimentToDrive(experimentId);
      setState(r.conflict
        ? { kind: "warn", text: `This experiment was changed in Google Drive from another device; saved as a separate copy "${r.name}".` }
        : { kind: "ok", text: "Saved to Google Drive (AntibiogramJ/Backups)." });
    } catch (e) {
      setState({ kind: "error", text: describe(e) });
    }
  };
  return (
    <>
      <button onClick={save} disabled={state.busy}>{state.busy ? "Saving…" : "Save to Drive"}</button>
      {state.text && <p className={`${state.kind} drive-inline`}>{state.text}</p>}
    </>
  );
}
