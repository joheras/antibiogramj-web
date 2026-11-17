// Excel export of an experiment, built in the browser in both flavours (it includes the expert system,
// which runs in the browser). Same layout as the desktop application (workspace/utils/ExcelGeneration.java):
// a summary sheet with one row per measurement, then one sheet per antibiogram.
import { categoryLabel, type Download, type ExperimentDetail, type Measurement } from "./api";
import { CATEGORY_NAME, evaluate, EXPERT_SYSTEM_SOURCES, SUPPLEMENTARY_TESTS } from "./expertRules";
import { QC_SOURCE, qcResult, qcStrain, rangeLabel, STATUS_LABEL, type QcStrain } from "./qc";
import { workbook, type Cell, type Sheet } from "./xlsx";

/** QC strain, range, target and result of a measurement ("" when the antibiogram is not a QC strain). */
function qcCells(strain: QcStrain | undefined, m: Measurement): Cell[] {
  if (!strain) return ["", "", "", ""];
  const { range, status } = qcResult(strain, m);
  const result: Cell = status === "in" ? { v: STATUS_LABEL[status], s: "S" } : status === "no-range" ? STATUS_LABEL[status] : { v: STATUS_LABEL[status], s: "R" };
  return [strain.id, range ? rangeLabel(range) : "", range?.target ?? range?.expected_category ?? "", result];
}

export function experimentSheets(e: ExperimentDetail): Sheet[] {
  const style: Record<string, "S" | "I" | "R"> = { Susceptible: "S", Intermediate: "I", Resistant: "R" };
  const cat = (c: string): Cell => (style[c] ? { v: categoryLabel(c, e.standard), s: style[c] } : c);
  const h = (...xs: string[]): Cell[] => xs.map((v) => ({ v, s: "header" as const }));
  const summary: Cell[][] = [
    ["Experiment", e.name], ["Standard", `${e.standard.name} ${e.standard.version}`], ["Comments", e.comments],
    ["QC ranges", e.antibiograms.some((a) => qcStrain(a.qc_strain)) ? QC_SOURCE : "No QC strains in this experiment"], [],
    h("Antibiogram", "Family", "Genus", "Species", "Strain", "Sample", "Plate", "Antibiotic", "Code", "Disk content",
      "Diameter (mm)", "Category", "Reported (expert rules)", "Microcolonies", "Interpretation", "Breakpoint case",
      "S limit (mm)", "R limit (mm)", "QC strain", "QC range (mm)", "QC target", "QC result"),
  ];
  const sheets: Sheet[] = [{ name: "Summary", rows: summary }];
  e.antibiograms.forEach((a, i) => {
    const evaluation = evaluate(a, e.standard);
    const qc = qcStrain(a.qc_strain);
    const reported = (m: Measurement): Cell => {
      const r = evaluation.reported.get(m.id);
      return r?.category ? cat(CATEGORY_NAME[r.category]) : "as tested";
    };
    const rows: Cell[][] = [
      [...h("Bacteria information", "", ""), { v: "Date", s: "header" }],
      [{ v: "Family", s: "bold" }, a.family.name, null, a.created_at.slice(0, 10)],
      [{ v: "Species", s: "bold" }, a.species], [{ v: "Genus", s: "bold" }, a.genus],
      [{ v: "Strain number", s: "bold" }, a.strain], [{ v: "Sample", s: "bold" }, a.sample],
      [{ v: "Comments", s: "bold" }, a.comments],
      ...(qc ? [[{ v: "QC strain", s: "bold" }, `${qc.name} (${QC_SOURCE})`] as Cell[]] : []),
      [], [{ v: "Antibiotics", s: "bold" }],
      h("Antibiotic name", "Category", "Reported (expert rules)", "Microcolonies", "Interpretation", "Diameter (mm)", "Plate",
        ...(qc ? ["QC range (mm)", "QC target", "QC result"] : [])),
    ];
    for (const p of a.plates) {
      for (const m of p.measurements) {
        summary.push([a.id, a.family.name, a.genus, a.species, a.strain, a.sample, p.id, m.antibiotic.name, m.antibiotic.code,
          m.antibiotic.disk_content, m.diameter_mm, cat(m.category), reported(m), m.microcolonies ? "Yes" : "No", m.interpretation,
          m.breakpoint?.case ?? "", m.breakpoint?.susceptible ?? null, m.breakpoint?.resistant ?? null, ...qcCells(qc, m)]);
        rows.push([`${m.antibiotic.name} ${m.antibiotic.disk_content}`, cat(m.category), reported(m), m.microcolonies ? "Yes" : "No",
          m.interpretation, m.diameter_mm, p.id, ...(qc ? qcCells(qc, m).slice(1) : [])]);
      }
    }
    const tests = SUPPLEMENTARY_TESTS.filter((t) => a.supplementary_tests[t.key]);
    if (tests.length) {
      rows.push([], [{ v: "Supplementary tests", s: "bold" }]);
      for (const t of tests) rows.push([t.label, t.options.find((o) => o.value === a.supplementary_tests[t.key])?.label ?? a.supplementary_tests[t.key]]);
    }
    rows.push([], [{ v: "Expert system", s: "bold" }], h("Type", "Message", "Source", "Grade"));
    if (!evaluation.rules.length) rows.push(["", "No expert rules apply to these results."]);
    for (const r of evaluation.rules) rows.push([r.kind, r.message, r.source, r.grade ?? ""]);
    rows.push(["", `Decision support only. Sources: ${EXPERT_SYSTEM_SOURCES}.`]);
    sheets.push({ name: `Antibiogram ${i + 1}`, rows });
  });
  return sheets;
}

export function experimentWorkbook(e: ExperimentDetail, name: string): Download {
  const blob = workbook(experimentSheets(e));
  return { url: URL.createObjectURL(blob), filename: `${name.replace(/[^\w-]+/g, "_") || "experiment"}.xlsx` };
}
