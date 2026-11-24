// Excel export of an experiment, built in the browser in both flavours (it includes the expert system,
// which runs in the browser). Same layout as the desktop application (workspace/utils/ExcelGeneration.java):
// a summary sheet with one row per measurement, then one sheet per antibiogram.
import { categoryLabel, familyLabel, standardLabel, type Download, type ExperimentDetail, type Measurement, type Standard } from "./api";
import { CATEGORY_NAME, evaluate, EXPERT_SYSTEM_SOURCES, SUPPLEMENTARY_TESTS } from "./expertRules";
import { detectPhenotypes, PHENOTYPE_SOURCES, STAGE_LABEL, STATUS_LABEL as PHENOTYPE_STATUS, type PhenotypeStatus } from "./phenotypes";
import { QC_SOURCE, qcResult, qcStrain, rangeLabel, STATUS_LABEL, type QcStrain } from "./qc";
import { workbook, type Cell, type Sheet } from "./xlsx";

/** QC strain, range, target and result of a measurement ("" when the antibiogram is not a QC strain). */
function qcCells(strain: QcStrain | undefined, m: Measurement): Cell[] {
  if (!strain) return ["", "", "", ""];
  const { range, status } = qcResult(strain, m);
  const result: Cell = status === "in" ? { v: STATUS_LABEL[status], s: "S" } : status === "no-range" ? STATUS_LABEL[status] : { v: STATUS_LABEL[status], s: "R" };
  return [strain.id, range ? rangeLabel(range) : "", range?.target ?? range?.expected_category ?? "", result];
}

/** ``standards``: the catalogue, to name the standard of each result (a reinterpretation keeps the original one). */
export function experimentSheets(e: ExperimentDetail, standards: Standard[] = []): Sheet[] {
  const style: Record<string, "S" | "I" | "R"> = { Susceptible: "S", Intermediate: "I", Resistant: "R" };
  const cat = (c: string, std: Standard | undefined = e.standard): Cell => (style[c] ? { v: categoryLabel(c, std), s: style[c] } : c);
  const standard = (id: number | null | undefined) => (id === e.standard.id ? e.standard : standards.find((s) => s.id === id));
  const original = (m: Measurement): Cell[] => {
    if (m.original_standard_id == null || !m.original_category) return ["", ""];
    const std = standard(m.original_standard_id);
    const c = cat(m.original_category, std);
    if (!m.original_overridden) return [standardLabel(std), c];
    return [standardLabel(std), typeof c === "object" && c !== null ? { ...c, v: `${c.v} (set manually)` } : `${c} (set manually)`];
  };
  const h = (...xs: string[]): Cell[] => xs.map((v) => ({ v, s: "header" as const }));
  const summary: Cell[][] = [
    ["Experiment", e.name], ["Standard", standardLabel(e.standard)], ["Comments", e.comments],
    ["QC ranges", e.antibiograms.some((a) => qcStrain(a.qc_strain)) ? QC_SOURCE : "No QC strains in this experiment"],
    ["Reinterpretation of", e.reinterpreted_from ?? ""],
    h("Antibiogram", "Family", "Genus", "Species", "Strain", "Sample", "Plate", "Antibiotic", "Code", "Disk content",
      "Diameter (mm)", "Category", "Reported (expert rules)", "Microcolonies", "Interpretation", "Breakpoint case",
      "S limit (mm)", "R limit (mm)", "QC strain", "QC range (mm)", "QC target", "QC result", "Standard",
      "Original standard", "Original category"),
  ];
  const sheets: Sheet[] = [{ name: "Summary", rows: summary }];
  const phenotypeStyle: Record<PhenotypeStatus, "S" | "I" | "R"> = { positive: "R", "screen-positive": "I", indeterminate: "I", negative: "S" };
  const phenotypeRows: Cell[][] = [
    ["Resistance phenotypes (presumptive, must be confirmed)"], ["Sources", PHENOTYPE_SOURCES],
    h("Antibiogram", "Genus", "Species", "Strain", "Sample", "Mechanism", "Status", "Stage", "Result", "Evidence", "Notes"),
  ];
  e.antibiograms.forEach((a, i) => {
    const evaluation = evaluate(a, e.standard);
    const qc = qcStrain(a.qc_strain);
    const reported = (m: Measurement): Cell => {
      const r = evaluation.reported.get(m.id);
      return r?.category ? cat(CATEGORY_NAME[r.category]) : "as tested";
    };
    const rows: Cell[][] = [
      [...h("Bacteria information", "", ""), { v: "Date", s: "header" }],
      [{ v: "Family", s: "bold" }, familyLabel(a.family.name, e.standard), null, a.created_at.slice(0, 10)],
      [{ v: "Species", s: "bold" }, a.species], [{ v: "Genus", s: "bold" }, a.genus],
      [{ v: "Strain number", s: "bold" }, a.strain], [{ v: "Sample", s: "bold" }, a.sample],
      [{ v: "Comments", s: "bold" }, a.comments],
      ...(qc ? [[{ v: "QC strain", s: "bold" }, `${qc.name} (${QC_SOURCE})`] as Cell[]] : []),
      [], [{ v: "Antibiotics", s: "bold" }],
      h("Antibiotic name", "Category", "Reported (expert rules)", "Microcolonies", "Interpretation", "Diameter (mm)", "Plate",
        ...(qc ? ["QC range (mm)", "QC target", "QC result"] : []), "Standard", "Original standard", "Original category"),
    ];
    for (const p of a.plates) {
      for (const m of p.measurements) {
        summary.push([a.id, familyLabel(a.family.name, e.standard), a.genus, a.species, a.strain, a.sample, p.id, m.antibiotic.name, m.antibiotic.code,
          m.antibiotic.disk_content, m.diameter_mm, cat(m.category), reported(m), m.microcolonies ? "Yes" : "No", m.interpretation,
          m.breakpoint?.case ?? "", m.breakpoint?.susceptible ?? null, m.breakpoint?.resistant ?? null, ...qcCells(qc, m),
          standardLabel(standard(m.standard_id)), ...original(m)]);
        rows.push([`${m.antibiotic.name} ${m.antibiotic.disk_content}`, cat(m.category), reported(m), m.microcolonies ? "Yes" : "No",
          m.interpretation, m.diameter_mm, p.id, ...(qc ? qcCells(qc, m).slice(1) : []), standardLabel(standard(m.standard_id)),
          ...original(m)]);
      }
    }
    const tests = SUPPLEMENTARY_TESTS.filter((t) => a.supplementary_tests[t.key]);
    if (tests.length) {
      rows.push([], [{ v: "Supplementary tests", s: "bold" }]);
      for (const t of tests) rows.push([t.label, t.options.find((o) => o.value === a.supplementary_tests[t.key])?.label ?? a.supplementary_tests[t.key]]);
    }
    const phenotypes = qc ? null : detectPhenotypes(a);
    if (phenotypes && (phenotypes.phenotypes.length || phenotypes.pairs.length)) {
      rows.push([], [{ v: "Resistance phenotypes", s: "bold" }], h("Mechanism", "Status", "Stage", "Result", "Evidence", "Notes", "Source"));
      for (const p of phenotypes.phenotypes) {
        const status: Cell = { v: PHENOTYPE_STATUS[p.status], s: phenotypeStyle[p.status] };
        rows.push([p.mechanism, status, STAGE_LABEL[p.stage], p.result, p.evidence.join(" | "), p.notes.join(" | "), p.source]);
        phenotypeRows.push([a.id, a.genus, a.species, a.strain, a.sample, p.mechanism, status, STAGE_LABEL[p.stage], p.result,
          p.evidence.join(" | "), p.notes.join(" | ")]);
      }
      if (phenotypes.pairs.length) {
        rows.push([], h("Combination disk", "Zone (mm)", "Plain disk", "Zone (mm)", "Increase (mm)", "Same plate"));
        for (const p of phenotypes.pairs) rows.push([`${p.combination.antibiotic.name} ${p.combination.antibiotic.disk_content}`,
          Math.round(p.combination.diameter_mm), `${p.base.antibiotic.name} ${p.base.antibiotic.disk_content}`, Math.round(p.base.diameter_mm),
          p.increase, p.samePlate ? "Yes" : "No"]);
      }
      for (const m of phenotypes.unpaired) rows.push([`${m.antibiotic.name} ${m.antibiotic.disk_content}`, "No plain disk to compare with"]);
    }
    rows.push([], [{ v: "Expert system", s: "bold" }], h("Type", "Message", "Source", "Grade"));
    if (!evaluation.rules.length) rows.push(["", "No expert rules apply to these results."]);
    for (const r of evaluation.rules) rows.push([r.kind, r.message, r.source, r.grade ?? ""]);
    rows.push(["", `Decision support only. Sources: ${EXPERT_SYSTEM_SOURCES}.`]);
    sheets.push({ name: `Antibiogram ${i + 1}`, rows });
  });
  if (phenotypeRows.length > 3) sheets.push({ name: "Phenotypes", rows: phenotypeRows });
  return sheets;
}

export function experimentWorkbook(e: ExperimentDetail, name: string, standards: Standard[] = []): Download {
  const blob = workbook(experimentSheets(e, standards));
  return { url: URL.createObjectURL(blob), filename: `${name.replace(/[^\w-]+/g, "_") || "experiment"}.xlsx` };
}
