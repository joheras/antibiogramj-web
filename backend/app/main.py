from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, select, text

from .config import BASE_DIR, settings
from .db import Base, SessionLocal, engine
from .models import Standard
from .routers import analysis, auth, catalog, experiments
from .standards import load_standard, standard_key

# Loaded on first start, in the same order as the desktop application so the
# antibiotic ids of the bundled templates (seed/templates/<id>) match. New standards
# are appended (never inserted) so existing ids do not change; the flag marks the
# default standard for new experiments.
SEED_STANDARDS = [("EUCAST-6.0.xml", False), ("CLSI-2015.xml", False), ("EUCAST-16.1.xml", True)]
FRONTEND_DIST = Path(BASE_DIR.parent / "frontend" / "dist")


def init_db() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    add_missing_columns()
    with SessionLocal() as db:
        seed_standards(db)
        analysis.purge_old_uploads(db)


# Columns added after the first release: (table, column, DDL type). create_all() does not add columns to
# existing tables.
ADDED_COLUMNS = [("antibiograms", "supplementary_tests", "JSON")]


def add_missing_columns(bind=None) -> None:
    bind = bind if bind is not None else engine
    inspector = inspect(bind)
    with bind.begin() as conn:
        for table, column, ddl in ADDED_COLUMNS:
            if column not in {c["name"] for c in inspector.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))


def seed_standards(db) -> None:
    """Load the seed standards: all of them in an empty database, otherwise only the
    missing ones (existing standards and their breakpoints are left untouched)."""
    fresh = db.scalar(select(Standard.id).limit(1)) is None
    legacy_ids: dict | None = {} if fresh else None  # template ids only on a first load
    loaded = {(s.name, s.version) for s in db.scalars(select(Standard))}
    added = False
    for filename, is_default in SEED_STANDARDS:
        path = settings.seed_dir / "standards" / filename
        if fresh or standard_key(path) not in loaded:
            load_standard(db, path, is_default, legacy_ids)
            added = added or is_default
    if added:  # a newly seeded default replaces the previous one
        default = next(f for f, d in SEED_STANDARDS if d)
        key = standard_key(settings.seed_dir / "standards" / default)
        for standard in db.scalars(select(Standard)):
            standard.is_default = (standard.name, standard.version) == key
    db.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="AntibiogramJ Web", version="2.0.0", lifespan=lifespan)

if settings.cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


for r in (auth.router, catalog.router, analysis.router, experiments.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Serve the built React application (single-page app) when it exists.
if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        candidate = (FRONTEND_DIST / path).resolve()
        if path and not path.startswith("api/") and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
