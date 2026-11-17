// Inbox (browser build): photos waiting to be analysed on this computer, either sent from a phone to the
// user's Google Drive (Capture mode) or added here from files (copied by cable, AirDrop, a USB stick…).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type ExperimentSummary } from "../api";
import {
  addLocalFiles, connect, describe, driveConfigured, inboxItems, localQueue, markInboxProcessed, prepareInboxAnalysis,
  prepareLocalAnalysis, removeLocal, subscribeQueues, useDrive, type InboxItem,
} from "../browser/cloud";
import type { LocalItem } from "../browser/captureDb";
import { useSession } from "../session";

const organismLabel = (o: { genus?: string; species?: string } | null) =>
  (o && [o.genus, o.species].filter(Boolean).join(" ")) || "Organism not given";
const details = (o: { strain?: string; sample?: string } | null) =>
  [o?.strain && `strain ${o.strain}`, o?.sample && `sample ${o.sample}`].filter(Boolean).join(" · ");

export default function InboxPage() {
  const { catalog } = useSession();
  const navigate = useNavigate();
  const { auth } = useDrive();
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [target, setTarget] = useState<number | "new">("new");
  const [driveItems, setDriveItems] = useState<InboxItem[] | null>(null);
  const [local, setLocal] = useState<LocalItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    api.experiments().then((xs) => {
      setExperiments(xs);
      if (xs.length) setTarget(xs[0].id);
    }).catch((e) => setError(describe(e)));
    const refresh = () => { localQueue().then(setLocal).catch((e) => setError(describe(e))); };
    refresh();
    return subscribeQueues(refresh);
  }, []);

  const refreshDrive = useCallback(() => {
    setError(null);
    setBusy("Reading the Google Drive inbox…");
    inboxItems().then(setDriveItems).catch((e) => setError(describe(e))).finally(() => setBusy(null));
  }, []);
  useEffect(() => { if (auth.status === "connected") refreshDrive(); }, [auth.status, refreshDrive]);

  async function run(message: string, fn: () => Promise<void>) {
    setBusy(message);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  }

  /** The experiment chosen above, created first if "New experiment" is selected. */
  async function experimentId(): Promise<number | null> {
    if (target !== "new") return target;
    const name = prompt("Name of the new experiment", `Inbox ${new Date().toLocaleDateString()}`);
    if (!name?.trim()) return null;
    const exp = await api.createExperiment({ name: name.trim(), comments: "", standard_id: null });
    return exp.id;
  }

  const analyseDrive = (item: InboxItem) => run("Downloading the photo…", async () => {
    const id = await experimentId();
    if (id === null) return;
    await prepareInboxAnalysis(item, catalog.families);
    navigate(`/experiments/${id}/add-plate?from=inbox`);
  });

  const analyseLocal = (item: LocalItem) => run("Opening the photo…", async () => {
    const id = await experimentId();
    if (id === null) return;
    prepareLocalAnalysis(item, catalog.families);
    navigate(`/experiments/${id}/add-plate?from=inbox`);
  });

  const addFiles = (files: File[]) => run("Adding photos…", async () => {
    const n = await addLocalFiles(files);
    if (!n) throw new Error("No images among the chosen files (JPEG, PNG or TIFF).");
  });

  return (
    <div className="page">
      <nav className="crumbs"><Link to="/">Experiments</Link> / Inbox</nav>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p className="muted">Photos waiting to be analysed. <b>Analyse</b> opens the usual steps with the photo and the organism
            data already filled in; once the plate is saved the photo leaves the inbox.</p>
        </div>
      </div>

      <div className="card inbox-target">
        <label>Add the plates to the experiment
          <select value={target} onChange={(e) => setTarget(e.target.value === "new" ? "new" : Number(e.target.value))}>
            {experiments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            <option value="new">New experiment…</option>
          </select>
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      {busy && <div className="busy"><div className="spinner" />{busy}</div>}

      {driveConfigured && (
        <section className="card inbox-section">
          <div className="section-head">
            <div>
              <h2>From your phone (Google Drive)</h2>
              <p className="muted small">Photos sent with <Link to="/capture">Capture</Link> on a phone to <i>AntibiogramJ/Inbox</i>.
                Analysed photos are moved to <i>Inbox/Processed</i>.</p>
            </div>
            <div className="actions">
              {auth.status === "connected"
                ? <button onClick={refreshDrive}>Refresh</button>
                : <button className="primary" disabled={auth.status === "connecting"} onClick={() => connect().catch((e) => setError(describe(e)))}>
                  {auth.status === "expired" ? "Reconnect" : "Connect Google Drive"}</button>}
            </div>
          </div>
          {auth.status === "connected" && driveItems !== null && (driveItems.length === 0
            ? <p className="muted">The inbox is empty. On the phone, open AntibiogramJ → <b>Capture</b>, connect the same Google account and send photos.</p>
            : (
              <ul className="inbox-list">
                {driveItems.map((i) => (
                  <li key={i.sidecar.id}>
                    <img src={i.meta.thumbnail} alt="" />
                    <div className="grow">
                      <b><i>{organismLabel(i.meta)}</i></b>{i.meta.qc_strain && <> <span className="tag">QC</span></>}
                      {i.meta.family_id && <span className="muted small"> · {catalog.families.find((f) => f.id === i.meta.family_id)?.name}</span>}
                      <div className="muted small">{[details(i.meta), `${new Date(i.meta.captured_at).toLocaleString()}, ${i.meta.device}`,
                        i.meta.original && "original included"].filter(Boolean).join(" · ")}</div>
                      {i.meta.notes && <div className="small">{i.meta.notes}</div>}
                    </div>
                    <div className="btn-col">
                      <button className="primary small" onClick={() => analyseDrive(i)}>Analyse</button>
                      <button className="ghost small" onClick={() => run("Moving to Processed…", async () => {
                        if (!confirm("Move this photo to Inbox/Processed without analysing it?")) return;
                        await markInboxProcessed(i);
                        setDriveItems((xs) => xs?.filter((x) => x !== i) ?? null);
                      })}>Skip</button>
                    </div>
                  </li>
                ))}
              </ul>
            ))}
        </section>
      )}

      <section className={`card inbox-section ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}>
        <div className="section-head">
          <div>
            <h2>Photos on this computer</h2>
            <p className="muted small">Add several photos at once (or drop them here) and analyse them one by one. They stay in this
              browser only. JSON files sent by Capture mode, if added with their photos, fill in the organism data.</p>
          </div>
          <div className="actions">
            <button onClick={() => fileRef.current?.click()}>Add photos…</button>
            <input ref={fileRef} type="file" multiple hidden accept="image/*,.tif,.tiff,.json,application/json"
              onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) addFiles(fs); }} />
          </div>
        </div>
        {local.length === 0 ? <p className="muted">No photos in the queue.</p> : (
          <ul className="inbox-list">
            {local.map((i) => (
              <li key={i.id}>
                {i.thumbnail ? <img src={i.thumbnail} alt="" /> : <div className="img-placeholder" />}
                <div className="grow">
                  <b>{i.file.name}</b>
                  <div className="muted small">{i.organism
                    ? [organismLabel(i.organism), details(i.organism)].filter(Boolean).join(" · ")
                    : `${(i.file.size / 1e6).toFixed(1)} MB · added ${new Date(i.added_at).toLocaleString()}`}</div>
                </div>
                <div className="btn-col">
                  <button className="primary small" onClick={() => analyseLocal(i)}>Analyse</button>
                  <button className="ghost small danger" onClick={() => void removeLocal(i.id)}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
