import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, download, MODE, type ExperimentSummary } from "../api";
import { startExample } from "../example";
import { useSession } from "../session";

export default function ExperimentsPage() {
  const { catalog } = useSession();
  const navigate = useNavigate();
  const [experiments, setExperiments] = useState<ExperimentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const defaultStandard = catalog.standards.find((s) => s.is_default) ?? catalog.standards[0];
  const [form, setForm] = useState({ name: "", comments: "", standard_id: defaultStandard?.id ?? null });

  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.experiments().then(setExperiments).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function restore(file: File) {
    setError(null);
    try {
      const n = await api.importBackup(file);
      setNotice(`${n} experiment(s) restored from ${file.name}.`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function tryExample() {
    setError(null);
    try {
      navigate(await startExample(catalog));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const exp = await api.createExperiment(form);
      navigate(`/experiments/${exp.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const standardName = (id: number) => {
    const s = catalog.standards.find((x) => x.id === id);
    return s ? `${s.name} ${s.version}` : "";
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Experiments</h1>
        <div className="actions">
          {MODE === "browser" && (
            <>
              <button onClick={() => api.exportBackup().then(download).catch((e) => setError(e.message))}
                title="Save all experiments, images and learned templates to a file">Back up</button>
              <button onClick={() => fileRef.current?.click()} title="Add the experiments of a backup file">Restore</button>
              <input ref={fileRef} type="file" accept=".json,application/json" hidden
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) restore(f); }} />
            </>
          )}
          <button className="primary" onClick={() => setCreating(!creating)}>{creating ? "Cancel" : "New experiment"}</button>
        </div>
      </div>
      {MODE === "browser" && (
        <p className="note">
          This version runs entirely in your browser: images and results never leave this computer. They are kept in this
          browser's storage, so <b>back up</b> regularly, and before clearing site data or changing computer.
        </p>
      )}
      {notice && <p className="ok">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {creating && (
        <form className="card form-grid" onSubmit={create}>
          <label>Name<input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></label>
          <label>
            Standard
            <select value={form.standard_id ?? ""} onChange={(e) => setForm({ ...form, standard_id: Number(e.target.value) })}>
              {catalog.standards.map((s) => <option key={s.id} value={s.id}>{s.name} {s.version}</option>)}
            </select>
          </label>
          <label className="span2">Comments<textarea maxLength={1000} value={form.comments} onChange={(e) => setForm({ ...form, comments: e.target.value })} /></label>
          <div className="span2"><button className="primary">Create</button></div>
        </form>
      )}

      {experiments === null ? <p className="muted">Loading…</p> : experiments.length === 0 ? (
        <div className="empty card">
          <p>You have no experiments yet.</p>
          <p className="muted">An experiment groups antibiograms; every antibiogram collects the plates inoculated with the same organism.</p>
          <div className="actions empty-actions">
            <button className="primary" onClick={tryExample}>Try it with an example plate</button>
            <Link className="button" to="/help">How to use AntibiogramJ</Link>
          </div>
        </div>
      ) : (
        <div className="cards">
          {experiments.map((e) => (
            <Link key={e.id} to={`/experiments/${e.id}`} className="card exp-card">
              <h3>{e.name}</h3>
              {e.comments && <p className="muted clamp">{e.comments}</p>}
              <div className="meta">
                <span className="tag">{standardName(e.standard_id)}</span>
                {e.reinterpreted_from && <span className="muted" title={`Reinterpretation of ${e.reinterpreted_from}`}>reinterpretation</span>}
                <span>{e.antibiogram_count} antibiogram{e.antibiogram_count === 1 ? "" : "s"}</span>
                <span>{e.plate_count} plate{e.plate_count === 1 ? "" : "s"}</span>
                <span className="muted">{new Date(e.created_at).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
