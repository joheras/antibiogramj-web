"""Reference results of the Python pipeline on tests/images/1.tiff, used by
frontend/scripts/validate-cv.mts to check the in-browser (OpenCV.js, onnxruntime-web) port.

Run from backend/:  .venv/bin/python scripts/cv_reference.py
"""

import json
import sys
from pathlib import Path

import cv2

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.cv import quality  # noqa: E402
from app.cv.codes import Entry  # noqa: E402
from app.cv.matching import Template, best_match, descriptors  # noqa: E402
from app.cv.processing import (brightness_channel, crop, detect_disks, detect_halo, detect_plate,  # noqa: E402
                               disk_crop, enhance_contrast)
from app.cv.reading import DiskReader  # noqa: E402

FRONTEND = BACKEND.parent / "frontend"

image = cv2.imread(str(BACKEND / "tests" / "images" / "1.tiff"))
templates = [Template(int(d.name), descriptors(cv2.imread(str(f))))
             for d in (BACKEND / "seed" / "templates").iterdir() for f in d.iterdir()]
plate = detect_plate(image)
photo = quality.check(image, plate)
c = crop(image, round(plate.cx - plate.r), round(plate.cy - plate.r), round(2 * plate.r), round(2 * plate.r))
s = 1600 / max(c.shape[:2])
c = enhance_contrast(cv2.resize(c, (round(c.shape[1] * s), round(c.shape[0] * s)), interpolation=cv2.INTER_AREA))
disks = detect_disks(c)
b = brightness_channel(c)
mean = float(b.mean())
# OCR with the lexicon the browser gets (catalog.json, written by export_catalog.py).
lexicon_rows = json.loads((FRONTEND / "src" / "browser" / "catalog.json").read_text())["disk_codes"]["lexicon"]
lexicon = tuple(Entry(e["name"], e["letters"], e["content"]) for e in lexicon_rows)
reader = DiskReader(BACKEND / "seed" / "models" / "ppocr_rec.onnx")
readings = [reader.read(disk_crop(c, d), lexicon) for d in disks]
reference = {
    "plate": plate.as_dict(),
    "quality": photo,
    "disks": [d.as_dict() for d in disks],
    "legacy_ids": [best_match(disk_crop(c, d), templates)[0] for d in disks],
    "halo_r": [round(detect_halo(b, d, mean).r, 2) for d in disks],
    "ocr": [{"codes": [c.entry.code for c in r.candidates], "confidence": [c.confidence for c in r.candidates],
             "free_text": r.free_text} for r in readings],
}
out = FRONTEND / "scripts" / "cv-reference.json"
out.write_text(json.dumps(reference, indent=1))
print(f"{len(disks)} disks -> {out}")
