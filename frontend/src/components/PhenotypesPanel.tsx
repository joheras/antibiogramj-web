import { GUIDE_URL, PHENOTYPE_SOURCES, STAGE_LABEL, STATUS_LABEL, type PhenotypeReport, type PhenotypeStatus } from "../phenotypes";

const STATUS_CLASS: Record<PhenotypeStatus, string> = {
  positive: "rule-mechanism", "screen-positive": "rule-warning", indeterminate: "rule-warning", negative: "rule-info",
};

/** Resistance phenotypes of an antibiogram (phenotypes.ts): screening, confirmation and the disk pairs used. */
export default function PhenotypesPanel({ report, compact = false }: { report: PhenotypeReport; compact?: boolean }) {
  const { phenotypes, pairs, unpaired } = report;
  if (!phenotypes.length && !pairs.length && !unpaired.length) return null;
  return (
    <div className="expert-rules phenotypes">
      <h3>Resistance phenotypes</h3>
      {phenotypes.length === 0 ? (
        <p className="muted">No resistance-mechanism screening applies to this organism and these disks.</p>
      ) : (
        <ul className="rules">
          {phenotypes.map((p) => (
            <li key={p.mechanism} className={STATUS_CLASS[p.status]}>
              <span className="rule-kind">{p.mechanism} · {STATUS_LABEL[p.status]} <span className="muted">({STAGE_LABEL[p.stage]})</span></span>
              <span><b>{p.result}</b></span>
              <details open={!compact && p.status !== "negative"}>
                <summary className="small">Why</summary>
                <ul className="evidence small">
                  {p.evidence.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
                {p.notes.length > 0 && (
                  <ul className="phenotype-notes small">
                    {p.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </details>
              <span className="muted small"><a href={GUIDE_URL} target="_blank" rel="noreferrer">{p.source}</a></span>
            </li>
          ))}
        </ul>
      )}
      {pairs.length > 0 && (
        <div className="table-wrap">
          <table className="pairs">
            <thead><tr><th>Combination disk</th><th className="num">Zone</th><th>Plain disk</th><th className="num">Zone</th><th className="num">Increase</th></tr></thead>
            <tbody>
              {pairs.map((p) => (
                <tr key={p.combination.id}>
                  <td>{p.combination.antibiotic.name} <span className="muted">{p.combination.antibiotic.disk_content}</span></td>
                  <td className="num">{Math.round(p.combination.diameter_mm)} mm</td>
                  <td>{p.base.antibiotic.name} <span className="muted">{p.base.antibiotic.disk_content}</span>
                    {!p.samePlate && <span className="muted small"> (other plate)</span>}</td>
                  <td className="num">{Math.round(p.base.diameter_mm)} mm</td>
                  <td className="num"><b>{p.increase >= 0 ? "+" : ""}{p.increase} mm</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unpaired.length > 0 && (
        <p className="note">
          No plain disk to compare with: {unpaired.map((m) => `${m.antibiotic.name} ${m.antibiotic.disk_content}`).join(", ")}.
          Add the plain disk (same content) on this or another plate of the antibiogram.
        </p>
      )}
      <p className="muted small">
        Presumptive phenotypes for infection control and surveillance: they do not change the categories and must be
        confirmed (genotypically when required). Sources: {PHENOTYPE_SOURCES}.
      </p>
    </div>
  );
}
