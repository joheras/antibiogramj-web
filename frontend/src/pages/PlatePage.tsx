import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, download, type Plate } from "../api";
import { useImageUrl } from "../components/AsyncImage";
import CategoryBadge from "../components/CategoryBadge";
import { QcCell } from "../components/Qc";
import { qcStrain, qcResult, type QcStrain } from "../qc";
import { useSession } from "../session";

export default function PlatePage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const { catalog } = useSession();
  const [plate, setPlate] = useState<Plate | null>(null);
  const [annotated, setAnnotated] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qc, setQc] = useState<QcStrain | undefined>(undefined);
  useEffect(() => {
    api.plate(id).then(async (p) => {
      setPlate(p);
      // The QC strain is a property of the antibiogram of the plate.
      const exp = await api.experiment(p.experiment_id);
      setQc(qcStrain(exp.antibiograms.find((a) => a.id === p.antibiogram_id)?.qc_strain));
    }).catch((e) => setError(e.message));
  }, [id]);

  const experimentId = plate?.experiment_id;
  const imageUrl = useImageUrl(plate ? () => api.plateImage(plate.id, annotated) : null, [plate?.id, annotated]);

  async function remove() {
    if (!plate || !confirm("Delete this plate and its measurements? This cannot be undone.")) return;
    await api.deletePlate(plate.id);
    navigate(experimentId ? `/experiments/${experimentId}` : "/");
  }

  if (error) return <div className="page"><p className="error">{error}</p><Link to="/">Back</Link></div>;
  if (!plate) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to="/">Experiments</Link>
        {experimentId && <> / <Link to={`/experiments/${experimentId}`}>Experiment</Link></>} / Plate
      </nav>
      <div className="page-head">
        <div>
          <h1>Plate{qc && <> <span className="tag" title={qc.name}>QC strain {qc.id}</span></>}</h1>
          <p className="muted">
            {plate.original_filename} · {new Date(plate.created_at).toLocaleString()} · disk {plate.disk_mm} mm ·
            {" "}{plate.px_per_mm.toFixed(1)} px/mm
          </p>
        </div>
        <div className="actions">
          <button onClick={() => api.plateImage(plate.id, true).then((url) => download({ url, filename: `plate-${plate.id}-annotated.jpg` }))}>Download image</button>
          <button className="danger ghost" onClick={remove}>Delete plate</button>
        </div>
      </div>
      {qc && (() => {
        const out = plate.measurements.filter((m) => ["low", "high"].includes(qcResult(qc, m).status)).length;
        return <p className={out ? "qc-alert" : "ok"}>{out ? `${out} result(s) of this ${qc.name} plate are out of the EUCAST QC range.` : `All results with a QC range are within it (${qc.name}).`}</p>;
      })()}
      <div className="split">
        <div>
          <label className="check">
            <input type="checkbox" checked={annotated} onChange={(e) => setAnnotated(e.target.checked)} /> Show annotations
          </label>
          {imageUrl ? <img className="plate-image" src={imageUrl} alt="Plate" /> : <div className="img-placeholder plate-image" />}
          <Legend />
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Antibiotic</th><th className="num">Diameter</th>{qc && <th>QC range</th>}<th>Breakpoints</th><th>Category</th><th>Microcol.</th><th>Interpretation</th></tr></thead>
            <tbody>
              {plate.measurements.map((m) => (
                <tr key={m.id}>
                  <td>{m.antibiotic.name} <span className="muted">{m.antibiotic.disk_content}</span>
                    {m.breakpoint?.case && <div className="muted small">{m.breakpoint.case}</div>}</td>
                  <td className="num">{m.diameter_mm.toFixed(1)} mm</td>
                  {qc && <td><QcCell strain={qc} measurement={m} /></td>}
                  <td className="muted">{m.breakpoint?.available && m.breakpoint.susceptible !== null
                    ? `S ${m.breakpoint.susceptible} / R ${m.breakpoint.resistant}` : "–"}</td>
                  <td><CategoryBadge category={m.category} standard={catalog.standards.find((s) => s.id === m.standard_id)} /></td>
                  <td>{m.microcolonies ? "Yes" : "No"}</td>
                  <td>{m.interpretation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function Legend() {
  return (
    <div className="legend">
      <span><i style={{ borderColor: "#ff00ff" }} /> Disk</span>
      <span><i style={{ borderColor: "#e6c000" }} /> Inhibition zone</span>
      <span><i style={{ borderColor: "#2f6fff" }} /> Susceptible limit</span>
      <span><i style={{ borderColor: "#ff3030" }} /> Resistant limit</span>
    </div>
  );
}
