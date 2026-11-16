"""Convert the official EUCAST "Clinical breakpoint tables" workbook into AntibiogramJXML.

Only the zone diameter (disk diffusion) breakpoints are used. Antibiotic names, drug
classes and disk contents of EUCAST-6.0.xml are reused whenever the drug and the disk
are the same, so the antibiotics (and their recognition templates) are shared.

Usage (from backend/):
  .venv/bin/python scripts/eucast_xlsx_to_xml.py v_16.1_Breakpoint_Tables.xlsx seed/standards/EUCAST-16.1.xml

Needs openpyxl (rich text is used to tell note superscripts apart from values).
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

import openpyxl
from openpyxl.cell.rich_text import CellRichText, TextBlock

SEED = Path(__file__).resolve().parent.parent / "seed" / "standards"

# Workbook sheet -> bacteria family. Existing EUCAST-6.0 names are kept for the same
# organism groups so experiments can switch standards without changing the family.
SHEETS = {
    "Enterobacterales": "Enterobacteriaceae",
    "Pseudomonas": "Pseudomonas spp.",
    "S.maltophilia": "Stenotrophomonas maltophilia",
    "Acinetobacter": "Acinetobacter spp.",
    "Staphylococcus": "Staphylococcus spp.",
    "Enterococcus": "Enterococcus spp.",
    "Streptococcus A,B,C,G": "Streptococcus groups A, B, C and G",
    "S.pneumoniae": "Streptococcus pneumoniae",
    "Viridans group streptococci": "Viridans group streptococci",
    "H.influenzae": "Haemophilus influenzae",
    "M.catarrhalis": "Moraxella catarrhalis",
    "Anaerobic bacteria_G-negative": "Gram-negative anaerobes",
    # Only the C. difficile sub-table has no zone diameter breakpoints (IP), so the old
    # name still describes the disk diffusion breakpoints.
    "Anaerobic bacteria_G-positive": "Gram-positive anaerobes except Clostridium difficile",
    "L.monocytogenes": "Listeria monocytogenes",
    "Pasteurella": "Pasteurella multocida",
    "C.jejuni_C.coli": "Campylobacter jejuni and coli",
    "Corynebacterium": "Corynebacterium spp.",
    "C.diphtheriae_C.ulcerans": "Corynebacterium diphtheriae and C. ulcerans",
    "A.sanguinicola_A.urinae": "Aerococcus sanguinicola and A. urinae",
    "K.kingae": "Kingella kingae",
    "Aeromonas": "Aeromonas spp.",
    "A.xylosoxidans": "Achromobacter xylosoxidans",
    "Vibrio": "Vibrio spp.",
    "Bacillus": "Bacillus spp. (except B. anthracis)",
    "B.anthracis": "Bacillus anthracis",
    "B.melitensis": "Brucella melitensis",
    "B.pseudomallei": "Burkholderia pseudomallei",
    "B.cepacia": "Burkholderia cepacia complex",
    "L.pneumophila": "Legionella pneumophila",
    "N.gonorrhoeae": "Neisseria gonorrhoeae",
    "N.meningitidis": "Neisseria meningitidis",
    "H.pylori": "Helicobacter pylori",
    "M.tuberculosis": "Mycobacterium tuberculosis",
}

# "Ampicillin iv" is one disk with two indications; these route-named agents are
# separate antibiotics in EUCAST-6.0 and keep their names.
KEEP_ROUTE_IN_NAME = {"Cefuroxime iv", "Cefuroxime oral", "Fosfomycin iv", "Fosfomycin oral"}
ROUTES = (" iv", " oral")


def space(text: str) -> str:
    return " ".join(text.replace("/ ", " ").split())


def split_cell(value) -> tuple[str, list[str]]:
    """Cell value -> (main text, superscript note keys)."""
    if value is None:
        return "", []
    if isinstance(value, CellRichText):
        main, sup = [], []
        for block in value:
            if isinstance(block, TextBlock) and block.font is not None and block.font.vertAlign == "superscript":
                sup.append(block.text)
            else:
                main.append(block.text if isinstance(block, TextBlock) else str(block))
        keys = [k.strip() for s in sup for k in s.split(",") if k.strip()]
        return " ".join("".join(main).split()), keys
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return " ".join(str(value).split()), []


def parse_notes(text: str) -> dict[str, str]:
    """'1. foo / 2/A. bar / B. baz' -> {'1': 'foo', '2': 'bar', 'A': 'bar', 'B': 'baz'}."""
    notes: dict[str, str] = {}
    current: list[str] = []
    for line in text.split("\n"):
        m = re.match(r"^\s*((?:\d+|[A-Z])(?:/(?:\d+|[A-Z]))*)\.\s+(.*)$", line)
        if m:
            current = m.group(1).split("/")
            for key in current:
                notes[key] = m.group(2).strip()
        elif current and line.strip():
            for key in current:
                notes[key] += " " + line.strip()
    return {k: " ".join(v.split()) for k, v in notes.items()}


def number(text: str) -> tuple[float | None, bool]:
    """'14' -> (14, False); '(18)' -> (18, True); 'IE' -> (None, False)."""
    m = re.fullmatch(r"(\()?\s*(\d+(?:\.\d+)?)\s*(\))?", text)
    if not m:
        return None, False
    return float(m.group(2)), bool(m.group(1))


def fmt(x: float) -> str:
    return str(int(x)) if x.is_integer() else str(x)


def legacy_vocabulary():
    """(family, name, disk) -> class and (name, disk) -> most used class, from EUCAST-6.0."""
    root = ET.parse(SEED / "EUCAST-6.0.xml").getroot()
    by_family, by_drug = {}, defaultdict(Counter)
    for fbp in root.iter("familyBreakPoint"):
        family = fbp.findtext("bacteriaFamily").strip()
        for ab in fbp.iter("antibiotic"):
            name, cls, disk = (ab.findtext(t).strip() for t in ("name", "family", "diskContent"))
            if disk in ("-", ""):
                continue
            by_family[(family, name, disk)] = cls
            by_drug[(name, disk)][cls] += 1
    return by_family, {k: c.most_common(1)[0][0] for k, c in by_drug.items()}


def drug_and_case(label: str) -> tuple[str, str]:
    cut = len(label)
    for sep in (" (", ","):
        i = label.find(sep)
        if i != -1:
            cut = min(cut, i)
    name, rest = label[:cut].strip(), label[cut:].strip().lstrip(",").strip()
    if name not in KEEP_ROUTE_IN_NAME:
        for route in ROUTES:
            if name.endswith(route):
                name, rest = name[: -len(route)], (route.strip() + " " + rest).strip()
    return name, rest


def read_sheet(ws):
    """Yield rows {group, cls, label_notes, name, case, mic, disk, zone_s, zone_r, zone_atu, notes}."""
    merged = {}
    for rng in ws.merged_cells.ranges:
        top = ws.cell(rng.min_row, rng.min_col).value
        for r in range(rng.min_row, rng.max_row + 1):
            for c in range(rng.min_col, rng.max_col + 1):
                merged[(r, c)] = top

    def cell(r, c):
        return merged.get((r, c), ws.cell(r, c).value)

    group, last_title, cls, notes, in_table = "", "", "", {}, False
    for r in range(1, ws.max_row + 1):
        a, _ = split_cell(cell(r, 1))
        e, _ = split_cell(cell(r, 5))
        if e.startswith("Disk content"):
            cls = a if a != "Antimicrobial agent" else ""
            group, in_table, notes = last_title, True, {}
            continue
        if not in_table:
            others = [split_cell(cell(r, c))[0] for c in range(2, 10)]
            if a and not any(others) and r > 7 and len(a) < 120 and not a.startswith(("*", "Examples", "http")):
                last_title = a
            continue
        if split_cell(cell(r, 2))[0] == "S ≤":
            continue
        if not a:
            in_table = False
            continue
        label, label_notes = split_cell(cell(r, 1))
        raw_notes = cell(r, 9)
        if raw_notes is not None and str(raw_notes).strip():
            text = str(raw_notes) if not isinstance(raw_notes, CellRichText) else "".join(
                b.text if isinstance(b, TextBlock) else str(b) for b in raw_notes)
            notes = parse_notes(text)
        name, case = drug_and_case(space(label))
        disk, disk_notes = split_cell(cell(r, 5))
        zs, zs_notes = split_cell(cell(r, 6))
        zr, zr_notes = split_cell(cell(r, 7))
        if zs.startswith("Note") and zs_notes:
            zs, zr = zs + ",".join(zs_notes), zr + ",".join(zr_notes)
        zatu, _ = split_cell(cell(r, 8))
        yield dict(group=group, cls=re.sub(r"\d+$", "", cls).strip(), name=name, case=case,
                   label_notes=label_notes, disk=disk, disk_notes=disk_notes, zs=zs, zr=zr,
                   zone_notes=list(dict.fromkeys(zs_notes + zr_notes)), zatu=zatu, notes=notes)


def convert(xlsx: Path, version: str, valid_from: str) -> ET.Element:
    wb = openpyxl.load_workbook(xlsx, rich_text=True)
    by_family, by_drug = legacy_vocabulary()
    class_of = {}
    sheets = {name.strip(): wb[name] for name in wb.sheetnames}
    rows_by_family = {}
    for sheet, family in SHEETS.items():
        rows = list(read_sheet(sheets[sheet]))
        rows_by_family[family] = rows
        for row in rows:
            if row["cls"]:
                class_of.setdefault(row["name"], row["cls"])

    root = ET.Element("standard")
    meta = ET.SubElement(root, "metadata")
    for tag, text in (("name", "EUCAST"), ("version", version), ("validFrom", valid_from),
                      ("susceptibleGTorG", "GT"), ("resistentLTorL", "L")):
        ET.SubElement(meta, tag).text = text
    bps = ET.SubElement(root, "breakpoints")
    report = Counter()
    for family, rows in rows_by_family.items():
        if not any(number(r["zs"])[0] is not None and r["disk"] for r in rows):
            continue  # no zone diameter breakpoint at all for this group
        fbp = ET.SubElement(bps, "familyBreakPoint")
        ET.SubElement(fbp, "bacteriaFamily").text = family
        for row in rows:
            name, disk = row["name"], row["disk"] or "-"
            cls = (by_family.get((family, name, disk)) or by_drug.get((name, disk))
                   or row["cls"] or class_of.get(name, "Miscellaneous agents"))
            s, s_br = number(row["zs"])
            rr, r_br = number(row["zr"])
            available = disk != "-" and s is not None and rr is not None
            notes = row["notes"]
            comments = []
            if row["zatu"]:
                comments.append(f"Area of Technical Uncertainty (ATU): {row['zatu']} mm. Results in the ATU are "
                                "uncertain; see the EUCAST guidance on technical uncertainty before reporting.")
            if available and s == 50:
                comments.append("S ≥ 50 mm is an off-scale breakpoint: wild-type isolates are categorised as "
                                "\"Susceptible, increased exposure\" (I); never report \"Susceptible, standard "
                                "dosing regimen\" (S).")
            if s_br or r_br:
                comments.append("Breakpoints in brackets (ECOFF based): they distinguish isolates with and without "
                                "phenotypically detectable resistance. Isolates with resistance can be reported R; "
                                "avoid reporting S or I without a comment.")
            if not available:
                value = row["zs"] or "-"
                comments.append({"-": "Dash: the agent is unsuitable for this organism group; testing and clinical "
                                      "use should be avoided (report resistant if included).",
                                 "IE": "IE: insufficient evidence that the organism is a good target for therapy "
                                       "with the agent.",
                                 "NA": "NA: not applicable.",
                                 "IP": "IP: zone diameter breakpoints in preparation."}.get(
                    value, "No zone diameter breakpoint (see note)." if value.startswith("Note")
                    else f"No zone diameter breakpoint ({value})."))
            keys = list(dict.fromkeys(row["label_notes"] + row["disk_notes"] + row["zone_notes"]
                                      + re.findall(r"[0-9]+|[A-Z]", row["zs"][4:] if row["zs"].startswith("Note") else "")))
            for key in keys:
                if key in notes and notes[key] not in comments:
                    comments.append(f"{key}. {notes[key]}")
            case = "; ".join(x for x in (row["group"], row["case"]) if x)
            bp = ET.SubElement(fbp, "breakpoint")
            ab = ET.SubElement(bp, "antibiotic")
            ET.SubElement(ab, "name").text = name
            ET.SubElement(ab, "family").text = cls
            ET.SubElement(ab, "diskContent").text = disk
            ET.SubElement(bp, "case").text = case
            ET.SubElement(bp, "available").text = "true" if available else "false"
            ET.SubElement(bp, "susceptible").text = fmt(s) if available else (row["zs"] or "-")
            ET.SubElement(bp, "resistant").text = fmt(rr) if available else (row["zr"] or "-")
            ET.SubElement(bp, "comments").text = " ".join(comments)
            report["available" if available else "unavailable"] += 1
    print(dict(report), file=sys.stderr)
    return root


def main() -> None:
    xlsx, out = Path(sys.argv[1]), Path(sys.argv[2])
    wb = openpyxl.load_workbook(xlsx, read_only=True)
    banner = str(wb["Notes"]["A3"].value)
    m = re.search(r"Version\s+([\d.]+),\s*valid from\s+(\d{4}-\d{2}-\d{2})", banner)
    if not m:
        raise SystemExit(f"Cannot find version in {banner!r}")
    root = convert(xlsx, m.group(1), m.group(2))
    ET.indent(root, space="    ")
    body = ET.tostring(root, encoding="unicode")
    out.write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                   f"<!-- Generated by backend/scripts/eucast_xlsx_to_xml.py from the EUCAST Clinical Breakpoint "
                   f"Tables v. {m.group(1)} (valid from {m.group(2)}), https://www.eucast.org/clinical_breakpoints -->\n"
                   + body + "\n", encoding="utf-8")
    print(f"EUCAST {m.group(1)} -> {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
