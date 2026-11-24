// Expert system: EUCAST expected phenotypes, expert rules and resistance-mechanism screening applied to the
// disk-diffusion results of one isolate (an antibiogram, i.e. all the measurements of all its plates).
//
// Sources (rule ids below refer to them):
//  * ERP  EUCAST Expected Resistant Phenotypes v1.2 (January 2023)
//  * ESP  EUCAST Expected Susceptible Phenotypes v1.1 (March 2022)
//  * ER   EUCAST Expert Rules: Enterobacterales v3.3 (June 2024); Staphylococcus, Enterococcus, Streptococcus,
//         S. pneumoniae (November 2025); Haemophilus, Moraxella, Salmonella, Campylobacter, Corynebacterium
//         v3.2 (June 2019)
//  * SCR  EUCAST phenotypic screening tests to detect / exclude resistance (2022)
//  * ATU  Areas of Technical Uncertainty copied from the breakpoint notes of the standard in use
//
// Only rules that can be evaluated from disk-diffusion categories/diameters are implemented; rules that need
// MICs or molecular tests are reported as a warning that asks for them. Rules never change the stored
// measurements: they produce messages and a suggested "reported" category per measurement.
// Screening and phenotypic confirmation of resistance mechanisms (ESBL, AmpC, carbapenemases, MRSA) are in
// phenotypes.ts.

import type { Antibiogram, Measurement, Standard } from "./api";

export type Cat = "S" | "I" | "R";
export type RuleKind = "unexpected-susceptible" | "unexpected-resistant" | "inference" | "warning" | "mechanism" | "atu";

export interface FiredRule {
  id: string;            // e.g. "ER Staphylococcus 1"
  kind: RuleKind;
  source: string;        // document and rule number
  url: string;
  grade?: string;        // EUCAST evidence grade (A, B, C)
  message: string;
  /** Tested agents this rule is about (display names). */
  agents: string[];
}

export interface Reported {
  category: Cat | null;  // null: keep the measured category
  rules: string[];       // ids of the rules that changed it
}

export interface Evaluation {
  rules: FiredRule[];
  reported: Map<number, Reported>; // by measurement id
  organism: string;                // as understood by the rules
  speciesKnown: boolean;           // genus and species given: species-specific rules could be applied
}

const URL_ER = "https://www.eucast.org/bacteria/important-additional-information/expert-rules/";
const URL_EXP = "https://www.eucast.org/bacteria/important-additional-information/expected-phenotypes/";
const ERP = "EUCAST Expected Resistant Phenotypes v1.2 (2023)";
const ESP = "EUCAST Expected Susceptible Phenotypes v1.1 (2022)";

export const EXPERT_SYSTEM_SOURCES =
  "EUCAST Expert Rules (Enterobacterales v3.3 2024; Staphylococcus, Enterococcus, Streptococcus, S. pneumoniae 2025; " +
  "other groups v3.2 2019), Expected Resistant Phenotypes v1.2, Expected Susceptible Phenotypes v1.1";

// ------------------------------------------------------------------ organisms

export interface Organism { family: string; genus: string; species: string }

export function organismOf(a: Pick<Antibiogram, "family" | "genus" | "species">): Organism {
  let genus = a.genus.trim().toLowerCase().replace(/\s+/g, " ");
  let species = a.species.trim().toLowerCase().replace(/\s+/g, " ");
  if (!genus && species.includes(" ")) [genus, species] = [species.split(" ")[0], species.split(" ").slice(1).join(" ")];
  // "Escherichia coli" or "E. coli" typed in the species field
  const words = species.split(" ");
  if (words.length > 1 && genus && (words[0] === genus || words[0] === `${genus[0]}.`)) species = words.slice(1).join(" ");
  if (/^spp?\.?$/.test(species)) species = "";
  return { family: a.family.name.toLowerCase(), genus, species };
}

/** "genus" or "genus species" (species may be followed by more words, e.g. "pneumoniae complex"). */
export const is = (o: Organism, ...names: string[]) => names.some((n) => {
  const [g, s] = n.split(" ");
  return o.genus === g && (!s || o.species === s || o.species.startsWith(`${s} `));
});
const fam = (o: Organism, prefix: string) => o.family.startsWith(prefix);

const ENTEROBACTERALES = ["escherichia", "klebsiella", "enterobacter", "citrobacter", "proteus", "morganella",
  "providencia", "serratia", "salmonella", "shigella", "hafnia", "raoultella", "yersinia", "cronobacter", "pantoea",
  "leclercia", "plesiomonas", "edwardsiella", "kluyvera"];
export const enterobacterales = (o: Organism) => fam(o, "enterobacteriaceae") || ENTEROBACTERALES.includes(o.genus);
const staphylococci = (o: Organism) => fam(o, "staphylococcus") || o.genus === "staphylococcus";
export const sAureus = (o: Organism) => is(o, "staphylococcus aureus");
const cons = (o: Organism) => staphylococci(o) && !sAureus(o) && o.species !== ""
  && !is(o, "staphylococcus pseudintermedius", "staphylococcus intermedius", "staphylococcus schleiferi", "staphylococcus coagulans");
const enterococci = (o: Organism) => fam(o, "enterococcus") || o.genus === "enterococcus";
const pneumococcus = (o: Organism) => fam(o, "streptococcus pneumoniae") || is(o, "streptococcus pneumoniae");
const betaHaemolytic = (o: Organism) => fam(o, "streptococcus groups")
  || is(o, "streptococcus pyogenes", "streptococcus agalactiae", "streptococcus dysgalactiae");
const viridans = (o: Organism) => fam(o, "viridans group streptococci");
const streptococci = (o: Organism) => betaHaemolytic(o) || pneumococcus(o) || viridans(o) || o.genus === "streptococcus";
const haemophilus = (o: Organism) => fam(o, "haemophilus influenzae") || is(o, "haemophilus influenzae");
const moraxella = (o: Organism) => fam(o, "moraxella catarrhalis") || is(o, "moraxella catarrhalis");
const campylobacter = (o: Organism) => fam(o, "campylobacter") || o.genus === "campylobacter";
const corynebacteria = (o: Organism) => (fam(o, "corynebacterium spp.") || o.genus === "corynebacterium")
  && !is(o, "corynebacterium diphtheriae", "corynebacterium ulcerans");
const salmonella = (o: Organism) => o.genus === "salmonella";
const nonFermenters = (o: Organism) => fam(o, "pseudomonas") || fam(o, "stenotrophomonas") || fam(o, "acinetobacter")
  || fam(o, "achromobacter") || ["pseudomonas", "stenotrophomonas", "acinetobacter", "achromobacter", "burkholderia",
    "elizabethkingia", "ochrobactrum", "chryseobacterium"].includes(o.genus);
const anaerobes = (o: Organism) => fam(o, "gram-positive anaerobes") || fam(o, "gram-negative anaerobes") || fam(o, "clostridium difficile");
const grampositive = (o: Organism) => staphylococci(o) || streptococci(o) || enterococci(o) || corynebacteria(o)
  || fam(o, "listeria") || fam(o, "aerococcus") || fam(o, "bacillus") || fam(o, "corynebacterium")
  || ["listeria", "leuconostoc", "pediococcus", "lactobacillus", "lacticaseibacillus", "aerococcus", "bacillus"].includes(o.genus);

// -------------------------------------------------------- supplementary tests

export interface SupplementaryTest {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  applies: (o: Organism) => boolean;
}

const POS_NEG = [{ value: "positive", label: "Positive" }, { value: "negative", label: "Negative" }];

/** Results that cannot be read from the disks but change the rules; stored per antibiogram. */
export const SUPPLEMENTARY_TESTS: SupplementaryTest[] = [
  { key: "inducible_clindamycin", label: "Inducible clindamycin resistance (D-test)", options: POS_NEG,
    applies: (o) => staphylococci(o) || streptococci(o) || corynebacteria(o) },
  { key: "mec", label: "mecA/mecC gene or PBP2a", options: POS_NEG, applies: staphylococci },
  { key: "van", label: "Glycopeptide resistance gene", applies: enterococci,
    options: [{ value: "vanA", label: "vanA detected" }, { value: "vanB", label: "vanB detected" }, { value: "negative", label: "Not detected" }] },
  { key: "esbl", label: "ESBL confirmation (gradient, broth or molecular test)", options: POS_NEG, applies: enterobacterales },
  { key: "esbl_ddst", label: "ESBL double-disk synergy test (DDST)", applies: enterobacterales,
    options: [...POS_NEG, { value: "indeterminate", label: "Indeterminate (no clear synergy)" }] },
  { key: "ampc_confirmation", label: "AmpC confirmation (cloxacillin or boronic acid synergy)", options: POS_NEG, applies: enterobacterales },
  // EUCAST resistance-mechanism guidelines v2.01, section 2.4.2 Table 2: "The exact definitions of synergy are
  // provided in package inserts" - the cut-off is the laboratory's, not a default of this application.
  { key: "carbapenemase_synergy_mm", label: "Synergy cut-off of the meropenem inhibitor disks (package insert)",
    applies: enterobacterales,
    options: [2, 3, 4, 5, 6, 7, 8, 9, 10].map((mm) => ({ value: String(mm), label: `Zone increase ≥ ${mm} mm` })) },
  { key: "carbapenemase", label: "Carbapenemase test (colorimetric, immunochromatographic or molecular)", applies: (o) => enterobacterales(o) || nonFermenters(o),
    options: [{ value: "KPC", label: "KPC / class A" }, { value: "MBL", label: "Metallo-beta-lactamase" },
      { value: "OXA-48", label: "OXA-48-like" }, { value: "positive", label: "Positive (type not known)" },
      { value: "negative", label: "Negative" }] },
  { key: "beta_lactamase", label: "Beta-lactamase (chromogenic cephalosporin)", options: POS_NEG, applies: haemophilus },
];

export function supplementaryTestsFor(a: Pick<Antibiogram, "family" | "genus" | "species">): SupplementaryTest[] {
  const o = organismOf(a);
  return SUPPLEMENTARY_TESTS.filter((t) => t.applies(o));
}

/** Genus and species the rules know about, for the organism fields. */
export const KNOWN_ORGANISMS: string[] = [
  "Escherichia coli", "Escherichia hermannii", "Klebsiella pneumoniae", "Klebsiella oxytoca", "Klebsiella aerogenes",
  "Klebsiella variicola", "Enterobacter cloacae", "Enterobacter hormaechei", "Citrobacter freundii", "Citrobacter koseri",
  "Citrobacter amalonaticus", "Hafnia alvei", "Morganella morganii", "Proteus mirabilis", "Proteus vulgaris",
  "Proteus penneri", "Providencia rettgeri", "Providencia stuartii", "Serratia marcescens", "Raoultella planticola",
  "Raoultella ornithinolytica", "Salmonella enterica", "Salmonella Typhi", "Shigella sonnei", "Shigella flexneri",
  "Yersinia enterocolitica", "Yersinia pseudotuberculosis", "Leclercia adecarboxylata", "Plesiomonas shigelloides",
  "Aeromonas hydrophila", "Aeromonas caviae", "Aeromonas veronii", "Aeromonas dhakensis", "Aeromonas jandaei",
  "Pseudomonas aeruginosa", "Acinetobacter baumannii", "Acinetobacter pittii", "Acinetobacter nosocomialis",
  "Stenotrophomonas maltophilia", "Achromobacter xylosoxidans", "Burkholderia cepacia", "Elizabethkingia meningoseptica",
  "Elizabethkingia anophelis", "Ochrobactrum anthropi", "Chryseobacterium indologenes",
  "Staphylococcus aureus", "Staphylococcus epidermidis", "Staphylococcus lugdunensis", "Staphylococcus saprophyticus",
  "Staphylococcus capitis", "Staphylococcus cohnii", "Staphylococcus xylosus", "Staphylococcus haemolyticus",
  "Staphylococcus pseudintermedius", "Enterococcus faecalis", "Enterococcus faecium", "Enterococcus gallinarum",
  "Enterococcus casseliflavus", "Enterococcus avium", "Streptococcus pyogenes", "Streptococcus agalactiae",
  "Streptococcus dysgalactiae", "Streptococcus pneumoniae", "Streptococcus mitis", "Streptococcus oralis",
  "Haemophilus influenzae", "Moraxella catarrhalis", "Neisseria meningitidis", "Neisseria gonorrhoeae",
  "Campylobacter jejuni", "Campylobacter coli", "Campylobacter fetus", "Corynebacterium striatum",
  "Corynebacterium diphtheriae", "Listeria monocytogenes", "Bacteroides fragilis", "Clostridioides difficile",
  "Clostridium ramosum", "Clostridium innocuum", "Leuconostoc mesenteroides", "Pediococcus pentosaceus",
  "Lactobacillus rhamnosus",
];

/** Genus suggestions, and species suggestions for a genus (KNOWN_ORGANISMS plus names already used). */
export function genusSuggestions(used: string[] = []): string[] {
  return [...new Set([...used, ...KNOWN_ORGANISMS.map((n) => n.split(" ")[0])])].sort();
}
export function speciesSuggestions(genus: string, used: string[] = []): string[] {
  const g = genus.trim().toLowerCase();
  const known = KNOWN_ORGANISMS.filter((n) => !g || n.split(" ")[0].toLowerCase() === g).map((n) => n.split(" ").slice(1).join(" "));
  return [...new Set([...used, ...known])].sort();
}

// -------------------------------------------------------------------- agents

/** Antibiotic name without route ("Cefuroxime iv" -> "cefuroxime"). */
export function agentKey(name: string): string {
  return name.toLowerCase().replace(/\s*\(.*\)\s*$/, "").replace(/\s+(iv|oral)$/, "").trim();
}

const CATEGORY: Record<string, Cat> = { Susceptible: "S", Intermediate: "I", Resistant: "R" };
const RANK: Record<Cat, number> = { S: 0, I: 1, R: 2 };
const NAME: Record<Cat, string> = { S: "susceptible", I: "susceptible, increased exposure (I)", R: "resistant" };

type Sel = (key: string, drugClass: string) => boolean;
const keys = (...ks: string[]): Sel => (k) => ks.includes(k);
const drugClass = (prefix: string, ...except: string[]): Sel => (k, c) => c.toLowerCase().startsWith(prefix) && !except.includes(k);
const any = (...sels: Sel[]): Sel => (k, c) => sels.some((s) => s(k, c));

const PENICILLINS = ["benzylpenicillin", "ampicillin", "amoxicillin", "piperacillin", "ticarcillin", "mecillinam", "temocillin"];
const FLUOROQUINOLONES = ["ciprofloxacin", "levofloxacin", "moxifloxacin", "ofloxacin", "norfloxacin", "pefloxacin", "delafloxacin"];
const CEPH_1_2 = ["cefazolin", "cefalexin", "cefadroxil", "cephalothin", "cefuroxime", "cefaclor", "cefoxitin"];
const CEPH_3_4 = ["cefotaxime", "ceftriaxone", "ceftazidime", "cefepime"];
const CEPH_3_ORAL = ["cefixime", "cefpodoxime", "ceftibuten"];
const CARBAPENEMS = ["doripenem", "ertapenem", "imipenem", "meropenem"];
const MACROLIDES = ["erythromycin", "azithromycin", "clarithromycin", "roxithromycin", "telithromycin"];
const GLYCOPEPTIDES = ["vancomycin", "teicoplanin", "dalbavancin", "oritavancin", "telavancin"];
const OXAZOLIDINONES = ["linezolid", "tedizolid"];
const TETRACYCLINES = ["tetracycline", "doxycycline", "minocycline"];
const POLYMYXINS = ["colistin", "polymyxin b"];
const BETA_LACTAM_CLASSES = ["penicillins", "cephalosporins", "carbapenems", "monobactams"];

const isBetaLactam: Sel = (_, c) => BETA_LACTAM_CLASSES.some((p) => c.toLowerCase().startsWith(p));
const aminoglycosides = drugClass("aminoglycosides");
const cephalosporins = drugClass("cephalosporins");

// ------------------------------------------------------------------- isolate

interface Result { m: Measurement; key: string; cat: Cat | null }

class Isolate {
  readonly results: Result[];
  constructor(measurements: Measurement[]) {
    this.results = measurements.map((m) => ({ m, key: agentKey(m.antibiotic.name), cat: CATEGORY[m.category] ?? null }));
  }
  of(key: string): Result[] { return this.results.filter((r) => r.key === key); }
  tested(key: string): boolean { return this.of(key).length > 0; }
  /** Most resistant category over all the measurements of the agent (null when none can be categorised). */
  cat(key: string): Cat | null {
    return this.of(key).reduce<Cat | null>((acc, r) => (r.cat && (!acc || RANK[r.cat] > RANK[acc]) ? r.cat : acc), null);
  }
  R(...ks: string[]) { return ks.some((k) => this.cat(k) === "R"); }
  S(...ks: string[]) { return ks.some((k) => this.cat(k) === "S"); }
  /** S or I (not resistant). */
  notR(...ks: string[]) { return ks.some((k) => this.cat(k) === "S" || this.cat(k) === "I"); }
  /** Smallest zone diameter of the agent, if tested. */
  diameter(key: string): number | null {
    const ds = this.of(key).map((r) => r.m.diameter_mm);
    return ds.length ? Math.min(...ds) : null;
  }
  select(sel: Sel): Result[] { return this.results.filter((r) => sel(r.key, r.m.antibiotic.drug_class)); }
  label(key: string): string { return this.of(key)[0]?.m.antibiotic.name ?? key; }
}

// --------------------------------------------------------------------- rules

interface Override { key: string; category: Cat; force: boolean; rule: string }

class Context {
  readonly rules: FiredRule[] = [];
  readonly overrides: Override[] = [];
  readonly iso: Isolate;
  readonly o: Organism;
  readonly tests: Record<string, string>;
  constructor(iso: Isolate, o: Organism, tests: Record<string, string>) { this.iso = iso; this.o = o; this.tests = tests; }

  fire(r: Omit<FiredRule, "agents"> & { agents?: string[] }) {
    if (!this.rules.some((x) => x.id === r.id)) this.rules.push({ ...r, agents: r.agents ?? [] });
  }
  /**
   * Suggest a reported category. With force the result of the test is ignored ("regardless of the test
   * result"); otherwise it only fills agents whose measurement could not be categorised.
   */
  report(rule: string, keys: string[], category: Cat, force: boolean) {
    for (const key of keys) this.overrides.push({ key, category, force, rule });
  }
  /** Tested agents (display names) among keys, and untested ones (lowercase keys). */
  split(keys: string[]): { tested: string[]; untested: string[] } {
    return {
      tested: keys.filter((k) => this.iso.tested(k)).map((k) => this.iso.label(k)),
      untested: keys.filter((k) => !this.iso.tested(k)),
    };
  }
}

const list = (xs: string[]) => xs.join(", ");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "report X resistant" with the tested/untested agents named. */
function inferred(ctx: Context, id: string, source: string, grade: string, why: string, keys: string[], category: Cat,
  force: boolean, url = URL_ER) {
  const { tested, untested } = ctx.split(keys);
  const parts = [];
  if (tested.length) parts.push(`report ${list(tested)} ${NAME[category]}${force ? " regardless of the test result" : ""}`);
  if (untested.length) parts.push(`${tested.length ? "and " : "report "}${list(untested)} (not tested) ${NAME[category]}`);
  ctx.fire({ id, kind: "inference", source, url, grade, message: `${why}: ${parts.join(" ")}.`, agents: tested });
  ctx.report(id, keys, category, force);
}

// ---- Expected resistant phenotypes (ERP v1.2): a susceptible result is unexpected

interface Expected { rule: string; label: string; org: (o: Organism) => boolean; agents: Sel }

const T1 = { // Enterobacterales and Aeromonas, Table 1 columns
  amp: keys("ampicillin", "amoxicillin"), amc: keys("amoxicillin-clavulanic acid"), sam: keys("ampicillin-sulbactam"),
  tic: keys("ticarcillin"), c1: keys("cefazolin", "cephalothin", "cefalexin", "cefadroxil"), fox: keys("cefoxitin"),
  cxm: keys("cefuroxime"), tet: keys(...TETRACYCLINES), col: keys(...POLYMYXINS), fos: keys("fosfomycin"),
  nit: keys("nitrofurantoin"),
};
const T2 = { // non-fermenters, Table 2 columns
  amp: keys("ampicillin", "amoxicillin"), amc: keys("amoxicillin-clavulanic acid"), sam: keys("ampicillin-sulbactam"),
  tic: keys("ticarcillin"), tim: keys("ticarcillin-clavulanic acid"), prl: keys("piperacillin"),
  tzp: keys("piperacillin-tazobactam"), ctx: keys("cefotaxime", "ceftriaxone"), caz: keys("ceftazidime"),
  fep: keys("cefepime"), atm: keys("aztreonam"), etp: keys("ertapenem"), ipm: keys("imipenem"), mem: keys("meropenem"),
  cip: keys("ciprofloxacin"), chl: keys("chloramphenicol"), ami: aminoglycosides, tmp: keys("trimethoprim"),
  fos: keys("fosfomycin"), tet: keys(...TETRACYCLINES), tgc: keys("tigecycline"), col: keys(...POLYMYXINS),
};
const T4 = { // gram-positive bacteria, Table 4 columns (aminoglycoside low-level resistance is left out: the
  // enterococcal/streptococcal aminoglycoside disks test high-level resistance)
  fd: keys("fusidic acid"), caz: keys("ceftazidime"), ceph: drugClass("cephalosporins", "ceftazidime"),
  mac: keys(...MACROLIDES), cli: keys("clindamycin"), qd: keys("quinupristin-dalfopristin"), van: keys("vancomycin"),
  tec: keys("teicoplanin"), fos: keys("fosfomycin"), nov: keys("novobiocin"), sul: keys("sulfonamides"),
};

const sp = (...names: string[]) => (o: Organism) => is(o, ...names);

const EXPECTED_RESISTANT: Expected[] = [
  // Table 1: Enterobacterales and Aeromonas spp.
  { rule: "1.1", label: "Citrobacter koseri / C. amalonaticus group", agents: any(T1.amp, T1.tic),
    org: sp("citrobacter koseri", "citrobacter amalonaticus", "citrobacter sedlakii", "citrobacter farmeri", "citrobacter rodentium") },
  { rule: "1.2", label: "Citrobacter freundii group", agents: any(T1.amp, T1.amc, T1.sam, T1.c1, T1.fox),
    org: sp("citrobacter freundii", "citrobacter braakii", "citrobacter murliniae", "citrobacter werkmanii", "citrobacter youngae") },
  { rule: "1.3", label: "Enterobacter cloacae complex", agents: any(T1.amp, T1.amc, T1.sam, T1.c1, T1.fox),
    org: sp("enterobacter cloacae", "enterobacter hormaechei", "enterobacter asburiae", "enterobacter kobei", "enterobacter ludwigii") },
  { rule: "1.4", label: "Escherichia hermannii", agents: any(T1.amp, T1.tic), org: sp("escherichia hermannii") },
  { rule: "1.5", label: "Hafnia alvei", agents: any(T1.amp, T1.amc, T1.col), org: sp("hafnia alvei") },
  { rule: "1.6", label: "Klebsiella aerogenes", agents: any(T1.amp, T1.amc, T1.sam, T1.c1, T1.fox),
    org: (o) => is(o, "klebsiella aerogenes", "enterobacter aerogenes") },
  { rule: "1.7", label: "Klebsiella pneumoniae complex", agents: any(T1.amp, T1.tic),
    org: sp("klebsiella pneumoniae", "klebsiella quasipneumoniae", "klebsiella variicola") },
  { rule: "1.8", label: "Klebsiella oxytoca", agents: any(T1.amp, T1.tic), org: sp("klebsiella oxytoca") },
  { rule: "1.9", label: "Leclercia adecarboxylata", agents: T1.fos, org: sp("leclercia adecarboxylata") },
  { rule: "1.10", label: "Morganella morganii", agents: any(T1.amp, T1.amc, T1.sam, T1.c1, T1.tet, T1.col, T1.nit),
    org: sp("morganella morganii") },
  { rule: "1.11", label: "Plesiomonas shigelloides", agents: any(T1.amp, T1.amc, T1.sam), org: sp("plesiomonas shigelloides") },
  { rule: "1.12", label: "Proteus mirabilis", agents: any(T1.tet, T1.col, T1.nit), org: sp("proteus mirabilis") },
  { rule: "1.13", label: "Proteus penneri", agents: any(T1.amp, T1.c1, T1.cxm, T1.tet, T1.col, T1.nit), org: sp("proteus penneri") },
  { rule: "1.14", label: "Proteus vulgaris", agents: any(T1.amp, T1.c1, T1.cxm, T1.tet, T1.col, T1.nit), org: sp("proteus vulgaris") },
  { rule: "1.15", label: "Providencia rettgeri", agents: any(T1.amp, T1.amc, T1.sam, T1.c1, T1.tet, T1.col, T1.nit),
    org: sp("providencia rettgeri") },
  { rule: "1.16", label: "Providencia stuartii", agents: any(T1.amp, T1.amc, T1.sam, T1.c1, T1.tet, T1.col, T1.nit),
    org: sp("providencia stuartii") },
  { rule: "1.17", label: "Raoultella spp.", agents: any(T1.amp, T1.tic), org: sp("raoultella") },
  { rule: "1.18", label: "Serratia marcescens", agents: any(T1.amp, T1.amc, T1.sam, T1.c1, T1.fox, T1.cxm, T1.col, T1.nit),
    org: sp("serratia marcescens") },
  { rule: "1.19", label: "Yersinia enterocolitica", agents: any(T1.amp, T1.amc, T1.sam, T1.tic, T1.c1, T1.fox),
    org: sp("yersinia enterocolitica") },
  { rule: "1.20", label: "Yersinia pseudotuberculosis", agents: T1.col, org: sp("yersinia pseudotuberculosis") },
  { rule: "1.21", label: "Aeromonas hydrophila", agents: any(T1.amp, T1.sam), org: sp("aeromonas hydrophila") },
  { rule: "1.22", label: "Aeromonas veronii", agents: any(T1.amp, T1.sam, T1.tic), org: sp("aeromonas veronii") },
  { rule: "1.23", label: "Aeromonas dhakensis", agents: any(T1.amp, T1.sam, T1.fox), org: sp("aeromonas dhakensis") },
  { rule: "1.24", label: "Aeromonas caviae", agents: any(T1.amp, T1.sam), org: sp("aeromonas caviae") },
  { rule: "1.25", label: "Aeromonas jandaei", agents: any(T1.amp, T1.sam, T1.tic), org: sp("aeromonas jandaei") },
  { rule: "Table 1", label: "Enterobacterales and Aeromonas spp.",
    org: (o) => enterobacterales(o) || fam(o, "aeromonas") || o.genus === "aeromonas",
    agents: any(keys("benzylpenicillin", "fusidic acid", "rifampicin", "clindamycin", "quinupristin-dalfopristin",
      "telithromycin", "clarithromycin", "roxithromycin", ...GLYCOPEPTIDES, ...OXAZOLIDINONES)) },

  // Table 2: non-fermentative gram-negative bacteria
  { rule: "2.1", label: "Acinetobacter baumannii group",
    agents: any(T2.amp, T2.amc, T2.ctx, T2.atm, T2.etp, T2.tmp, T2.fos, keys("tetracycline", "doxycycline")),
    org: (o) => is(o, "acinetobacter baumannii", "acinetobacter pittii", "acinetobacter nosocomialis") },
  { rule: "2.2", label: "Achromobacter xylosoxidans", agents: any(T2.amp, T2.ctx, T2.atm, T2.etp),
    org: (o) => fam(o, "achromobacter") || is(o, "achromobacter xylosoxidans") },
  { rule: "2.3", label: "Burkholderia cepacia complex", org: sp("burkholderia cepacia", "burkholderia cenocepacia", "burkholderia multivorans"),
    agents: any(T2.amp, T2.amc, T2.sam, T2.tic, T2.tim, T2.prl, T2.tzp, T2.ctx, T2.atm, T2.etp, T2.cip, T2.chl, T2.ami, T2.tmp, T2.fos, T2.col) },
  { rule: "2.4", label: "Elizabethkingia meningoseptica", org: sp("elizabethkingia meningoseptica"),
    agents: any(T2.amp, T2.amc, T2.sam, T2.tic, T2.tim, T2.ctx, T2.caz, T2.fep, T2.atm, T2.etp, T2.ipm, T2.mem, T2.col) },
  { rule: "2.5", label: "Elizabethkingia anophelis", org: sp("elizabethkingia anophelis"),
    agents: any(T2.amp, T2.amc, T2.sam, T2.tic, T2.tim, T2.ctx, T2.caz, T2.fep, T2.atm, T2.etp, T2.ipm, T2.mem) },
  { rule: "2.6", label: "Ochrobactrum anthropi", org: sp("ochrobactrum anthropi"),
    agents: any(T2.amp, T2.amc, T2.sam, T2.tic, T2.tim, T2.prl, T2.tzp, T2.ctx, T2.caz, T2.fep, T2.atm, T2.etp) },
  { rule: "2.7", label: "Pseudomonas aeruginosa", org: sp("pseudomonas aeruginosa"),
    agents: any(T2.amp, T2.amc, T2.sam, T2.ctx, T2.etp, T2.chl, T2.tmp, T2.tet, T2.tgc, keys("kanamycin", "neomycin")) },
  { rule: "2.8", label: "Stenotrophomonas maltophilia",
    org: (o) => fam(o, "stenotrophomonas") || is(o, "stenotrophomonas maltophilia"),
    agents: any(T2.amp, T2.amc, T2.sam, T2.tic, T2.prl, T2.tzp, T2.ctx, T2.atm, T2.etp, T2.ipm, T2.mem, T2.ami, T2.tmp,
      T2.fos, keys("tetracycline")) },
  { rule: "2.9", label: "Chryseobacterium spp.", org: sp("chryseobacterium"),
    agents: any(T2.amp, T2.amc, T2.sam, T2.tic, T2.tim, T2.ctx, T2.caz, T2.atm, T2.etp, T2.ipm, T2.mem, T2.ami, T2.col) },
  { rule: "Table 2", label: "non-fermentative gram-negative bacteria", org: nonFermenters,
    agents: any(keys("benzylpenicillin", "fusidic acid", "rifampicin", "clindamycin", "quinupristin-dalfopristin",
      ...CEPH_1_2, ...MACROLIDES, ...GLYCOPEPTIDES, ...OXAZOLIDINONES)) },

  // Table 3: other gram-negative bacteria
  { rule: "3.1", label: "Haemophilus influenzae", agents: keys("fusidic acid", "quinupristin-dalfopristin"), org: haemophilus },
  { rule: "3.2", label: "Moraxella catarrhalis", agents: keys("trimethoprim"), org: moraxella },
  { rule: "3.3", label: "Neisseria spp.", agents: keys("trimethoprim"), org: (o) => fam(o, "neisseria") || o.genus === "neisseria" },
  { rule: "3.4", label: "Campylobacter fetus", org: sp("campylobacter fetus"),
    agents: keys("fusidic acid", "quinupristin-dalfopristin", "trimethoprim", "nalidixic acid") },
  { rule: "3.5", label: "Campylobacter jejuni / C. coli", agents: keys("fusidic acid", "quinupristin-dalfopristin", "trimethoprim"),
    org: (o) => fam(o, "campylobacter") || is(o, "campylobacter jejuni", "campylobacter coli") },
  { rule: "Table 3", label: "Haemophilus, Moraxella, Neisseria and Campylobacter",
    org: (o) => haemophilus(o) || moraxella(o) || campylobacter(o) || fam(o, "neisseria") || o.genus === "neisseria",
    agents: keys("clindamycin", ...GLYCOPEPTIDES, ...OXAZOLIDINONES) },

  // Table 4: gram-positive bacteria
  { rule: "4.1", label: "Staphylococcus saprophyticus", agents: any(T4.fd, T4.caz, T4.fos, T4.nov), org: sp("staphylococcus saprophyticus") },
  { rule: "4.2", label: "Staphylococcus cohnii", agents: any(T4.caz, T4.nov), org: sp("staphylococcus cohnii") },
  { rule: "4.3", label: "Staphylococcus xylosus", agents: any(T4.caz, T4.nov), org: sp("staphylococcus xylosus") },
  { rule: "4.4", label: "Staphylococcus capitis", agents: any(T4.caz, T4.fos), org: sp("staphylococcus capitis") },
  { rule: "4.5", label: "staphylococci", agents: T4.caz, org: staphylococci },
  { rule: "4.6", label: "Streptococcus spp.", agents: any(T4.fd, T4.caz), org: streptococci },
  { rule: "4.7", label: "Enterococcus faecalis", agents: any(T4.fd, T4.caz, T4.ceph, T4.mac, T4.cli, T4.qd, T4.sul),
    org: sp("enterococcus faecalis") },
  { rule: "4.8", label: "Enterococcus gallinarum / E. casseliflavus", org: sp("enterococcus gallinarum", "enterococcus casseliflavus"),
    agents: any(T4.fd, T4.caz, T4.ceph, T4.mac, T4.cli, T4.qd, T4.van, T4.sul) },
  { rule: "4.9", label: "Enterococcus faecium", agents: any(T4.fd, T4.caz, T4.ceph, T4.mac, T4.sul), org: sp("enterococcus faecium") },
  { rule: "4.10", label: "Corynebacterium spp.", agents: T4.fos, org: (o) => fam(o, "corynebacterium") || o.genus === "corynebacterium" },
  { rule: "4.11", label: "Listeria monocytogenes", agents: any(T4.caz, T4.ceph), org: (o) => fam(o, "listeria") || is(o, "listeria monocytogenes") },
  { rule: "4.12", label: "Leuconostoc / Pediococcus spp.", agents: any(T4.van, T4.tec), org: sp("leuconostoc", "pediococcus") },
  { rule: "4.13", label: "Lactobacillus casei / L. rhamnosus", agents: any(T4.van, T4.tec),
    org: sp("lactobacillus casei", "lactobacillus rhamnosus", "lacticaseibacillus casei", "lacticaseibacillus rhamnosus") },
  { rule: "Table 4", label: "gram-positive bacteria", org: grampositive,
    agents: keys("aztreonam", "temocillin", "nalidixic acid", ...POLYMYXINS) },

  // Table 5: anaerobes
  { rule: "5.1", label: "Clostridium ramosum / C. innocuum", agents: keys("vancomycin"),
    org: sp("clostridium ramosum", "clostridium innocuum", "thomasclavelia ramosa") },
  { rule: "Table 5", label: "anaerobes", org: anaerobes, agents: any(keys("aztreonam", "nalidixic acid", ...POLYMYXINS), aminoglycosides) },
];

function expectedResistant(ctx: Context) {
  const done = new Set<string>();
  for (const e of EXPECTED_RESISTANT) {
    if (!e.org(ctx.o)) continue;
    const hits = ctx.iso.select(e.agents).filter((r) => !done.has(r.key) && r.cat !== "R");
    hits.forEach((r) => done.add(r.key));
    const names = (cat: (c: Cat | null) => boolean) => [...new Set(hits.filter((r) => cat(r.cat)).map((r) => r.key))];
    const susceptible = names((c) => c === "S" || c === "I"), uncategorised = names((c) => c === null);
    const id = `ERP ${e.rule}`, source = `${ERP}, ${e.rule.startsWith("Table") ? e.rule : `rule ${e.rule}`}`;
    if (susceptible.length) {
      ctx.fire({
        id, kind: "unexpected-susceptible", source, url: URL_EXP, agents: susceptible.map((k) => ctx.iso.label(k)),
        message: `${list(susceptible.map((k) => ctx.iso.label(k)))} tested susceptible, but ${e.label} are expected to be resistant. ` +
          "Check the species identification and the test; do not report the agent, or report it resistant.",
      });
      ctx.report(id, susceptible, "R", true);
    }
    if (uncategorised.length) {
      ctx.fire({
        id: `${id} (expected)`, kind: "inference", source, url: URL_EXP, agents: uncategorised.map((k) => ctx.iso.label(k)),
        message: `${e.label} are expected to be resistant to ${list(uncategorised.map((k) => ctx.iso.label(k)))}: testing is not ` +
          "needed; do not report the agent, or report it resistant.",
      });
      ctx.report(id, uncategorised, "R", false);
    }
  }
}

// ---- Expected susceptible phenotypes (ESP v1.1): a resistant result is unexpected

function expectedSusceptible(ctx: Context) {
  const { iso, o } = ctx;
  const check = (rule: string, label: string, sel: Sel, extra = "") => {
    const hits = [...new Set(iso.select(sel).filter((r) => r.cat === "R").map((r) => r.key))];
    if (!hits.length) return;
    ctx.fire({
      id: `ESP ${rule}`, kind: "unexpected-resistant", source: `${ESP}, rule ${rule}`, url: URL_EXP,
      agents: hits.map((k) => iso.label(k)),
      message: `${list(hits.map((k) => iso.label(k)))} tested resistant: resistance is not expected in ${label}. ` +
        `Check the identification and the susceptibility test; if confirmed, send the isolate to a reference laboratory.${extra}`,
    });
  };
  const gp = [...GLYCOPEPTIDES, "daptomycin", ...OXAZOLIDINONES, "quinupristin-dalfopristin", "tigecycline", "eravacycline", "omadacycline"];
  if (enterobacterales(o) && !is(o, "morganella", "proteus", "providencia", "serratia marcescens"))
    check("1.1", "Enterobacterales (except Morganellaceae and S. marcescens)", keys(...POLYMYXINS),
      " Colistin resistance is not rare in some countries.");
  if (is(o, "salmonella typhi")) check("1.2", "Salmonella Typhi", keys(...CARBAPENEMS));
  if (is(o, "pseudomonas aeruginosa") || fam(o, "acinetobacter") || o.genus === "acinetobacter")
    check("1.3", "P. aeruginosa and Acinetobacter spp.", keys(...POLYMYXINS));
  if (haemophilus(o)) check("1.4", "H. influenzae", keys(...CEPH_3_4.slice(0, 3), ...CEPH_3_ORAL, ...CARBAPENEMS, ...FLUOROQUINOLONES));
  if (moraxella(o)) check("1.5", "M. catarrhalis", keys(...CEPH_3_4.slice(0, 3), ...CEPH_3_ORAL, ...FLUOROQUINOLONES));
  if (fam(o, "neisseria meningitidis") || is(o, "neisseria meningitidis"))
    check("1.6", "N. meningitidis", keys(...CEPH_3_4.slice(0, 3), ...CEPH_3_ORAL, ...FLUOROQUINOLONES));
  if (fam(o, "neisseria gonorrhoeae") || is(o, "neisseria gonorrhoeae")) check("1.7", "N. gonorrhoeae", keys("spectinomycin"));
  if (sAureus(o)) check("2.1", "S. aureus", keys(...gp));
  else if (cons(o)) check("2.2", "coagulase-negative staphylococci", keys(...gp.filter((k) => k !== "teicoplanin")),
    " Linezolid, tedizolid and quinupristin-dalfopristin resistance is not rare in some countries.");
  if (corynebacteria(o)) check("2.3", "Corynebacterium spp.", keys(...gp.filter((k) => !["eravacycline", "omadacycline"].includes(k))));
  if (pneumococcus(o)) check("2.4", "S. pneumoniae", keys(...CARBAPENEMS, ...gp, "rifampicin"));
  if (betaHaemolytic(o)) check("2.5", "beta-haemolytic streptococci (groups A, B, C and G)",
    any(keys("benzylpenicillin", "ampicillin", "amoxicillin", ...gp), cephalosporins));
  if (enterococci(o)) {
    check("2.6", "Enterococcus spp.", keys("daptomycin", ...OXAZOLIDINONES, "tigecycline", "eravacycline", "omadacycline"));
    if (iso.R("teicoplanin") && iso.tested("vancomycin") && !iso.R("vancomycin"))
      ctx.fire({ id: "ESP 2.6b", kind: "unexpected-resistant", source: `${ESP}, rule 2.6`, url: URL_EXP,
        agents: [iso.label("teicoplanin")],
        message: "Resistant to teicoplanin but not to vancomycin is an unexpected phenotype in enterococci: check the identification and the test." });
  }
  if (is(o, "enterococcus faecalis")) check("2.7", "E. faecalis", keys("ampicillin", "amoxicillin"),
    " An ampicillin-resistant enterococcus is most likely E. faecium.");
  if (is(o, "enterococcus faecalis", "enterococcus gallinarum", "enterococcus casseliflavus", "enterococcus avium")
    && iso.S("quinupristin-dalfopristin"))
    ctx.fire({ id: "ESP 2.8", kind: "unexpected-resistant", source: `${ESP}, rule 2.8`, url: URL_EXP,
      agents: [iso.label("quinupristin-dalfopristin")],
      message: "Susceptible to quinupristin-dalfopristin: consider misidentification" +
        (iso.R("ampicillin") ? "; being also ampicillin resistant, it is almost certainly E. faecium." : ".") });
  if (is(o, "bacteroides")) check("3.1", "Bacteroides spp.", keys("metronidazole"));
  if (fam(o, "clostridium difficile") || is(o, "clostridioides difficile", "clostridium difficile"))
    check("3.2", "C. difficile", keys("metronidazole", "vancomycin", "fidaxomicin"));
}

// ---- Expert rules

function enterobacteralesRules(ctx: Context) {
  const { iso, o } = ctx;
  const src = (n: number) => `EUCAST Expert Rules v3.3, Enterobacterales, rule ${n}`;
  if (is(o, "escherichia coli", "proteus mirabilis")) {
    if (iso.R("ampicillin")) inferred(ctx, "ER Enterobacterales 1", src(1), "A", "Resistant to ampicillin", ["piperacillin"], "R", true);
    else if (iso.S("ampicillin")) inferred(ctx, "ER Enterobacterales 1", src(1), "A", "Susceptible to ampicillin", ["piperacillin"], "S", false);
  }
  const klebsiella = (is(o, "klebsiella") && !is(o, "klebsiella aerogenes")) || is(o, "raoultella");
  if (klebsiella && iso.tested("piperacillin"))
    inferred(ctx, "ER Enterobacterales 2", src(2), "A", "Klebsiella spp. (except K. aerogenes) and Raoultella spp.", ["piperacillin"], "R", true);
  const ampcHigh = is(o, "enterobacter", "klebsiella aerogenes", "citrobacter freundii", "citrobacter braakii",
    "citrobacter murliniae", "citrobacter werkmanii", "citrobacter youngae", "hafnia alvei");
  const ampcLow = is(o, "serratia", "morganella morganii", "providencia");
  const thirdGen = ["cefotaxime", "ceftriaxone", "ceftazidime"];
  if (ampcHigh) {
    const s = [...thirdGen, "piperacillin", "piperacillin-tazobactam"].filter((k) => iso.notR(k));
    if (s.length) ctx.fire({ id: "ER Enterobacterales 3", kind: "warning", source: src(3), url: URL_ER, grade: "A",
      agents: s.map((k) => iso.label(k)),
      message: `${list(s.map((k) => iso.label(k)))} susceptible in a species with chromosomal inducible AmpC: add a note that ` +
        "monotherapy (or combination with an aminoglycoside) is discouraged because AmpC-derepressed resistant mutants " +
        "may be selected, or suppress these results. The risk is absent or much lower for cefepime." });
  }
  if (ampcLow) {
    const s = thirdGen.filter((k) => iso.notR(k));
    if (s.length) ctx.fire({ id: "ER Enterobacterales 4", kind: "warning", source: src(4), url: URL_ER, grade: "A",
      agents: s.map((k) => iso.label(k)),
      message: `${list(s.map((k) => iso.label(k)))} susceptible: note that monotherapy may infrequently select resistant mutants.` });
  }
  if ((ampcHigh || ampcLow) && iso.notR("cefuroxime", "cefaclor"))
    inferred(ctx, "ER Enterobacterales 5", src(5), "C", "Susceptible to cefuroxime in a species with chromosomal AmpC (therapy not recommended)",
      ["cefuroxime", "cefaclor"].filter((k) => iso.tested(k)), "R", true);
  if (is(o, "escherichia coli", "raoultella") || klebsiella) {
    const r = [...thirdGen, "cefepime"].filter((k) => iso.R(k));
    if (r.length) {
      const bli = ["piperacillin-tazobactam", "amoxicillin-clavulanic acid"].filter((k) => iso.notR(k));
      if (bli.length) ctx.fire({ id: "ER Enterobacterales 6", kind: "warning", source: src(6), url: URL_ER, grade: "A",
        agents: bli.map((k) => iso.label(k)),
        message: `Resistant to ${list(r.map((k) => iso.label(k)))} (phenotype most often caused by an ESBL) and susceptible to ` +
          `${list(bli.map((k) => iso.label(k)))}: report as tested. Beta-lactam/inhibitor combinations against ESBL producers ` +
          "remain controversial; use appropriate dosing." });
      const s = [...thirdGen, "cefepime"].filter((k) => iso.notR(k));
      if (s.length) ctx.fire({ id: "ER Enterobacterales 7", kind: "warning", source: src(7), url: URL_ER, grade: "A",
        agents: s.map((k) => iso.label(k)),
        message: `Resistant to ${list(r.map((k) => iso.label(k)))} and susceptible to ${list(s.map((k) => iso.label(k)))}: report ` +
          "each as tested with a warning that the therapeutic outcome is uncertain for infections other than urinary tract infections." });
    }
  }
  if (!salmonella(o) && iso.R("ciprofloxacin"))
    inferred(ctx, "ER Enterobacterales 8", src(8), "B", "Resistant to ciprofloxacin",
      FLUOROQUINOLONES.filter((k) => k !== "ciprofloxacin" && (iso.tested(k) || ["levofloxacin", "moxifloxacin", "ofloxacin"].includes(k))), "R", true);
  if (is(o, "serratia", "providencia", "proteus", "morganella morganii") && iso.tested("tigecycline"))
    inferred(ctx, "ER Enterobacterales 9", src(9), "C", "Tigecycline has poor activity against Serratia, Providencia, Proteus and M. morganii",
      ["tigecycline"], "R", true);
}

function salmonellaRules(ctx: Context) {
  const { iso } = ctx;
  const src = (n: number) => `EUCAST Expert Rules v3.2, Salmonella, rule ${n}`;
  const second = ["cefuroxime", "cefaclor", "cefoxitin"].filter((k) => iso.notR(k));
  if (second.length) inferred(ctx, "ER Salmonella 1", src(1), "B",
    "1st/2nd generation cephalosporins have a low cure rate in Salmonella infections (report resistant or not at all)", second, "R", true);
  const amino = [...new Set(iso.select(aminoglycosides).filter((r) => r.cat === "S" || r.cat === "I").map((r) => r.key))];
  if (amino.length) inferred(ctx, "ER Salmonella 2", src(2), "B",
    "Aminoglycosides are ineffective in invasive Salmonella infections", amino, "R", true);
  if (iso.R("pefloxacin")) {
    inferred(ctx, "ER Salmonella 3", src(3), "A/B", "Positive pefloxacin screen", ["ciprofloxacin"], "R", true);
    ctx.fire({ id: "ER Salmonella 3b", kind: "warning", source: src(3), url: URL_ER,
      message: "Positive pefloxacin screen: include a caution against the use of other fluoroquinolones." });
  } else if (iso.S("pefloxacin")) {
    inferred(ctx, "ER Salmonella 3", src(3), "A/B", "Negative pefloxacin screen", ["ciprofloxacin"], "S", false);
  }
}

/** Erythromycin / clindamycin: inducible MLSB (staphylococci, streptococci, pneumococci, corynebacteria). */
function mlsb(ctx: Context, id: string, source: string, grade: string, allMacrolides: boolean) {
  const { iso } = ctx;
  const ery = iso.cat("erythromycin"), cli = iso.cat("clindamycin"), dTest = ctx.tests.inducible_clindamycin;
  if (ery === "R" && (cli === "S" || cli === "I")) {
    if (dTest === "positive")
      inferred(ctx, id, source, grade, "Resistant to erythromycin with inducible clindamycin resistance (positive D-test)",
        ["clindamycin"], "R", true);
    else if (dTest === "negative")
      ctx.fire({ id, kind: "inference", source, url: URL_ER, grade, agents: [iso.label("clindamycin")],
        message: "Resistant to erythromycin with a negative D-test (no inducible MLSB resistance): report clindamycin as tested." });
    else ctx.fire({ id, kind: "warning", source, url: URL_ER, grade, agents: [iso.label("clindamycin")],
      message: "Resistant to erythromycin and susceptible to clindamycin: test for inducible MLSB resistance (D-test) and " +
        "record the result under Supplementary tests. If inducible, report clindamycin resistant; if not, report it susceptible." });
  } else if (allMacrolides && ery === "S" && cli === "S")
    inferred(ctx, id, source, grade, "Susceptible to erythromycin and clindamycin",
      ["azithromycin", "clarithromycin", "roxithromycin"], "S", false);
}

function staphylococcusRules(ctx: Context) {
  const { iso, o } = ctx;
  const src = (n: number) => `EUCAST Expert Rules, Staphylococcus spp. (2025), rule ${n}`;
  if (!is(o, "staphylococcus pseudintermedius", "staphylococcus intermedius", "staphylococcus schleiferi", "staphylococcus coagulans")) {
    const mec = ctx.tests.mec;
    const fox = mec === "positive" ? "R" : iso.cat("cefoxitin");
    if (mec === "positive" && iso.cat("cefoxitin") !== "R")
      ctx.fire({ id: "ER Staphylococcus 1 (mec)", kind: "unexpected-resistant", source: src(1), url: URL_ER,
        message: "mecA/mecC or PBP2a detected although the cefoxitin screen is negative: the isolate is methicillin " +
          "resistant; check the cefoxitin test." });
    if (mec === "negative" && iso.cat("cefoxitin") === "R")
      ctx.fire({ id: "ER Staphylococcus 1 (mec)", kind: "warning", source: src(1), url: URL_ER,
        message: "Positive cefoxitin screen but mecA/mecC or PBP2a not detected: check that the assay detects mecC and " +
          "consider other mechanisms (e.g. MODSA); EUCAST reports the isolate according to the cefoxitin screen." });
    const betaLactams = [...new Set(iso.select(isBetaLactam).map((r) => r.key))]
      .filter((k) => !["cefoxitin", "ceftaroline", "ceftobiprole"].includes(k));
    const source = sAureus(o) ? src(1) : "EUCAST screening tests to detect/exclude resistance (2022): cefoxitin, staphylococci";
    if (fox === "R") {
      ctx.fire({ id: "ER Staphylococcus 1", kind: "mechanism", source, url: URL_ER, grade: sAureus(o) ? "A" : undefined,
        agents: [iso.label("cefoxitin")],
        message: `${mec === "positive" ? "mecA/mecC or PBP2a detected" : "Positive cefoxitin screen"}: methicillin-resistant ` +
          `(${sAureus(o) ? "MRSA" : "MR-CoNS"}). Report resistant to all ` +
          "beta-lactams except ceftaroline and ceftobiprole, which must be tested individually." });
      if (betaLactams.length) ctx.report("ER Staphylococcus 1", betaLactams, "R", true);
    } else if (fox === "S") {
      ctx.fire({ id: "ER Staphylococcus 1", kind: "inference", source, url: URL_ER, grade: sAureus(o) ? "A" : undefined,
        agents: [iso.label("cefoxitin")],
        message: "Negative cefoxitin screen: methicillin-susceptible. Beta-lactams with recognised anti-staphylococcal activity " +
          "can be reported susceptible (penicillins without inhibitor depend on the benzylpenicillin test)." });
    }
  }
  if (sAureus(o) && iso.R("benzylpenicillin")) {
    const pens = PENICILLINS.filter((k) => ["ampicillin", "amoxicillin", "piperacillin"].includes(k) || (iso.tested(k) && k !== "benzylpenicillin"));
    inferred(ctx, "ER Staphylococcus 2", src(2), "C", "Resistant to benzylpenicillin (penicillinase)", pens, "R", true);
  }
  mlsb(ctx, "ER Staphylococcus 3", src(3), "A", true);
  if (iso.cat("erythromycin") === "S" && iso.R("clindamycin"))
    ctx.fire({ id: "ER Staphylococcus 4", kind: "warning", source: src(4), url: URL_ER, grade: "C", agents: [iso.label("clindamycin")],
      message: "Susceptible to erythromycin and resistant to clindamycin (rare lincosamide-inactivating enzyme, linA/lnuA): report as tested." });
  const nor = iso.cat("norfloxacin");
  if (nor === "S") negativeNorfloxacin(ctx, "ER Staphylococcus 5", src(5), "C", ["ciprofloxacin", "levofloxacin"]);
  else if (nor === "R") {
    const notR = ["ciprofloxacin", "levofloxacin", "moxifloxacin"].filter((k) => iso.notR(k));
    ctx.fire({ id: "ER Staphylococcus 5", kind: "warning", source: src(5), url: URL_ER, grade: "C", agents: notR.map((k) => iso.label(k)),
      message: "Positive norfloxacin screen: report the individual fluoroquinolones as tested" +
        (notR.length ? `, with a warning of risk of resistance development during therapy with ${list(notR.map((k) => iso.label(k)))}.` : ".") });
  }
  if (iso.R("levofloxacin", "moxifloxacin"))
    inferred(ctx, "ER Staphylococcus 6", src(6), "C", "Resistant to levofloxacin or moxifloxacin",
      ["ciprofloxacin", "levofloxacin", "moxifloxacin", "ofloxacin"], "R", true);
  tetracyclineRule(ctx, "ER Staphylococcus 7", src(7), true);
  if (iso.S("vancomycin"))
    inferred(ctx, "ER Staphylococcus 8", src(8), "C", "Susceptible to vancomycin", ["dalbavancin", "oritavancin", "telavancin"], "S", false);
  if (iso.S("linezolid")) inferred(ctx, "ER Staphylococcus 8b", `${src(8)} (linezolid)`, "C", "Susceptible to linezolid", ["tedizolid"], "S", false);
}

/** Negative norfloxacin screen in staphylococci and streptococci: listed agents "I", moxifloxacin "S". */
function negativeNorfloxacin(ctx: Context, id: string, source: string, grade: string, increased: string[]) {
  const names = (ks: string[]) => list(ks.map((k) => (ctx.iso.tested(k) ? ctx.iso.label(k) : k)));
  ctx.fire({ id, kind: "inference", source, url: URL_ER, grade,
    agents: [...increased, "moxifloxacin"].filter((k) => ctx.iso.tested(k)).map((k) => ctx.iso.label(k)),
    message: `Negative norfloxacin screen: report ${names(increased)} ${NAME.I} and moxifloxacin ${NAME.S}.` });
  ctx.report(id, increased, "I", false);
  ctx.report(id, ["moxifloxacin"], "S", false);
}

function tetracyclineRule(ctx: Context, id: string, source: string, tigecycline: boolean) {
  const { iso } = ctx;
  const targets = ["doxycycline", "minocycline", ...(tigecycline ? ["tigecycline"] : [])];
  if (iso.S("tetracycline")) inferred(ctx, id, source, "C", "Susceptible to tetracycline", targets, "S", false);
  else if (iso.R("tetracycline")) {
    inferred(ctx, id, source, "C", "Resistant to tetracycline (or determine the MIC and report individually)",
      ["doxycycline", "minocycline"], "R", false);
  }
}

function enterococcusRules(ctx: Context) {
  const { iso, o } = ctx;
  const src = (n: number) => `EUCAST Expert Rules, Enterococcus spp. (2025), rule ${n}`;
  if (is(o, "enterococcus faecalis", "enterococcus faecium") && iso.R("ampicillin"))
    inferred(ctx, "ER Enterococcus 1", src(1), "C", "Resistant to ampicillin", ["amoxicillin", "piperacillin", "imipenem"], "R", true);
  const gen = iso.cat("gentamicin");
  if (gen === "R") ctx.fire({ id: "ER Enterococcus 2", kind: "warning", source: src(2), url: URL_ER, grade: "B", agents: [iso.label("gentamicin")],
    message: "High-level gentamicin resistance: combinations with gentamicin and other aminoglycosides (except streptomycin) " +
      "are no longer synergistic; test for high-level streptomycin resistance." });
  else if (gen === "S") ctx.fire({ id: "ER Enterococcus 2", kind: "inference", source: src(2), url: URL_ER, grade: "B", agents: [iso.label("gentamicin")],
    message: "No high-level gentamicin resistance: gentamicin can be reported effective for synergy with cell-wall active agents." });
  const str = iso.cat("streptomycin");
  if (str === "R") ctx.fire({ id: "ER Enterococcus 3", kind: "warning", source: src(3), url: URL_ER, grade: "B", agents: [iso.label("streptomycin")],
    message: "High-level streptomycin resistance: combinations of streptomycin with beta-lactams are no longer synergistic." });
  else if (str === "S") ctx.fire({ id: "ER Enterococcus 3", kind: "inference", source: src(3), url: URL_ER, grade: "B", agents: [iso.label("streptomycin")],
    message: "No high-level streptomycin resistance: streptomycin can be reported effective for synergy." });
  const nor = iso.cat("norfloxacin");
  if (nor === "S") inferred(ctx, "ER Enterococcus 4", src(4), "C", "Negative norfloxacin screen (uncomplicated UTI only)",
    ["ciprofloxacin", "levofloxacin"], "S", false);
  else if (nor === "R") inferred(ctx, "ER Enterococcus 4", src(4), "C", "Positive norfloxacin screen (uncomplicated UTI only)",
    ["ciprofloxacin", "levofloxacin"], "R", false);
  if (iso.S("vancomycin"))
    inferred(ctx, "ER Enterococcus 5", src(5), "C", "Susceptible to vancomycin", ["dalbavancin", "oritavancin", "telavancin"], "S", false);
  const van = ctx.tests.van;
  if (van === "vanA")
    inferred(ctx, "ER Enterococcus 5 (vanA)", src(5), "B", "vanA detected", ["vancomycin", "teicoplanin"], "R", true);
  else if (van === "vanB") {
    inferred(ctx, "ER Enterococcus 5 (vanB)", src(5), "B", "vanB detected", ["vancomycin"], "R", true);
    ctx.fire({ id: "ER Enterococcus 5b", kind: "warning", source: src(5), url: URL_ER, grade: "B",
      message: "vanB detected: report teicoplanin with a warning that resistance may develop during therapy." });
  } else if (is(o, "enterococcus faecalis", "enterococcus faecium") && iso.R("vancomycin") && iso.notR("teicoplanin"))
    ctx.fire({ id: "ER Enterococcus 5b", kind: "warning", source: src(5), url: URL_ER, grade: "B", agents: [iso.label("teicoplanin")],
      message: "Resistant to vancomycin and susceptible to teicoplanin (vanB phenotype): report teicoplanin with a warning " +
        "that resistance may develop during therapy." });
  if (is(o, "enterococcus faecium") && iso.tested("clindamycin"))
    inferred(ctx, "ER Enterococcus 6", src(6), "C", "Clindamycin has no proven therapeutic utility in E. faecium (report resistant or not at all)",
      ["clindamycin"], "R", true);
}

function streptococcusRules(ctx: Context) {
  const { iso, o } = ctx;
  const src = (n: number) => `EUCAST Expert Rules, Streptococcus spp. (2025), rule ${n}`;
  if (betaHaemolytic(o)) {
    if (iso.S("benzylpenicillin")) {
      const others = [...new Set(iso.select(any(keys("ampicillin", "amoxicillin", ...CARBAPENEMS), cephalosporins)).map((r) => r.key))];
      inferred(ctx, "ER Streptococcus 1", src(1), "C", "Susceptible to benzylpenicillin",
        others.length ? others : ["aminopenicillins", "cephalosporins", "carbapenems"], "S", false);
    } else if (iso.R("benzylpenicillin") || iso.cat("benzylpenicillin") === "I")
      ctx.fire({ id: "ER Streptococcus 1", kind: "warning", source: src(1), url: URL_ER, grade: "C", agents: [iso.label("benzylpenicillin")],
        message: "Beta-haemolytic streptococcus not susceptible to benzylpenicillin: confirm the species identification, and " +
          "determine and report the MIC of the relevant beta-lactams." });
    const nor = iso.cat("norfloxacin");
    if (nor === "S") negativeNorfloxacin(ctx, "ER Streptococcus 4", src(4), "A", ["levofloxacin"]);
    else if (nor === "R") ctx.fire({ id: "ER Streptococcus 4", kind: "warning", source: src(4), url: URL_ER, grade: "A",
      message: "Positive norfloxacin screen: test levofloxacin and moxifloxacin individually, or report them resistant." });
  }
  if (viridans(o)) {
    if (iso.S("benzylpenicillin"))
      inferred(ctx, "ER Streptococcus 2", src(2), "C", "Negative benzylpenicillin screen", ["ampicillin", "amoxicillin", "cefotaxime", "ceftriaxone"], "S", false);
    else if (iso.R("benzylpenicillin"))
      ctx.fire({ id: "ER Streptococcus 2", kind: "warning", source: src(2), url: URL_ER, grade: "C",
        message: "Positive benzylpenicillin screen: test the individual beta-lactams, or report them resistant." });
  }
  mlsb(ctx, "ER Streptococcus 3", src(3), "A", false);
  if (iso.R("gentamicin"))
    ctx.fire({ id: "ER Streptococcus 5", kind: "warning", source: src(5), url: URL_ER, grade: "C",
      message: "High-level gentamicin resistance (endocarditis isolates): combinations of a beta-lactam with gentamicin may not be synergistic." });
}

function pneumococcusRules(ctx: Context) {
  const { iso } = ctx;
  const src = (n: number) => `EUCAST Expert Rules, S. pneumoniae (2025), rule ${n}`;
  const ox = iso.cat("oxacillin");
  if (ox === "S") {
    const bl = [...new Set(iso.select(isBetaLactam).map((r) => r.key))].filter((k) => k !== "oxacillin");
    inferred(ctx, "ER Pneumococcus 1", src(1), "A", "Negative oxacillin screen (beta-lactam agents with S. pneumoniae breakpoints)",
      bl.length ? bl : ["benzylpenicillin", "aminopenicillins", "cephalosporins", "carbapenems"], "S", false);
  } else if (ox === "R") ctx.fire({ id: "ER Pneumococcus 1", kind: "warning", source: src(1), url: URL_ER, grade: "A",
    agents: [iso.label("oxacillin")],
    message: "Positive oxacillin screen: follow the S. pneumoniae beta-lactam flowchart of the breakpoint table " +
      "(benzylpenicillin MIC and the relevant agents)." });
  mlsb(ctx, "ER Pneumococcus 2", src(2), "A", true);
  const nor = iso.cat("norfloxacin");
  if (nor === "S") negativeNorfloxacin(ctx, "ER Pneumococcus 3", src(3), "C", ["levofloxacin"]);
  else if (nor === "R") ctx.fire({ id: "ER Pneumococcus 3", kind: "warning", source: src(3), url: URL_ER, grade: "C",
    message: "Positive norfloxacin screen: test levofloxacin and moxifloxacin individually or report them resistant; if " +
      "reported susceptible, warn of the risk of resistance development during therapy." });
  if (iso.R("levofloxacin", "moxifloxacin"))
    inferred(ctx, "ER Pneumococcus 4", src(4), "A", "Resistant to levofloxacin or moxifloxacin", ["levofloxacin", "moxifloxacin", "ciprofloxacin", "ofloxacin"].filter((k) => iso.tested(k)), "R", true);
  tetracyclineRule(ctx, "ER Pneumococcus 5", src(5), false);
  if (iso.S("vancomycin"))
    inferred(ctx, "ER Pneumococcus 6", src(6), "C", "Susceptible to vancomycin", ["dalbavancin", "oritavancin", "telavancin"], "S", false);
}

function haemophilusRules(ctx: Context) {
  const { iso } = ctx;
  const src = (n: number) => `EUCAST Expert Rules v3.2, Haemophilus, rule ${n}`;
  const pen = iso.cat("benzylpenicillin");
  if (pen === "S") {
    const pens = [...new Set(iso.select(drugClass("penicillins")).map((r) => r.key))].filter((k) => k !== "benzylpenicillin");
    inferred(ctx, "ER Haemophilus 1", src(1), "A",
      "Negative benzylpenicillin screen (amoxicillin and amoxicillin-clavulanic acid oral: report I)",
      pens.length ? pens : ["penicillins with breakpoints"], "S", false);
  } else if (pen === "R") ctx.fire({ id: "ER Haemophilus 1", kind: "warning", source: src(1), url: URL_ER, grade: "A",
    message: "Positive benzylpenicillin screen: follow the H. influenzae flowchart of the breakpoint table (beta-lactamase " +
      "test, recorded under Supplementary tests, and the relevant agents)." });
  if (ctx.tests.beta_lactamase === "positive")
    inferred(ctx, "BP Haemophilus beta-lactamase", "EUCAST breakpoint table, H. influenzae, ampicillin note 2", "",
      "Beta-lactamase positive", ["ampicillin", "amoxicillin", "piperacillin"], "R", true);
  nalidixicScreen(ctx, "ER Haemophilus 2", src(2), ["ciprofloxacin", "levofloxacin", "moxifloxacin", "ofloxacin"]);
  tetracyclineRule(ctx, "ER Haemophilus 3", src(3), false);
}

function nalidixicScreen(ctx: Context, id: string, source: string, fqs: string[]) {
  const na = ctx.iso.cat("nalidixic acid");
  if (na === "S") inferred(ctx, id, source, "C", "Negative nalidixic acid screen", fqs, "S", false);
  else if (na === "R") inferred(ctx, id, source, "C",
    "Positive nalidixic acid screen (or determine the susceptibility of the agent used and, if susceptible, warn that resistance may develop)",
    fqs, "R", false);
}

function otherGroupsRules(ctx: Context) {
  const { iso, o } = ctx;
  if (moraxella(o)) nalidixicScreen(ctx, "ER Moraxella 1", "EUCAST Expert Rules v3.2, Moraxella, rule 1",
    ["ciprofloxacin", "levofloxacin", "moxifloxacin", "ofloxacin"]);
  if (campylobacter(o)) {
    const ery = iso.cat("erythromycin");
    if (ery === "S" || ery === "R") inferred(ctx, "ER Campylobacter 1", "EUCAST Expert Rules v3.2, Campylobacter, rule 1", "C",
      `${ery === "S" ? "Susceptible" : "Resistant"} to erythromycin`, ["clarithromycin", "azithromycin"], ery, false);
  }
  if (corynebacteria(o) && iso.R("erythromycin") && iso.notR("clindamycin") && ctx.tests.inducible_clindamycin === "positive")
    inferred(ctx, "ER Corynebacterium 1", "EUCAST Expert Rules v3.2, Corynebacterium, rule 1", "C",
      "Resistant to erythromycin and inducibly resistant to clindamycin", ["clindamycin"], "R", true);
  else if (corynebacteria(o) && iso.R("erythromycin") && iso.notR("clindamycin") && !ctx.tests.inducible_clindamycin)
    ctx.fire({ id: "ER Corynebacterium 1", kind: "warning", source: "EUCAST Expert Rules v3.2, Corynebacterium, rule 1",
      url: URL_ER, grade: "C", agents: [iso.label("clindamycin")],
      message: "Resistant to erythromycin and susceptible to clindamycin: test for inducible clindamycin resistance (ermX); if inducible, report clindamycin resistant." });
}

// ---- Areas of Technical Uncertainty, from the breakpoint notes

const ATU = /(?:Area of Technical Uncertainty \(ATU\):|ATU of)\s*(\d+)(?:\s*-\s*(\d+))?\s*mm/i;

function technicalUncertainty(ctx: Context) {
  for (const r of ctx.iso.results) {
    const m = r.m.breakpoint?.comments.match(ATU);
    if (!m) continue;
    const lo = Number(m[1]), hi = Number(m[2] ?? m[1]), d = Math.round(r.m.diameter_mm);
    if (d < lo || d > hi) continue;
    ctx.fire({ id: `ATU ${r.m.id}`, kind: "atu", source: "Breakpoint table notes (Area of Technical Uncertainty)",
      url: "https://www.eucast.org/clinical_breakpoints", agents: [r.m.antibiotic.name],
      message: `${r.m.antibiotic.name}: ${r.m.diameter_mm.toFixed(1)} mm is in the Area of Technical Uncertainty ` +
        `(${lo === hi ? lo : `${lo}-${hi}`} mm). Repeat the test or use another method; if that is not possible, report ` +
        "the result with a warning about its uncertainty, or downgrade the category." });
  }
}

// ---------------------------------------------------------------- evaluation

export function evaluate(a: Pick<Antibiogram, "family" | "genus" | "species" | "plates"> & { supplementary_tests?: Record<string, string> },
  standard?: Pick<Standard, "name">): Evaluation {
  const o = organismOf(a);
  const measurements = a.plates.flatMap((p) => p.measurements);
  const tests = Object.fromEntries(supplementaryTestsFor(a).map((t) => [t.key, a.supplementary_tests?.[t.key]])
    .filter(([, v]) => v)) as Record<string, string>;
  const ctx = new Context(new Isolate(measurements), o, tests);

  expectedResistant(ctx);
  expectedSusceptible(ctx);
  if (enterobacterales(o)) {
    enterobacteralesRules(ctx);
    if (salmonella(o)) salmonellaRules(ctx);
  }
  if (staphylococci(o)) staphylococcusRules(ctx);
  if (enterococci(o)) enterococcusRules(ctx);
  if (pneumococcus(o)) pneumococcusRules(ctx);
  else if (streptococci(o)) streptococcusRules(ctx);
  if (haemophilus(o)) haemophilusRules(ctx);
  otherGroupsRules(ctx);
  if (!standard || standard.name.toUpperCase().startsWith("EUCAST")) technicalUncertainty(ctx);

  // Reported category per measurement: forced rules ("regardless of the test result") win, the most
  // resistant first; the others only fill measurements that could not be categorised.
  const reported = new Map<number, Reported>();
  for (const r of ctx.iso.results) {
    const ov = ctx.overrides.filter((x) => x.key === r.key);
    const forced = ov.filter((x) => x.force).sort((x, y) => RANK[y.category] - RANK[x.category]);
    const fill = r.cat === null ? ov.filter((x) => !x.force).sort((x, y) => RANK[y.category] - RANK[x.category]) : [];
    const top = forced[0] ?? fill[0];
    if (top && top.category !== r.cat) {
      reported.set(r.m.id, { category: top.category, rules: [...new Set(ov.filter((x) => x.category === top.category).map((x) => x.rule))] });
    }
  }

  const KIND_ORDER: RuleKind[] = ["unexpected-susceptible", "unexpected-resistant", "mechanism", "atu", "warning", "inference"];
  ctx.rules.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind));
  return {
    rules: ctx.rules,
    reported,
    organism: [o.genus && cap(o.genus), o.species].filter(Boolean).join(" ") || a.family.name,
    speciesKnown: Boolean(o.genus && o.species),
  };
}

export const CATEGORY_NAME: Record<Cat, string> = { S: "Susceptible", I: "Intermediate", R: "Resistant" };
