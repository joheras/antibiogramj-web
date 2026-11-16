"""Evaluate disk readers on the desktop app's sample plates.

usage: python evaluate.py <images dir> [engine ...]   engines: templates, tesseract, render, ppocr, rapidocr
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "backend"))
sys.path.insert(0, str(HERE))

from app.cv.matching import Template, best_match, descriptors  # noqa: E402
from app.cv.processing import disk_crop  # noqa: E402
from extract import plate_disks  # noqa: E402

CATALOG = json.loads((HERE.parents[1] / "frontend/src/browser/catalog.json").read_text())
NAMES = {a["id"]: a["name"] for a in CATALOG["antibiotics"]}
GT_NAME = {"AK": "Amikacin", "CN": "Gentamicin", "SXT": "Trimethoprim-sulfamethoxazole", "NA": "Nalidixic acid",
           "TOB": "Tobramycin", "CIP": "Ciprofloxacin", "TE": "Tetracycline", "CTX": "Cefotaxime",
           "FOX": "Cefoxitin", "AMC": "Amoxicillin-clavulanic acid", "C": "Chloramphenicol",
           "CAZ": "Ceftazidime", "AMP": "Ampicillin", "P": "Benzylpenicillin", "DA": "Clindamycin"}


def template_reader():
    root = HERE.parents[1] / "backend/seed/templates"
    templates = []
    for folder in root.iterdir():
        for f in folder.iterdir():
            im = cv2.imread(str(f), cv2.IMREAD_COLOR)
            if im is not None:
                templates.append(Template(int(folder.name) + 1, descriptors(im)))  # catalogue id = legacy + 1

    def read(disk):
        aid, score = best_match(disk, templates)
        return (NAMES[aid] if aid else None), (f"id{aid} score={score}" if aid else "-"), float(score)
    return read


def ocr_reader(engine_name: str):
    import ocr
    if engine_name == "tesseract":
        engine = ocr.tesseract_engine
    else:
        import rapid
        engine = rapid.engine()

    def read(disk):
        r = ocr.read_disk(disk, engine)
        if r.entry is None:
            return None, "-", 0.0
        return (r.entry.name, f"'{r.text}' @{r.angle}° -> {r.entry.letters} {r.entry.content} ({r.score:.2f}) "
                f"{r.candidates[1:]}", r.score)
    return read


def render_reader():
    import render_match

    def read(disk):
        m = render_match.read_disk(disk)
        if m.entry is None:
            return None, "-", 0.0
        return (m.entry.name, f"@{m.angle}° -> {m.entry.letters} {m.entry.content} (d={m.distance:.2f}) "
                f"{m.candidates[1:]}", -m.distance)
    return read


def ppocr_reader(step=20):
    import ppocr

    def read(disk):
        r = ppocr.read_disk(disk, step=step)
        if r.entry is None:
            return None, "-", -1e9
        return r.entry.name, (f"'{r.free_text}' @{r.angle:.0f}° -> {r.entry.letters} {r.entry.content} "
                              f"(logp={r.logp:.1f}) {r.candidates[1:]}"), r.logp
    return read


READERS = {"templates": template_reader, "render": render_reader, "ppocr": ppocr_reader,
           "ppocr15": lambda: ppocr_reader(15), "ppocr10": lambda: ppocr_reader(10)}


def main():
    images = Path(sys.argv[1])
    engines = sys.argv[2:] or ["templates", "tesseract"]
    gt = json.loads((HERE / "ground_truth.json").read_text())
    readers = {e: READERS.get(e, ocr_reader)(*([] if e in READERS else [e])) for e in engines}
    totals = {e: [0, 0, 0.0] for e in engines}  # correct, n, seconds
    distinct = {e: [0, 0] for e in engines}
    records = []
    for plate in sorted((k for k in gt if not k.startswith("_")), key=int):
        img, disks = plate_disks(str(images / f"{plate}.tiff"))
        assert len(disks) == len(gt[plate]), (plate, len(disks))
        for i, (d, truth) in enumerate(zip(disks, gt[plate])):
            disk = disk_crop(img, d)
            want = GT_NAME[truth.split()[0]]
            line = [f"{plate:>2}/{i} {truth:<7}"]
            for e, read in readers.items():
                t0 = time.perf_counter()
                name, info, score = read(disk)
                records.append({"plate": plate, "disk": i, "truth": truth, "want": want, "engine": e,
                                "name": name, "score": score, "info": info})
                totals[e][2] += time.perf_counter() - t0
                ok = name == want
                totals[e][0] += ok
                totals[e][1] += 1
                if plate in ("0", "1", "2", "3"):
                    distinct[e][0] += ok
                    distinct[e][1] += 1
                line.append(f"[{e}] {'OK ' if ok else 'BAD'} {name or '-'}: {info}")
            print("  ".join(line), flush=True)
    out = HERE / "results" / f"{'_'.join(engines)}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(records, indent=1, ensure_ascii=False))
    print()
    for e, (ok, n, s) in totals.items():
        print(f"{e:<10} all plates {ok}/{n} = {ok / n:.0%}   distinct plates (0,1,2,3) "
              f"{distinct[e][0]}/{distinct[e][1]} = {distinct[e][0] / distinct[e][1]:.0%}   {1000 * s / n:.0f} ms/disk")


if __name__ == "__main__":
    main()
