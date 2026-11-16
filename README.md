# AntibiogramJ Web

Web version of AntibiogramJ (the Java desktop application by J. Heras, C. Domínguez, E. Mata and V. Pascual,
University of La Rioja) — analysis of
disk-diffusion antibiogram images: detection of antibiotic disks, recognition of the printed codes, measurement
of inhibition zones and S/I/R categorisation with EUCAST/CLSI breakpoints.

It comes in two flavours built from the same React frontend:

| | **Server** (multi-user service) | **Browser** (runs entirely on the user's computer) |
|---|---|---|
| Analysis | Python + OpenCV in `backend/` | OpenCV.js (WebAssembly) in a Web Worker, `frontend/src/browser/` |
| Data | PostgreSQL/SQLite + image files, per account | IndexedDB in the user's browser; backup/restore to a file |
| Accounts | e-mail + password | none: nothing leaves the computer |
| Build | `npm run build` + backend | `npm run build:browser` → static site in `frontend/dist-browser/` |

* **backend/** — FastAPI + SQLAlchemy + OpenCV. Multi-user (accounts, data isolated per user).
* **frontend/** — React + TypeScript (Vite). SVG editor to adjust the plate, disks and halos. The pages talk to an
  `Api` interface (`src/api.ts`) implemented by `src/http.ts` (server) or `src/browser/localApi.ts` (browser);
  the build mode picks one, so each build contains only its own.

## Features (v2.0, MVP)

| Desktop AntibiogramJ | Web |
|---|---|
| Users / labs (no password) | Accounts with e-mail + password (bcrypt), lab, city, country |
| Experiments → antibiograms → plates | Same model; one owner per experiment |
| Wizard: bacteria data, crop, brightness/contrast, disks, disk size, codes, halos, annotation | Same 5 steps; annotated image generated on save |
| Template learning in `antibiotics/<id>/` | Bundled templates shared by all + up to 10 learned templates per antibiotic **per user** |
| Standards EUCAST 6.0 + CLSI 2015 (AntibiogramJXML) | Same files + **EUCAST 16.1** (default for new experiments) |
| Export experiment to Excel | `.xlsx` with a summary sheet + one sheet per antibiogram |
| Expert-rules system (stub: intrinsic resistance, exceptional phenotypes, interpretive rules) | **EUCAST expert system** (see below) |

Not yet ported: searches (by antibiotic / strains / antibiograms), editable abbreviations, loading new standards
from the UI, import/export of experiments as files.

### Breakpoint standards

The standards are AntibiogramJXML files in `backend/seed/standards/` (schema `antibiogramJStandardsSchema.xsd`):

| Standard | Valid from | Notes |
|---|---|---|
| **EUCAST 16.1** (default) | 2026-06-24 | Zone diameter breakpoints of the [EUCAST Clinical Breakpoint Tables v. 16.1](https://www.eucast.org/clinical_breakpoints) |
| EUCAST 6.0 | 2016-01-01 | From the desktop application |
| CLSI 2015 | 2016-01-01 | From the desktop application (Enterobacteriaceae only) |

New experiments use the default standard; existing experiments keep the standard they were created with. The
server loads the seed standards that are missing from its database at every start (existing standards and their
breakpoints are never modified), and new standards are always appended to `SEED_STANDARDS` in
`backend/app/main.py` so the ids of existing standards, antibiotics and breakpoints do not change.

`EUCAST-16.1.xml` is generated from the official Excel workbook with
`backend/.venv/bin/python backend/scripts/eucast_xlsx_to_xml.py v_16.1_Breakpoint_Tables.xlsx backend/seed/standards/EUCAST-16.1.xml`:

* Only zone diameter (disk diffusion) breakpoints are used. Agents without one (MIC only, "-", "IE", "IP", "Note")
  are listed as not available; organism groups with no zone diameter breakpoint at all (*N. gonorrhoeae*,
  *N. meningitidis*, *H. pylori*, *M. tuberculosis*, *L. pneumophila*, *B. cepacia* complex) are left out.
* Indications, routes and species (e.g. "iv", "(uncomplicated UTI only)", "(meningitis)", "S. aureus") go to the
  breakpoint *case*; when there are several, the first one is preselected and the others can be chosen in the
  wizard. The EUCAST notes for the disk test, the Area of Technical Uncertainty (ATU), screening tests, off-scale
  breakpoints (S ≥ 50 mm) and breakpoints in brackets are copied to the breakpoint notes.
* EUCAST renamed the table *Enterobacteriaceae* to **Enterobacterales** (it applies to the whole order). It keeps
  the existing family name *Enterobacteriaceae* in the app, so the same bacteria family works with every
  standard. Likewise, the anaerobe tables use the existing *Gram-negative anaerobes* and *Gram-positive anaerobes
  except Clostridium difficile* families (the species is in the case, e.g. "Bacteroides spp."). New organism
  groups (Aeromonas, Vibrio, Kingella kingae, Bacillus, Brucella, ...) are new families.
* Antibiotics with the same name, disk content and class as in EUCAST 6.0 are shared, so the bundled disk code
  templates still recognise them; new agents/disks (cefiderocol, ceftazidime-avibactam, temocillin, ...) have no
  bundled templates yet (the app learns them when you identify them manually).

**S/I/R with EUCAST.** Since 2019 (v 9.0) EUCAST defines **I as "Susceptible, increased exposure"**: the organism
is susceptible when the exposure to the agent is increased (higher dose or concentration at the site of infection),
not an uncertain result. With EUCAST standards valid from 2019 (EUCAST 16.1) the app shows and exports I as
**"Susceptible, increased exposure"**; with EUCAST 6.0 and CLSI it is "Intermediate", its meaning in those
standards. The stored value is still "Intermediate" (compatible with existing data and the desktop application).
With an off-scale breakpoint (S ≥ 50 mm) wild-type isolates are categorised I and must never be reported S.

### Expert system

`frontend/src/expertRules.ts` applies EUCAST rules to all the results of an isolate (every plate of an
antibiogram). It runs in the browser in both flavours, is shown under each antibiogram of the experiment page
(**Expert system** panel and **Reported** column) and is included in the Excel export, which the web interface
builds in the browser in both flavours (`frontend/src/excel.ts`; the server endpoint
`/api/experiments/{id}/export.xlsx` remains for API clients, without the expert system).

**Supplementary tests.** Results that cannot be read from the disks are recorded per antibiogram (**Supplementary
tests** in the panel; only the tests relevant to the organism are offered) and used by the rules: D-test (inducible
clindamycin resistance → clindamycin R), mecA/mecC or PBP2a (→ MRSA), vanA/vanB (→ vancomycin/teicoplanin),
ESBL confirmation, carbapenemase (KPC, MBL, OXA-48) and beta-lactamase of *H. influenzae* (→ ampicillin,
amoxicillin, piperacillin R). **Edit** on an antibiogram changes genus, species, strain, sample and comments
(the family selects the breakpoints and cannot change); the genus/species fields suggest the organisms the rules
know.

| Source | What the app does |
|---|---|
| [Expected Resistant Phenotypes v1.2](https://www.eucast.org/bacteria/important-additional-information/expected-phenotypes/) (2023), tables 1-5 | Susceptible result for an agent the species is expected to be resistant to → *unexpected susceptible*, report R; untestable (no breakpoint) → report R without testing |
| [Expected Susceptible Phenotypes v1.1](https://www.eucast.org/bacteria/important-additional-information/expected-phenotypes/) (2022) | Resistant result where resistance is not expected (e.g. linezolid-R *S. aureus*, ampicillin-R *E. faecalis*) → *unexpected resistant*: check identification/test, reference lab |
| [Expert Rules](https://www.eucast.org/bacteria/important-additional-information/expert-rules/): Enterobacterales v3.3 (2024); *Staphylococcus*, *Enterococcus*, *Streptococcus*, *S. pneumoniae* (Nov 2025); *Haemophilus*, *Moraxella*, *Salmonella*, *Campylobacter*, *Corynebacterium* v3.2 (2019) | Inferences (ampicillin → piperacillin, ciprofloxacin → all fluoroquinolones, cefoxitin screen → MRSA and all beta-lactams, norfloxacin/nalidixic acid/pefloxacin/oxacillin/benzylpenicillin screens, tetracycline → doxycycline/minocycline, ...) and warnings (inducible MLSB/D-test, AmpC derepression, ESBL phenotypes, vanB, high-level aminoglycoside resistance, ...) |
| [Detection of resistance mechanisms v2.0](https://www.eucast.org/bacteria/important-additional-information/resistance-detection/) (2017) | Enterobacterales: ESBL screening cut-offs (cefotaxime <21, ceftriaxone <23, ceftazidime <22, cefpodoxime <21 mm) and carbapenemase screening (meropenem <28 mm, 25-27 mm exception with piperacillin-tazobactam; temocillin <11 mm → OXA-48) |
| Breakpoint notes of the standard | Zone diameter inside an Area of Technical Uncertainty (ATU) |

Rules never change the stored measurements: they add messages and a suggested reported category. Rules applied
"regardless of the test result" (and expected resistances) override the measured category; inferences only fill
agents that could not be categorised or were not tested (named in the message). Species-specific rules need the
genus and species of the isolate ("Escherichia" + "coli", or "E. coli" in the species field); with only the family,
the group rules are applied and the panel asks for them. Rules that need an MIC (the standards only have zone
diameter breakpoints) are reported as warnings that ask for it. The engine is
decision support and does not replace the validation of the results by a microbiologist.
`npm run test:rules` runs the rules on synthetic isolates.

### Algorithms

Ported 1:1 from the Java code (`backend/app/cv/processing.py`, `matching.py`): Hough plate detection, ImageJ
*Enhance Contrast* (0.35 % saturation), disk detection (mean-shift + V-channel threshold), code recognition (ORB,
ratio 0.7, >10 matches), halo growth by 5 px rings and the S/I/R rules with each standard's operators.
Deliberate differences:

* Halo search starts 5 % outside the disk border (the blurred white disk edge made the original miss clear halos).
* The mm/px scale is the mean diameter of all disks of the plate divided by the disk size (6 mm by default),
  instead of using each disk's own size.
* After cropping, images are analysed at most at 1600 px (configurable).

[docs/disk-reading.md](docs/disk-reading.md) studies reading disk codes without templates (PP-OCR text
recognition constrained to a lexicon of disk codes); prototypes in `research/disk_reading/`, not used by the app.

## Development

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest                         # end-to-end API tests on a real plate image
.venv/bin/uvicorn app.main:app --reload  # http://localhost:8000/docs
```

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173 (proxies /api to :8000)
npm run build   # dist/ is served by the backend at http://localhost:8000
```

Configuration uses `ABJ_*` environment variables (see `backend/app/config.py`). SQLite is used by default;
set `ABJ_DATABASE_URL` for PostgreSQL. Images are stored under `backend/data/`.

## Browser version

**Live:** https://joheras.github.io/antibiogramj-web/ (deployed by `.github/workflows/pages.yml` on every push to `main`).

```bash
cd frontend
npm run dev:browser     # http://localhost:5173, no backend needed
npm run build:browser   # static site in dist-browser/ (~11 MB, mostly OpenCV.js)
npm run validate:cv     # checks the OpenCV.js port against the Python results (tests/images/1.tiff)
npm run test:rules      # checks the EUCAST expert system on synthetic isolates
```

`dist-browser/` can be published on any static host (GitHub Pages, Netlify, a university web server, an
internal share served over HTTP(S)); it uses hash URLs, so no rewrite rules are needed. It must be served over
`http(s)://` — opening `index.html` from the file system does not work (Web Workers and WebAssembly).

* Data lives in the browser's IndexedDB of that site: **Back up** saves everything (experiments, images, learned
  templates) to one `.json` file and **Restore** adds a backup's experiments. Clearing the site data deletes it.
* OpenCV.js lacks `pyrMeanShiftFiltering`; `src/browser/cv.ts` implements it following OpenCV's code and it is
  identical pixel by pixel to `cv2.pyrMeanShiftFiltering`. Plate, disks, codes and halos match the Python backend.
* Excel files are written by a small dependency-free writer (`src/browser/xlsx.ts`).
* The catalogue (standards, breakpoints) and the bundled templates are generated from the backend seed with
  `backend/.venv/bin/python backend/scripts/export_catalog.py` (writes `src/browser/catalog.json` and
  `public-browser/templates/`); `backend/scripts/cv_reference.py` regenerates the reference of `validate:cv`.

## Production (server version)

```bash
cp .env.example .env   # set POSTGRES_PASSWORD and ABJ_SECRET_KEY
docker compose up -d --build
```

The app listens on `127.0.0.1:8000`; serve it through an HTTPS reverse proxy (Caddy, nginx). Before opening it
to the public, also consider:

* rate limiting of `/api/auth/*` and `/api/analysis/uploads` at the proxy;
* `ABJ_ALLOW_REGISTRATION=false` if accounts should be created only by the operator;
* backups of the PostgreSQL volume **and** the `files` volume (images);
* a privacy notice: users upload clinical/laboratory images.
