"""Image-processing algorithms ported from AntibiogramJ (Java/ImageJ/JavaCV).

All images are OpenCV BGR ``uint8`` arrays. Circles are ``(cx, cy, r)`` in
pixel coordinates of the image they were computed on.

Original sources:
  * auto crop          -> workspace/wizard/step2_1.java  (detectRegionToCrop)
  * auto contrast      -> ImageJ "Enhance Contrast saturated=0.35" (step2_2.java)
  * disk detection     -> workspace/imagejAdds/DiskManager.java (auto_detect)
  * keepOnlyLetters    -> workspace/computervision/Processing.java
  * halo detection     -> workspace/computervision/Processing.java (haloDetection)
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class Circle:
    cx: float
    cy: float
    r: float

    def as_dict(self) -> dict:
        return {"cx": round(self.cx, 2), "cy": round(self.cy, 2), "r": round(self.r, 2)}


def _smoothed_value_channel(image: np.ndarray) -> np.ndarray:
    """Mean-shift + Gaussian blur + HSV V channel (shared by several steps)."""
    shifted = cv2.pyrMeanShiftFiltering(image, 11, 21)
    blurred = cv2.GaussianBlur(shifted, (11, 11), 0)
    return cv2.cvtColor(blurred, cv2.COLOR_BGR2HSV)[:, :, 2]


def _downscale(image: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = image.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        image = cv2.resize(image, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_AREA)
    return image, scale


# --------------------------------------------------------------------------- crop
def detect_plate(image: np.ndarray) -> Circle | None:
    """Locate the Petri dish with a Hough transform (step2_1.detectRegionToCrop).

    Hough parameters are the original ones; the image is processed at <=800 px
    so the fixed ``minDist=100`` keeps a comparable meaning and it runs fast.
    """
    small, scale = _downscale(image, 800)
    v = _smoothed_value_channel(small)
    h, w = v.shape
    min_radius = min(h, w) // 4
    circles = cv2.HoughCircles(v, cv2.HOUGH_GRADIENT, 1.2, 100, param1=100, param2=100, minRadius=min_radius, maxRadius=0)
    if circles is None or len(circles[0]) == 0:
        return None
    cx, cy, r = circles[0][0]
    return Circle(float(cx) / scale, float(cy) / scale, float(r) / scale)


def crop(image: np.ndarray, x: int, y: int, w: int, h: int) -> np.ndarray:
    H, W = image.shape[:2]
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(W, int(x + w)), min(H, int(y + h))
    if x1 - x0 < 10 or y1 - y0 < 10:
        raise ValueError("Crop region is too small or outside the image")
    return image[y0:y1, x0:x1].copy()


# ----------------------------------------------------------------------- contrast
def enhance_contrast(image: np.ndarray, saturated: float = 0.35) -> np.ndarray:
    """ImageJ's *Enhance Contrast* (normalize off) for RGB images.

    ImageJ computes the histogram of the RGB image's luminance, finds the
    bounds leaving ``saturated`` % of the pixels saturated (half at each end)
    and applies the same linear stretch to the three channels.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hist = np.bincount(gray.ravel(), minlength=256)
    threshold = gray.size * saturated / 200.0
    cumulative = np.cumsum(hist)
    lo = int(np.searchsorted(cumulative, threshold, side="right"))
    hi = int(np.searchsorted(cumulative, gray.size - threshold, side="left"))
    if hi <= lo:
        return image.copy()
    lut = np.clip((np.arange(256) - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)
    return cv2.LUT(image, lut)


# ------------------------------------------------------------------ disk detection
def detect_disks(image: np.ndarray) -> list[Circle]:
    """Antibiotic disk detection (DiskManager.auto_detect).

    Bright, roughly round blobs (aspect ratio 0.8-1.2) after thresholding the
    smoothed V channel at mean + std, with radius between 3 % and 5 % of the
    image width.
    """
    small, scale = _downscale(image, 1200)
    v = _smoothed_value_channel(small)
    mean, std = cv2.meanStdDev(v)
    t_value = int(mean[0][0]) + int(std[0][0])
    _, thresh = cv2.threshold(v, t_value, 255, cv2.THRESH_BINARY)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    w = v.shape[1]
    disks: list[Circle] = []
    for c in contours:
        _, _, bw, bh = cv2.boundingRect(c)
        if bh == 0 or not (0.8 < bw / bh < 1.2):
            continue
        (cx, cy), radius = cv2.minEnclosingCircle(c)
        if w * 0.03 < radius < w * 0.05:
            disks.append(Circle(cx / scale, cy / scale, radius / scale))
    # Stable reading order: top-to-bottom, then left-to-right.
    disks.sort(key=lambda d: (round(d.cy / (d.r * 2)), d.cx))
    return disks


def disk_crop(image: np.ndarray, disk: Circle) -> np.ndarray:
    """Bounding-box crop of a disk (ImageJ Duplicator on an OvalRoi)."""
    x, y = int(round(disk.cx - disk.r)), int(round(disk.cy - disk.r))
    d = int(round(2 * disk.r))
    H, W = image.shape[:2]
    x0, y0, x1, y1 = max(0, x), max(0, y), min(W, x + d), min(H, y + d)
    return image[y0:y1, x0:x1].copy()


# ------------------------------------------------------------- letters on a disk
def _good_contour(x: int, y: int, w: int, h: int, wi: int, hi: int) -> bool:
    if (h + y) > 0.95 * hi or (w + x) > 0.95 * wi or y < 0.05 * hi or x < 0.05 * wi:
        return False
    if w < 0.1 * wi and h < 0.1 * hi:
        return False
    return True


def keep_only_letters(image: np.ndarray) -> np.ndarray:
    """Keep only the printed code of an antibiotic disk (Processing.keepOnlyLetters)."""
    image = image.copy()
    h, w = image.shape[:2]
    v = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)[:, :, 2]
    mask = np.zeros((h, w), np.uint8)
    cv2.circle(mask, (w // 2, h // 2), int(min(w, h) / 2 * 0.95), 255, -1)
    v = cv2.bitwise_and(v, mask)
    v = cv2.adaptiveThreshold(v, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 25, 5)

    contours, _ = cv2.findContours(v.copy(), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates = np.zeros_like(image)
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if _good_contour(x, y, cw, ch, w, h):
            hull = cv2.convexHull(c)
            cv2.drawContours(candidates, [hull], -1, (255, 255, 255), -1)
    return cv2.bitwise_and(image, candidates)


# ----------------------------------------------------------------- halo detection
def brightness_channel(image: np.ndarray) -> np.ndarray:
    """ImageJ HSB brightness == HSV value == max(R, G, B)."""
    return image.max(axis=2)


def detect_halo(brightness: np.ndarray, disk: Circle, global_mean: float | None = None,
                step: int = 5, max_iter: int = 50) -> Circle:
    """Inhibition-zone detection (Processing.haloDetection, the one used by step4_1).

    Starting at the disk border, rings of ``step`` px are grown outwards. The
    mean brightness of each ring (restricted to the inner area of the plate) is
    compared with the previous ring; a jump of more than 2 grey levels marks
    the border between the inhibition zone (dark, translucent agar) and the
    bacterial lawn. If the very first ring is already much brighter than the
    image mean, there is no inhibition zone and the disk itself is returned.

    Difference with the original: the first ring starts 5 % of the radius away
    from the disk border, so the blurred white edge of the disk is not mistaken
    for bacterial growth (this missed clear halos, e.g. AK in tests/images/4).
    """
    h, w = brightness.shape
    if global_mean is None:
        global_mean = float(brightness.mean())

    # Plate border mask (Processing.intersectWithBorder): OvalRoi(0.05m, 0.05m, 0.85m, 0.85m)
    m = min(h, w)
    plate = np.zeros((h, w), np.uint8)
    cv2.ellipse(plate, (int(0.05 * m + 0.425 * m), int(0.05 * m + 0.425 * m)),
                (int(0.425 * m), int(0.425 * m)), 0, 0, 360, 255, -1)

    yy, xx = np.ogrid[:h, :w]
    dist2 = (xx - disk.cx) ** 2 + (yy - disk.cy) ** 2
    plate_bool = plate > 0

    r = disk.r * 1.05
    old_mean = 0.0
    for i in range(max_iter):
        ring = (dist2 >= r * r) & (dist2 < (r + step) ** 2) & plate_bool
        if not ring.any():
            break
        mean2 = float(brightness[ring].mean())
        if i == 0:
            old_mean = mean2
            if global_mean + 20 < mean2:
                return Circle(disk.cx, disk.cy, disk.r)
        elif mean2 - old_mean > 2:
            # The original steps back one ring once the jump is found.
            return Circle(disk.cx, disk.cy, max(disk.r, r - step))
        r += step
        old_mean = mean2
    return Circle(disk.cx, disk.cy, r)


# ---------------------------------------------------------------------- render
def render_annotations(image: np.ndarray, items: list[dict]) -> np.ndarray:
    """Draw disks, halos and breakpoint circles (same colours as AntibiogramJ).

    ``items``: dicts with ``disk`` (Circle), ``halo_r`` (px), ``code`` (str),
    ``s_r``/``r_r`` (px radii of the susceptible / resistant limits or None),
    ``category``.
    """
    out = image.copy()
    thickness = max(2, int(round(min(out.shape[:2]) / 400)))
    font_scale = max(0.5, min(out.shape[:2]) / 1400)
    for it in items:
        d: Circle = it["disk"]
        c = (int(round(d.cx)), int(round(d.cy)))
        if it.get("r_r"):
            cv2.circle(out, c, int(round(it["r_r"])), (0, 0, 255), thickness)
        if it.get("s_r"):
            cv2.circle(out, c, int(round(it["s_r"])), (255, 0, 0), thickness)
        cv2.circle(out, c, int(round(d.r)), (255, 0, 255), thickness)
        cv2.circle(out, c, int(round(it["halo_r"])), (0, 255, 255), thickness)
        label = f"{it.get('code', '')} {it.get('category', '')[:1]}".strip()
        org = (c[0] - int(d.r), c[1] - int(d.r) - 6)
        cv2.putText(out, label, org, cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 0, 0), thickness + 2, cv2.LINE_AA)
        cv2.putText(out, label, org, cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), thickness, cv2.LINE_AA)
    return out
