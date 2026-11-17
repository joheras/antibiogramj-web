import type { Antibiogram, Measurement } from "../api";
import {
  QC_SOURCE, QC_STRAINS, QC_TABLES, qcResult, qcSummary, rangeLabel, STATUS_LABEL, USE_LABEL, type QcStrain, type QcUse,
} from "../qc";

const GROUPS: [QcUse, string][] = [
  ["routine", "Routine QC strains"],
  ["inhibitor", "β-lactamase producers (inhibitor component)"],
  ["extended", "Extended QC (resistance mechanisms)"],
];
const mainUse = (s: QcStrain) => s.ranges[0].use;

/** Select of the EUCAST QC strains ("" = clinical isolate, not a QC strain). */
export function QcStrainSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No: clinical isolate</option>
      {GROUPS.map(([use, label]) => (
        <optgroup key={use} label={label}>
          {QC_STRAINS.filter((s) => mainUse(s) === use).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/** QC range and result of one measurement. */
export function QcCell({ strain, measurement }: { strain: QcStrain; measurement: Pick<Measurement, "antibiotic" | "diameter_mm"> }) {
  const { range, status } = qcResult(strain, measurement);
  if (!range) return <span className="muted" title={`${strain.name} has no zone-diameter range for this disk in ${QC_SOURCE}`}>no range</span>;
  const target = range.target ? `target ${range.target} mm` : `expected ${range.expected_category}`;
  return (
    <span className={`qc qc-${status}`} title={`${STATUS_LABEL[status]} · ${USE_LABEL[range.use]} · ${QC_SOURCE}`}>
      {status === "in" ? "✓" : "✗"} {rangeLabel(range)} mm <span className="small">({target})</span>
    </span>
  );
}

/** Summary of the QC results of an antibiogram marked as a QC strain. */
export function QcPanel({ antibiogram }: { antibiogram: Antibiogram }) {
  const { strain, inRange, out, noRange } = qcSummary(antibiogram);
  if (!strain) return null;
  const outOfRange = antibiogram.plates.flatMap((p) => p.measurements).filter((m) => {
    const s = qcResult(strain, m).status;
    return s === "low" || s === "high";
  });
  return (
    <div className="qc-panel">
      <h3>Quality control: {strain.name}</h3>
      <p className={out ? "qc-alert" : inRange ? "ok" : "muted"}>
        {out
          ? <><b>{out} result{out === 1 ? "" : "s"} out of range</b> · {inRange} in range</>
          : inRange ? <>All {inRange} result{inRange === 1 ? " is" : "s are"} within the QC range.</> : <>No result can be checked.</>}
        {noRange > 0 && <> · {noRange} without a QC range for this strain</>}
      </p>
      {outOfRange.length > 0 && (
        <ul className="small">
          {outOfRange.map((m) => {
            const { range, status } = qcResult(strain, m);
            return <li key={m.id}>{m.antibiotic.name} {m.antibiotic.disk_content}: {m.diameter_mm.toFixed(1)} mm, {status === "low" ? "below" : "above"} the range {rangeLabel(range!)} mm{range!.target && <> (target {range!.target} mm)</>}</li>;
          })}
        </ul>
      )}
      <p className="muted small">
        Ranges and targets from <a href={QC_TABLES.url} target="_blank" rel="noreferrer">{QC_SOURCE}</a>. Diameters are
        rounded to the whole millimetre. Out-of-range results mean the tests of the day (disks, medium, inoculum,
        incubation or reading) must be investigated before reporting; see the EUCAST disk diffusion manual.
      </p>
    </div>
  );
}
