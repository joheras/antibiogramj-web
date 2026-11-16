"""Lexicon of printed disk codes and fuzzy matching of OCR output against it.

The lexicon is built from the catalogue (frontend/src/browser/catalog.json,
code = "<abbreviation> <content>") plus a synonym table with the codes other
manufacturers print on their cartridges. Synonyms marked ``?`` are from
memory and must be checked against the manufacturers' catalogues before
being shipped (Oxoid/Thermo, BD BBL Sensi-Disc, Liofilchem, Bio-Rad, Mast,
Rosco Neo-Sensitabs, HiMedia...).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[2] / "frontend/src/browser/catalog.json"

# antibiotic name -> extra letter codes (other manufacturers) and extra printed
# contents (e.g. CLSI disk contents, which differ from EUCAST ones).
SYNONYMS: dict[str, dict[str, list[str]]] = {
    "Amikacin": {"codes": ["AN", "AMK"], "contents": ["30"]},
    "Gentamicin": {"codes": ["GM", "GEN", "GN"], "contents": ["10", "30", "120"]},
    "Tobramycin": {"codes": ["NN", "TM"], "contents": ["10"]},
    "Ampicillin": {"codes": ["AM"], "contents": ["10", "2"]},
    "Amoxicillin-clavulanic acid": {"codes": ["AMC", "AUG", "XL"], "contents": ["30", "3"]},
    "Cefotaxime": {"codes": ["CTX"], "contents": ["30", "5"]},
    "Ceftazidime": {"codes": ["CAZ"], "contents": ["30", "10"]},
    "Ceftriaxone": {"codes": ["CRO", "AXO"], "contents": ["30"]},
    "Cefazolin": {"codes": ["CZ", "KZ"], "contents": ["30"]},
    "Cefuroxime iv": {"codes": ["CXM"], "contents": ["30"]},
    "Clindamycin": {"codes": ["CC", "CD", "CM"], "contents": ["2"]},
    "Imipenem": {"codes": ["IMP", "IMI"], "contents": ["10"]},
    "Meropenem": {"codes": ["MRP", "MEM"], "contents": ["10"]},
    "Levofloxacin": {"codes": ["LVX", "LE"], "contents": ["5"]},
    "Nitrofurantoin": {"codes": ["FM", "F/M", "NIT"], "contents": ["300", "100"]},
    "Piperacillin": {"codes": ["PIP"], "contents": ["100", "30"]},
    "Piperacillin-tazobactam": {"codes": ["TZP", "PTZ"], "contents": ["110", "36"]},
    "Ampicillin-sulbactam": {"codes": ["SAM"], "contents": ["20"]},
    "Rifampicin": {"codes": ["RA", "RIF"], "contents": ["5"]},
    "Trimethoprim": {"codes": ["TMP"], "contents": ["5"]},
    "Trimethoprim-sulfamethoxazole": {"codes": ["SXT", "TS"], "contents": ["25"]},
    "Minocycline": {"codes": ["MI", "MIN"], "contents": ["30"]},
    "Fusidic acid": {"codes": ["FA", "FC"], "contents": ["10"]},
    "Quinupristin-dalfopristin": {"codes": ["SYN"], "contents": ["15"]},
    "Benzylpenicillin": {"codes": ["P", "PG"], "contents": ["10", "1"]},
    "Oxacillin": {"codes": ["OX"], "contents": ["1"]},
    "Vancomycin": {"codes": ["VA"], "contents": ["30", "5"]},
    "Tetracycline": {"codes": ["TE"], "contents": ["30"]},
    "Erythromycin": {"codes": ["E"], "contents": ["15"]},
    "Chloramphenicol": {"codes": ["C"], "contents": ["30"]},
    "Nalidixic acid": {"codes": ["NA"], "contents": ["30"]},
    "Ciprofloxacin": {"codes": ["CIP"], "contents": ["5"]},
    "Cefoxitin": {"codes": ["FOX"], "contents": ["30"]},
    "Linezolid": {"codes": ["LZD", "LNZ"], "contents": ["30", "10"]},
}


def printed_content(content: str) -> str:
    """Catalogue content -> what is usually printed ("20-10" -> "30", "1 unit" -> "1")."""
    content = content.replace("unit", "").replace("µg", "").strip()
    parts = [p for p in re.split(r"[-/+]", content) if p.strip()]
    try:
        total = sum(float(p) for p in parts)
    except ValueError:
        return content.replace(" ", "")
    return str(int(round(total))) if abs(total - round(total)) < 1e-6 or total > 20 else f"{total:g}"


@dataclass(frozen=True)
class Entry:
    name: str          # antibiotic name (catalogue)
    letters: str       # printed abbreviation, e.g. "AK"
    content: str       # printed content, e.g. "30"

    @property
    def text(self) -> str:
        return self.letters.replace("/", "") + self.content


@lru_cache
def lexicon() -> tuple[Entry, ...]:
    catalog = json.loads(CATALOG.read_text())
    entries: set[Entry] = set()
    for a in catalog["antibiotics"]:
        letters = a["code"].split(" ")[0] if " " in a["code"] else a["code"]
        contents = {printed_content(a["disk_content"])}
        syn = SYNONYMS.get(a["name"], {})
        contents |= set(syn.get("contents", []))
        for code in {letters, *syn.get("codes", [])}:
            for c in contents:
                entries.add(Entry(a["name"], code, c))
    return tuple(sorted(entries, key=lambda e: (e.name, e.letters, e.content)))


# Characters OCR engines confuse on these fonts: substitution is cheap.
_CONFUSABLE = {frozenset(p) for p in ["0O", "0D", "1I", "1L", "5S", "8B", "2Z", "6G", "OD", "OQ", "CG", "EF", "KX", "NM", "PR"]}


def _sub_cost(a: str, b: str) -> float:
    if a == b:
        return 0.0
    return 0.4 if frozenset((a, b)) in _CONFUSABLE else 1.0


def edit_distance(a: str, b: str) -> float:
    prev = [float(j) for j in range(len(b) + 1)]
    for i in range(1, len(a) + 1):
        cur = [float(i)] + [0.0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + _sub_cost(a[i - 1], b[j - 1]))
        prev = cur
    return prev[-1]


def similarity(read: str, expected: str) -> float:
    if not read or not expected:
        return 0.0
    return max(0.0, 1.0 - edit_distance(read, expected) / max(len(read), len(expected)))


def clean(text: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", text.upper())


def best_entries(text: str, k: int = 3) -> list[tuple[float, Entry]]:
    """Rank lexicon entries for one OCR reading (letters weigh more than content)."""
    text = clean(text)
    if not text:
        return []
    scored = []
    for e in lexicon():
        full = similarity(text, e.text)
        # Reading split into letters / digits; the abbreviation is what matters.
        m = re.match(r"^([A-Z]*)(.*)$", text)
        letters_read = m.group(1) if m else text
        letters = similarity(letters_read, e.letters.replace("/", ""))
        score = 0.6 * full + 0.4 * letters
        scored.append((score, e))
    scored.sort(key=lambda t: -t[0])
    return scored[:k]
