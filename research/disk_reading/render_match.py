"""Template-free reading by *rendering* every lexicon code and comparing shapes.

No image templates are collected: each code of the lexicon ("AK" over "30")
is drawn with OpenCV's Hershey fonts (the same in OpenCV.js) and compared
with the binarised disk at every rotation by a symmetric chamfer distance.
Any new antibiotic or manufacturer code only needs a lexicon line.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np

from codes import Entry, lexicon
from ocr import normalise

H, W = 48, 96          # comparison canvas (text block scaled to height H, centred)
FONTS = [(cv2.FONT_HERSHEY_SIMPLEX, 0.5), (cv2.FONT_HERSHEY_DUPLEX, 0.5)]


def _fit(mask: np.ndarray) -> np.ndarray | None:
    """Crop to the ink bounding box and scale it to height H, centred on a WxH canvas."""
    ys, xs = np.nonzero(mask)
    if len(xs) < 10:
        return None
    crop = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = crop.shape
    nw = max(1, min(W, int(round(w * H / h))))
    scaled = cv2.resize(crop.astype(np.uint8) * 255, (nw, H), interpolation=cv2.INTER_AREA) > 96
    canvas = np.zeros((H, W), bool)
    x0 = (W - nw) // 2
    canvas[:, x0:x0 + nw] = scaled
    return canvas


def _render(lines: list[str], font: int, thickness: int) -> np.ndarray:
    scale = 2.0
    sizes = [cv2.getTextSize(t, font, scale, thickness)[0] for t in lines]
    lh = max(s[1] for s in sizes)
    width = max(s[0] for s in sizes) + 20
    img = np.zeros((int(lh * (1.6 * len(lines) + 1)), width), np.uint8)
    y = lh + 10
    for t, (tw, _) in zip(lines, sizes):
        cv2.putText(img, t, ((width - tw) // 2, y), font, scale, 255, thickness, cv2.LINE_AA)
        y += int(lh * 1.6)
    return img > 127


@dataclass
class Bank:
    entries: list[Entry]
    masks: np.ndarray      # (N, H, W) bool
    dts: np.ndarray        # (N, H, W) float32 distance to ink


@lru_cache
def bank() -> Bank:
    entries, masks = [], []
    for e in lexicon():
        layouts = [[e.letters, e.content]] if e.content else [[e.letters]]
        for lines in layouts:
            for font, _ in FONTS:
                for thickness in (5, 8):
                    m = _fit(_render(lines, font, thickness))
                    if m is not None:
                        entries.append(e)
                        masks.append(m)
    masks_a = np.stack(masks)
    dts = np.stack([cv2.distanceTransform((~m).astype(np.uint8), cv2.DIST_L2, 3) for m in masks_a])
    return Bank(entries, masks_a, dts.astype(np.float32))


def text_mask(binary: np.ndarray) -> np.ndarray:
    """Ink without the orientation bar and specks (bool, True = ink)."""
    ink = binary < 128
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink.astype(np.uint8))
    size = binary.shape[0]
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        comp = (labels == i).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        (_, _), (rw, rh), _ = cv2.minAreaRect(cnts[0])
        elong = max(rw, rh) / max(1.0, min(rw, rh))
        if area < size * size * 0.0005:
            continue
        if elong > 3.5 and max(rw, rh) > size * 0.12:   # the underline / orientation bar
            continue
        keep[i] = True
    return keep[labels]


@dataclass
class Match:
    entry: Entry | None
    distance: float
    angle: int
    candidates: list[tuple[float, str]]


def read_disk(disk_bgr: np.ndarray, step: int = 5) -> Match:
    b = bank()
    mask = text_mask(normalise(disk_bgr)).astype(np.uint8) * 255
    size = mask.shape[0]
    best: dict[str, tuple[float, Entry, int]] = {}
    nm = b.masks.reshape(len(b.entries), -1).astype(np.float32)
    nd = b.dts.reshape(len(b.entries), -1)
    for angle in range(0, 360, step):
        rot = cv2.warpAffine(mask, cv2.getRotationMatrix2D((size / 2, size / 2), angle, 1.0), (size, size),
                             flags=cv2.INTER_NEAREST)
        fitted = _fit(rot > 0)
        if fitted is None:
            continue
        dt = cv2.distanceTransform((~fitted).astype(np.uint8), cv2.DIST_L2, 3).ravel()
        f = fitted.ravel().astype(np.float32)
        d1 = nd @ f / max(f.sum(), 1)                    # disk ink -> rendered ink
        d2 = nm @ dt / np.maximum(nm.sum(1), 1)          # rendered ink -> disk ink
        dist = (d1 + d2) / 2
        for i in np.argsort(dist)[:5]:
            e = b.entries[i]
            if e.name not in best or dist[i] < best[e.name][0]:
                best[e.name] = (float(dist[i]), e, angle)
    if not best:
        return Match(None, 1e9, 0, [])
    ranked = sorted(best.values(), key=lambda t: t[0])
    d, e, angle = ranked[0]
    return Match(e, d, angle, [(round(r[0], 2), f"{r[1].letters} {r[1].content}") for r in ranked[:3]])
