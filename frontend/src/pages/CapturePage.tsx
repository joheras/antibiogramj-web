// Capture mode (browser build): take photos of plates with the phone and send them, with the organism data, to
// the inbox in the user's Google Drive, to analyse them later on a computer. Works with an intermittent connection:
// the photos wait in this browser and are uploaded when there is a connection.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  clearSentCaptures, connect, describe, driveConfigured, outbox, processOutbox, queueCaptures, removeCapture,
  retryCapture, subscribeQueues, useDrive,
} from "../browser/cloud";
import type { Organism, OutboxItem } from "../browser/captureDb";
import { QcStrainSelect } from "../components/Qc";
import { genusSuggestions, speciesSuggestions } from "../expertRules";
import { qcFamily, qcStrain } from "../qc";
import { useSession } from "../session";

const FORM_KEY = "aj.capture.organism";
const EMPTY: Organism = { family_id: null, genus: "", species: "", strain: "", sample: "", notes: "", qc_strain: "" };

function savedOrganism(): Organism {
  try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(FORM_KEY) ?? "{}") }; } catch { return EMPTY; }
}

export default function CapturePage() {
  const { catalog } = useSession();
  const { auth } = useDrive();
  const [organism, setOrganism] = useState<Organism>(savedOrganism);
  const [photos, setPhotos] = useState<File[]>([]);
  const [original, setOriginal] = useState(false);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const refresh = () => { outbox().then(setItems).catch((e) => setError(describe(e))); };
    refresh();
    const off = subscribeQueues(refresh);
    const net = () => setOnline(navigator.onLine);
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    return () => { off(); window.removeEventListener("online", net); window.removeEventListener("offline", net); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(FORM_KEY, JSON.stringify(organism)); } catch { /* storage blocked */ }
  }, [organism]);

  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  const set = (k: keyof Organism) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setOrganism({ ...organism, [k]: k === "family_id" ? (Number(e.target.value) || null) : e.target.value });
  // Copy the FileList now: it is live and emptied when the input is reset.
  const add = (list: FileList | null) => { const files = Array.from(list ?? []); if (files.length) setPhotos((p) => [...p, ...files]); };

  async function send() {
    setError(null);
    setBusy(`Preparing ${photos.length} photo(s)…`);
    try {
      await queueCaptures(photos, organism, original);
      setPhotos([]);
      // The strain, sample and notes usually change from one plate to the next; the organism often does not.
      setOrganism((o) => (o.qc_strain ? { ...o, sample: "", notes: "" } : { ...o, strain: "", sample: "", notes: "" }));
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(null);
    }
  }

  const waiting = items.filter((i) => i.status !== "done").length;
  const sent = items.length - waiting;

  if (!driveConfigured) {
    return (
      <div className="page capture">
        <h1>Capture</h1>
        <p className="note">Capture mode sends photos to your Google Drive, which is not configured in this build. Copy the
          photos to the computer instead and use <Link to="/inbox">Inbox → Photos on this computer</Link>.</p>
      </div>
    );
  }

  return (
    <div className="page capture">
      <div className="page-head">
        <div>
          <h1>Capture plates</h1>
          <p className="muted small">Take photos now, analyse them later on a computer: they go to <i>AntibiogramJ/Inbox</i> in
            your Google Drive.</p>
        </div>
      </div>

      {auth.status !== "connected" && (
        <div className="card capture-connect">
          <p>{auth.status === "expired" ? "The Google Drive session has expired." : "Connect your Google Drive to send the photos."}
            {waiting > 0 && ` ${waiting} photo(s) are waiting in this phone.`}</p>
          <button className="primary" disabled={auth.status === "connecting"}
            onClick={() => { setError(null); connect().catch((e) => setError(describe(e))); }}>
            {auth.status === "connecting" ? "Waiting for Google…" : auth.status === "expired" ? "Reconnect" : "Connect Google Drive"}
          </button>
        </div>
      )}
      {!online && <p className="warn">You are offline. Photos are kept in this phone and sent when the connection is back.</p>}
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Organism</h2>
        <div className="capture-form">
          <label className="wide">Quality-control strain
            <QcStrainSelect value={organism.qc_strain ?? ""} onChange={(id) => {
              const s = qcStrain(id);
              setOrganism(s
                ? { ...organism, qc_strain: id, genus: s.genus, species: s.species, strain: s.id,
                    family_id: qcFamily(s, catalog.families)?.id ?? organism.family_id }
                : { ...organism, qc_strain: "" });
            }} />
          </label>
          <label className="wide">Bacteria family / group (optional)
            <select value={organism.family_id ?? ""} onChange={set("family_id")}>
              <option value="">Choose later</option>
              {catalog.families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
          <label>Genus<input list="cap-genus" value={organism.genus} onChange={set("genus")} maxLength={100} autoCapitalize="words" /></label>
          <label>Species<input list="cap-species" value={organism.species} onChange={set("species")} maxLength={100} autoCapitalize="none" /></label>
          <label>Strain<input value={organism.strain} onChange={set("strain")} maxLength={100} /></label>
          <label>Sample<input value={organism.sample} onChange={set("sample")} maxLength={100} placeholder="Lab code, not a patient name" /></label>
          <label className="wide">Notes<textarea value={organism.notes} onChange={set("notes")} maxLength={1000} /></label>
          <datalist id="cap-genus">{genusSuggestions([]).map((g) => <option key={g} value={g} />)}</datalist>
          <datalist id="cap-species">{speciesSuggestions(organism.genus, []).map((g) => <option key={g} value={g} />)}</datalist>
        </div>
        <p className="muted small">Do not write names or other data that identify patients: use the codes of your laboratory.</p>
      </section>

      <section className="card">
        <h2>Photos</h2>
        <div className="capture-buttons">
          <label className="button primary capture-btn">
            Take photo
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          </label>
          <label className="button capture-btn">
            Choose from gallery
            <input type="file" accept="image/*" multiple hidden onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
        <p className="muted small">One plate per photo, from above, filling most of the frame, on a dark background. All the
          photos of this batch get the organism data above. <Link to="/help#photos">Tips</Link></p>
        {photos.length > 0 && (
          <>
            <div className="capture-grid">
              {photos.map((_, i) => (
                <figure key={i} className="capture-thumb">
                  <img src={previews[i]} alt={`Photo ${i + 1}`} />
                  <button className="small" aria-label={`Remove photo ${i + 1}`} onClick={() => setPhotos((p) => p.filter((_, j) => j !== i))}>✕</button>
                </figure>
              ))}
            </div>
            <label className="check small"><input type="checkbox" checked={original} onChange={(e) => setOriginal(e.target.checked)} /> Also upload the original photos (larger, full resolution)</label>
            <button className="primary capture-send" onClick={send} disabled={!!busy}>
              {busy ?? `Send ${photos.length} photo${photos.length === 1 ? "" : "s"} to the inbox`}
            </button>
          </>
        )}
      </section>

      {items.length > 0 && (
        <section className="card">
          <div className="section-head">
            <h2>Sent from this phone</h2>
            <div className="actions">
              {waiting > 0 && auth.status === "connected" && <button className="small" onClick={() => void processOutbox()}>Send now</button>}
              {sent > 0 && <button className="small ghost" onClick={() => void clearSentCaptures()}>Clear sent</button>}
            </div>
          </div>
          <ul className="capture-queue">
            {items.map((i) => (
              <li key={i.id}>
                <img src={i.meta.thumbnail} alt="" />
                <div className="grow">
                  <b>{[i.meta.genus, i.meta.species].filter(Boolean).join(" ") || "Organism not given"}</b>
                  <div className="muted small">{[i.meta.strain && `strain ${i.meta.strain}`, i.meta.sample && `sample ${i.meta.sample}`,
                    new Date(i.meta.captured_at).toLocaleString()].filter(Boolean).join(" · ")}</div>
                  <div className={`small status-${i.status}`}>
                    {i.status === "done" ? "✓ In the inbox"
                      : i.status === "uploading" ? "Uploading…"
                        : i.status === "error" ? `Failed: ${i.error}`
                          : i.error ? `Waiting: ${i.error}` : "Waiting to be sent"}
                  </div>
                </div>
                <div className="btn-col">
                  {i.status === "error" && <button className="small" onClick={() => void retryCapture(i.id)}>Retry</button>}
                  {i.status !== "uploading" && (
                    <button className="small ghost danger" onClick={() => {
                      if (i.status === "done" || confirm("This photo has not been sent yet. Delete it from this phone?")) void removeCapture(i.id);
                    }}>{i.status === "done" ? "Hide" : "Delete"}</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
