"""Template store for antibiotic-code recognition.

Shared templates come from the desktop application (``seed/templates/<legacy
id>/*.tif``); learned templates are stored per user. Descriptors are cached in
memory because computing them dominates the matching time.
"""

from __future__ import annotations

import threading
from pathlib import Path

import cv2
import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import storage
from .config import settings
from .cv.matching import Template, descriptors
from .cv.processing import keep_only_letters
from .models import Antibiotic, LearnedTemplate

_lock = threading.Lock()
_shared: list[Template] | None = None
_learned: dict[int, list[Template]] = {}


def _load_shared(db: Session) -> list[Template]:
    by_legacy = {a.legacy_id: a.id for a in db.scalars(select(Antibiotic).where(Antibiotic.legacy_id.isnot(None)))}
    templates = []
    root: Path = settings.seed_dir / "templates"
    if root.is_dir():
        for folder in sorted(root.iterdir()):
            if not folder.is_dir() or not folder.name.isdigit() or int(folder.name) not in by_legacy:
                continue
            for f in sorted(folder.iterdir()):
                image = cv2.imread(str(f), cv2.IMREAD_COLOR)
                if image is not None:
                    templates.append(Template(by_legacy[int(folder.name)], descriptors(image)))
    return templates


def templates_for(db: Session, user_id: int) -> list[Template]:
    global _shared
    # Another worker process may have learned new templates for this user.
    stored = db.scalar(select(func.count()).select_from(LearnedTemplate).where(LearnedTemplate.owner_id == user_id))
    with _lock:
        if _shared is None:
            _shared = _load_shared(db)
        if user_id not in _learned or len(_learned[user_id]) != stored:
            learned = []
            for t in db.scalars(select(LearnedTemplate).where(LearnedTemplate.owner_id == user_id)):
                try:
                    learned.append(Template(t.antibiotic_id, descriptors(storage.load_image(t.path))))
                except FileNotFoundError:
                    continue
            _learned[user_id] = learned
        return _shared + _learned[user_id]


def learn(db: Session, user_id: int, antibiotic_id: int, disk_image: np.ndarray) -> None:
    """Store a confirmed disk code as a new template (max N per antibiotic and user)."""
    count = db.scalar(select(func.count()).select_from(LearnedTemplate).where(
        LearnedTemplate.owner_id == user_id, LearnedTemplate.antibiotic_id == antibiotic_id))
    if count >= settings.templates_per_antibiotic or disk_image.size == 0:
        return
    letters = keep_only_letters(disk_image)
    rel = storage.new_rel_path(f"templates/{user_id}")
    storage.save_image(letters, rel)
    db.add(LearnedTemplate(owner_id=user_id, antibiotic_id=antibiotic_id, path=rel))
    with _lock:
        if user_id in _learned:
            _learned[user_id].append(Template(antibiotic_id, descriptors(letters)))
