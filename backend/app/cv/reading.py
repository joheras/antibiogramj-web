"""Reading the code printed on an antibiotic disk with a text recogniser (OCR).

See docs/disk-reading.md. The recogniser is PaddleOCR's PP-OCRv3 text-line
model (``seed/models/ppocr_rec.onnx``, built by scripts/build_ocr_model.py),
run with onnxruntime. No text detector is needed: the code is the only text
on the disk.

1. ``robust_binary``: ink = pixels clearly darker than the disk's median
   (min of G and B, so red print counts as ink), after flat-fielding.
2. ``text_mask``: ink without specks, the orientation bar and dirt far from
   the centre. Its number of components estimates the number of characters.
3. Orientations every ``step`` degrees, then +-step/3 around the best one.
   In each, the text block is cut as one line and as two lines.
4. The recogniser gives per-time-step character probabilities (CTC).
5. Lexicon decoding: ``log P(code | image)`` of every lexicon entry with the
   CTC forward algorithm, minus the likelihood of the free (greedy) reading
   of the same crop, plus a length prior. The best (orientation, entry) wins
   and its score is the confidence: 0 for a perfect reading, the lower the
   less certain (>= -2 was always right in the study).

The same steps run in the browser (frontend/src/browser/ocr.ts).
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from .codes import Entry

SIZE = 400                 # disks are resampled to SIZE x SIZE pixels
LINE_HEIGHT = 48           # recogniser input height
LENGTH_WEIGHT = 1.0
GLYPH_FRACTION = 0.2       # ink components smaller than this fraction of the largest are fragments, not glyphs
ALLOWED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")


class Recogniser:
    """PP-OCR text-line recogniser restricted to blank + ``A-Z 0-9``."""

    def __init__(self, model_path: Path, threads: int = 2):
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(str(model_path), opts, providers=["CPUExecutionProvider"])
        chars = self.session.get_modelmeta().custom_metadata_map["character"].splitlines()
        n_out = self.session.get_outputs()[0].shape[-1]
        self.chars = ["<blank>"] + chars + ([" "] if not isinstance(n_out, int) or n_out > len(chars) + 1 else [])
        self.keep = np.array([0] + [i for i, c in enumerate(self.chars) if c in ALLOWED])
        self.pos = {self.chars[k]: j for j, k in enumerate(self.keep) if j}
        self.input_name = self.session.get_inputs()[0].name

    def logits(self, lines: list[np.ndarray]) -> list[np.ndarray]:
        """Per line (grey uint8): (T, 1 + 36) log-probabilities over blank + allowed characters."""
        if not lines:
            return []
        widths = [max(1, int(math.ceil(LINE_HEIGHT * im.shape[1] / im.shape[0]))) for im in lines]
        width = max(max(widths), LINE_HEIGHT)
        batch = np.zeros((len(lines), 3, LINE_HEIGHT, width), np.float32)
        for k, (im, w) in enumerate(zip(lines, widths)):
            r = cv2.resize(im, (w, LINE_HEIGHT)).astype(np.float32) / 255
            batch[k, :, :, :w] = (r - 0.5) / 0.5
        probs = self.session.run(None, {self.input_name: batch})[0]   # (N, T, C) softmax
        out = []
        for k, w in enumerate(widths):
            t = max(1, int(round(probs.shape[1] * w / width)))
            p = probs[k, :t][:, self.keep]
            p = p / np.maximum(p.sum(1, keepdims=True), 1e-9)
            out.append(np.log(np.maximum(p, 1e-9)))
        return out

    def greedy(self, logp: np.ndarray) -> str:
        s, prev = [], 0
        for b in logp.argmax(1):
            if b != prev and b != 0:
                s.append(self.chars[self.keep[b]])
            prev = b
        return "".join(s)

    def label(self, text: str) -> list[int] | None:
        ids = [self.pos.get(c) for c in text]
        return None if not ids or None in ids else ids   # type: ignore[return-value]


def ctc_batch(logp: np.ndarray, labels: list[list[int]]) -> np.ndarray:
    """CTC forward algorithm (blank = 0): ``log P(label | logp)`` for many labels at once."""
    n = len(labels)
    L = max(len(lab) for lab in labels)
    if L == 0:
        return np.full(n, float(logp[:, 0].sum()))
    S = 2 * L + 1
    ext = np.zeros((n, S), int)
    valid = np.zeros((n, S), bool)
    for k, lab in enumerate(labels):
        ext[k, 1:2 * len(lab):2] = lab
        valid[k, :2 * len(lab) + 1] = True
    skip_ok = np.zeros((n, S), bool)
    skip_ok[:, 2:] = (ext[:, 2:] != 0) & (ext[:, 2:] != ext[:, :-2])
    alpha = np.full((n, S), -np.inf)
    alpha[:, 0] = logp[0, 0]
    alpha[:, 1] = np.where(valid[:, 1], logp[0, ext[:, 1]], -np.inf)
    for t in range(1, logp.shape[0]):
        a = alpha.copy()
        a[:, 1:] = np.logaddexp(a[:, 1:], alpha[:, :-1])
        sk = np.full_like(alpha, -np.inf)
        sk[:, 2:] = np.where(skip_ok[:, 2:], alpha[:, :-2], -np.inf)
        a = np.logaddexp(a, sk)
        alpha = np.where(valid, a + logp[t][ext], -np.inf)
    last = np.array([2 * len(lab) for lab in labels])
    rows = np.arange(n)
    return np.logaddexp(alpha[rows, last], alpha[rows, np.maximum(last - 1, 0)])


# ------------------------------------------------------------------ preprocessing
def _min_gb(disk_bgr: np.ndarray) -> np.ndarray:
    g = np.minimum(disk_bgr[:, :, 0], disk_bgr[:, :, 1])
    return cv2.resize(g, (SIZE, SIZE), interpolation=cv2.INTER_CUBIC).astype(np.float32)


def _background(g: np.ndarray) -> np.ndarray:
    return cv2.morphologyEx(g, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))


def robust_binary(disk_bgr: np.ndarray, k: float = 3.0) -> np.ndarray:
    """Ink (0) on white (255): darker than the disk's median by ``k`` robust standard deviations."""
    g = cv2.GaussianBlur(_min_gb(disk_bgr), (5, 5), 0)
    flat = g / np.maximum(_background(g), 1) * 255
    inside = np.zeros((SIZE, SIZE), np.uint8)
    cv2.circle(inside, (SIZE // 2, SIZE // 2), int(SIZE * 0.43), 255, -1)
    v = flat[inside > 0]
    med = float(np.median(v))
    mad = float(np.median(np.abs(v - med))) * 1.4826
    ink = (flat < med - max(k * mad, 12)) & (inside > 0)
    return np.where(ink, 0, 255).astype(np.uint8)


def flat_gray(disk_bgr: np.ndarray) -> np.ndarray:
    """Flat-fielded, contrast-stretched grey disk (what the recogniser sees); white outside the disk."""
    g = _min_gb(disk_bgr)
    flat = np.clip(g / np.maximum(_background(g), 1) * 255, 0, 255)
    lo, hi = np.percentile(flat, [1, 99])
    out = np.clip((flat - lo) * 255 / max(hi - lo, 1), 0, 255).astype(np.uint8)
    circle = np.zeros_like(out)
    cv2.circle(circle, (SIZE // 2, SIZE // 2), int(SIZE * 0.45), 255, -1)
    out[circle == 0] = 255
    return out


def text_mask(binary: np.ndarray, max_dist: float = 0.36) -> np.ndarray:
    """Ink components of the code (uint8 0/255): no specks, no orientation bar, near the centre."""
    n, labels, stats, cents = cv2.connectedComponentsWithStats((binary < 128).astype(np.uint8))
    keep = np.zeros(n, bool)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < SIZE * SIZE * 0.0005:
            continue
        if math.hypot(cents[i][0] - SIZE / 2, cents[i][1] - SIZE / 2) >= max_dist * SIZE:
            continue
        cnts, _ = cv2.findContours((labels == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        (_, _), (rw, rh), _ = cv2.minAreaRect(cnts[0])
        if max(rw, rh) / max(1.0, min(rw, rh)) > 3.5 and max(rw, rh) > SIZE * 0.12:   # orientation bar
            continue
        keep[i] = True
    return np.where(keep[labels], 255, 0).astype(np.uint8)


def _rotate(im: np.ndarray, angle: float, border: int) -> np.ndarray:
    m = cv2.getRotationMatrix2D((SIZE / 2, SIZE / 2), angle, 1.0)
    return cv2.warpAffine(im, m, (SIZE, SIZE), flags=cv2.INTER_LINEAR, borderValue=border)


def layouts(m_rot: np.ndarray, g_rot: np.ndarray) -> list[list[np.ndarray]]:
    """Line crops of the text block: as one line, and as two lines split at the row-profile valley."""
    ys, xs = np.nonzero(m_rot)
    if len(xs) < 20:
        return []
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
    h = y1 - y0
    pad = max(4, int(0.15 * h))
    xa, xb = max(0, x0 - pad), min(SIZE, x1 + pad)

    def crop(a: int, b: int, pa: int, pb: int) -> np.ndarray:
        return g_rot[max(0, a - pa):min(SIZE, b + pb), xa:xb]

    out = [[crop(y0, y1, pad, pad)]]
    rows = np.convolve(m_rot[y0:y1].sum(1).astype(float), np.ones(5) / 5, "same")
    a, b = int(0.25 * h), int(0.75 * h)
    if b - a > 3:
        cut = y0 + a + int(np.argmin(rows[a:b]))
        out.append([crop(y0, cut, pad // 2, 2), crop(cut, y1, 2, pad // 2)])
    return out


# ------------------------------------------------------------------------ reader
@dataclass
class Candidate:
    entry: Entry
    confidence: float


@dataclass
class Reading:
    candidates: list[Candidate] = field(default_factory=list)   # best first, one per antibiotic name
    free_text: str = ""                                         # unconstrained reading of the best orientation
    angle: float = 0.0

    @property
    def best(self) -> Candidate | None:
        return self.candidates[0] if self.candidates else None


class DiskReader:
    def __init__(self, model_path: Path, threads: int = 2):
        self.rec = Recogniser(model_path, threads)
        self._prepared: dict[tuple[Entry, ...], tuple[list[Entry], list[list[int]], np.ndarray]] = {}

    def _prepare(self, lexicon: tuple[Entry, ...]) -> tuple[list[Entry], list[list[int]], np.ndarray]:
        if lexicon not in self._prepared:
            entries = [e for e in lexicon if self.rec.label(e.text)]
            labels = [self.rec.label(e.text) for e in entries]
            self._prepared = {lexicon: (entries, labels, np.array([len(lab) for lab in labels]))}  # type: ignore[misc]
        return self._prepared[lexicon]

    def read(self, disk_bgr: np.ndarray, lexicon: tuple[Entry, ...], step: int = 20, top: int = 3) -> Reading:
        entries, labels, lengths = self._prepare(lexicon)
        if disk_bgr.size == 0 or not entries:
            return Reading()
        mask = text_mask(robust_binary(disk_bgr))
        gray = flat_gray(disk_bgr)
        # Length prior: the code should explain the glyphs seen (blur can merge or split some).
        areas = cv2.connectedComponentsWithStats(mask)[2][1:, cv2.CC_STAT_AREA]
        n_glyphs = int((areas >= GLYPH_FRACTION * areas.max()).sum()) if len(areas) else 0
        prior = -LENGTH_WEIGHT * np.maximum(0, np.abs(lengths - n_glyphs) - 1)
        best: dict[str, tuple[float, int, float, str]] = {}   # name -> (score, entry, angle, free text)

        def evaluate(angle: float) -> float:
            m_rot = _rotate(mask, angle, 0) > 127
            g_rot = _rotate(gray, angle, 255)
            here = -np.inf
            for lines in layouts(m_rot, g_rot):
                logits = self.rec.logits(lines)
                seq = np.concatenate(logits, 0)
                free = " ".join(self.rec.greedy(lp) for lp in logits)
                # Likelihood ratio against the free reading of the same crop: a crop read as
                # "nothing" cannot favour short codes.
                ref = float(ctc_batch(seq, [self.rec.label(free.replace(" ", "")) or []])[0])
                scores = ctc_batch(seq, labels) - ref + prior
                for j in np.argsort(-scores)[:5]:
                    name = entries[j].name
                    if name not in best or scores[j] > best[name][0]:
                        best[name] = (float(scores[j]), int(j), angle, free)
                here = max(here, float(scores.max()))
            return here

        coarse = {a: evaluate(float(a)) for a in range(0, 360, step)}
        a0 = max(coarse, key=coarse.__getitem__)
        for d in (-step / 3, step / 3):
            evaluate(float((a0 + d) % 360))
        if not best:
            return Reading()
        ranked = sorted(best.values(), key=lambda t: -t[0])
        return Reading([Candidate(entries[j], round(min(0.0, s), 2)) for s, j, _, _ in ranked[:top]],
                       ranked[0][3], ranked[0][2])


_readers: dict[Path, DiskReader | None] = {}
_readers_lock = threading.Lock()


def get_reader(model_path: Path) -> DiskReader | None:
    """Shared reader (``None`` when the model or onnxruntime is not available)."""
    with _readers_lock:
        if model_path not in _readers:
            try:
                _readers[model_path] = DiskReader(model_path)
            except (ImportError, OSError, RuntimeError, ValueError, KeyError):
                _readers[model_path] = None
        return _readers[model_path]
