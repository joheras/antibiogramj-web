// Resistance phenotypes from disk-diffusion results: screening and phenotypic confirmation of ESBL, acquired
// AmpC and carbapenemases in Enterobacterales, and methicillin resistance in S. aureus, for one isolate (an
// antibiogram: all the measurements of all its plates, so the plain disk and its inhibitor combination may be on
// different plates).
//
// Sources (every cut-off below cites its section):
//  * GUIDE  EUCAST guidelines for detection of resistance mechanisms and specific resistances of clinical and/or
//           epidemiological importance, version 2.01 (July 2017) - the current version on eucast.org
//  * CDT    EUCAST technical guidance on the use of the combination disk test (CDT) for confirmation of ESBL in
//           Enterobacterales (12 February 2019): cefotaxime 5 µg and ceftazidime 10 µg ± clavulanic acid 10 µg
//
// The results are presumptive phenotypes for infection control and surveillance: they never change the stored
// measurements or the categories, and must be confirmed (genotypically for the carbapenemases and whenever the
// phenotype is unclear).

import type { Antibiogram, Measurement } from "./api";
import { enterobacterales, is, organismOf, sAureus, type Organism } from "./expertRules.ts"; // explicit extension: also run by node (scripts/test-phenotypes.mts)

export const GUIDE = "EUCAST guidelines for detection of resistance mechanisms v2.01 (July 2017)";
export const CDT = "EUCAST technical guidance on the combination disk test for ESBL confirmation (February 2019)";
export const GUIDE_URL = "https://www.eucast.org/bacteria/important-additional-information/resistance-detection/";
export const PHENOTYPE_SOURCES = `${GUIDE}; ${CDT}`;

// ---------------------------------------------------------------- cut-offs (mm)

/** GUIDE section 3.4.1, Table 1 (disk diffusion): "Conduct ESBL-testing if" the zone is below the cut-off. */
export const ESBL_SCREEN = [
  { name: "Cefotaxime", content: "5", below: 21 },
  { name: "Ceftriaxone", content: "30", below: 23 },
  { name: "Ceftazidime", content: "10", below: 22 },
  { name: "Cefpodoxime", content: "10", below: 21 },
] as const;
/** GUIDE section 3.4.2 A and Tables 2-3; CDT "Interpretive criteria": positive if, for one or both agents, the
 *  zone is ≥ 5 mm larger with clavulanic acid than without. */
export const CDT_INCREASE = 5;
/** GUIDE section 2.4.1, Table 1: meropenem 10 µg screening cut-off < 28 mm. */
export const MEROPENEM_SCREEN = 28;
/** GUIDE section 2.4.1, Table 1 footnote 2: always investigate if < 25 mm; 25-27 mm only if resistant to
 *  piperacillin-tazobactam and/or temocillin (Figure 1: 25-27 mm and piperacillin-tazobactam I/S, no further testing). */
export const MEROPENEM_ALWAYS = 25;
/** GUIDE section 2.4.1, Table 1: ertapenem 10 µg screening cut-off < 25 mm (high sensitivity, low specificity). */
export const ERTAPENEM_SCREEN = 25;
/** GUIDE section 2.4.2, Figure 1 footnote 2 and Table 2: high-level temocillin resistance (zone < 11 mm) is a
 *  phenotypic marker of OXA-48. */
export const TEMOCILLIN_HIGH_LEVEL = 11;
/** GUIDE section 4.4 and Figure 1 footnote 1: cefoxitin non-wild type, MIC > 8 mg/L or zone < 19 mm (also the
 *  cefoxitin criterion of section 3.4.3 / Figure 1 footnote 1 of chapter 3 for AmpC masking ESBL). */
export const CEFOXITIN_AMPC = 19;
/** GUIDE section 7.4.1 B: S. aureus with a cefoxitin 30 µg zone < 22 mm is methicillin resistant. */
export const CEFOXITIN_MRSA = 22;

// ---------------------------------------------------------- combination disks

export type Inhibitor = "clavulanic acid" | "EDTA" | "dipicolinic acid" | "boronic acid" | "dipicolinic acid + boronic acid" | "cloxacillin";

export interface Combination {
  name: string; content: string;          // catalogue antibiotic (backend/seed/supplementary_disks.json)
  base: { name: string; content: string }; // the plain disk it is compared with
  inhibitor: Inhibitor;
}

/** Same pairs as backend/seed/supplementary_disks.json. */
export const COMBINATIONS: Combination[] = [
  { name: "Cefotaxime-clavulanic acid", content: "5-10", base: { name: "Cefotaxime", content: "5" }, inhibitor: "clavulanic acid" },
  { name: "Ceftazidime-clavulanic acid", content: "10-10", base: { name: "Ceftazidime", content: "10" }, inhibitor: "clavulanic acid" },
  { name: "Cefepime-clavulanic acid", content: "30-10", base: { name: "Cefepime", content: "30" }, inhibitor: "clavulanic acid" },
  { name: "Meropenem-EDTA", content: "10", base: { name: "Meropenem", content: "10" }, inhibitor: "EDTA" },
  { name: "Meropenem-dipicolinic acid", content: "10", base: { name: "Meropenem", content: "10" }, inhibitor: "dipicolinic acid" },
  { name: "Meropenem-boronic acid", content: "10", base: { name: "Meropenem", content: "10" }, inhibitor: "boronic acid" },
  { name: "Meropenem-dipicolinic acid-boronic acid", content: "10", base: { name: "Meropenem", content: "10" }, inhibitor: "dipicolinic acid + boronic acid" },
  { name: "Meropenem-cloxacillin", content: "10", base: { name: "Meropenem", content: "10" }, inhibitor: "cloxacillin" },
];

export function combinationOf(m: Pick<Measurement, "antibiotic">): Combination | undefined {
  return COMBINATIONS.find((c) => c.name === m.antibiotic.name && c.content === m.antibiotic.disk_content);
}

/** A combination disk and the plain disk it is compared with. */
export interface Pair {
  combination: Measurement; base: Measurement; spec: Combination;
  samePlate: boolean;
  /** Zone diameter with the inhibitor minus without, in whole millimetres (zones are read to the mm). */
  increase: number;
}

const mm = (d: number) => Math.round(d);
const disk = (m: Measurement) => `${m.antibiotic.name} ${m.antibiotic.disk_content} µg`;
const zone = (m: Measurement) => `${disk(m)}: ${mm(m.diameter_mm)} mm`;

/** Pairs every combination disk with its plain disk, on the same plate if possible, otherwise on another plate
 *  of the antibiogram. Combination disks without a plain disk are returned in ``unpaired``. */
export function combinationPairs(a: Pick<Antibiogram, "plates">): { pairs: Pair[]; unpaired: Measurement[] } {
  const pairs: Pair[] = [], unpaired: Measurement[] = [];
  const all = a.plates.flatMap((p) => p.measurements.map((m) => ({ m, plate: p.id })));
  for (const { m, plate } of all) {
    const spec = combinationOf(m);
    if (!spec) continue;
    const bases = all.filter(({ m: b }) => b.antibiotic.name === spec.base.name && b.antibiotic.disk_content === spec.base.content);
    const base = bases.find((b) => b.plate === plate) ?? bases[0];
    if (!base) { unpaired.push(m); continue; }
    pairs.push({ combination: m, base: base.m, spec, samePlate: base.plate === plate,
      increase: mm(m.diameter_mm) - mm(base.m.diameter_mm) });
  }
  return { pairs, unpaired };
}

// --------------------------------------------------------------------- report

export type Mechanism = "ESBL" | "AmpC" | "Carbapenemase" | "MRSA";
/**
 *  positive        phenotype detected (presumptive, see notes)
 *  negative        not detected (by screening or by confirmation)
 *  screen-positive screening positive: a confirmation test is needed
 *  indeterminate   the tests done do not allow a conclusion (missing disks, no clear synergy, combined mechanisms)
 */
export type PhenotypeStatus = "positive" | "negative" | "screen-positive" | "indeterminate";

export interface Phenotype {
  mechanism: Mechanism;
  status: PhenotypeStatus;
  /** Headline, e.g. "Metallo-β-lactamase (presumptive)". */
  result: string;
  /** Highest step reached: screening, phenotypic confirmation, or a result recorded by the user. */
  stage: "screening" | "confirmation" | "recorded";
  /** The measurements and tests that led to the result, each with the cut-off and its section. */
  evidence: string[];
  /** What to do next and the caveats of the guideline. */
  notes: string[];
  source: string;
}

export interface PhenotypeReport {
  phenotypes: Phenotype[];
  pairs: Pair[];
  unpaired: Measurement[];
  organism: string;
}

class Results {
  readonly ms: Measurement[];
  constructor(ms: Measurement[]) { this.ms = ms; }
  /** Measurements of a disk (name and content) - the smallest zone first. */
  of(name: string, content?: string): Measurement[] {
    return this.ms.filter((m) => m.antibiotic.name === name && (content === undefined || m.antibiotic.disk_content === content))
      .sort((x, y) => x.diameter_mm - y.diameter_mm);
  }
  first(name: string, content?: string): Measurement | undefined { return this.of(name, content)[0]; }
  /** Resistant with the breakpoints in use (any disk of the agent). */
  R(name: string): boolean { return this.of(name).some((m) => m.category === "Resistant"); }
  /** Categorised and not resistant. */
  notR(name: string): boolean {
    const ms = this.of(name).filter((m) => ["Susceptible", "Intermediate", "Resistant"].includes(m.category));
    return ms.length > 0 && ms.every((m) => m.category !== "Resistant");
  }
  S(name: string): boolean { return this.of(name).some((m) => m.category === "Susceptible") && !this.R(name); }
}

const PRESUMPTIVE = "Phenotypic, presumptive result: detection of the mechanism does not in itself change the clinical " +
  "categorisation (guideline section 1); it is for infection control and surveillance.";

// ---- ESBL in Enterobacterales (GUIDE chapter 3)

/** GUIDE section 3.4.1 B and Figure 1: group 2, Enterobacterales with inducible chromosomal AmpC. */
const esblGroup2 = (o: Organism) => is(o, "enterobacter", "klebsiella aerogenes", "citrobacter freundii", "morganella morganii",
  "providencia", "serratia", "hafnia alvei");

function esbl(r: Results, o: Organism, tests: Record<string, string>, pairs: Pair[], carbapenemase?: Phenotype): Phenotype | null {
  const evidence: string[] = [], notes: string[] = [];
  const screened = ESBL_SCREEN.map((s) => ({ s, m: r.first(s.name, s.content) })).filter((x) => x.m);
  const cdt = pairs.filter((p) => p.spec.inhibitor === "clavulanic acid");
  const recorded = tests.esbl, ddst = tests.esbl_ddst;
  if (!screened.length && !cdt.length && !recorded && !ddst) return null;

  // Screening (section 3.4.1, Table 1)
  const positive = screened.filter(({ s, m }) => mm(m!.diameter_mm) < s.below);
  for (const { s, m } of screened) evidence.push(`${zone(m!)} ${mm(m!.diameter_mm) < s.below ? "<" : "≥"} ${s.below} mm ESBL screening cut-off (section 3.4.1, Table 1)`);
  const has = (n: string) => screened.some(({ s }) => s.name === n);
  // Table 1 footnote 1: test (cefotaxime or ceftriaxone) AND ceftazidime, or cefpodoxime alone
  const complete = ((has("Cefotaxime") || has("Ceftriaxone")) && has("Ceftazidime")) || has("Cefpodoxime");
  if (screened.length && !complete) notes.push("Incomplete screening: test cefotaxime (or ceftriaxone) and ceftazidime, or cefpodoxime (section 3.4.1, Table 1 footnote 1).");

  // Species group and AmpC (Figure 1 and footnote 1; section 3.4.3)
  const group2 = esblGroup2(o);
  const fox = r.first("Cefoxitin", "30");
  const ampc = fox !== undefined && mm(fox.diameter_mm) < CEFOXITIN_AMPC;
  if (group2) notes.push("Species with inducible chromosomal AmpC (group 2): confirm with cefepime ± clavulanic acid (section 3.4.1 B, Table 3).");
  else if (!o.species) notes.push("Species not given: the group 1 algorithm (cefotaxime and ceftazidime ± clavulanic acid) was applied (section 3.4, Figure 1).");
  if (!group2 && ampc) {
    evidence.push(`${zone(fox!)} < ${CEFOXITIN_AMPC} mm (cefoxitin MIC > 8 mg/L): high-level AmpC may mask the ESBL (section 3.4.3)`);
    notes.push("Cefoxitin resistant: perform the cefepime ± clavulanic acid confirmation test (chapter 3 Figure 1 footnote 1, section 3.4.3).");
  }

  // Combination disk test (section 3.4.2 A, Tables 2-3; CDT guidance)
  for (const p of cdt) {
    evidence.push(`${p.combination.antibiotic.name} ${mm(p.combination.diameter_mm)} mm vs ${p.base.antibiotic.name} ${mm(p.base.diameter_mm)} mm: ` +
      `${p.increase >= 0 ? "+" : ""}${p.increase} mm (${p.increase >= CDT_INCREASE ? "≥" : "<"} ${CDT_INCREASE} mm, section 3.4.2 A)` +
      (p.samePlate ? "" : " - disks on different plates"));
  }
  const cdtPositive = cdt.filter((p) => p.increase >= CDT_INCREASE);
  const pairOf = (name: string) => cdt.find((p) => p.base.antibiotic.name === name);
  const required = group2 || ampc ? ["Cefepime"] : ["Cefotaxime", "Ceftazidime"];
  const missing = required.filter((n) => !pairOf(n));
  if (ddst) evidence.push(`Double-disk synergy test recorded: ${ddst} (section 3.4.2 B)`);
  if (recorded) evidence.push(`ESBL confirmation recorded under Supplementary tests: ${recorded}`);

  const base = { mechanism: "ESBL" as const, source: `${GUIDE}, chapter 3; ${CDT}` };
  const masked = carbapenemase?.status === "positive" && /MBL|KPC|class A|metallo/i.test(carbapenemase.result);
  if (masked) notes.push("MBLs and KPCs (but not OXA-48-like enzymes) can mask ESBLs: use molecular methods if detection is relevant (section 3.4.3).");
  const falsePositive = () => {
    if (is(o, "klebsiella oxytoca", "proteus vulgaris", "proteus penneri", "citrobacter koseri", "kluyvera", "citrobacter sedlakii",
      "citrobacter farmeri", "citrobacter amalonaticus"))
      notes.push("This species has a chromosomal beta-lactamase inhibited by clavulanic acid (e.g. K1 in K. oxytoca): the confirmation may be false positive (section 3.4.2 E).");
    if (ampc) notes.push("AmpC can also be present in isolates with a positive ESBL test (chapter 4, Figure 1 footnote 1).");
  };

  if (recorded === "positive" || recorded === "negative") {
    if (recorded === "positive") falsePositive();
    return { ...base, status: recorded, stage: "recorded", evidence, notes: [...notes, PRESUMPTIVE],
      result: recorded === "positive" ? "ESBL producer (recorded confirmation)" : "ESBL not confirmed (recorded test)" };
  }
  if (cdtPositive.length || ddst === "positive") {
    falsePositive();
    notes.push("Genotypic confirmation (PCR, sequencing) where required (section 3.4.4).", PRESUMPTIVE);
    return { ...base, status: "positive", stage: "confirmation", evidence, notes,
      result: `ESBL producer (presumptive; ${[...cdtPositive.map((p) => `${p.base.antibiotic.name.toLowerCase()} + clavulanic acid`), ...(ddst === "positive" ? ["DDST"] : [])].join(", ")})` };
  }
  if (cdt.length || ddst) {
    // no synergy in the tests done
    if (ddst === "indeterminate" || (cdt.length && missing.length) || (!cdt.length && ddst === "negative" && ampc && !group2)) {
      if (missing.length) notes.push(`No synergy so far; also test ${missing.map((n) => `${n.toLowerCase()} ± clavulanic acid`).join(" and ")} (Tables ${group2 || ampc ? "3" : "2"}).`);
      if (ddst === "indeterminate") notes.push("No clear synergy: if confirmation with cefepime ± clavulanic acid is still indeterminate, genotypic testing is required (chapter 3 Figure 1 footnote 2).");
      return { ...base, status: "indeterminate", stage: "confirmation", evidence, notes: [...notes, PRESUMPTIVE], result: "ESBL indeterminate" };
    }
    if (masked) return { ...base, status: "indeterminate", stage: "confirmation", evidence, notes, result: "ESBL not detectable phenotypically (carbapenemase)" };
    notes.push("Negative confirmation in an isolate with reduced susceptibility: consider AmpC, carbapenemases or permeability defects.");
    return { ...base, status: "negative", stage: "confirmation", evidence, notes, result: "ESBL not detected (confirmation negative)" };
  }
  if (positive.length) {
    notes.push(`Perform an ESBL confirmation test: combination disks ${group2 || ampc ? "cefepime" : "cefotaxime and ceftazidime"} ± clavulanic acid ` +
      "(≥ 5 mm increase), double-disk synergy, gradient or broth microdilution test (section 3.4.2).");
    return { ...base, status: "screen-positive", stage: "screening", evidence, notes,
      result: `ESBL screening positive (${positive.map(({ s }) => s.name.toLowerCase()).join(", ")})` };
  }
  return { ...base, status: "negative", stage: "screening", evidence, notes,
    result: complete ? "ESBL screening negative" : "ESBL screening negative (incomplete)" };
}

// ---- Acquired AmpC in Enterobacterales (GUIDE chapter 4)

/** GUIDE section 4.4, Figure 1: the species of the AmpC algorithm. */
const ampcSpecies = (o: Organism) => is(o, "escherichia coli", "klebsiella pneumoniae", "proteus mirabilis", "salmonella", "shigella");

function ampc(r: Results, o: Organism, tests: Record<string, string>): Phenotype | null {
  if (!ampcSpecies(o)) return null;
  const evidence: string[] = [], notes: string[] = [];
  const fox = r.first("Cefoxitin", "30");
  const thirdGen = ["Cefotaxime", "Ceftazidime"].filter((n) => r.R(n));
  const recorded = tests.ampc_confirmation;
  if (!fox && !thirdGen.length && !recorded) return null;
  const base = { mechanism: "AmpC" as const, source: `${GUIDE}, chapter 4` };
  for (const n of thirdGen) evidence.push(`${zone(r.first(n)!)}: resistant with the breakpoints in use (section 4.4, Figure 1)`);
  let screen: boolean | null = null;
  if (fox) {
    const low = mm(fox.diameter_mm) < CEFOXITIN_AMPC;
    evidence.push(`${zone(fox)} ${low ? "<" : "≥"} ${CEFOXITIN_AMPC} mm (cefoxitin ${low ? "non-wild type, MIC > 8 mg/L" : "wild type"}, section 4.4)`);
    screen = low && thirdGen.length > 0;
    if (low && !thirdGen.length) notes.push("Cefoxitin resistant but cefotaxime and ceftazidime not resistant: cefoxitin resistance may also be due to porin deficiency (section 4.4).");
  } else if (thirdGen.length && r.S("Cefepime")) {
    evidence.push(`${zone(r.first("Cefepime")!)}: susceptible (cefoxitin not tested; less specific indicator, chapter 4 Figure 1 footnote 1)`);
    screen = true;
    notes.push("Test cefoxitin 30 µg: cefoxitin non-wild type (< 19 mm) is the recommended screening criterion (section 4.4).");
  } else if (thirdGen.length) {
    notes.push("Test cefoxitin 30 µg to screen for AmpC (section 4.4).");
  }
  notes.push("ACC-1, a plasmid-mediated AmpC, does not hydrolyse cefoxitin and is not detected by this screening (section 4.4).");
  if (recorded) evidence.push(`Cloxacillin/boronic acid synergy recorded under Supplementary tests: ${recorded}`);
  const chromosomal = is(o, "escherichia coli", "shigella");
  if (recorded === "positive") {
    notes.push(chromosomal
      ? "E. coli and Shigella: PCR is required to discriminate plasmid-acquired AmpC from hyperproduction of the chromosomal AmpC (section 4.4, Figure 1)."
      : "This species lacks a chromosomal AmpC: plasmid-mediated AmpC detected (section 4.4, Figure 1).",
    "Boronic acid derivatives also inhibit class A carbapenemases and some class A penicillinases (section 4.4).", PRESUMPTIVE);
    return { ...base, status: "positive", stage: "recorded", evidence, notes,
      result: chromosomal ? "AmpC producer (acquired or chromosomal hyperproduction; presumptive)" : "Plasmid-mediated AmpC (presumptive)" };
  }
  if (recorded === "negative") {
    notes.push("No cloxacillin synergy: other mechanisms, e.g. porin loss (section 4.4, Figure 1).");
    return { ...base, status: "negative", stage: "recorded", evidence, notes, result: "AmpC not confirmed (no cloxacillin synergy)" };
  }
  if (screen) {
    notes.push("Confirm with cloxacillin or boronic acid synergy (combination disks/tablets, AmpC gradient test) or PCR, and " +
      "record the result under Supplementary tests (section 4.4).");
    return { ...base, status: "screen-positive", stage: "screening", evidence, notes, result: "AmpC screening positive" };
  }
  if (screen === false) return { ...base, status: "negative", stage: "screening", evidence, notes, result: "AmpC screening negative" };
  return { ...base, status: "indeterminate", stage: "screening", evidence, notes, result: "AmpC screening incomplete (cefoxitin not tested)" };
}

// ---- Carbapenemases in Enterobacterales (GUIDE chapter 2)

type Syn = boolean | null; // null: not tested

function classifyCarbapenemase(r: Results, tests: Record<string, string>, pairs: Pair[]): Phenotype | null {
  const evidence: string[] = [], notes: string[] = [];
  const mem = r.first("Meropenem", "10"), etp = r.first("Ertapenem", "10"), tem = r.first("Temocillin", "30");
  const inhib = pairs.filter((p) => p.base.antibiotic.name === "Meropenem");
  const recorded = tests.carbapenemase;
  if (!mem && !etp && !inhib.length && !recorded) return null;
  const base = { mechanism: "Carbapenemase" as const, source: `${GUIDE}, chapter 2` };

  // Screening (section 2.4.1, Table 1 and footnote 2; Figure 1)
  let screen: "positive" | "negative" | "borderline" | null = null;
  if (mem) {
    const d = mm(mem.diameter_mm);
    if (d >= MEROPENEM_SCREEN) {
      screen = "negative";
      evidence.push(`${zone(mem)} ≥ ${MEROPENEM_SCREEN} mm carbapenemase screening cut-off (section 2.4.1, Table 1)`);
    } else if (d >= MEROPENEM_ALWAYS) {
      const tzpR = r.R("Piperacillin-tazobactam"), temR = r.R("Temocillin");
      evidence.push(`${zone(mem)}: ${MEROPENEM_ALWAYS}-${MEROPENEM_SCREEN - 1} mm (section 2.4.1, Table 1 footnote 2)`);
      if (tzpR || temR) {
        screen = "positive";
        evidence.push(`Resistant to ${[tzpR && "piperacillin-tazobactam", temR && "temocillin"].filter(Boolean).join(" and ")}: investigate (Table 1 footnote 2)`);
      } else if (r.notR("Piperacillin-tazobactam") && (!r.first("Temocillin") || r.notR("Temocillin"))) {
        screen = "negative";
        evidence.push("Piperacillin-tazobactam not resistant: no further testing (section 2.4.2, Figure 1 exception)");
      } else {
        screen = "borderline";
        notes.push("Meropenem 25-27 mm only needs investigation if resistant to piperacillin-tazobactam and/or temocillin: test them (Table 1 footnote 2).");
      }
    } else {
      screen = "positive";
      evidence.push(`${zone(mem)} < ${MEROPENEM_ALWAYS} mm: investigation for carbapenemases always warranted (section 2.4.1, Table 1 footnote 2)`);
    }
  } else if (etp) {
    const d = mm(etp.diameter_mm);
    screen = d < ERTAPENEM_SCREEN ? "positive" : "negative";
    evidence.push(`${zone(etp)} ${d < ERTAPENEM_SCREEN ? "<" : "≥"} ${ERTAPENEM_SCREEN} mm ertapenem screening cut-off (section 2.4.1, Table 1)`);
    notes.push("Ertapenem has high sensitivity but low specificity (ESBL/AmpC with porin loss): meropenem offers the best balance (section 2.4.1, Table 1 footnote 3).");
  }

  // Inhibitor combination disks (section 2.4.2, Figure 1 and Table 2)
  const cutoff = tests.carbapenemase_synergy_mm ? Number(tests.carbapenemase_synergy_mm) : null;
  for (const p of inhib) {
    evidence.push(`${p.combination.antibiotic.name} ${mm(p.combination.diameter_mm)} mm vs meropenem ${mm(p.base.diameter_mm)} mm: ` +
      `${p.increase >= 0 ? "+" : ""}${p.increase} mm` + (cutoff !== null ? ` (${p.increase >= cutoff ? "synergy" : "no synergy"}, cut-off ≥ ${cutoff} mm from the package insert)` : "") +
      (p.samePlate ? "" : " - disks on different plates"));
  }
  const syn = (...inhibitors: Inhibitor[]): Syn => {
    const ps = inhib.filter((p) => inhibitors.includes(p.spec.inhibitor));
    if (!ps.length || cutoff === null) return null;
    return ps.some((p) => p.increase >= cutoff);
  };
  const mbl = syn("EDTA", "dipicolinic acid"), apba = syn("boronic acid"), dual = syn("dipicolinic acid + boronic acid"), clx = syn("cloxacillin");
  const temHigh: Syn = tem ? mm(tem.diameter_mm) < TEMOCILLIN_HIGH_LEVEL : null;
  if (tem) evidence.push(`${zone(tem)} ${temHigh ? "<" : "≥"} ${TEMOCILLIN_HIGH_LEVEL} mm (high-level temocillin resistance${temHigh ? "" : " absent"}, section 2.4.2 Figure 1 footnote 2)`);
  if (recorded) evidence.push(`Carbapenemase test recorded under Supplementary tests: ${recorded}`);

  const caveats = [
    "The exact definitions of synergy are provided in the package inserts of the combination disks/tablets (section 2.4.2, Table 2).",
    "Confirm the carbapenemase and its type genotypically (or with other validated methods) and notify infection control.",
    PRESUMPTIVE,
  ];
  const classified = (status: PhenotypeStatus, result: string, ...extra: string[]): Phenotype =>
    ({ ...base, status, stage: "confirmation", evidence, notes: [...notes, ...extra, ...caveats], result });

  // A result recorded by the user takes precedence; the disks remain as evidence
  if (recorded && (recorded !== "positive" || !inhib.length) && recorded !== "negative") {
    const type = { KPC: "KPC / class A carbapenemase", MBL: "Metallo-β-lactamase", "OXA-48": "OXA-48-like carbapenemase", positive: "Carbapenemase (type not known)" }[recorded] ?? recorded;
    if (inhib.length) notes.push("The recorded test takes precedence over the combination disks: check that they agree.");
    return { ...base, status: "positive", stage: "recorded", evidence, notes: [...notes, PRESUMPTIVE], result: `${type} (recorded test)` };
  }
  if (recorded === "negative") {
    if (inhib.length) notes.push("The recorded test takes precedence over the combination disks: check that they agree.");
    if (screen === "positive") notes.push("Reduced carbapenem susceptibility without carbapenemase: most often ESBL or AmpC with porin loss (sections 2.3, 2.4.2).");
    return { ...base, status: "negative", stage: "recorded", evidence, notes, result: "Carbapenemase not detected (recorded test)" };
  }
  if (inhib.length && cutoff === null) {
    notes.push("Choose the synergy cut-off of your combination disks (package insert) under Supplementary tests to classify the carbapenemase (section 2.4.2, Table 2).");
  } else if (inhib.length) {
    // Table 2: the MBL + KPC row is the only one with double-inhibitor synergy (single inhibitors variable, cloxacillin -)
    if (dual === true && clx === false)
      return classified("positive", "MBL + KPC (presumptive)",
        "Double-inhibitor tablets lack multi-centre validation; this combination is rare outside Greece (Table 2 footnote 2).",
        ...(mbl === true || apba === true ? ["Synergy also with a single inhibitor: confirm both enzymes with molecular tests."] : []));
    if (dual === true)
      return classified("indeterminate", "Double-inhibitor synergy, phenotype not classifiable", clx === null
        ? "Test meropenem + cloxacillin: MBL + KPC requires no cloxacillin synergy (Table 2)."
        : "Synergy with the double inhibitor and cloxacillin is not in Table 2: use molecular methods.");
    if (mbl === true && apba === true)
      return classified("indeterminate", "Possible combination of carbapenemases (e.g. MBL + KPC)", "Synergy with both inhibitors: molecular testing is usually necessary (Figure 1 footnote 1).");
    if (mbl === true && clx !== true)
      return classified("positive", "Metallo-β-lactamase (MBL, presumptive)", "MBLs do not hydrolyse aztreonam (section 2.1).");
    if (apba === true && clx === true && mbl !== true)
      return classified("negative", "AmpC (chromosomal or plasmid-mediated) plus porin loss - not a carbapenemase (presumptive)");
    if (apba === true && clx === false && mbl !== true)
      return classified("positive", "KPC or other class A carbapenemase (presumptive)", "Boronic acid inhibits class A carbapenemases, although data beyond KPC are scarce (section 2.4.2).");
    if (apba === true && clx === null)
      return classified("indeterminate", "KPC or AmpC + porin loss", "Synergy with boronic acid only: test meropenem + cloxacillin to separate KPC (no cloxacillin synergy) from AmpC with porin loss (Table 2).");
    if (mbl === false && apba === false && clx !== true) {
      notes.push("No synergy with any inhibitor (Figure 1). A combination of several carbapenemases (e.g. MBL and KPC) can also give no synergy: molecular testing is usually necessary (Figure 1 footnote 1).");
      if (temHigh === true)
        return classified("positive", "OXA-48-like carbapenemase (presumptive)",
          "High-level temocillin resistance is not specific for OXA-48-like enzymes: their presence has to be confirmed with other methods (section 2.4.2).");
      if (temHigh === false) return classified("negative", "ESBL + porin loss - no carbapenemase detected (presumptive)");
      return classified("indeterminate", "No synergy: OXA-48-like or ESBL + porin loss", "Test temocillin 30 µg: zone < 11 mm suggests OXA-48-like, otherwise ESBL + porin loss (Figure 1, Table 2).");
    }
    const missing = [mbl === null && "meropenem + EDTA or dipicolinic acid", apba === null && "meropenem + boronic acid"].filter(Boolean);
    return classified("indeterminate", "Carbapenemase phenotype not classifiable",
      missing.length ? `Test also ${missing.join(" and ")} (Table 2).` : "The synergy pattern is not in Table 2: use molecular methods.");
  }

  if (screen === "positive") {
    if (!inhib.length) notes.push("Investigate carbapenemase production: combination disks (meropenem ± dipicolinic acid/EDTA, boronic acid, cloxacillin; temocillin), " +
      "colorimetric, CIM, MALDI-TOF, lateral flow or molecular tests (section 2.4).");
    if (temHigh) notes.push("High-level temocillin resistance (< 11 mm) is a phenotypic marker of OXA-48 (Figure 1 footnote 2).");
    return { ...base, status: inhib.length ? "indeterminate" : "screen-positive", stage: inhib.length ? "confirmation" : "screening", evidence, notes: [...notes, PRESUMPTIVE],
      result: inhib.length ? "Carbapenemase screening positive, classification pending" : "Carbapenemase screening positive" };
  }
  if (screen === "borderline") return { ...base, status: "indeterminate", stage: "screening", evidence, notes, result: "Carbapenemase screening borderline (meropenem 25-27 mm)" };
  if (inhib.length) return { ...base, status: "indeterminate", stage: "confirmation", evidence, notes, result: "Carbapenemase classification pending" };
  return { ...base, status: "negative", stage: "screening", evidence, notes, result: "Carbapenemase screening negative" };
}

function carbapenemase(r: Results, tests: Record<string, string>, pairs: Pair[]): Phenotype | null {
  const p = classifyCarbapenemase(r, tests, pairs);
  // Recorded positive of unknown type: the disks may give the type but do not make the result negative or pending
  if (p && tests.carbapenemase === "positive" && p.status !== "positive")
    return { ...p, status: "positive", stage: "recorded", result: "Carbapenemase (type not known) (recorded test)",
      notes: [`The recorded test takes precedence over the combination disks (${p.result}): check that they agree.`, ...p.notes] };
  return p;
}

// ---- MRSA (GUIDE chapter 7)

function mrsa(r: Results, o: Organism, tests: Record<string, string>): Phenotype | null {
  if (!sAureus(o)) return null;
  const fox = r.first("Cefoxitin", "30");
  const mec = tests.mec;
  if (!fox && !mec) return null;
  const evidence: string[] = [], notes: string[] = [];
  const base = { mechanism: "MRSA" as const, source: `${GUIDE}, chapter 7` };
  const low = fox ? mm(fox.diameter_mm) < CEFOXITIN_MRSA : null;
  if (fox) evidence.push(`${zone(fox)} ${low ? "<" : "≥"} ${CEFOXITIN_MRSA} mm cefoxitin screen (section 7.4.1 B)`);
  if (mec) evidence.push(`mecA/mecC or PBP2a recorded under Supplementary tests: ${mec}`);
  if (mec === "positive") return { ...base, status: "positive", stage: "recorded", evidence, notes: ["If the mecA gene is detected the isolate should always be reported resistant (section 7.3)."],
    result: "Methicillin-resistant S. aureus (mecA/mecC or PBP2a)" };
  if (low) {
    if (mec === "negative") notes.push("PBP2c (mecC) is not detected by the majority of commercial assays (section 7.4.2); borderline resistance without mec genes (BORSA) is rare (section 7.3).");
    return { ...base, status: "positive", stage: "screening", evidence, notes: [...notes, "Report resistant to beta-lactams except ceftaroline and ceftobiprole (section 7.1)."],
      result: "Methicillin-resistant S. aureus (MRSA)" };
  }
  notes.push("mecA-positive isolates susceptible to cefoxitin and oxacillin (OS-MRSA) are only detected by molecular methods (section 7.3).");
  return { ...base, status: "negative", stage: mec ? "recorded" : "screening", evidence, notes,
    result: fox ? "Methicillin susceptible (cefoxitin screen negative)" : "Methicillin susceptible (mecA/mecC not detected)" };
}

// ------------------------------------------------------------------ evaluation

export function detectPhenotypes(a: Pick<Antibiogram, "family" | "genus" | "species" | "plates"> & { supplementary_tests?: Record<string, string> }): PhenotypeReport {
  const o = organismOf(a);
  const tests = a.supplementary_tests ?? {};
  const r = new Results(a.plates.flatMap((p) => p.measurements));
  const { pairs, unpaired } = combinationPairs(a);
  const phenotypes: Phenotype[] = [];
  if (enterobacterales(o)) {
    const cpe = carbapenemase(r, tests, pairs);
    const e = esbl(r, o, tests, pairs, cpe ?? undefined);
    const c = ampc(r, o, tests);
    for (const p of [e, c, cpe]) if (p) phenotypes.push(p);
  }
  const m = mrsa(r, o, tests);
  if (m) phenotypes.push(m);
  return { phenotypes, pairs, unpaired, organism: [o.genus, o.species].filter(Boolean).join(" ") || a.family.name };
}

export const STATUS_LABEL: Record<PhenotypeStatus, string> = {
  positive: "Detected", negative: "Not detected", "screen-positive": "Screening positive", indeterminate: "Indeterminate",
};
export const STAGE_LABEL: Record<Phenotype["stage"], string> = {
  screening: "Screening", confirmation: "Phenotypic confirmation", recorded: "Recorded test",
};
