"""Template-free disk reading: preprocessing + rotations + OCR + lexicon.

Engine-agnostic: an engine is a function ``list[np.ndarray] -> list[(text, conf)]``
(one reading per rotated image). ``read_disk`` tries every rotation and keeps
the reading that best matches a code of the lexicon.
"""

from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from codes import Entry, best_entries, clean

SIZE = 400
Engine = Callable[[list[np.ndarray]], list[tuple[str, float]]]


def normalise(disk_bgr: np.ndarray, size: int = SIZE) -> np.ndarray:
    """Flat-field the disk and binarise it: dark print on white, outside of the disk white.

    Uses the min of G and B, so red print (e.g. some P / FOX disks) is as dark
    as black print, then divides by a morphological-closing background
    estimate and applies Otsu inside the disk.
    """
    g = np.minimum(disk_bgr[:, :, 0], disk_bgr[:, :, 1])
    g = cv2.resize(g, (size, size), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    bg = cv2.morphologyEx(g, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
    flat = np.clip(g / np.maximum(bg, 1) * 255, 0, 255).astype(np.uint8)
    mask = np.zeros_like(flat)
    cv2.circle(mask, (size // 2, size // 2), int(size * 0.43), 255, -1)
    flat[mask == 0] = 255
    t, _ = cv2.threshold(flat[mask > 0].reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    binary = np.where(flat > t, 255, 0).astype(np.uint8)
    # Drop specks.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(255 - binary)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < size * size * 0.0003:
            binary[labels == i] = 255
    return binary


def rotations(binary: np.ndarray, step: int = 15) -> list[tuple[int, np.ndarray]]:
    h, w = binary.shape
    out = []
    for angle in range(0, 360, step):
        m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        out.append((angle, cv2.warpAffine(binary, m, (w, h), flags=cv2.INTER_NEAREST, borderValue=255)))
    return out


def tesseract_engine(images: list[np.ndarray], psm: int = 6) -> list[tuple[str, float]]:
    """Batch call of the tesseract CLI (one process for all images, TSV output)."""
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for i, im in enumerate(images):
            p = Path(tmp) / f"{i:03d}.png"
            cv2.imwrite(str(p), im)
            paths.append(str(p))
        lst = Path(tmp) / "list.txt"
        lst.write_text("\n".join(paths) + "\n")
        res = subprocess.run(
            ["tesseract", str(lst), "stdout", "--psm", str(psm), "-c",
             "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/", "tsv"],
            capture_output=True, text=True, check=False)
    words: dict[int, list[tuple[str, float]]] = {i: [] for i in range(len(images))}
    for line in res.stdout.splitlines()[1:]:
        f = line.split("\t")
        if len(f) < 12 or f[0] != "5" or not f[11].strip():
            continue
        page = int(f[1]) - 1
        words.setdefault(page, []).append((f[11], float(f[10])))
    out = []
    for i in range(len(images)):
        ws = words.get(i, [])
        text = " ".join(w for w, _ in ws)
        conf = float(np.mean([c for _, c in ws])) if ws else 0.0
        out.append((text, conf))
    return out


@dataclass
class Reading:
    entry: Entry | None
    score: float
    text: str
    angle: int
    candidates: list[tuple[float, str]]


def read_disk(disk_bgr: np.ndarray, engine: Engine = tesseract_engine, step: int = 15) -> Reading:
    rots = rotations(normalise(disk_bgr), step)
    readings = engine([im for _, im in rots])
    best: dict[str, tuple[float, Entry, str, int]] = {}
    for (angle, _), (text, conf) in zip(rots, readings):
        if not clean(text):
            continue
        for score, e in best_entries(text, k=3):
            # OCR confidence (0-100) modulates the lexical score.
            s = score * (0.5 + 0.5 * max(conf, 0) / 100)
            if e.name not in best or s > best[e.name][0]:
                best[e.name] = (s, e, text, angle)
    if not best:
        return Reading(None, 0.0, "", 0, [])
    ranked = sorted(best.values(), key=lambda t: -t[0])
    s, e, text, angle = ranked[0]
    return Reading(e, s, text, angle, [(round(r[0], 3), f"{r[1].letters} {r[1].content}") for r in ranked[:3]])
