"""Lexicon of the codes printed on antibiotic disks.

Every catalogue antibiotic contributes its abbreviation and printed content
(``code`` = "AK 30"); ``seed/disk_codes.json`` adds the codes of other
manufacturers and the contents of other standards. The OCR reader only
outputs entries of this lexicon (see :mod:`.reading`).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

LETTERS = re.compile(r"^[A-Z][A-Z/]{0,4}$")


def printed_content(content: str) -> str:
    """Catalogue disk content -> what is printed on the disk ("20-10" -> "30", "1 unit" -> "1")."""
    content = content.replace("unit", "").replace("µg", "").strip()
    parts = [p for p in re.split(r"[-/+]", content) if p.strip()]
    try:
        total = sum(float(p) for p in parts)
    except ValueError:
        return re.sub(r"[^0-9]", "", content)
    return str(int(round(total))) if abs(total - round(total)) < 1e-6 or total > 20 else f"{total:g}".replace(".", "")


@dataclass(frozen=True)
class Entry:
    name: str        # catalogue antibiotic name
    letters: str     # printed abbreviation, e.g. "AK" or "F/M"
    content: str     # printed content, e.g. "30"

    @property
    def text(self) -> str:
        """What the recogniser should read, in reading order and without separators."""
        return self.letters.replace("/", "") + self.content

    @property
    def code(self) -> str:
        return f"{self.letters} {self.content}"


def load_synonyms(path: Path) -> dict[str, dict[str, list[str]]]:
    return json.loads(path.read_text(encoding="utf-8"))["antibiotics"] if path.is_file() else {}


def build_lexicon(antibiotics: Iterable[tuple[str, str, str]], synonyms: dict[str, dict[str, list[str]]]) -> list[Entry]:
    """``antibiotics``: ``(name, code, disk_content)`` of the catalogue rows."""
    letters: dict[str, set[str]] = {}
    contents: dict[str, set[str]] = {}
    for name, code, disk_content in antibiotics:
        abbreviation = code.split(" ")[0]
        letters.setdefault(name, set())
        if LETTERS.match(abbreviation):   # newer EUCAST rows have the full name as code
            letters[name].add(abbreviation)
        contents.setdefault(name, set()).add(printed_content(disk_content))
    for name, syn in synonyms.items():
        if name in letters:
            letters[name] |= set(syn.get("codes", []))
            contents[name] |= set(syn.get("contents", []))
    entries = {Entry(name, ls, c) for name in letters for ls in letters[name] for c in contents[name] if c}
    return sorted(entries, key=lambda e: (e.name, e.letters, e.content))
