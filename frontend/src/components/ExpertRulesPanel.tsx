import type { Antibiogram } from "../api";
import { EXPERT_SYSTEM_SOURCES, supplementaryTestsFor, type Evaluation, type RuleKind } from "../expertRules";

const KIND: Record<RuleKind, { label: string; className: string }> = {
  "unexpected-susceptible": { label: "Unexpected susceptible", className: "rule-alert" },
  "unexpected-resistant": { label: "Unexpected resistant", className: "rule-alert" },
  mechanism: { label: "Resistance mechanism", className: "rule-mechanism" },
  atu: { label: "Technical uncertainty", className: "rule-warning" },
  warning: { label: "Warning", className: "rule-warning" },
  inference: { label: "Inference", className: "rule-info" },
};

export default function ExpertRulesPanel({ antibiogram, evaluation, standardName, onTests, onEdit }: {
  antibiogram: Antibiogram; evaluation: Evaluation; standardName: string;
  onTests: (tests: Record<string, string>) => void; onEdit: () => void;
}) {
  const { rules, speciesKnown, organism } = evaluation;
  const tests = supplementaryTestsFor(antibiogram);
  const setTest = (key: string, value: string) => {
    const next = { ...antibiogram.supplementary_tests };
    if (value) next[key] = value;
    else delete next[key];
    onTests(next);
  };
  return (
    <div className="expert-rules">
      <h3>Expert system</h3>
      {!speciesKnown && (
        <p className="note">
          Only the rules of the group <b>{organism}</b> were applied.{" "}
          <button className="link" onClick={onEdit}>Enter the genus and species</button> of the isolate to apply the
          species-specific EUCAST rules and expected phenotypes.
        </p>
      )}
      {tests.length > 0 && (
        <details className="supplementary" open={Object.keys(antibiogram.supplementary_tests).length > 0}>
          <summary>Supplementary tests</summary>
          <div className="form-grid">
            {tests.map((t) => (
              <label key={t.key}>{t.label}
                <select value={antibiogram.supplementary_tests[t.key] ?? ""} onChange={(e) => setTest(t.key, e.target.value)}>
                  <option value="">Not done</option>
                  {t.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            ))}
          </div>
        </details>
      )}
      {!standardName.toUpperCase().startsWith("EUCAST") && (
        <p className="muted small">These are EUCAST rules; the categories come from {standardName} breakpoints.</p>
      )}
      {rules.length === 0 ? (
        <p className="muted">No expert rules apply to these results.</p>
      ) : (
        <ul className="rules">
          {rules.map((r) => (
            <li key={r.id} className={KIND[r.kind].className}>
              <span className="rule-kind">{KIND[r.kind].label}</span>
              <span>{r.message}</span>
              <span className="muted small">
                <a href={r.url} target="_blank" rel="noreferrer">{r.source}</a>
                {r.grade && <> · evidence grade {r.grade}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Decision support only: the results must be validated by a microbiologist. Sources: {EXPERT_SYSTEM_SOURCES}.
      </p>
    </div>
  );
}
