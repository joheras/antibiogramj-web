"""Convert the EUCAST QC Tables (PDF) into the zone-diameter QC ranges used by AntibiogramJ.

Source: "Routine and extended internal quality control for MIC determination and disk diffusion as
recommended by EUCAST", Version 16.0, valid from 2026-01-01
https://www.eucast.org/fileadmin/eucast/pdf/disk_test_documents/2026/v_16.0_EUCAST_QC_tables_routine_and_extended_QC.pdf

EUCAST publishes the QC tables only as a PDF (generated from Excel). The words are read with their
positions (``pdftotext -bbox``, poppler-utils) so that note superscripts (smaller font) are dropped and
every value is assigned to its column. Only the disk-diffusion columns are kept (disk content, zone
diameter target and range); MIC values are ignored.

Writes the same JSON to
  backend/seed/qc/EUCAST-QC-16.0.json   (server: Excel export of the API)
  frontend/src/qcTables.json             (both flavours: views and Excel export of the web interface)

Run from backend/:  python scripts/eucast_qc_pdf_to_json.py path/to/v_16.0_EUCAST_QC_tables_routine_and_extended_QC.pdf
"""

import json
import re
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

BACKEND = Path(__file__).resolve().parent.parent
OUTPUTS = [BACKEND / "seed" / "qc" / "EUCAST-QC-16.0.json", BACKEND.parent / "frontend" / "src" / "qcTables.json"]

META = {
    "name": "EUCAST QC Tables",
    "version": "16.0",
    "valid_from": "2026-01-01",
    "url": "https://www.eucast.org/fileadmin/eucast/pdf/disk_test_documents/2026/"
           "v_16.0_EUCAST_QC_tables_routine_and_extended_QC.pdf",
    "citation": "The European Committee on Antimicrobial Susceptibility Testing. Routine and extended internal "
                "quality control for MIC determination and disk diffusion as recommended by EUCAST. "
                "Version 16.0, 2026. http://www.eucast.org.",
}

SUPERSCRIPT_MAX_HEIGHT = 6.0  # pt; body text is 7.5-7.9 pt, note references ~5 pt
STRAIN_HEADER = re.compile(r"^[A-Z][a-z]+ [a-z]+.*\b(ATCC|NCTC|DSM)\b")
STRAIN_CODE = re.compile(r"\b((?:ATCC|NCTC|DSM) [\w-]+)$")
VALUE = re.compile(r"[\d.,\-–≤]+|IP|Note\d*|-|unit")
RANGE = re.compile(r"^(\d+)(?:-(\d+))?$")


def pages(pdf: Path):
    xml = subprocess.run(["pdftotext", "-bbox", str(pdf), "-"], check=True, capture_output=True, text=True).stdout
    xml = re.sub(r"<!DOCTYPE[^>]*>", "", xml).replace(' xmlns="http://www.w3.org/1999/xhtml"', "")
    for page in ET.fromstring(xml).iter("page"):
        words = sorted((float(w.get("yMin")), float(w.get("yMax")), float(w.get("xMin")), float(w.get("xMax")), w.text)
                       for w in page.iter("word"))
        lines: list[list] = []  # [y, [(x0, x1, height, text)]]
        for y0, y1, x0, x1, text in words:
            if lines and abs(lines[-1][0] - y0) < 3:
                lines[-1][1].append((x0, x1, y1 - y0, text))
            else:
                lines.append([y0, [(x0, x1, y1 - y0, text)]])
        yield [sorted(ws) for _, ws in lines]


def parse(pdf: Path) -> dict:
    strains: dict[str, dict] = {}
    current = cols = kind = pending = disk_x = None
    for page in pages(pdf):
        section = "routine"  # every page starts with its own section heading
        for ws in page:
            text = " ".join(t for *_, t in ws)
            if text.startswith("Control of the inhibitor component"):
                section = "inhibitor"
            elif text.startswith("Extended quality control") or text.startswith("Quality control strains for detection"):
                section = "extended"
            if max(h for _, _, h, _ in ws) > 9 and STRAIN_HEADER.match(text) and len(ws) <= 8:
                name = text.rstrip("*").strip()
                code_match = STRAIN_CODE.search(name)
                if not code_match:  # table of contents (ends with a page number)
                    continue
                code = code_match.group(1)
                genus, species = name.split()[:2]
                current = strains.setdefault(code, {"id": code, "name": name, "genus": genus, "species": species,
                                                    "ranges": []})
                cols = pending = disk_x = None
                continue
            if current is None:
                continue
            first = ws[0]
            if first[2] < SUPERSCRIPT_MAX_HEIGHT and first[0] < 62 and first[3].isdigit():
                cols = pending = None  # the notes below the table
                continue
            normal = [w for w in ws if w[2] > SUPERSCRIPT_MAX_HEIGHT]
            centres = [((x0 + x1) / 2, t) for x0, x1, _, t in normal]
            if text.startswith("(µg)"):
                disk_x = centres[0][0]
                if cols is not None and kind == "routine":
                    cols["disk"] = disk_x
                continue
            if "Target" in text and "Range" in text:
                heads = [x for x, t in centres if t.startswith(("Target", "Range"))]
                if "Disk" in text:  # extended QC: disk content | target susceptibility | range | comments
                    kind = "extended"
                    cols = {"disk": next(x for x, t in centres if t == "Disk") + 12, "category": heads[0],
                            "range": heads[1]}
                elif len(heads) == 4:  # MIC target | MIC range | disk content | zone target | zone range
                    kind = "routine"
                    cols = {"target": heads[2], "range": heads[3]}
                    if disk_x is not None:
                        cols["disk"] = disk_x
                else:
                    cols = None
                continue
            if not cols or "disk" not in cols or not normal or text.startswith(("Disk content", "Antimicrobial", "MIC")):
                continue
            if normal[0][0] > 70 and pending is None:
                continue
            name_words = [w for w in normal if w[0] < 150 and not VALUE.fullmatch(w[3])]
            values = [w for w in normal if w not in name_words]
            if name_words and not values:  # the values are on the next line
                pending = " ".join(w[3] for w in name_words)
                continue
            agent = " ".join(w[3] for w in name_words) or pending
            pending = None
            if not agent or not values:
                continue
            cells: dict[str, str] = {}
            for x0, x1, _, t in values:
                key = min(cols, key=lambda k: abs(cols[k] - (x0 + x1) / 2))
                if abs(cols[key] - (x0 + x1) / 2) < 30:
                    cells[key] = f"{cells.get(key, '')} {t}".strip()
            m = RANGE.match(cells.get("range", ""))
            if not m:
                continue  # no disk-diffusion range (MIC only, "-" or "IP" = in preparation)
            low, high = int(m.group(1)), int(m.group(2) or m.group(1))
            row = {"agent": agent, "disk_content": cells["disk"], "min": low, "max": high, "use": section}
            if kind == "routine":
                row["target"] = cells.get("target", "")
            else:
                row["expected_category"] = cells.get("category", "")
            if not any(r["agent"] == agent and r["disk_content"] == row["disk_content"] for r in current["ranges"]):
                current["ranges"].append(row)
    return {**META, "strains": [s for s in strains.values() if s["ranges"]]}


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    data = parse(Path(sys.argv[1]))
    text = json.dumps(data, indent=1, ensure_ascii=False) + "\n"
    for out in OUTPUTS:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
    n = sum(len(s["ranges"]) for s in data["strains"])
    print(f"{len(data['strains'])} strains, {n} zone-diameter ranges -> " + ", ".join(str(o) for o in OUTPUTS))


if __name__ == "__main__":
    main()
