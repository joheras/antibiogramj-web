from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .config import BASE_DIR, settings
from .db import Base, SessionLocal, engine
from .models import Standard
from .routers import analysis, auth, catalog, experiments
from .standards import load_standard

# Loaded on first start, in the same order as the desktop application so the
# antibiotic ids of the bundled templates (seed/templates/<id>) match.
SEED_STANDARDS = [("EUCAST-6.0.xml", True), ("CLSI-2015.xml", False)]
FRONTEND_DIST = Path(BASE_DIR.parent / "frontend" / "dist")


def init_db() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if db.scalar(select(Standard.id).limit(1)) is None:
            legacy_ids: dict = {}
            for filename, is_default in SEED_STANDARDS:
                load_standard(db, settings.seed_dir / "standards" / filename, is_default, legacy_ids)
            db.commit()
        analysis.purge_old_uploads(db)


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
