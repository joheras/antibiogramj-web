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
| Standards EUCAST 6.0 + CLSI 2015 (AntibiogramJXML) | Same files, loaded on first start |
| Export experiment to Excel | `.xlsx` with a summary sheet + one sheet per antibiogram |

Not yet ported: searches (by antibiotic / strains / antibiograms), editable abbreviations, loading new standards
from the UI, import/export of experiments as files, the expert-rules system.

### Algorithms

Ported 1:1 from the Java code (`backend/app/cv/processing.py`, `matching.py`): Hough plate detection, ImageJ
*Enhance Contrast* (0.35 % saturation), disk detection (mean-shift + V-channel threshold), code recognition (ORB,
ratio 0.7, >10 matches), halo growth by 5 px rings and the S/I/R rules with each standard's operators.
Deliberate differences:

* Halo search starts 5 % outside the disk border (the blurred white disk edge made the original miss clear halos).
* The mm/px scale is the mean diameter of all disks of the plate divided by the disk size (6 mm by default),
  instead of using each disk's own size.
* After cropping, images are analysed at most at 1600 px (configurable).

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
