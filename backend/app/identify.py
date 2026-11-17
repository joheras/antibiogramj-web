"""Which antibiotic is each disk? OCR of the printed code, templates as fallback (docs/disk-reading.md).

For every disk:
1. OCR reading with confidence >= ``settings.ocr_auto_accept``: accepted.
2. Otherwise the templates (shared + learned from the user's corrections), if
   they recognise the disk; the result is marked for review.
3. Otherwise nothing is chosen. In every case the OCR's best candidates are
   returned as suggestions.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .cv.codes import Entry, build_lexicon, load_synonyms, printed_content
from .cv.matching import best_match
from .cv.reading import Reading, get_reader
from .models import Antibiotic, Breakpoint
from .schemas import Identification, Suggestion
from .templates import templates_for

_lexicons: dict[tuple, tuple[Entry, ...]] = {}


def lexicon(antibiotics: list[Antibiotic]) -> tuple[Entry, ...]:
    rows = tuple(sorted((a.name, a.code, a.disk_content) for a in antibiotics))
    if rows not in _lexicons:
        _lexicons.clear()
        _lexicons[rows] = tuple(build_lexicon(rows, load_synonyms(settings.seed_dir / "disk_codes.json")))
    return _lexicons[rows]


class Resolver:
    """Lexicon entry -> catalogue antibiotic id.

    Several catalogue rows can share a name (Ampicillin 10 / 2, or one row per
    drug class). Preference: same printed content, then a breakpoint for the
    plate's standard and bacteria family, then the lowest id.
    """

    def __init__(self, antibiotics: list[Antibiotic], with_breakpoints: set[int]):
        self.by_name: dict[str, list[Antibiotic]] = {}
        for a in antibiotics:
            self.by_name.setdefault(a.name, []).append(a)
        self.with_breakpoints = with_breakpoints

    def __call__(self, entry: Entry) -> int | None:
        rows = self.by_name.get(entry.name)
        if not rows:
            return None
        return min(rows, key=lambda a: (printed_content(a.disk_content) != entry.content,
                                        a.id not in self.with_breakpoints, a.id)).id


def identify_disks(db: Session, user_id: int, crops: list[np.ndarray], family_id: int | None = None,
                   standard_id: int | None = None) -> list[Identification]:
    antibiotics = list(db.scalars(select(Antibiotic)))
    with_breakpoints: set[int] = set()
    if family_id is not None and standard_id is not None:
        with_breakpoints = set(db.scalars(select(Breakpoint.antibiotic_id).where(
            Breakpoint.standard_id == standard_id, Breakpoint.family_id == family_id)))
    resolve = Resolver(antibiotics, with_breakpoints)
    templates = templates_for(db, user_id)
    reader = get_reader(settings.seed_dir / "models" / "ppocr_rec.onnx") if settings.ocr_enabled else None
    lex = lexicon(antibiotics) if reader else ()

    def one(crop: np.ndarray) -> Identification:
        if crop.size == 0:
            return Identification(antibiotic_id=None, score=0, review=True)
        template_id, score = best_match(crop, templates)
        if reader is None:   # OCR not available: templates only, as before
            return Identification(antibiotic_id=template_id, score=score, source="template" if template_id else None)
        reading: Reading = reader.read(crop, lex)
        suggestions: list[Suggestion] = []
        for c in reading.candidates:
            aid = resolve(c.entry)
            if aid is not None and all(s.antibiotic_id != aid for s in suggestions):
                suggestions.append(Suggestion(antibiotic_id=aid, code=c.entry.code, confidence=c.confidence))
        best = reading.best
        out = Identification(antibiotic_id=None, score=score, review=True, suggestions=suggestions,
                             code_read=best.entry.code if best else None, text_read=reading.free_text or None,
                             confidence=best.confidence if best else None)
        if best and suggestions and best.confidence >= settings.ocr_auto_accept:
            out.antibiotic_id, out.source, out.review = suggestions[0].antibiotic_id, "ocr", False
        elif template_id is not None:
            out.antibiotic_id, out.source = template_id, "template"
        return out

    with ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(one, crops))
