import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, bacteriaLabel, download, type Antibiogram, type AntibiogramUpdate, type ExperimentDetail } from "../api";
import AsyncImage from "../components/AsyncImage";
import CategoryBadge from "../components/CategoryBadge";
import AntibiogramEditor from "../components/AntibiogramEditor";
import ExpertRulesPanel from "../components/ExpertRulesPanel";
import { QcCell, QcPanel } from "../components/Qc";
import { qcStrain } from "../qc";
import { CATEGORY_NAME, evaluate } from "../expertRules";

export default function ExperimentPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const [exp, setExp] = useState<ExperimentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const load = useCallback(() => {
    api.experiment(id).then(setExp).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  async function removeExperiment() {
    if (!exp || !confirm(`Delete the experiment "${exp.name}" with all its antibiograms and plates? This cannot be undone.`)) return;
    await api.deleteExperiment(exp.id);
    navigate("/");
  }

  async function removeAntibiogram(a: Antibiogram) {
    if (!confirm(`Delete the antibiogram of ${bacteriaLabel(a)} and its ${a.plates.length} plate(s)? This cannot be undone.`)) return;
    await api.deleteAntibiogram(a.id).catch((e) => setError(e.message));
    load();
  }

  async function updateAntibiogram(a: Antibiogram, data: Partial<AntibiogramUpdate>) {
    const { genus, species, strain, sample, comments, supplementary_tests, qc_strain } = a;
    await api.updateAntibiogram(a.id, { genus, species, strain, sample, comments, supplementary_tests, qc_strain, ...data });
    load();
  }

  if (error) return <div className="page"><p className="error">{error}</p><Link to="/">Back</Link></div>;
  if (!exp) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <nav className="crumbs"><Link to="/">Experiments</Link> / {exp.name}</nav>
      <div className="page-head">
        <div>
          <h1>{exp.name}</h1>
          <p className="muted">
            <span className="tag">{exp.standard.name} {exp.standard.version}</span>{" "}
            Created {new Date(exp.created_at).toLocaleDateString()}
          </p>
          {exp.comments && <p>{exp.comments}</p>}
        </div>
        <div className="actions">
          <Link className="button primary" to={`/experiments/${exp.id}/add-plate`}>Add plate</Link>
          <button onClick={() => api.exportExperiment(exp.id, exp.name).then(download).catch((e) => setError(e.message))}>Export to Excel</button>
          <button className="danger ghost" onClick={removeExperiment}>Delete</button>
        </div>
      </div>

      {exp.antibiograms.length === 0 ? (
        <div className="empty card">
          <p>This experiment has no antibiograms yet.</p>
          <p className="muted">Use <b>Add plate</b> to analyse an antibiogram image.</p>
        </div>
      ) : exp.antibiograms.map((a) => {
        const evaluation = evaluate(a, exp.standard);
        const qc = qcStrain(a.qc_strain);
        return (
        <section key={a.id} className="card antibiogram">
          <div className="section-head">
            <div>
              <h2><i>{[a.genus, a.species].filter(Boolean).join(" ") || "Unnamed organism"}</i>{qc && <> <span className="tag" title={qc.name}>QC strain {qc.id}</span></>}</h2>
              <p className="muted">
                {a.family.name}
                {a.strain && <> · strain {a.strain}</>}
                {a.sample && <> · sample {a.sample}</>}
                {" · "}{new Date(a.created_at).toLocaleDateString()}
              </p>
              {a.comments && <p>{a.comments}</p>}
            </div>
            <div className="actions">
              <button className="small" onClick={() => setEditing(a.id)}>Edit</button>
              <button className="danger ghost small" onClick={() => removeAntibiogram(a)}>Delete antibiogram</button>
            </div>
          </div>
          {editing === a.id && (
            <AntibiogramEditor antibiogram={a} onCancel={() => setEditing(null)}
              onSave={async (data) => { await updateAntibiogram(a, data); setEditing(null); }} />
          )}

          <div className="plates">
            {a.plates.map((p, i) => (
              <Link key={p.id} to={`/plates/${p.id}`} className="plate-thumb" title={p.original_filename}>
                <AsyncImage load={() => api.plateImage(p.id, true)} deps={[p.id]} alt={`Plate ${i + 1}`} />
                <span>Plate {i + 1}</span>
              </Link>
            ))}
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Antibiotic</th><th>Code</th><th>Plate</th><th className="num">Diameter</th>{qc && <th>QC range</th>}<th>Category</th><th title="Category to report after applying the expert rules">Reported</th><th>Microcolonies</th><th>Interpretation</th></tr>
              </thead>
              <tbody>
                {a.plates.flatMap((p, i) => p.measurements.map((m) => (
                  <tr key={m.id}>
                    <td>{m.antibiotic.name} <span className="muted">{m.antibiotic.disk_content}</span></td>
                    <td>{m.antibiotic.code}</td>
                    <td>{i + 1}</td>
                    <td className="num">{m.diameter_mm.toFixed(1)} mm</td>
                    {qc && <td><QcCell strain={qc} measurement={m} /></td>}
                    <td><CategoryBadge category={m.category} standard={exp.standard} /></td>
                    <td>{(() => {
                      const r = evaluation.reported.get(m.id);
                      return r?.category
                        ? <span className="reported" title={`Changed by ${r.rules.join(", ")}`}><CategoryBadge category={CATEGORY_NAME[r.category]} standard={exp.standard} /> *</span>
                        : <span className="muted">as tested</span>;
                    })()}</td>
                    <td>{m.microcolonies ? "Yes" : "No"}</td>
                    <td>{m.interpretation}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          {qc && <QcPanel antibiogram={a} />}
          {!qc && a.plates.some((p) => p.measurements.length > 0) && (
            <ExpertRulesPanel antibiogram={a} evaluation={evaluation} standardName={`${exp.standard.name} ${exp.standard.version}`}
              onEdit={() => setEditing(a.id)}
              onTests={(supplementary_tests) => updateAntibiogram(a, { supplementary_tests }).catch((e) => setError(e.message))} />
          )}
        </section>
        );
      })}
    </div>
  );
}
