"""Evaluate the app's OCR disk reader (backend/app/cv/reading.py) on the desktop app's sample plates.

usage: python evaluate_app.py <images dir> [model.onnx ...]
Default model: backend/seed/models/ppocr_rec.onnx. Writes results/app_<model>.json.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1] / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE))

from app.cv.codes import build_lexicon, load_synonyms  # noqa: E402
from app.cv.processing import disk_crop  # noqa: E402
from app.cv.reading import DiskReader  # noqa: E402
from evaluate import GT_NAME  # noqa: E402
from extract import plate_disks  # noqa: E402

CATALOG = json.loads((HERE.parents[1] / "frontend/src/browser/catalog.json").read_text())
DISTINCT = ("0", "1", "2", "3")
AUTO_ACCEPT = -2.0


def main() -> None:
    images = Path(sys.argv[1])
    models = [Path(m) for m in sys.argv[2:]] or [BACKEND / "seed/models/ppocr_rec.onnx"]
    lexicon = tuple(build_lexicon([(a["name"], a["code"], a["disk_content"]) for a in CATALOG["antibiotics"]],
                                  load_synonyms(BACKEND / "seed/disk_codes.json")))
    gt = json.loads((HERE / "ground_truth.json").read_text())
    plates = {p: plate_disks(str(images / f"{p}.tiff")) for p in sorted((k for k in gt if not k.startswith("_")), key=int)}
    print(f"lexicon: {len(lexicon)} entries")
    for model in models:
        reader = DiskReader(model, threads=4)
        records, seconds = [], 0.0
        for plate, (img, disks) in plates.items():
            for i, (d, truth) in enumerate(zip(disks, gt[plate])):
                t0 = time.perf_counter()
                r = reader.read(disk_crop(img, d), lexicon)
                seconds += time.perf_counter() - t0
                names = [c.entry.name for c in r.candidates]
                records.append({"plate": plate, "disk": i, "truth": truth, "want": GT_NAME[truth.split()[0]],
                                "read": [[c.entry.code, c.confidence] for c in r.candidates], "names": names,
                                "free": r.free_text, "angle": r.angle})
        (HERE / "results" / f"app_{model.stem}.json").write_text(json.dumps(records, indent=1))

        def stats(rs: list[dict]) -> str:
            top1 = sum(bool(r["names"]) and r["names"][0] == r["want"] for r in rs)
            top3 = sum(r["want"] in r["names"] for r in rs)
            auto = [r for r in rs if r["read"] and r["read"][0][1] >= AUTO_ACCEPT]
            auto_ok = sum(r["names"][0] == r["want"] for r in auto)
            return f"top1 {top1}/{len(rs)}  top3 {top3}/{len(rs)}  auto-accepted {len(auto)} ({auto_ok} correct)"

        print(f"\n{model.name}: {seconds / len(records) * 1000:.0f} ms/disk")
        print("  distinct (plates 0-3):", stats([r for r in records if r["plate"] in DISTINCT]))
        print("  all photos:           ", stats(records))
        for r in records:
            if r["plate"] in DISTINCT and (not r["names"] or r["names"][0] != r["want"]):
                print(f"    {r['plate']}/{r['disk']} {r['truth']:<7} -> {r['read']} free='{r['free']}'")


if __name__ == "__main__":
    main()
