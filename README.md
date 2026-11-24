# AntibiogramJ Web

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.24337999.svg)](https://doi.org/10.5281/zenodo.24337999)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Web version of AntibiogramJ (the Java desktop application by J. Heras, C. Domínguez, E. Mata and V. Pascual,
University of La Rioja) — analysis of
disk-diffusion antibiogram images: detection of antibiotic disks, recognition of the printed codes, measurement
of inhibition zones and S/I/R categorisation with EUCAST/CLSI breakpoints.

It comes in two flavours built from the same React frontend:

| | **Server** (multi-user service) | **Browser** (runs entirely on the user's computer) |
|---|---|---|
| Analysis | Python + OpenCV + onnxruntime in `backend/` | OpenCV.js + onnxruntime-web (WebAssembly) in a Web Worker, `frontend/src/browser/` |
| Data | PostgreSQL/SQLite + image files, per account | IndexedDB in the user's browser; backup/restore to a file; optional sync with the user's own Google Drive |
| Accounts | e-mail + password | none: nothing is sent to any server of ours |
| Build | `npm run build` + backend | `npm run build:browser` → static site in `frontend/dist-browser/`, installable (PWA) and usable offline |

* **backend/** — FastAPI + SQLAlchemy + OpenCV. Multi-user (accounts, data isolated per user).
* **frontend/** — React + TypeScript (Vite). SVG editor to adjust the plate, disks and halos. The pages talk to an
  `Api` interface (`src/api.ts`) implemented by `src/http.ts` (server) or `src/browser/localApi.ts` (browser);
  the build mode picks one, so each build contains only its own.

## Features

| Desktop AntibiogramJ | Web |
|---|---|
| Users / labs (no password) | Accounts with e-mail + password (bcrypt), lab, city, country |
| Experiments → antibiograms → plates | Same model; one owner per experiment |
| Wizard: bacteria data, crop, brightness/contrast, disks, disk size, codes, halos, annotation | Same 5 steps; annotated image generated on save |
| Disk codes recognised by templates in `antibiotics/<id>/` | **OCR of the printed code** (any antibiotic of the catalogue, other manufacturers' codes) with a confidence; bundled + learned templates (up to 10 per antibiotic **per user**) as fallback |
| Standards EUCAST 6.0 + CLSI 2015 (AntibiogramJXML) | Same files + **EUCAST 16.1** (default for new experiments) |
| Export experiment to Excel | `.xlsx` with a summary sheet + one sheet per antibiogram |
| Expert-rules system (stub: intrinsic resistance, exceptional phenotypes, interpretive rules) | **EUCAST expert system** and **resistance phenotypes** (ESBL, AmpC, carbapenemases MBL/KPC/OXA-48-like, MRSA) with combination disks (see below) |
| – | **Quality control** with the EUCAST QC strains (QC Tables v 16.0) and **photo quality checks** (see below) |
| – | **Reinterpretation** of an experiment with another standard or version, keeping the original results (see below) |
| Desktop only | **Phones and tablets**: touch editing (pinch-zoom, larger handles), camera capture, compact layout; the browser version installs as an app (PWA) and works offline |
| – | Browser version: optional **Google Drive** backups and a **phone → computer** flow (Capture on the phone, Inbox on the computer); local multi-photo import queue |

Not yet ported: searches (by antibiotic / strains / antibiograms), editable abbreviations, loading new standards
from the UI, and export/import of experiments as files in the server version (the browser version has Back up /
Restore and Google Drive).

### Breakpoint standards

The standards are AntibiogramJXML files in `backend/seed/standards/` (schema `antibiogramJStandardsSchema.xsd`):

| Standard | Valid from | Notes |
|---|---|---|
| **EUCAST 16.1** (default) | 2026-06-24 | Zone diameter breakpoints of the [EUCAST Clinical Breakpoint Tables v. 16.1](https://www.eucast.org/clinical_breakpoints) |
| EUCAST 6.0 | 2016-01-01 | From the desktop application |
| CLSI 2015 | 2016-01-01 | From the desktop application (Enterobacteriaceae only) |

New experiments use the default standard; existing experiments keep the standard they were created with
(**Reinterpret with…**, below, reads them with another one). The
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
  except Clostridium difficile* families (the species is in the case, e.g. "Bacteroides spp."). With standards valid
  from 2019 the app shows and exports these names as *Enterobacterales* and *Clostridioides difficile*. New organism
  groups (Aeromonas, Vibrio, Kingella kingae, Bacillus, Brucella, ...) are new families.
* Antibiotics with the same name, disk content and class as in EUCAST 6.0 are shared, so the bundled disk code
  templates still recognise them. New agents/disks (cefiderocol, ceftazidime-avibactam, temocillin, ...) have no
  bundled templates, but the OCR reads their codes (see below).

**S/I/R with EUCAST.** Since 2019 (v 9.0) EUCAST defines **I as "Susceptible, increased exposure"**: the organism
is susceptible when the exposure to the agent is increased (higher dose or concentration at the site of infection),
not an uncertain result. With EUCAST standards valid from 2019 (EUCAST 16.1) the app shows and exports I as
**"Susceptible, increased exposure"**; with EUCAST 6.0 and CLSI it is "Intermediate", its meaning in those
standards. The stored value is still "Intermediate" (compatible with existing data and the desktop application).
With an off-scale breakpoint (S ≥ 50 mm) wild-type isolates are categorised I and must never be reported S.

### Quality control

An antibiogram can be marked as a **EUCAST QC strain** (wizard step 1 or **Edit**). Its zone diameters, rounded to
the whole millimetre, are compared with the QC range and target of the strain in the plate and experiment views and in
the Excel export (both the web export and `/api/experiments/{id}/export.xlsx`). The ranges come from the
[EUCAST QC Tables v 16.0](https://www.eucast.org/fileadmin/eucast/pdf/disk_test_documents/2026/v_16.0_EUCAST_QC_tables_routine_and_extended_QC.pdf)
(valid from 2026-01-01; routine, β-lactamase-inhibitor and extended QC strains, disk diffusion only), converted by
`backend/scripts/eucast_qc_pdf_to_json.py` (needs `pdftotext` from poppler-utils) into
`backend/seed/qc/EUCAST-QC-16.0.json` and `frontend/src/qcTables.json`; `frontend/src/qc.ts` and `backend/app/qc.py`
apply them. Every disk of the catalogue (78 distinct antibiotic and content pairs) has a range for at least one strain.

### Photo quality checks

Right after the upload (`backend/app/cv/quality.py`, ported to `frontend/src/browser/cv.ts::photoQuality`), the
photo is checked and non-blocking warnings with tips are shown in the pre-processing step: out of focus (sharpness
of the strongest edges: 99.9th percentile of the Sobel gradient divided by the contrast, on a copy with the plate at
800 px; the variance of the Laplacian was discarded because sensor noise raises it as much as focus), glare
(saturated pixels that are not disk-shaped), plate not found / partly outside the photo / small in the frame (from the
Hough plate detection) and low resolution (plate < 700 px). Thresholds were calibrated on the sample images of
AntibiogramJ and on blurred, noisy, over-exposed, cropped and down-scaled versions of them; `tests/images/1.tiff`
raises no warning, and `npm run validate:cv` checks that the browser gives the same measures as Python.

### Reinterpreting an experiment with another standard

The measured diameters are stored, so **Reinterpret with…** on an experiment page creates a *copy* of the
experiment (organisms, supplementary tests, plates and images) whose results are categorised with the breakpoints
of another standard, with its annotated images redrawn and the expert system applied to the new categories. The
original experiment is not modified. Every copied result keeps its first interpretation (standard and category,
and whether the category had been set by hand), shown in the **Original** column of the experiment and plate pages
and in the Excel export (columns *Standard*, *Original standard*, *Original category*). Manual categories are not
carried over: they were decided with the other breakpoints. The breakpoint of the same case (e.g. "uncomplicated UTI
only") is used when the new standard has it, otherwise the first one; antibiotics or organism groups without a
zone-diameter breakpoint in the new standard become **Not available** (the experiment page says how many).
Antibiotics listed under another drug class in each standard (same name and disk) are matched.

### Expert system

`frontend/src/expertRules.ts` applies EUCAST rules to all the results of an isolate (every plate of an
antibiogram). It runs in the browser in both flavours, is shown under each antibiogram of the experiment page
(**Expert system** panel and **Reported** column) and is included in the Excel export, which the web interface
builds in the browser in both flavours (`frontend/src/excel.ts`; the server endpoint
`/api/experiments/{id}/export.xlsx` remains for API clients, without the expert system).

**Supplementary tests.** Results that cannot be read from the disks are recorded per antibiogram (**Supplementary
tests** in the panel; only the tests relevant to the organism are offered) and used by the rules: D-test (inducible
clindamycin resistance → clindamycin R), mecA/mecC or PBP2a (→ MRSA), vanA/vanB (→ vancomycin/teicoplanin),
ESBL confirmation, ESBL double-disk synergy, AmpC confirmation, the synergy cut-off of the carbapenemase
inhibitor disks, carbapenemase (KPC, MBL, OXA-48) and beta-lactamase of *H. influenzae* (→ ampicillin,
amoxicillin, piperacillin R). **Edit** on an antibiogram changes genus, species, strain, sample and comments
(the family selects the breakpoints and cannot change); the genus/species fields suggest the organisms the rules
know.

| Source | What the app does |
|---|---|
| [Expected Resistant Phenotypes v1.2](https://www.eucast.org/bacteria/important-additional-information/expected-phenotypes/) (2023), tables 1-5 | Susceptible result for an agent the species is expected to be resistant to → *unexpected susceptible*, report R; untestable (no breakpoint) → report R without testing |
| [Expected Susceptible Phenotypes v1.1](https://www.eucast.org/bacteria/important-additional-information/expected-phenotypes/) (2022) | Resistant result where resistance is not expected (e.g. linezolid-R *S. aureus*, ampicillin-R *E. faecalis*) → *unexpected resistant*: check identification/test, reference lab |
| [Expert Rules](https://www.eucast.org/bacteria/important-additional-information/expert-rules/): Enterobacterales v3.3 (2024); *Staphylococcus*, *Enterococcus*, *Streptococcus*, *S. pneumoniae* (Nov 2025); *Haemophilus*, *Moraxella*, *Salmonella*, *Campylobacter*, *Corynebacterium* v3.2 (2019) | Inferences (ampicillin → piperacillin, ciprofloxacin → all fluoroquinolones, cefoxitin screen → MRSA and all beta-lactams, norfloxacin/nalidixic acid/pefloxacin/oxacillin/benzylpenicillin screens, tetracycline → doxycycline/minocycline, ...) and warnings (inducible MLSB/D-test, AmpC derepression, ESBL phenotypes, vanB, high-level aminoglycoside resistance, ...) |
| Breakpoint notes of the standard | Zone diameter inside an Area of Technical Uncertainty (ATU) |

Rules never change the stored measurements: they add messages and a suggested reported category. Rules applied
"regardless of the test result" (and expected resistances) override the measured category; inferences only fill
agents that could not be categorised or were not tested (named in the message). Species-specific rules need the
genus and species of the isolate ("Escherichia" + "coli", or "E. coli" in the species field); with only the family,
the group rules are applied and the panel asks for them. Rules that need an MIC (the standards only have zone
diameter breakpoints) are reported as warnings that ask for it. The engine is
decision support and does not replace the validation of the results by a microbiologist.
`npm run test:rules` runs the rules on synthetic isolates.

### Resistance phenotypes (ESBL, AmpC, carbapenemases, MRSA)

`frontend/src/phenotypes.ts` detects resistance-mechanism phenotypes from the zones of all the plates of an
antibiogram, following the [EUCAST guidelines for detection of resistance mechanisms and specific resistances of
clinical and/or epidemiological importance v2.01](https://www.eucast.org/bacteria/important-additional-information/resistance-detection/)
(July 2017, the current version) and the EUCAST technical guidance on the combination disk test for confirmation of
ESBL (February 2019). Every cut-off in the code cites its section. It runs in the browser in both flavours, is shown
in the **Resistance phenotypes** panel of the experiment and plate pages, and is exported to Excel (a section per
antibiogram and a *Phenotypes* sheet). Results are **presumptive**: they never change the categories, and must be
confirmed (genotypically for carbapenemases and whenever unclear).

| Phenotype | Screening (routine disks) | Phenotypic confirmation |
|---|---|---|
| ESBL, Enterobacterales (chapter 3) | cefotaxime 5 µg <21, ceftriaxone 30 µg <23, ceftazidime 10 µg <22, cefpodoxime 10 µg <21 mm (Table 1) | combination disks ± clavulanic acid 10 µg: increase ≥5 mm (3.4.2 A; CDT 2019). Cefotaxime 5 + ceftazidime 10 µg (group 1); cefepime 30 µg for species with chromosomal AmpC and cefoxitin <19 mm (3.4.1 B, 3.4.3); DDST recorded by the user. False positives (K1 of *K. oxytoca*, ...) and masking by MBL/KPC are noted |
| AmpC, *E. coli*, *K. pneumoniae*, *P. mirabilis*, *Salmonella*, *Shigella* (chapter 4) | cefoxitin 30 µg <19 mm with cefotaxime/ceftazidime R; without cefoxitin, cefepime S (less specific) (4.4) | cloxacillin/boronic acid synergy recorded by the user; *E. coli*/*Shigella* need PCR to tell acquired from chromosomal AmpC |
| Carbapenemases, Enterobacterales (chapter 2) | meropenem 10 µg <28 mm; 25-27 mm only with piperacillin-tazobactam and/or temocillin R; ertapenem <25 mm as an alternative (2.4.1, Table 1) | meropenem 10 µg ± dipicolinic acid/EDTA (MBL), boronic acid (KPC), double inhibitor without cloxacillin synergy (MBL + KPC, whatever the single inhibitors), cloxacillin (AmpC + porin loss); no synergy + temocillin 30 µg <11 mm → OXA-48-like, ≥11 mm → ESBL + porin loss (2.4.2, Figure 1, Table 2). The synergy cut-off comes from the package insert and is chosen per antibiogram (EUCAST does not define it) |
| MRSA, *S. aureus* (chapter 7) | cefoxitin 30 µg <22 mm (7.4.1 B) | mecA/mecC or PBP2a recorded by the user |

The combination disks are appended to the catalogue (`backend/seed/supplementary_disks.json`, class *Resistance
mechanism tests*, ids 89-96, no breakpoints) after the seed standards, so existing ids never change; their codes
(e.g. `CTXCV`, `MRPDP`) are catalogue labels in the OCR lexicon, not verified against manufacturers' disks or photos. Each one is paired with its plain disk of the same content on the
same plate, or on another plate of the antibiogram. Outcomes are *detected*, *not detected*, *screening positive*
(confirmation needed) or *indeterminate* (the panel names the missing test). The results of other methods are
recorded under Supplementary tests and take precedence. A carbapenemase recorded as positive of
unknown type takes its type from the disks when they give one. The phenotypes are computed from the stored measurements
and supplementary tests, so backups and Drive copies carry them without format changes.
`npm run test:phenotypes` runs synthetic cases (positive, negative and indeterminate outcomes of each phenotype).

### Algorithms

Ported 1:1 from the Java code (`backend/app/cv/processing.py`, `matching.py`): Hough plate detection, ImageJ
*Enhance Contrast* (0.35 % saturation), disk detection (mean-shift + V-channel threshold), code recognition (ORB,
ratio 0.7, >10 matches), halo growth by 5 px rings and the S/I/R rules with each standard's operators.
Deliberate differences:

* Halo search starts 5 % outside the disk border (the blurred white disk edge made the original miss clear halos).
* The mm/px scale is the mean diameter of all disks of the plate divided by the disk size (6 mm by default),
  instead of using each disk's own size.
* After cropping, images are analysed at most at 1600 px (configurable).

**Reading the disk codes.** The code printed on each disk (`AK 30`, `CIP 5`...) is read with PaddleOCR's PP-OCRv3
text recogniser (`backend/seed/models/ppocr_rec.onnx`, 4.6 MB) and decoded against a lexicon: the catalogue codes
plus other manufacturers' codes and printed contents (`backend/seed/disk_codes.json`). A reading with confidence
≥ −2 is accepted ("auto"); otherwise the templates are used and the disk is marked "check", with the OCR's three
best codes as one-click suggestions. On the sample plates the OCR reads 24 of 28 distinct disks (57/66 photos),
every auto-accepted reading is right, and with the templates as fallback 27/28 are right. The study, the
alternatives and the numbers are in [docs/disk-reading.md](docs/disk-reading.md); prototypes in
`research/disk_reading/`.

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
npm run build:browser   # static site in dist-browser/ (~31 MB: OpenCV.js, onnxruntime-web and the OCR model)
npm run validate:cv     # checks the OpenCV.js and OCR ports against the Python results (tests/images/1.tiff)
npm run test:rules      # checks the EUCAST expert system on synthetic isolates
npm run test:phenotypes # checks the resistance phenotypes (ESBL, AmpC, carbapenemases, MRSA)
npm run test:drive      # checks the Google Drive client against a mocked Drive API
```

`dist-browser/` can be published on any static host (GitHub Pages, Netlify, a university web server, an
internal share served over HTTP(S)); it uses hash URLs, so no rewrite rules are needed. It must be served over
`http(s)://` — opening `index.html` from the file system does not work (Web Workers and WebAssembly).

* **Installable app (PWA)**: `pwa/plugin.ts` adds the web app manifest and writes `sw.js`, a service worker that
  precaches every built file (app, OpenCV.js, onnxruntime-web, OCR model, templates; ~30 MB) with a version hash,
  so the app works offline and shows an *update available* banner after a new deployment. It can be installed from
  Chrome/Edge (Android, desktop) and from Safari's *Add to Home Screen* (iOS). On iPhone/iPad, installing it also
  keeps Safari from deleting the stored data of a site that has not been used for 7 days; the app requests
  persistent storage as well. The Help page explains installation.
* **Phones**: the photo can be taken directly with the camera (`capture="environment"`); very large photos are
  downscaled in the worker before analysis; the image editor supports pinch-zoom and pan with larger touch targets,
  and the wizard uses a compact step indicator and a sticky action bar on small screens.
* Data lives in the browser's IndexedDB of that site: **Back up** saves everything (experiments, images, learned
  templates) to one `.json` file and **Restore** adds a backup's experiments. Clearing the site data deletes it.
* **Google Drive (optional)**: save/load experiments to the user's own Drive, phone **Capture** mode that sends
  photos to `AntibiogramJ/Inbox`, and an **Inbox** on the computer that opens the wizard with them (plus a local
  multi-photo import queue that needs no cloud). Google Identity Services token model, scope `drive.file` only,
  token kept in memory; no server of ours is involved. Enabled by `VITE_GOOGLE_CLIENT_ID` in
  `frontend/.env.browser`; setup and design in [docs/google-drive.md](docs/google-drive.md). Privacy policy:
  `public-browser/privacy.html`.
* OpenCV.js lacks `pyrMeanShiftFiltering`; `src/browser/cv.ts` implements it following OpenCV's code and it is
  identical pixel by pixel to `cv2.pyrMeanShiftFiltering`. Plate, disks, codes and halos match the Python backend.
* The OCR (`src/browser/ocr.ts`, onnxruntime-web on one WASM thread) and its model are downloaded from the site
  itself the first time a plate is identified, and then cached by the browser. It takes about 1 s per disk.
* Excel files are written by a small dependency-free writer (`src/browser/xlsx.ts`).
* The catalogue (standards, breakpoints, OCR lexicon) and the bundled templates are generated from the backend
  seed with `backend/.venv/bin/python backend/scripts/export_catalog.py` (writes `src/browser/catalog.json` and
  `public-browser/templates/`); `backend/scripts/cv_reference.py` regenerates the reference of `validate:cv`.
  The OCR model is not copied: `vite.config.ts` serves it from `backend/seed/models/`.

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

## License and citation

AntibiogramJ Web is released under the [MIT License](LICENSE). Third-party components (OpenCV.js, ONNX Runtime,
the PaddleOCR-based OCR model…) and the bundled EUCAST data keep their own licences and terms: see
[NOTICE.md](NOTICE.md).

If you use it in your work, please cite it — GitHub's *Cite this repository* button and
[CITATION.cff](CITATION.cff) give the reference. Releases are archived in Zenodo:

* all versions (always resolves to the latest): [10.5281/zenodo.24337999](https://doi.org/10.5281/zenodo.24337999)
* version 2.0.0: [10.5281/zenodo.24338000](https://doi.org/10.5281/zenodo.24338000)

> Heras, J. (2026). *AntibiogramJ Web* (Version 2.0.0) [Computer software]. Zenodo.
> https://doi.org/10.5281/zenodo.24337999

AntibiogramJ Web is a research and teaching tool, not a certified medical device: every result must be checked by
qualified personnel.
