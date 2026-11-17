import { useState } from "react";
import type { Antibiogram, AntibiogramUpdate } from "../api";
import { genusSuggestions, speciesSuggestions } from "../expertRules";
import { QC_SOURCE } from "../qc";
import { QcStrainSelect } from "./Qc";

/** Edits the organism data of an antibiogram (the family cannot change: it selects the breakpoints). */
export default function AntibiogramEditor({ antibiogram: a, onSave, onCancel }: {
  antibiogram: Antibiogram; onSave: (data: AntibiogramUpdate) => Promise<void>; onCancel: () => void;
}) {
  const [data, setData] = useState<AntibiogramUpdate>({
    genus: a.genus, species: a.species, strain: a.strain, sample: a.sample, comments: a.comments,
    supplementary_tests: a.supplementary_tests, qc_strain: a.qc_strain,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Omit<AntibiogramUpdate, "supplementary_tests" | "qc_strain">) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setData({ ...data, [k]: e.target.value });
  const id = `ab${a.id}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(data);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="antibiogram-editor" onSubmit={save}>
      <p className="muted small">Family: {a.family.name} (it selects the breakpoints and cannot be changed).</p>
      <div className="form-grid">
        <label>Genus<input list={`${id}-genus`} value={data.genus} onChange={set("genus")} maxLength={100} /></label>
        <label>Species<input list={`${id}-species`} value={data.species} onChange={set("species")} maxLength={100} /></label>
        <label>Strain<input value={data.strain} onChange={set("strain")} maxLength={100} /></label>
        <label>Sample<input value={data.sample} onChange={set("sample")} maxLength={100} /></label>
      </div>
      <label>Quality-control strain ({QC_SOURCE})
        <QcStrainSelect value={data.qc_strain} onChange={(qc_strain) => setData({ ...data, qc_strain })} />
      </label>
      <label>Comments<textarea value={data.comments} onChange={set("comments")} maxLength={1000} /></label>
      <datalist id={`${id}-genus`}>{genusSuggestions().map((g) => <option key={g} value={g} />)}</datalist>
      <datalist id={`${id}-species`}>{speciesSuggestions(data.genus).map((s) => <option key={s} value={s} />)}</datalist>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>Save</button>
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}
