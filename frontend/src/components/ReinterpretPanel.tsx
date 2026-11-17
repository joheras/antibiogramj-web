import { useState } from "react";
import { api, categorise, standardLabel, type ExperimentDetail, type ExperimentSummary } from "../api";
import { useSession } from "../session";

/** "Reinterpret with…": copies the experiment and categorises the measured diameters with another standard. */
export default function ReinterpretPanel({ experiment, onCancel, onDone }: {
  experiment: ExperimentDetail; onCancel: () => void; onDone: (copy: ExperimentSummary) => void;
}) {
  const { catalog } = useSession();
  const others = catalog.standards.filter((s) => s.id !== experiment.standard_id);
  const [standardId, setStandardId] = useState<number>(others.find((s) => s.is_default)?.id ?? others[0]?.id ?? 0);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = others.find((s) => s.id === standardId);
  const suffix = ` (${standardLabel(experiment.standard)})`; // same default name as the API
  const baseName = (experiment.name.endsWith(suffix) && experiment.name.slice(0, -suffix.length)) || experiment.name;
  const manual = experiment.antibiograms.flatMap((a) => a.plates.flatMap((p) => p.measurements)).filter((m) =>
    m.original_standard_id == null && m.category !== categorise(m.diameter_mm, m.breakpoint, experiment.standard)).length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.reinterpretExperiment(experiment.id, { standard_id: standardId, name: name.trim() || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!others.length) return <div className="card"><p className="muted">There is no other standard.</p></div>;
  return (
    <form className="card reinterpret" onSubmit={submit}>
      <h2>Reinterpret with another standard</h2>
      <p className="muted">
        Creates a new experiment with the same plates and diameters, categorised with the breakpoints of the chosen
        standard, and applies its expert rules. <b>{experiment.name}</b> ({standardLabel(experiment.standard)}) is not
        changed; every result of the copy shows its original category and standard.
      </p>
      <div className="form-grid">
        <label>Standard
          <select value={standardId} onChange={(e) => setStandardId(Number(e.target.value))}>
            {others.map((s) => <option key={s.id} value={s.id}>{standardLabel(s)}</option>)}
          </select>
        </label>
        <label>Name of the new experiment
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100}
            placeholder={`${baseName} (${standardLabel(target)})`.slice(0, 100)} />
        </label>
      </div>
      <ul className="muted small">
        <li>Categories set by hand are recalculated; the manual category stays visible as the original
          {manual > 0 && <> ({manual} result{manual === 1 ? "" : "s"} of this experiment)</>}.</li>
        <li>Antibiotics or organisms without a zone-diameter breakpoint in {standardLabel(target)} become <b>Not available</b>.</li>
        <li>Organism, supplementary tests, microcolonies and comments are copied.</li>
      </ul>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="primary" type="submit" disabled={busy || !target}>{busy ? "Reinterpreting…" : "Create reinterpretation"}</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
