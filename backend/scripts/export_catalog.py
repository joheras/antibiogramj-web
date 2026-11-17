"""Export the reference data for the in-browser version of AntibiogramJ.

Loads the seed standards exactly as the server does (same ids) and writes
  frontend/src/browser/catalog.json          standards, families, antibiotics, breakpoints, templates,
                                             disk_codes (OCR lexicon, from seed/disk_codes.json)
  frontend/public-browser/templates/*.png    bundled antibiotic-code templates
The OCR model (seed/models/ppocr_rec.onnx) is served to the browser by vite.config.ts.

Run from backend/:  .venv/bin/python scripts/export_catalog.py
"""

import json
import sys
from pathlib import Path

import cv2
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.config import settings  # noqa: E402
from app.cv.codes import build_lexicon, load_synonyms, printed_content  # noqa: E402
from app.db import Base  # noqa: E402
from app.main import SEED_STANDARDS  # noqa: E402
from app.models import Antibiotic, Breakpoint, Family, Standard  # noqa: E402
from app.standards import load_standard  # noqa: E402

FRONTEND = BACKEND.parent / "frontend"


def rows(db: Session, model, fields: list[str]) -> list[dict]:
    out = []
    for obj in db.scalars(select(model).order_by(model.id)):
        row = {f: getattr(obj, f) for f in fields}
        out.append({k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in row.items()})
    return out


def main() -> None:
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        legacy_ids: dict = {}
        for filename, is_default in SEED_STANDARDS:
            load_standard(db, settings.seed_dir / "standards" / filename, is_default, legacy_ids)
        db.commit()

        catalog = {
            "standards": rows(db, Standard, ["id", "name", "version", "valid_from", "susceptible_op",
                                             "resistant_op", "is_default"]),
            "families": rows(db, Family, ["id", "name"]),
            "antibiotics": rows(db, Antibiotic, ["id", "name", "drug_class", "disk_content", "code"]),
            "breakpoints": rows(db, Breakpoint, ["id", "standard_id", "family_id", "antibiotic_id", "case",
                                                 "available", "susceptible", "resistant", "comments"]),
            "templates": [],
        }
        antibiotics = list(db.scalars(select(Antibiotic).order_by(Antibiotic.id)))
        lexicon = build_lexicon([(a.name, a.code, a.disk_content) for a in antibiotics],
                                load_synonyms(settings.seed_dir / "disk_codes.json"))
        catalog["disk_codes"] = {
            "lexicon": [{"name": e.name, "letters": e.letters, "content": e.content} for e in lexicon],
            "printed": {a.id: printed_content(a.disk_content) for a in antibiotics},
        }

        out_dir = FRONTEND / "public-browser" / "templates"
        out_dir.mkdir(parents=True, exist_ok=True)
        for old in out_dir.glob("*.png"):
            old.unlink()
        by_legacy = {a.legacy_id: a.id for a in db.scalars(select(Antibiotic).where(Antibiotic.legacy_id.isnot(None)))}
        for folder in sorted((settings.seed_dir / "templates").iterdir(), key=lambda p: p.name):
            if not folder.name.isdigit() or int(folder.name) not in by_legacy:
                continue
            antibiotic_id = by_legacy[int(folder.name)]
            for i, f in enumerate(sorted(folder.iterdir())):
                image = cv2.imread(str(f), cv2.IMREAD_COLOR)
                if image is None:
                    continue
                name = f"{antibiotic_id}_{i}.png"
                cv2.imwrite(str(out_dir / name), image, [cv2.IMWRITE_PNG_COMPRESSION, 9])
                catalog["templates"].append({"antibiotic_id": antibiotic_id, "path": f"templates/{name}"})

    target = FRONTEND / "src" / "browser" / "catalog.json"
    target.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(catalog['breakpoints'])} breakpoints, {len(catalog['templates'])} templates, "
          f"{len(catalog['disk_codes']['lexicon'])} disk codes -> {target}")


if __name__ == "__main__":
    main()
