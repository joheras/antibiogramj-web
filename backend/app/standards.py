"""AntibiogramJXML standards: loading and S/I/R categorisation.

Ported from workspace/xml/ReadXMLFile.java and AntibioticReading.setHalosize.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Antibiotic, Breakpoint, Family, Standard

SUSCEPTIBLE = "Susceptible"
INTERMEDIATE = "Intermediate"
RESISTANT = "Resistant"
NOT_AVAILABLE = "Not available"
CATEGORIES = [SUSCEPTIBLE, INTERMEDIATE, RESISTANT, NOT_AVAILABLE]

_EMPTY_DISK = {"-", "", " "}

# Default disk codes (Oxoid/EUCAST style). Users' disks may print other codes;
# the code is only a label, recognition uses the disk images.
ABBREVIATIONS = {
    "Amikacin": "AK", "Amoxicillin-clavulanic acid": "AMC", "Ampicillin": "AMP", "Ampicillin-sulbactam": "SAM",
    "Aztreonam": "ATM", "Benzylpenicillin": "P", "Cefaclor": "CEC", "Cefadroxil": "CFR", "Cefalexin": "CL",
    "Cefazolin": "KZ", "Cefepime": "FEP", "Cefixime": "CFM", "Cefotaxime": "CTX", "Cefoxitin": "FOX",
    "Cefpodoxime": "CPD", "Ceftaroline": "CPT", "Ceftazidime": "CAZ", "Ceftibuten": "CTB", "Ceftobiprole": "BPR",
    "Ceftolozane-tazobactam": "C/T", "Ceftriaxone": "CRO", "Cefuroxime iv": "CXM", "Cefuroxime oral": "CXM",
    "Chloramphenicol": "C", "Ciprofloxacin": "CIP", "Clindamycin": "DA", "Doripenem": "DOR", "Ertapenem": "ETP",
    "Erythromycin": "E", "Fusidic acid": "FD", "Gentamicin": "CN", "Imipenem": "IPM", "Levofloxacin": "LEV",
    "Linezolid": "LZD", "Mecillinam": "MEL", "Meropenem": "MEM", "Minocycline": "MH", "Moxifloxacin": "MXF",
    "Mupirocin": "MUP", "Nalidixic acid": "NA", "Netilmicin": "NET", "Nitrofurantoin": "F", "Norfloxacin": "NOR",
    "Ofloxacin": "OFX", "Oxacillin": "OX", "Pefloxacin": "PEF", "Piperacillin": "PRL",
    "Piperacillin-tazobactam": "TZP", "Quinupristin-dalfopristin": "QD", "Rifampicin": "RD", "Streptomycin": "S",
    "Teicoplanin": "TEC", "Telithromycin": "TEL", "Tetracycline": "TE", "Ticarcillin": "TIC",
    "Ticarcillin-clavulanic acid": "TIM", "Tigecycline": "TGC", "Tobramycin": "TOB", "Trimethoprim": "W",
    "Trimethoprim-sulfamethoxazole": "SXT", "Vancomycin": "VA",
}


def default_code(name: str, disk_content: str) -> str:
    abbreviation = ABBREVIATIONS.get(name)
    if abbreviation is None:
        return f"{name} {disk_content}"
    return abbreviation if len(disk_content) > 6 else f"{abbreviation} {disk_content}"


def _text(el: ET.Element, tag: str) -> str:
    found = el.find(tag)
    return (found.text or "") if found is not None else ""


def _number(value: str) -> float | None:
    try:
        return float(value.strip())
    except ValueError:
        return None


def standard_key(path: Path) -> tuple[str, str]:
    """(name, version) of an AntibiogramJXML file."""
    meta = ET.parse(path).getroot().find("metadata")
    if meta is None:
        raise ValueError("Missing <metadata>")
    return _text(meta, "name").strip(), _text(meta, "version").strip()


def load_standard(db: Session, path: Path, is_default: bool = False,
                  legacy_ids: dict[tuple[str, str, str], int] | None = None) -> Standard:
    """Load an AntibiogramJXML file. Idempotent per (name, version).

    ``legacy_ids`` accumulates the ids the desktop application assigned to
    antibiotics (sequential, in loading order) so template folders can be mapped.
    """
    root = ET.parse(path).getroot()
    meta = root.find("metadata")
    if meta is None:
        raise ValueError("Missing <metadata>")
    name, version = _text(meta, "name").strip(), _text(meta, "version").strip()

    # The same (odd) mapping as the desktop application.
    susceptible_op = ">=" if _text(meta, "susceptibleGTorG").strip() == "GT" else ">"
    resistant_op = "<=" if _text(meta, "resistentLTorL").strip() == "LT" else "<"
    valid_from = None
    if _text(meta, "validFrom").strip():
        valid_from = date.fromisoformat(_text(meta, "validFrom").strip())

    standard = db.scalar(select(Standard).where(Standard.name == name, Standard.version == version))
    already_loaded = standard is not None
    if standard is None:
        standard = Standard(name=name, version=version, valid_from=valid_from, susceptible_op=susceptible_op,
                            resistant_op=resistant_op, is_default=is_default)
        db.add(standard)
        db.flush()

    families = {f.name: f for f in db.scalars(select(Family))}
    antibiotics = {(a.name, a.drug_class, a.disk_content): a for a in db.scalars(select(Antibiotic))}

    for fbp in root.iter("familyBreakPoint"):
        family_name = _text(fbp, "bacteriaFamily").strip()
        family = families.get(family_name)
        if family is None:
            family = families[family_name] = Family(name=family_name)
            db.add(family)
            db.flush()
        for bp in fbp.iter("breakpoint"):
            ab = bp.find("antibiotic")
            if ab is None:
                continue
            raw_key = (_text(ab, "name"), _text(ab, "family"), _text(ab, "diskContent"))
            if raw_key[2] in _EMPTY_DISK:
                continue  # not testable by disk diffusion
            if legacy_ids is not None and raw_key not in legacy_ids:
                legacy_ids[raw_key] = len(legacy_ids)
            key = tuple(s.strip() for s in raw_key)
            antibiotic = antibiotics.get(key)
            if antibiotic is None:
                antibiotic = antibiotics[key] = Antibiotic(
                    name=key[0], drug_class=key[1], disk_content=key[2], code=default_code(key[0], key[2]),
                    legacy_id=legacy_ids.get(raw_key) if legacy_ids is not None else None)
                db.add(antibiotic)
                db.flush()
            if already_loaded:
                continue
            available = _text(bp, "available").strip() != "false"
            s_value = _number(_text(bp, "susceptible")) if available else None
            r_value = _number(_text(bp, "resistant")) if available else None
            if s_value is None or r_value is None:
                s_value = r_value = None
            db.add(Breakpoint(standard_id=standard.id, family_id=family.id, antibiotic_id=antibiotic.id,
                              case=_text(bp, "case").strip(), available=available, susceptible=s_value,
                              resistant=r_value, comments=" ".join(_text(bp, "comments").split())))
    db.flush()
    return standard


def load_supplementary_disks(db: Session, path: Path) -> list[Antibiotic]:
    """Append the disks used only to detect resistance mechanisms (seed/supplementary_disks.json).

    They have no breakpoints (their measurements are "Not available"); idempotent: existing rows are kept.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    existing = {(a.name, a.drug_class, a.disk_content): a for a in db.scalars(select(Antibiotic))}
    added = []
    for disk in data["disks"]:
        key = (disk["name"], data["drug_class"], disk["disk_content"])
        if key not in existing:
            antibiotic = existing[key] = Antibiotic(name=key[0], drug_class=key[1], disk_content=key[2], code=disk["code"])
            db.add(antibiotic)
            db.flush()
            added.append(antibiotic)
    return added


def categorise(diameter: float, breakpoint: Breakpoint | None, standard: Standard) -> str:
    """S/I/R category of an inhibition-zone diameter in mm."""
    if breakpoint is None or not breakpoint.available or breakpoint.susceptible is None \
            or breakpoint.resistant is None:
        return NOT_AVAILABLE
    s, r = breakpoint.susceptible, breakpoint.resistant
    if (standard.susceptible_op == ">=" and diameter >= s) or (standard.susceptible_op == ">" and diameter > s):
        return SUSCEPTIBLE
    if (standard.resistant_op == "<" and diameter < r) or (standard.resistant_op == "<=" and diameter <= r):
        return RESISTANT
    return INTERMEDIATE


# Names the standards adopted later for the same groups (EUCAST and CLSI since 2019); families keep the
# original names in the database so that every standard shares them.
_RENAMED_FAMILIES = [("Enterobacteriaceae", "Enterobacterales"), ("Clostridium difficile", "Clostridioides difficile")]


def family_label(name: str, standard: Standard | None) -> str:
    """The name of a bacteria family as the standard calls it (same as familyLabel in frontend/src/api.ts)."""
    if standard is not None and standard.valid_from is not None and standard.valid_from.isoformat() >= "2019-01-01":
        for old, new in _RENAMED_FAMILIES:
            name = name.replace(old, new)
    return name


def pick_breakpoint(candidates: list[Breakpoint], case: str | None) -> Breakpoint | None:
    """The breakpoint of the same case (e.g. "Uncomplicated UTI") as before, otherwise the first one."""
    return next((b for b in candidates if case and b.case == case), candidates[0] if candidates else None)
