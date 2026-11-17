import json
from pathlib import Path

import cv2
from app.cv import processing as cvp
from app.cv.codes import build_lexicon, load_synonyms, printed_content
from app.cv.reading import DiskReader

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "backend" / "seed"
CATALOG = json.loads((ROOT / "frontend/src/browser/catalog.json").read_text())
ROWS = [(a["name"], a["code"], a["disk_content"]) for a in CATALOG["antibiotics"]]
# Newer EUCAST antibiotics whose printed codes are not in seed/disk_codes.json yet.
WITHOUT_CODE = {"Aztreonam-avibactam", "Cefepime-enmetazobactam", "Lefamulin", "Nitroxoline"}


def test_printed_content():
    assert printed_content("30") == "30"
    assert printed_content("20-10") == "30"
    assert printed_content("1.25-23.75") == "25"
    assert printed_content("1 unit") == "1"
    assert printed_content("10-4") == "14"


def test_lexicon_covers_the_catalogue():
    synonyms = load_synonyms(SEED / "disk_codes.json")
    names = {r[0] for r in ROWS}
    assert set(synonyms) <= names, set(synonyms) - names   # typos in the synonym table
    lexicon = build_lexicon(ROWS, synonyms)
    covered = {e.name for e in lexicon}
    assert names - covered == WITHOUT_CODE
    codes = {(e.name, e.code) for e in lexicon}
    assert {("Amikacin", "AK 30"), ("Amikacin", "AN 30"), ("Trimethoprim-sulfamethoxazole", "SXT 25"),
            ("Ceftolozane-tazobactam", "C/T 40"), ("Cefotaxime", "CTX 30")} <= codes
    assert all(e.text.isalnum() and e.text == e.text.upper() for e in lexicon)


def test_reader_on_plate_1():
    """OCR alone on the sample plate (the API test checks the decision with the templates)."""
    reader = DiskReader(SEED / "models" / "ppocr_rec.onnx")
    lexicon = tuple(build_lexicon(ROWS, load_synonyms(SEED / "disk_codes.json")))
    image = cv2.imread(str(ROOT / "backend/tests/images/1.tiff"))
    plate = cvp.detect_plate(image)
    image = cvp.crop(image, round(plate.cx - plate.r), round(plate.cy - plate.r), round(2 * plate.r), round(2 * plate.r))
    scale = 1600 / max(image.shape[:2])   # as the app's pre-processing step
    image = cvp.enhance_contrast(cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA))
    readings = [reader.read(cvp.disk_crop(image, d), lexicon) for d in cvp.detect_disks(image)]
    accepted = [r.best.entry.code if r.best.confidence >= -2 else None for r in readings]
    assert accepted == ["TE 30", "CTX 30", "FOX 30", "AMC 30", None, "CAZ 30", "AMP 10"]
    assert readings[4].best.confidence < -2   # "C 30", almost invisible
    assert all(-20 < r.best.confidence <= 0 for r in readings)
