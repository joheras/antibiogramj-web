"""Photo quality checks run right after an image is uploaded (non-blocking warnings).

Same algorithm as ``photoQuality`` in frontend/src/browser/cv.ts. The checks use the plate found
by ``detect_plate`` and look at the inner 85 % of the plate (the rim often reflects light and is
not measured anyway), on a copy scaled so that the plate is at most 800 px wide, so the measures do
not depend on the camera resolution.

* blur: sharpness of the strongest edges (the antibiotic disks and their printed codes), the
  99.9th percentile of the Sobel gradient magnitude divided by the image contrast (99th - 1st
  percentile of the grey levels). The variance of the Laplacian was tried first but sensor noise
  raises it as much as focus does (a blurred, noisy photo scored like a sharp one).
* glare: saturated white pixels (all channels >= 250) that are not round blobs the size of a
  disk (white disks may be over-exposed on dark agar without harm).
* framing: plate not found, partly outside the image, or small in the frame.
* resolution: plate diameter in pixels.

Thresholds calibrated on the sample images of AntibiogramJ (sharp photos: 22-24; Gaussian blur
of sigma 1.5 / 2 px at 1600 px: 18-20 / 16-18, with or without noise) and checked not to raise
any warning on tests/images/1.tiff.
"""

from __future__ import annotations

import math

import cv2
import numpy as np

from .processing import Circle

ANALYSIS_DIAMETER = 800  # px, plate diameter of the analysed copy
INNER = 0.85  # fraction of the plate radius analysed
MIN_SHARPNESS = 19.0
MAX_GLARE = 0.003  # fraction of the analysed area
SATURATED = 250
MIN_PLATE_DIAMETER = 700  # px in the original image
MIN_PLATE_FRACTION = 0.6  # plate diameter / shorter image side
MAX_OUTSIDE = 0.08  # fraction of the radius outside the image
DISK_FRACTION = 6 / 90  # 6 mm disk on a 90 mm plate


def _percentile(values: np.ndarray, q: float) -> float:
    return float(np.percentile(values, q)) if values.size else 0.0


def _gray(image: np.ndarray) -> np.ndarray:
    """Luma with integer weights (written out so that the browser version gives the same values)."""
    b, g, r = (image[:, :, i].astype(np.int32) for i in range(3))
    return ((r * 4899 + g * 9617 + b * 1868 + 8192) >> 14).astype(np.uint8)


def _glare_fraction(saturated: np.ndarray, area: int, plate_r: float) -> float:
    """Saturated pixels outside round, disk-sized blobs, as a fraction of ``area``."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(saturated.astype(np.uint8), connectivity=8)
    disk_area = math.pi * (DISK_FRACTION * plate_r) ** 2
    glare = 0
    for i in range(1, n):
        a = int(stats[i, cv2.CC_STAT_AREA])
        side = max(int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT]))
        roundness = a / (math.pi * (side / 2) ** 2)
        if a <= 1.5 * disk_area and roundness > 0.5:
            continue  # an over-exposed disk
        glare += a
    return glare / area if area else 0.0


def measure(image: np.ndarray, plate: Circle | None) -> dict:
    """Quality measures of a BGR image (rounded, the same in the browser version)."""
    h, w = image.shape[:2]
    cx, cy, r = (plate.cx, plate.cy, plate.r) if plate else (w / 2, h / 2, min(w, h) / 2)
    scale = min(1.0, ANALYSIS_DIAMETER / (2 * r))
    small = image if scale >= 1 else cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    sh, sw = small.shape[:2]
    yy, xx = np.ogrid[:sh, :sw]
    rr = INNER * r * scale
    mask = (xx - cx * scale) ** 2 + (yy - cy * scale) ** 2 < rr * rr
    mask[[0, -1], :] = False  # the Sobel border is not used
    mask[:, [0, -1]] = False

    gray = _gray(small)
    gx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
    magnitude = np.sqrt(gx * gx + gy * gy)[mask]
    levels = gray[mask]
    contrast = max(1.0, _percentile(levels, 99) - _percentile(levels, 1))
    sharpness = 10 * _percentile(magnitude, 99.9) / contrast

    saturated = (small.min(axis=2) >= SATURATED) & mask
    glare = _glare_fraction(saturated, int(mask.sum()), rr / INNER)

    outside = max(0.0, r - cx, r - cy, cx + r - w, cy + r - h) / r if plate else 0.0
    return {
        "plate_found": plate is not None,
        "plate_diameter_px": round(2 * r) if plate else None,
        "plate_fraction": round(2 * r / min(w, h), 3) if plate else None,
        "outside_fraction": round(outside, 3),
        "sharpness": round(sharpness, 2),
        "glare_fraction": round(glare, 4),
        "width": w,
        "height": h,
    }


def warnings(m: dict) -> list[str]:
    """Codes of the warnings for the measures of ``measure`` (texts and tips are in the frontend)."""
    out = []
    if not m["plate_found"]:
        out.append("plate_not_found")
    else:
        if m["outside_fraction"] > MAX_OUTSIDE:
            out.append("plate_cut")
        if m["plate_fraction"] < MIN_PLATE_FRACTION:
            out.append("plate_small")
    if (m["plate_diameter_px"] or min(m["width"], m["height"])) < MIN_PLATE_DIAMETER:
        out.append("low_resolution")
    if m["sharpness"] < MIN_SHARPNESS:
        out.append("blur")
    if m["glare_fraction"] > MAX_GLARE:
        out.append("glare")
    return out


def check(image: np.ndarray, plate: Circle | None) -> dict:
    m = measure(image, plate)
    return {"warnings": warnings(m), "metrics": m}
