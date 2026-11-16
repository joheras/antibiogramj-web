// Checks the expert system (src/expertRules.ts) on synthetic isolates categorised with the EUCAST 16.1
// breakpoints of the browser catalogue.
//   node --experimental-strip-types --no-warnings scripts/test-expert-rules.mts
import fs from "node:fs";
import type { Antibiogram, Breakpoint, Measurement } from "../src/api.ts";
import { evaluate } from "../src/expertRules.ts";

const catalog = JSON.parse(fs.readFileSync(new URL("../src/browser/catalog.json", import.meta.url), "utf8"));
const eucast = catalog.standards.find((s: { name: string; version: string }) => s.name === "EUCAST" && s.version === "16.1");

// Same rules as api.ts::categorise (EUCAST operators: S >=, R <).
function categorise(d: number, bp: Breakpoint | undefined): string {
  if (!bp || !bp.available || bp.susceptible === null || bp.resistant === null) return "Not available";
  return d >= bp.susceptible ? "Susceptible" : d < bp.resistant ? "Resistant" : "Intermediate";
}

let nextId = 1;
/** results: [antibiotic name, diameter in mm, optional breakpoint case substring] */
function isolate(familyName: string, genus: string, species: string, results: [string, number, string?][],
  tests: Record<string, string> = {}): Antibiogram {
  const family = catalog.families.find((f: { name: string }) => f.name === familyName);
  if (!family) throw new Error(`family ${familyName}`);
  const measurements: Measurement[] = results.map(([name, d, kase]) => {
    const bps: Breakpoint[] = catalog.breakpoints.filter((b: Breakpoint) => b.standard_id === eucast.id && b.family_id === family.id
      && catalog.antibiotics.find((a: { id: number }) => a.id === b.antibiotic_id).name === name && b.available
      && (!kase || b.case.includes(kase)));
    const bp = bps[0];
    const antibiotic = bp ? catalog.antibiotics.find((a: { id: number }) => a.id === bp.antibiotic_id)
      : catalog.antibiotics.find((a: { name: string }) => a.name === name);
    if (!antibiotic) throw new Error(`antibiotic ${name}`);
    return { id: nextId++, antibiotic, breakpoint: bp ?? null, standard_id: eucast.id, disk_cx: 0, disk_cy: 0, disk_r: 0,
      halo_r: 0, diameter_mm: d, category: categorise(d, bp), microcolonies: false, interpretation: "" };
  });
  return { id: 1, experiment_id: 1, family, genus, species, strain: "", sample: "", comments: "", created_at: "",
    supplementary_tests: tests,
    plates: [{ id: 1, antibiogram_id: 1, experiment_id: 1, original_filename: "", disk_mm: 6, px_per_mm: 1, created_at: "", measurements }] };
}

let failures = 0;
function check(title: string, a: Antibiogram, expectRules: string[], expectReported: Record<string, string> = {}, forbid: string[] = []) {
  const ev = evaluate(a, eucast);
  const ids = ev.rules.map((r) => r.id);
  const reported: Record<string, string> = {};
  for (const m of a.plates[0].measurements) {
    const r = ev.reported.get(m.id);
    if (r?.category) reported[m.antibiotic.name] = r.category;
  }
  const problems = [
    ...expectRules.filter((id) => !ids.some((x) => x === id || x.startsWith(`${id} `) || (id === "ATU" && x.startsWith("ATU")))).map((id) => `missing rule ${id}`),
    ...forbid.filter((id) => ids.includes(id)).map((id) => `unexpected rule ${id}`),
    ...Object.entries(expectReported).filter(([k, v]) => reported[k] !== v).map(([k, v]) => `${k} reported ${reported[k] ?? "as tested"}, expected ${v}`),
  ];
  console.log(`${problems.length ? "FAIL" : "ok  "} ${title}`);
  for (const r of ev.rules) console.log(`       [${r.kind}] ${r.id}: ${r.message}`);
  if (Object.keys(reported).length) console.log(`       reported: ${JSON.stringify(reported)}`);
  for (const p of problems) console.log(`    !! ${p}`);
  failures += problems.length ? 1 : 0;
}

check("E. coli ESBL + FQ resistance", isolate("Enterobacteriaceae", "Escherichia", "coli", [
  ["Ampicillin", 6], ["Amoxicillin-clavulanic acid", 22, "iv"], ["Piperacillin-tazobactam", 22], ["Piperacillin", 25],
  ["Cefotaxime", 12], ["Ceftazidime", 19], ["Cefepime", 26], ["Meropenem", 26], ["Ciprofloxacin", 12], ["Levofloxacin", 23],
]), ["ER Enterobacterales 1", "ER Enterobacterales 6", "ER Enterobacterales 7", "ER Enterobacterales 8", "MECH ESBL", "MECH CPE"],
{ Piperacillin: "R", Levofloxacin: "R" });

check("E. coli in the ATU of amoxicillin-clavulanic acid", isolate("Enterobacteriaceae", "", "Escherichia coli", [
  ["Amoxicillin-clavulanic acid", 19.4, "iv"], ["Ampicillin", 20],
]), ["ATU", "ER Enterobacterales 1"], {}, ["MECH ESBL"]);

check("K. pneumoniae susceptible to ampicillin (unexpected)", isolate("Enterobacteriaceae", "Klebsiella", "pneumoniae", [
  ["Ampicillin", 20], ["Piperacillin", 25], ["Meropenem", 20], ["Temocillin", 9],
]), ["ERP 1.7", "ER Enterobacterales 2", "MECH CPE"], { Ampicillin: "R", Piperacillin: "R" });

check("Enterobacter cloacae: AmpC rules", isolate("Enterobacteriaceae", "Enterobacter", "cloacae", [
  ["Cefoxitin", 25], ["Cefotaxime", 25], ["Cefuroxime iv", 22],
]), ["ERP 1.3", "ER Enterobacterales 3", "ER Enterobacterales 5"], { Cefoxitin: "R", "Cefuroxime iv": "R" });

check("Family only (no species): group rules only", isolate("Enterobacteriaceae", "", "", [
  ["Ciprofloxacin", 10], ["Levofloxacin", 25], ["Ampicillin", 25],
]), ["ER Enterobacterales 8"], { Levofloxacin: "R" }, ["ER Enterobacterales 1"]);

check("Salmonella: pefloxacin screen and aminoglycosides", isolate("Enterobacteriaceae", "Salmonella", "enterica", [
  ["Pefloxacin", 18], ["Ciprofloxacin", 26], ["Gentamicin", 22],
]), ["ER Salmonella 3", "ER Salmonella 2"], { Ciprofloxacin: "R", Gentamicin: "R" }, ["ER Enterobacterales 8"]);

check("MRSA with inducible MLSB phenotype", isolate("Staphylococcus spp.", "Staphylococcus", "aureus", [
  ["Cefoxitin", 18, "S. aureus"], ["Benzylpenicillin", 12], ["Erythromycin", 10], ["Clindamycin", 25], ["Norfloxacin", 20],
  ["Tetracycline", 30], ["Linezolid", 26], ["Ceftaroline", 25], ["Amoxicillin-clavulanic acid", 25],
]), ["ER Staphylococcus 1", "ER Staphylococcus 2", "ER Staphylococcus 3", "ER Staphylococcus 5", "ER Staphylococcus 7", "ER Staphylococcus 8b"],
{ "Amoxicillin-clavulanic acid": "R" }, ["ESP 2.1"]);

check("S. aureus resistant to linezolid (unexpected)", isolate("Staphylococcus spp.", "Staphylococcus", "aureus", [
  ["Cefoxitin", 26, "S. aureus"], ["Linezolid", 15], ["Ceftazidime", 22],
]), ["ESP 2.1", "ER Staphylococcus 1", "ERP 4.5"], { Ceftazidime: "R" });

check("E. faecalis resistant to ampicillin", isolate("Enterococcus spp.", "Enterococcus", "faecalis", [
  ["Ampicillin", 6], ["Norfloxacin", 20], ["Vancomycin", 8], ["Teicoplanin", 20], ["Clindamycin", 20],
]), ["ESP 2.7", "ER Enterococcus 1", "ER Enterococcus 4", "ER Enterococcus 5b"]);

check("P. aeruginosa: expected resistances", isolate("Pseudomonas spp.", "Pseudomonas", "aeruginosa", [
  ["Cefotaxime", 25], ["Ertapenem", 30], ["Ceftazidime", 22], ["Ciprofloxacin", 30],
]), ["ERP 2.7"], { Cefotaxime: "R", Ertapenem: "R" });

check("S. pneumoniae: oxacillin and norfloxacin screens", isolate("Streptococcus pneumoniae", "Streptococcus", "pneumoniae", [
  ["Oxacillin", 25], ["Norfloxacin", 15], ["Erythromycin", 30], ["Clindamycin", 25], ["Tetracycline", 30],
]), ["ER Pneumococcus 1", "ER Pneumococcus 2", "ER Pneumococcus 3", "ER Pneumococcus 5"]);

check("H. influenzae: positive benzylpenicillin screen, nalidixic acid negative", isolate("Haemophilus influenzae", "Haemophilus", "influenzae", [
  ["Benzylpenicillin", 8], ["Nalidixic acid", 26], ["Cefotaxime", 15],
]), ["ER Haemophilus 1", "ER Haemophilus 2"]);

check("Group A streptococcus resistant to penicillin (unexpected)", isolate("Streptococcus groups A, B, C and G", "Streptococcus", "pyogenes", [
  ["Benzylpenicillin", 12], ["Erythromycin", 10], ["Clindamycin", 22],
]), ["ESP 2.5", "ER Streptococcus 1", "ER Streptococcus 3"]);

check("No rules for an unremarkable isolate", isolate("Enterobacteriaceae", "Escherichia", "coli", [
  ["Ampicillin", 20], ["Cefotaxime", 28], ["Ciprofloxacin", 30], ["Meropenem", 30],
]), ["ER Enterobacterales 1"], {}, ["MECH ESBL", "MECH CPE", "ER Enterobacterales 8"]);

check("Positive D-test makes clindamycin resistant", isolate("Staphylococcus spp.", "Staphylococcus", "aureus", [
  ["Erythromycin", 10], ["Clindamycin", 25], ["Cefoxitin", 26, "S. aureus"],
], { inducible_clindamycin: "positive", mec: "positive" }), ["ER Staphylococcus 3", "ER Staphylococcus 1", "ER Staphylococcus 1 (mec)"],
{ Clindamycin: "R" });

check("vanA enterococcus", isolate("Enterococcus spp.", "Enterococcus", "faecium", [
  ["Vancomycin", 20], ["Teicoplanin", 20],
], { van: "vanA" }), ["ER Enterococcus 5 (vanA)"], { Vancomycin: "R", Teicoplanin: "R" });

check("H. influenzae beta-lactamase positive", isolate("Haemophilus influenzae", "Haemophilus", "influenzae", [
  ["Ampicillin", 20],
], { beta_lactamase: "positive" }), ["BP Haemophilus beta-lactamase"], { Ampicillin: "R" });

check("Confirmed ESBL and OXA-48", isolate("Enterobacteriaceae", "Klebsiella", "pneumoniae", [
  ["Cefotaxime", 12], ["Meropenem", 24],
], { esbl: "positive", carbapenemase: "OXA-48" }), ["MECH ESBL", "MECH CPE"]);

check("Tests that do not apply to the organism are ignored", isolate("Enterobacteriaceae", "Escherichia", "coli", [
  ["Ampicillin", 20],
], { van: "vanA", mec: "positive" }), ["ER Enterobacterales 1"], {}, ["ER Enterococcus 5 (vanA)"]);

console.log(failures ? `\n${failures} case(s) failed` : "\nAll cases passed");
process.exit(failures ? 1 : 0);
