"""Antibiotic-code recognition by keypoint matching (workspace/computervision/Matching.java).

AntibiogramJ uses ORB keypoints/descriptors on the V channel, a brute-force
matcher with L1 norm, Lowe's ratio test (0.7) and requires more than 10 good
matches per template. Matches are summed per antibiotic over all its
templates and the antibiotic with the highest total wins.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .processing import keep_only_letters

RATIO = 0.7
MIN_MATCHES = 10


@dataclass
class Template:
    antibiotic_id: int
    descriptors: np.ndarray | None


_orb = cv2.ORB_create()
_matcher = cv2.BFMatcher(cv2.NORM_L1, crossCheck=False)


def descriptors(image_letters_only: np.ndarray) -> np.ndarray | None:
    v = cv2.cvtColor(image_letters_only, cv2.COLOR_BGR2HSV)[:, :, 2]
    keypoints = _orb.detect(v, None)
    _, desc = _orb.compute(v, keypoints)
    return desc


def count_good_matches(desc1: np.ndarray | None, desc2: np.ndarray | None) -> int:
    if desc1 is None or desc2 is None or len(desc1) == 0 or len(desc2) < 2:
        return 0
    matches = _matcher.knnMatch(desc1.astype(np.float32), desc2.astype(np.float32), k=2)
    good = 0
    for pair in matches:
        if len(pair) < 2 or pair[1].distance == 0:
            continue
        if pair[0].distance / pair[1].distance < RATIO:
            good += 1
    return good if good > MIN_MATCHES else 0


def best_match(disk_image: np.ndarray, templates: list[Template]) -> tuple[int | None, int]:
    """Return ``(antibiotic_id, score)``; ``(None, 0)`` when nothing matches."""
    desc = descriptors(keep_only_letters(disk_image))
    scores: dict[int, int] = {}
    for t in templates:
        n = count_good_matches(desc, t.descriptors)
        if n:
            scores[t.antibiotic_id] = scores.get(t.antibiotic_id, 0) + n
    if not scores:
        return None, 0
    best = max(scores, key=scores.__getitem__)
    return best, scores[best]
