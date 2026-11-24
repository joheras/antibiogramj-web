// Checks the resistance-phenotype detection (src/phenotypes.ts) on synthetic isolates categorised with the
// EUCAST 16.1 breakpoints of the browser catalogue: positive, negative and indeterminate outcomes of each phenotype.
//   node --experimental-strip-types --no-warnings scripts/test-phenotypes.mts
import fs from "node:fs";
import type { Antibiogram, Antibiotic, Breakpoint, Measurement, Plate } from "../src/api.ts";
import { evaluate } from "../src/expertRules.ts";
import { COMBINATIONS, detectPhenotypes, type Mechanism, type PhenotypeStatus } from "../src/phenotypes.ts";

const catalog = JSON.parse(fs.readFileSync(new URL("../src/browser/catalog.json", import.meta.url), "utf8"));
const eucast = catalog.standards.find((s: { name: string; version: string }) => s.name === "EUCAST" && s.version === "16.1");

function categorise(d: number, bp: Breakpoint | undefined): string {
  if (!bp || !bp.available || bp.susceptible === null || bp.resistant === null) return "Not available";
  return d >= bp.susceptible ? "Susceptible" : d < bp.resistant ? "Resistant" : "Intermediate";
}

let nextId = 1;
/** results: [antibiotic name, diameter in mm, plate number (default 1)] */
function isolate(familyName: string, genus: string, species: string, results: [string, number, number?][],
  tests: Record<string, string> = {}): Antibiogram {
  const family = catalog.families.find((f: { name: string }) => f.name === familyName);
  if (!family) throw new Error(`family ${familyName}`);
  const plates = new Map<number, Plate>();
  for (const [name, d, plate = 1] of results) {
    const antibiotics: Antibiotic[] = catalog.antibiotics.filter((a: Antibiotic) => a.name === name);
    if (!antibiotics.length) throw new Error(`antibiotic ${name}`);
    const bps: Breakpoint[] = catalog.breakpoints.filter((b: Breakpoint) => b.standard_id === eucast.id && b.family_id === family.id
      && antibiotics.some((a) => a.id === b.antibiotic_id) && b.available);
    const bp = bps[0];
    const antibiotic = bp ? antibiotics.find((a) => a.id === bp.antibiotic_id)! : antibiotics[0];
    const m: Measurement = { id: nextId++, antibiotic, breakpoint: bp ?? null, standard_id: eucast.id, disk_cx: 0, disk_cy: 0,
      disk_r: 0, halo_r: 0, diameter_mm: d, category: categorise(d, bp), microcolonies: false, interpretation: "" };
    if (!plates.has(plate)) plates.set(plate, { id: plate, antibiogram_id: 1, experiment_id: 1, original_filename: "", disk_mm: 6,
      px_per_mm: 1, created_at: "", measurements: [] });
    plates.get(plate)!.measurements.push(m);
  }
  return { id: 1, experiment_id: 1, family, genus, species, strain: "", sample: "", comments: "", created_at: "",
    supplementary_tests: tests, qc_strain: "", plates: [...plates.values()] };
}

let failures = 0, cases = 0;
/** expect: mechanism -> status, or [status, substring of the result]; null: the phenotype must not be reported. */
function check(title: string, a: Antibiogram, expect: Partial<Record<Mechanism, PhenotypeStatus | [PhenotypeStatus, string] | null>>,
  extra?: (report: ReturnType<typeof detectPhenotypes>) => string[]) {
  cases++;
  const report = detectPhenotypes(a);
  const problems: string[] = [];
  for (const [mech, want] of Object.entries(expect) as [Mechanism, PhenotypeStatus | [PhenotypeStatus, string] | null][]) {
    const got = report.phenotypes.find((p) => p.mechanism === mech);
    if (want === null) { if (got) problems.push(`${mech} reported (${got.status}), expected none`); continue; }
    const [status, text] = Array.isArray(want) ? want : [want, undefined];
    if (!got) problems.push(`${mech} missing, expected ${status}`);
    else {
      if (got.status !== status) problems.push(`${mech} ${got.status}, expected ${status}`);
      if (text && !got.result.includes(text)) problems.push(`${mech} result "${got.result}" lacks "${text}"`);
      if (!got.evidence.length && got.stage !== "recorded") problems.push(`${mech} without evidence`);
    }
  }
  problems.push(...(extra?.(report) ?? []));
  console.log(`${problems.length ? "FAIL" : "ok  "} ${title}`);
  for (const p of report.phenotypes) {
    console.log(`       [${p.mechanism}] ${p.status} (${p.stage}): ${p.result}`);
    for (const e of p.evidence) console.log(`           · ${e}`);
  }
  for (const p of problems) console.log(`    !! ${p}`);
  failures += problems.length ? 1 : 0;
}

const ENT = "Enterobacteriaceae";
const ecoli = (r: [string, number, number?][], t: Record<string, string> = {}) => isolate(ENT, "Escherichia", "coli", r, t);
const kpn = (r: [string, number, number?][], t: Record<string, string> = {}) => isolate(ENT, "Klebsiella", "pneumoniae", r, t);
const SYN5 = { carbapenemase_synergy_mm: "5" };

// The catalogue has every combination disk, without breakpoints, after the original antibiotics.
cases++;
{
  const missing = COMBINATIONS.filter((c) => !catalog.antibiotics.some((a: Antibiotic) => a.name === c.name && a.disk_content === c.content
    && a.drug_class === "Resistance mechanism tests" && a.id > 88));
  const withBp = catalog.breakpoints.filter((b: Breakpoint) => b.antibiotic_id > 88);
  const bases = COMBINATIONS.filter((c) => !catalog.antibiotics.some((a: Antibiotic) => a.name === c.base.name && a.disk_content === c.base.content));
  const ok = !missing.length && !withBp.length && !bases.length;
  console.log(`${ok ? "ok  " : "FAIL"} catalogue: combination disks appended without breakpoints, plain disks present`);
  if (!ok) { failures++; console.log(missing, withBp.length, bases); }
}

// ---- ESBL (chapter 3)
check("ESBL: screening negative", ecoli([["Cefotaxime", 27], ["Ceftazidime", 25]]), { ESBL: ["negative", "screening negative"] });
check("ESBL: incomplete screening (cefotaxime only)", ecoli([["Cefotaxime", 27]]), { ESBL: ["negative", "incomplete"] });
check("ESBL: cut-off is strict (cefotaxime 20.6 mm reads as 21, ceftazidime 22 mm)", ecoli([["Cefotaxime", 20.6], ["Ceftazidime", 22]]), { ESBL: "negative" });
check("ESBL: screening positive without confirmation (20.4 mm reads as 20)", ecoli([["Cefotaxime", 20.4], ["Ceftazidime", 25]]), { ESBL: "screen-positive" });
check("ESBL: cefpodoxime alone is a complete screen", ecoli([["Cefpodoxime", 18]]), { ESBL: "screen-positive" });
check("ESBL: CDT positive with cefotaxime (+9 mm)", ecoli([["Cefotaxime", 15], ["Cefotaxime-clavulanic acid", 24], ["Ceftazidime", 18], ["Ceftazidime-clavulanic acid", 20]]),
  { ESBL: ["positive", "cefotaxime + clavulanic acid"] });
check("ESBL: CDT boundary, +5 mm after rounding is positive", ecoli([["Ceftazidime", 17.4], ["Ceftazidime-clavulanic acid", 22.4], ["Cefotaxime", 19], ["Cefotaxime-clavulanic acid", 20]]),
  { ESBL: "positive" });
check("ESBL: CDT +4 mm with both agents is negative", ecoli([["Cefotaxime", 15], ["Cefotaxime-clavulanic acid", 19], ["Ceftazidime", 18], ["Ceftazidime-clavulanic acid", 22]]),
  { ESBL: ["negative", "confirmation negative"] });
check("ESBL: only cefotaxime ± clavulanic acid, negative -> indeterminate", ecoli([["Cefotaxime", 15], ["Cefotaxime-clavulanic acid", 17], ["Ceftazidime", 18]]),
  { ESBL: "indeterminate" });
check("ESBL: plain and combination disks on different plates", ecoli([["Cefotaxime", 14, 1], ["Ceftazidime", 17, 1], ["Cefotaxime-clavulanic acid", 23, 2]]),
  { ESBL: "positive" }, (r) => (r.pairs.length === 1 && !r.pairs[0].samePlate && r.pairs[0].increase === 9 ? [] : ["pair across plates not found"]));
check("ESBL: same-plate pair preferred", ecoli([["Cefotaxime", 10, 1], ["Cefotaxime", 15, 2], ["Cefotaxime-clavulanic acid", 21, 2]]),
  {}, (r) => (r.pairs[0]?.samePlate && r.pairs[0].increase === 6 ? [] : ["wrong pair"]));
check("ESBL: group 2 (Enterobacter) confirmed with cefepime", isolate(ENT, "Enterobacter", "cloacae", [["Cefotaxime", 14], ["Ceftazidime", 16],
  ["Cefepime", 21], ["Cefepime-clavulanic acid", 28]]), { ESBL: "positive", AmpC: null });
check("ESBL: group 2 with negative cefotaxime/ceftazidime CDT needs cefepime -> indeterminate", isolate(ENT, "Enterobacter", "cloacae", [
  ["Cefotaxime", 14], ["Cefotaxime-clavulanic acid", 15], ["Ceftazidime", 16], ["Ceftazidime-clavulanic acid", 17]]), { ESBL: "indeterminate" });
check("ESBL: cefoxitin-resistant E. coli, negative CDT without cefepime -> indeterminate", ecoli([["Cefoxitin", 14], ["Cefotaxime", 12],
  ["Cefotaxime-clavulanic acid", 13], ["Ceftazidime", 14], ["Ceftazidime-clavulanic acid", 15]]), { ESBL: "indeterminate", AmpC: "screen-positive" });
check("ESBL: cefoxitin-resistant E. coli, cefepime CDT negative -> negative", ecoli([["Cefoxitin", 14], ["Cefotaxime", 12],
  ["Cefotaxime-clavulanic acid", 13], ["Ceftazidime", 14], ["Ceftazidime-clavulanic acid", 15], ["Cefepime", 24], ["Cefepime-clavulanic acid", 26]]),
  { ESBL: "negative" });
check("ESBL: DDST recorded positive", ecoli([["Cefotaxime", 15], ["Ceftazidime", 17]], { esbl_ddst: "positive" }), { ESBL: ["positive", "DDST"] });
check("ESBL: DDST recorded indeterminate", ecoli([["Cefotaxime", 15], ["Ceftazidime", 17]], { esbl_ddst: "indeterminate" }), { ESBL: "indeterminate" });
check("ESBL: DDST recorded negative", ecoli([["Cefotaxime", 15], ["Ceftazidime", 17]], { esbl_ddst: "negative" }), { ESBL: "negative" });
check("ESBL: recorded confirmation overrides", ecoli([["Cefotaxime", 15], ["Ceftazidime", 17]], { esbl: "positive" }), { ESBL: ["positive", "recorded"] });
check("ESBL: K. oxytoca positive CDT carries the K1 caveat", isolate(ENT, "Klebsiella", "oxytoca", [["Cefotaxime", 15], ["Cefotaxime-clavulanic acid", 23],
  ["Ceftazidime", 24]]), { ESBL: "positive" }, (r) => (r.phenotypes[0].notes.some((n) => n.includes("K1")) ? [] : ["K1 caveat missing"]));
check("ESBL: masked by an MBL -> indeterminate", kpn([["Cefotaxime", 6], ["Cefotaxime-clavulanic acid", 7], ["Ceftazidime", 6], ["Ceftazidime-clavulanic acid", 7],
  ["Meropenem", 16], ["Meropenem-dipicolinic acid", 24], ["Meropenem-boronic acid", 17], ["Meropenem-cloxacillin", 16]], SYN5),
  { ESBL: "indeterminate", Carbapenemase: ["positive", "Metallo"] });
check("ESBL: unpaired combination disk is listed", ecoli([["Ceftazidime-clavulanic acid", 25], ["Cefotaxime", 25]]), {},
  (r) => (r.unpaired.length === 1 ? [] : ["unpaired disk not listed"]));

// ---- AmpC (chapter 4)
check("AmpC: cefoxitin < 19 mm and cefotaxime R -> screening positive", ecoli([["Cefoxitin", 15], ["Cefotaxime", 12], ["Ceftazidime", 15]]), { AmpC: "screen-positive" });
check("AmpC: cefoxitin 19 mm -> negative", ecoli([["Cefoxitin", 19], ["Cefotaxime", 12]]), { AmpC: "negative" });
check("AmpC: cefoxitin R but cephalosporins not R -> negative (porins)", ecoli([["Cefoxitin", 15], ["Cefotaxime", 26], ["Ceftazidime", 25]]), { AmpC: "negative" });
check("AmpC: no cefoxitin, cefepime S -> screening positive (less specific)", ecoli([["Cefotaxime", 12], ["Ceftazidime", 14], ["Cefepime", 30]]), { AmpC: "screen-positive" });
check("AmpC: no cefoxitin, cefepime not tested -> indeterminate", ecoli([["Cefotaxime", 12]]), { AmpC: "indeterminate" });
check("AmpC: E. coli confirmed -> PCR needed", ecoli([["Cefoxitin", 15], ["Cefotaxime", 12]], { ampc_confirmation: "positive" }), { AmpC: ["positive", "chromosomal"] });
check("AmpC: K. pneumoniae confirmed -> plasmid-mediated", kpn([["Cefoxitin", 15], ["Cefotaxime", 12]], { ampc_confirmation: "positive" }), { AmpC: ["positive", "Plasmid"] });
check("AmpC: no cloxacillin synergy -> negative", kpn([["Cefoxitin", 15], ["Cefotaxime", 12]], { ampc_confirmation: "negative" }), { AmpC: "negative" });
check("AmpC: not applied to species with chromosomal AmpC", isolate(ENT, "Citrobacter", "freundii", [["Cefoxitin", 10], ["Cefotaxime", 12]]), { AmpC: null });

// ---- Carbapenemases (chapter 2)
check("CPE: meropenem 28 mm -> screening negative", kpn([["Meropenem", 28]]), { Carbapenemase: "negative" });
check("CPE: meropenem 24 mm -> screening positive", kpn([["Meropenem", 24]]), { Carbapenemase: "screen-positive" });
check("CPE: meropenem 26 mm, piperacillin-tazobactam S -> no further testing", kpn([["Meropenem", 26], ["Piperacillin-tazobactam", 25]]), { Carbapenemase: "negative" });
check("CPE: meropenem 26 mm, piperacillin-tazobactam R -> screening positive", kpn([["Meropenem", 26], ["Piperacillin-tazobactam", 10]]), { Carbapenemase: "screen-positive" });
check("CPE: meropenem 26 mm alone -> indeterminate", kpn([["Meropenem", 26]]), { Carbapenemase: ["indeterminate", "borderline"] });
check("CPE: ertapenem 22 mm without meropenem -> screening positive", kpn([["Ertapenem", 22]]), { Carbapenemase: "screen-positive" });
check("CPE: combination disks without a synergy cut-off -> indeterminate", kpn([["Meropenem", 18], ["Meropenem-dipicolinic acid", 25], ["Meropenem-boronic acid", 18]]),
  { Carbapenemase: "indeterminate" }, (r) => (r.phenotypes.find((p) => p.mechanism === "Carbapenemase")!.notes.some((n) => n.includes("package insert")) ? [] : ["cut-off note missing"]));
const MBL: [string, number][] = [["Meropenem", 18], ["Meropenem-dipicolinic acid", 25], ["Meropenem-boronic acid", 19], ["Meropenem-cloxacillin", 18]];
check("CPE: MBL (dipicolinic acid synergy)", kpn(MBL, SYN5), { Carbapenemase: ["positive", "Metallo"] });
check("CPE: MBL (EDTA synergy)", kpn([["Meropenem", 18], ["Meropenem-EDTA", 24], ["Meropenem-boronic acid", 18]], SYN5), { Carbapenemase: ["positive", "Metallo"] });
check("CPE: the cut-off is the user's (same disks, cut-off 8 mm -> no MBL)", kpn(MBL, { carbapenemase_synergy_mm: "8" }), { Carbapenemase: ["indeterminate", "No synergy"] });
check("CPE: KPC (boronic acid only)", kpn([["Meropenem", 16], ["Meropenem-dipicolinic acid", 17], ["Meropenem-boronic acid", 23], ["Meropenem-cloxacillin", 17]], SYN5),
  { Carbapenemase: ["positive", "KPC"] });
check("CPE: AmpC + porin loss (boronic acid and cloxacillin)", kpn([["Meropenem", 22], ["Meropenem-dipicolinic acid", 22], ["Meropenem-boronic acid", 28],
  ["Meropenem-cloxacillin", 28]], SYN5), { Carbapenemase: ["negative", "AmpC"] });
check("CPE: boronic acid synergy without cloxacillin disk -> indeterminate", kpn([["Meropenem", 16], ["Meropenem-dipicolinic acid", 17], ["Meropenem-boronic acid", 23]], SYN5),
  { Carbapenemase: ["indeterminate", "KPC or AmpC"] });
const NOSYN: [string, number][] = [["Meropenem", 20], ["Meropenem-dipicolinic acid", 21], ["Meropenem-boronic acid", 21], ["Meropenem-cloxacillin", 20]];
check("CPE: no synergy + temocillin < 11 mm -> OXA-48-like", kpn([...NOSYN, ["Temocillin", 8]], SYN5), { Carbapenemase: ["positive", "OXA-48"] });
check("CPE: no synergy + temocillin 11 mm -> ESBL + porin loss", kpn([...NOSYN, ["Temocillin", 11]], SYN5), { Carbapenemase: ["negative", "porin"] });
check("CPE: no synergy, temocillin not tested -> indeterminate", kpn(NOSYN, SYN5), { Carbapenemase: ["indeterminate", "OXA-48-like or ESBL"] });
check("CPE: synergy with both inhibitors -> indeterminate (combination)", kpn([["Meropenem", 10], ["Meropenem-dipicolinic acid", 16], ["Meropenem-boronic acid", 16]], SYN5),
  { Carbapenemase: ["indeterminate", "combination"] });
check("CPE: double-inhibitor disk only -> MBL + KPC", kpn([["Meropenem", 8], ["Meropenem-dipicolinic acid", 10], ["Meropenem-boronic acid", 11],
  ["Meropenem-dipicolinic acid-boronic acid", 18], ["Meropenem-cloxacillin", 8]], SYN5), { Carbapenemase: ["positive", "MBL + KPC"] });
check("CPE: dipicolinic acid only, no synergy, boronic acid missing -> indeterminate", kpn([["Meropenem", 18], ["Meropenem-dipicolinic acid", 19]], SYN5),
  { Carbapenemase: ["indeterminate", "not classifiable"] });
check("CPE: recorded OXA-48 test", kpn([["Meropenem", 24]], { carbapenemase: "OXA-48" }), { Carbapenemase: ["positive", "recorded"] });
check("CPE: recorded negative test", kpn([["Meropenem", 24]], { carbapenemase: "negative" }), { Carbapenemase: "negative" });

for (const t of ["KPC", "OXA-48"]) check(`CPE: recorded ${t} takes precedence over MBL disks`, kpn(MBL, { ...SYN5, carbapenemase: t }), { Carbapenemase: ["positive", t] });
check("CPE: recorded negative takes precedence over MBL disks", kpn(MBL, { ...SYN5, carbapenemase: "negative" }), { Carbapenemase: ["negative", "recorded"] });
check("CPE: recorded positive, the disks give the type", kpn(MBL, { ...SYN5, carbapenemase: "positive" }), { Carbapenemase: ["positive", "Metallo"] });
check("CPE: recorded positive is not undone by the disks", kpn([...NOSYN, ["Temocillin", 15]], { ...SYN5, carbapenemase: "positive" }), { Carbapenemase: ["positive", "type not known"] });
const dualDisks = (dpa: number, apba: number, clx?: number): [string, number][] => [["Meropenem", 8], ["Meropenem-dipicolinic acid", dpa],
  ["Meropenem-boronic acid", apba], ["Meropenem-dipicolinic acid-boronic acid", 18], ...(clx === undefined ? [] : [["Meropenem-cloxacillin", clx] as [string, number]])];
for (const [d, b] of [[16, 9], [9, 16], [16, 16]]) check(`CPE: double inhibitor + single inhibitors ${d}/${b} mm -> MBL + KPC`, kpn(dualDisks(d, b, 8), SYN5), { Carbapenemase: ["positive", "MBL + KPC"] });
check("CPE: double inhibitor without cloxacillin -> indeterminate", kpn(dualDisks(16, 9), SYN5), { Carbapenemase: ["indeterminate", "Double"] });
check("CPE: double inhibitor and cloxacillin synergy -> indeterminate", kpn(dualDisks(9, 16, 16), SYN5), { Carbapenemase: ["indeterminate", "Double"] });

// ---- MRSA (chapter 7)
const sau = (r: [string, number][], t: Record<string, string> = {}) => isolate("Staphylococcus spp.", "Staphylococcus", "aureus", r, t);
check("MRSA: cefoxitin 21 mm -> MRSA", sau([["Cefoxitin", 21]]), { MRSA: "positive" });
check("MRSA: cefoxitin 22 mm -> methicillin susceptible", sau([["Cefoxitin", 22]]), { MRSA: "negative" });
check("MRSA: mecA recorded overrides a negative screen", sau([["Cefoxitin", 25]], { mec: "positive" }), { MRSA: "positive" });
check("MRSA: only S. aureus (chapter 7)", isolate("Staphylococcus spp.", "Staphylococcus", "epidermidis", [["Cefoxitin", 18]]), { MRSA: null });
check("No phenotypes for non-Enterobacterales gram-negatives", isolate("Pseudomonas spp.", "Pseudomonas", "aeruginosa", [["Meropenem", 15]]),
  { Carbapenemase: null, ESBL: null });

// ---- Combination disks do not disturb the expert rules
cases++;
{
  const a = kpn([["Cefotaxime", 15], ["Cefotaxime-clavulanic acid", 24], ["Meropenem", 18], ["Meropenem-boronic acid", 25], ["Ampicillin", 6]]);
  const combos = a.plates[0].measurements.filter((m) => m.antibiotic.drug_class === "Resistance mechanism tests");
  const ev = evaluate(a, eucast);
  const touched = combos.filter((m) => ev.reported.has(m.id) || ev.rules.some((r) => r.agents.includes(m.antibiotic.name)));
  const ok = combos.length === 2 && combos.every((m) => m.category === "Not available") && !touched.length;
  console.log(`${ok ? "ok  " : "FAIL"} combination disks are "Not available" and ignored by the expert rules`);
  if (!ok) failures++;
}

console.log(failures ? `\n${failures} of ${cases} case(s) failed` : `\nAll ${cases} cases passed`);
process.exit(failures ? 1 : 0);
