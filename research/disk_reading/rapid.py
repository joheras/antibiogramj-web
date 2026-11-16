"""PP-OCR (PaddleOCR models exported to ONNX) through RapidOCR, as an ``ocr.Engine``.

Detection finds the text lines of the (rotated) disk, recognition reads each
line; lines are concatenated top to bottom. Run with a venv that has
``rapidocr_onnxruntime`` installed.
"""

from __future__ import annotations

import cv2
import numpy as np


def engine():
    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR()

    def run(images: list[np.ndarray]) -> list[tuple[str, float]]:
        out = []
        for im in images:
            if im.ndim == 2:
                im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
            result, _ = ocr(im, use_cls=False)
            if not result:
                out.append(("", 0.0))
                continue
            result.sort(key=lambda r: np.mean([p[1] for p in r[0]]))   # top to bottom
            text = " ".join(r[1] for r in result)
            conf = float(np.mean([float(r[2]) for r in result])) * 100
            out.append((text, conf))
        return out
    return run
