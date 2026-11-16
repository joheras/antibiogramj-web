"""Disk reading with the PP-OCR text *recogniser* (ONNX) + lexicon-constrained CTC.

No text detector is needed: the disk is small and the code is the only text
on it, so lines are found with projection profiles on the binarised disk.

1. ``normalise`` (flat-field + Otsu) and ``text_mask`` (ink without the
   orientation bar) from the other prototypes.
2. Orientation: projection-profile deskew (angle in [0, 180) maximising the
   variance of the row profile); the two best, well separated angles and
   their 180-degree flips are tried (4 orientations).
3. Each orientation is cut into text lines, each line is recognised by the
   CRNN/SVTR recogniser (48 px high input) giving CTC logits.
4. Lexicon decoding: the probability of every lexicon string (letters +
   content, in reading order) is computed with the CTC forward algorithm on
   the concatenated line logits. The best (orientation, entry) wins. Free
   decoding (greedy, alphanumerics only) is kept for display.

Only onnxruntime + numpy + OpenCV: the same steps run in a browser worker
with onnxruntime-web and OpenCV.js.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

from codes import Entry, lexicon
from ocr import normalise
from render_match import text_mask

LENGTH_WEIGHT = 1.0
ALLOWED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")


def _default_model() -> str:
    import rapidocr_onnxruntime
    return str(Path(rapidocr_onnxruntime.__file__).parent / "models/ch_PP-OCRv3_rec_infer.onnx")


class Recogniser:
    def __init__(self, model_path: str | None = None, threads: int = 4):
        import onnxruntime as ort
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(model_path or _default_model(), opts, providers=["CPUExecutionProvider"])
        meta = self.session.get_modelmeta().custom_metadata_map
        chars = meta["character"].splitlines()
        self.chars = ["<blank>"] + chars + [" "]           # PaddleOCR CTCLabelDecode layout
        self.index = {c: i for i, c in enumerate(self.chars)}
        # Restrict the output to blank + allowed characters (renormalised later).
        self.keep = np.array([0] + [i for i, c in enumerate(self.chars) if c in ALLOWED])
        self.input_name = self.session.get_inputs()[0].name

    def logits(self, lines: list[np.ndarray]) -> list[np.ndarray]:
        """Per line: (T, len(keep)) log-probabilities over blank + allowed chars."""
        if not lines:
            return []
        h = 48
        width = max(int(math.ceil(h * im.shape[1] / im.shape[0])) for im in lines)
        width = max(width, 48)
        batch = np.zeros((len(lines), 3, h, width), np.float32)
        for k, im in enumerate(lines):
            w = int(math.ceil(h * im.shape[1] / im.shape[0]))
            r = cv2.resize(im, (w, h)).astype(np.float32) / 255
            if r.ndim == 2:
                r = np.repeat(r[:, :, None], 3, axis=2)
            batch[k, :, :, :w] = ((r - 0.5) / 0.5).transpose(2, 0, 1)
        probs = self.session.run(None, {self.input_name: batch})[0]   # (N, T, C) softmax
        out = []
        for k, im in enumerate(lines):
            w = int(math.ceil(h * im.shape[1] / im.shape[0]))
            t = max(1, int(round(probs.shape[1] * w / width)))
            p = probs[k, :t][:, self.keep]
            p = p / np.maximum(p.sum(1, keepdims=True), 1e-9)
            out.append(np.log(np.maximum(p, 1e-9)))
        return out

    def greedy(self, logp: np.ndarray) -> str:
        best = logp.argmax(1)
        s, prev = [], 0
        for b in best:
            if b != prev and b != 0:
                s.append(self.chars[self.keep[b]])
            prev = b
        return "".join(s)

    def label(self, text: str) -> list[int] | None:
        pos = {c: j for j, c in enumerate(self.keep)}
        ids = []
        for c in text:
            i = self.index.get(c)
            if i is None or i not in pos:
                return None
            ids.append(pos[i])
        return ids


def ctc_log_likelihood(logp: np.ndarray, label: list[int]) -> float:
    """log P(label | logp) with the CTC forward algorithm (blank = 0)."""
    T = logp.shape[0]
    ext = [0]
    for l in label:
        ext += [l, 0]
    S = len(ext)
    if T == 0:
        return -1e9
    alpha = np.full(S, -np.inf)
    alpha[0] = logp[0, 0]
    if S > 1:
        alpha[1] = logp[0, ext[1]]
    for t in range(1, T):
        prev = alpha
        a = prev.copy()
        a[1:] = np.logaddexp(a[1:], prev[:-1])
        skip = np.full(S, -np.inf)
        for s in range(2, S):
            if ext[s] != 0 and ext[s] != ext[s - 2]:
                skip[s] = prev[s - 2]
        a = np.logaddexp(a, skip)
        alpha = a + logp[t, ext]
    return float(np.logaddexp(alpha[-1], alpha[-2]) if S > 1 else alpha[-1])


def _rotate(im: np.ndarray, angle: float, border: int) -> np.ndarray:
    h, w = im.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(im, m, (w, h), flags=cv2.INTER_LINEAR, borderValue=border)


def orientations(mask: np.ndarray) -> list[float]:
    """Projection-profile deskew: 2 best line directions (+ their flips)."""
    m = mask.astype(np.uint8) * 255
    scores = []
    for a in range(0, 180, 3):
        prof = (_rotate(m, a, 0) > 127).sum(1).astype(np.float32)
        scores.append((float(prof.var()), a))
    scores.sort(reverse=True)
    picked = [scores[0][1]]
    for _, a in scores[1:]:
        if all(min(abs(a - p), 180 - abs(a - p)) > 30 for p in picked):
            picked.append(a)
            break
    # The strongest profile may be the columns of a 2-line block: try the
    # four right-angle variants of each picked direction.
    out: list[float] = []
    for a in picked:
        for k in range(4):
            b = float((a + 90 * k) % 360)
            if all(min(abs(b - o), 360 - abs(b - o)) > 20 for o in out):
                out.append(b)
    return out


def split_lines(mask_rot: np.ndarray, gray_rot: np.ndarray) -> list[np.ndarray]:
    """Cut the rotated disk into text lines (top to bottom) using the row profile."""
    rows = mask_rot.sum(1)
    on = rows > max(2, 0.02 * rows.max())
    lines, y = [], 0
    H = len(rows)
    while y < H:
        if on[y]:
            y0 = y
            while y < H and on[y]:
                y += 1
            if y - y0 >= H * 0.05:
                lines.append((y0, y))
        y += 1
    # Two lines merged by blur or a slight skew: split a block that is too tall
    # for one line at the weakest row of its middle part.
    split = []
    for y0, y1 in lines:
        cols = np.nonzero(mask_rot[y0:y1].sum(0))[0]
        width = cols[-1] - cols[0] + 1 if len(cols) else 0
        if width and (y1 - y0) > 0.6 * width and (y1 - y0) > H * 0.15:
            a, b = y0 + int(0.3 * (y1 - y0)), y0 + int(0.7 * (y1 - y0))
            cut = a + int(np.argmin(np.convolve(rows[a:b], np.ones(5) / 5, "same")))
            split += [(y0, cut), (cut, y1)]
        else:
            split.append((y0, y1))
    lines = split
    out = []
    for y0, y1 in lines:
        cols = np.nonzero(mask_rot[y0:y1].sum(0))[0]
        if len(cols) == 0:
            continue
        pad = int(0.25 * (y1 - y0))
        ya, yb = max(0, y0 - pad), min(H, y1 + pad)
        xa, xb = max(0, cols[0] - pad), min(mask_rot.shape[1], cols[-1] + 1 + pad)
        out.append(gray_rot[ya:yb, xa:xb])
    return out


@dataclass
class PPReading:
    entry: Entry | None
    logp: float
    angle: float
    free_text: str
    candidates: list[tuple[float, str]] = field(default_factory=list)


@lru_cache
def recogniser() -> Recogniser:
    return Recogniser()


def flat_gray(disk_bgr: np.ndarray, size: int = 400) -> np.ndarray:
    g = np.minimum(disk_bgr[:, :, 0], disk_bgr[:, :, 1])
    g = cv2.resize(g, (size, size), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    bg = cv2.morphologyEx(g, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
    flat = np.clip(g / np.maximum(bg, 1) * 255, 0, 255)
    lo, hi = np.percentile(flat, [1, 99])
    return np.clip((flat - lo) * 255 / max(hi - lo, 1), 0, 255).astype(np.uint8)


def robust_binary(disk_bgr: np.ndarray, size: int = 400, k: float = 3.0) -> np.ndarray:
    """Ink = pixels darker than the disk's median by k robust std (MAD); white background.

    Keeps faint print that Otsu loses and does not turn the paper texture of
    pale disks into ink.
    """
    g = np.minimum(disk_bgr[:, :, 0], disk_bgr[:, :, 1])
    g = cv2.resize(g, (size, size), interpolation=cv2.INTER_CUBIC).astype(np.float32)
    g = cv2.GaussianBlur(g, (5, 5), 0)
    bg = cv2.morphologyEx(g, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
    flat = g / np.maximum(bg, 1) * 255
    inside = np.zeros((size, size), np.uint8)
    cv2.circle(inside, (size // 2, size // 2), int(size * 0.43), 255, -1)
    v = flat[inside > 0]
    med = float(np.median(v))
    mad = float(np.median(np.abs(v - med))) * 1.4826
    ink = (flat < med - max(k * mad, 12)) & (inside > 0)
    return np.where(ink, 0, 255).astype(np.uint8)


def ctc_batch(logp: np.ndarray, labels: list[list[int]]) -> np.ndarray:
    """Vectorised CTC forward algorithm: log P(label | logp) for many labels at once."""
    n = len(labels)
    L = max(len(l) for l in labels)
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
    T = logp.shape[0]
    alpha = np.full((n, S), -np.inf)
    alpha[:, 0] = logp[0, 0]
    alpha[:, 1] = np.where(valid[:, 1], logp[0, ext[:, 1]], -np.inf)
    for t in range(1, T):
        a = alpha.copy()
        a[:, 1:] = np.logaddexp(a[:, 1:], alpha[:, :-1])
        sk = np.full_like(alpha, -np.inf)
        sk[:, 2:] = np.where(skip_ok[:, 2:], alpha[:, :-2], -np.inf)
        a = np.logaddexp(a, sk)
        alpha = np.where(valid, a + logp[t][ext], -np.inf)
    last = np.array([2 * len(l) for l in labels])
    rows = np.arange(n)
    return np.logaddexp(alpha[rows, last], alpha[rows, np.maximum(last - 1, 0)])


def central_mask(mask: np.ndarray, max_dist: float = 0.36) -> np.ndarray:
    """Drop ink components whose centroid is far from the disk centre (dirt, rim)."""
    n, labels, stats, cents = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
    size = mask.shape[0]
    keep = np.zeros(n, bool)
    for i in range(1, n):
        if np.hypot(cents[i][0] - size / 2, cents[i][1] - size / 2) < max_dist * size:
            keep[i] = True
    return keep[labels]


def layouts(m_rot: np.ndarray, g_rot: np.ndarray) -> list[list[np.ndarray]]:
    """Line crops of the text block: as one line, and as two lines split at the profile valley."""
    ys, xs = np.nonzero(m_rot)
    if len(xs) < 20:
        return []
    H, W = m_rot.shape
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    h = y1 - y0
    pad = max(4, int(0.15 * h))
    xa, xb = max(0, x0 - pad), min(W, x1 + pad)

    def crop(a, b, pa, pb):
        return g_rot[max(0, a - pa):min(H, b + pb), xa:xb]

    out = [[crop(y0, y1, pad, pad)]]
    rows = np.convolve(m_rot[y0:y1].sum(1).astype(float), np.ones(5) / 5, "same")
    a, b = int(0.25 * h), int(0.75 * h)
    if b - a > 3:
        cut = y0 + a + int(np.argmin(rows[a:b]))
        out.append([crop(y0, cut, pad // 2, 2), crop(cut, y1, 2, pad // 2)])
    return out


def read_disk(disk_bgr: np.ndarray, rec: Recogniser | None = None, step: int = 20) -> PPReading:
    """Coarse search every ``step`` degrees, refined +-step/3 around the best angle."""
    rec = rec or recogniser()
    binary = robust_binary(disk_bgr)
    mask = central_mask(text_mask(binary))
    gray = flat_gray(disk_bgr, binary.shape[0])
    size = binary.shape[0]
    circle = np.zeros_like(gray)
    cv2.circle(circle, (size // 2, size // 2), int(size * 0.45), 255, -1)
    gray[circle == 0] = 255
    mask_u8 = mask.astype(np.uint8) * 255

    lex = [e for e in lexicon() if rec.label(e.text)]
    labels = [rec.label(e.text) for e in lex]
    # Length prior: the code should explain the glyphs seen on the disk
    # (connected components ~ characters; blur can merge or split some).
    n_glyphs = cv2.connectedComponents(mask_u8)[0] - 1
    length_prior = -LENGTH_WEIGHT * np.maximum(0, np.abs(np.array([len(l) for l in labels]) - n_glyphs) - 1)
    results: list[tuple[float, int, float, str]] = []   # (score, entry index, angle, free text)

    def evaluate(angle: float) -> float:
        m_rot = _rotate(mask_u8, angle, 0) > 127
        g_rot = _rotate(gray, angle, 255)
        best_here = -np.inf
        for lines in layouts(m_rot, g_rot):
            logits = rec.logits(lines)
            seq = np.concatenate(logits, 0)
            free = " ".join(rec.greedy(l) for l in logits)
            # Likelihood ratio against the unconstrained (greedy) reading of the
            # same crop: a crop read as "nothing" cannot favour short codes.
            ref = float(ctc_batch(seq, [rec.label(free.replace(" ", "")) or []])[0])
            scores = ctc_batch(seq, labels) - ref + length_prior
            k = int(np.argmax(scores))
            for j in np.argsort(-scores)[:5]:
                results.append((float(scores[j]), int(j), angle, free))
            best_here = max(best_here, float(scores[k]))
        return best_here

    coarse = {a: evaluate(float(a)) for a in range(0, 360, step)}
    a0 = max(coarse, key=coarse.__getitem__)
    for d in (-step / 3, step / 3):
        evaluate(float((a0 + d) % 360))

    best: dict[str, tuple[float, Entry, float, str]] = {}
    for sc, j, angle, free in results:
        e = lex[j]
        if e.name not in best or sc > best[e.name][0]:
            best[e.name] = (sc, e, angle, free)
    if not best:
        return PPReading(None, -1e9, 0.0, "")
    ranked = sorted(best.values(), key=lambda t: -t[0])
    ll, e, a, free = ranked[0]
    return PPReading(e, ll, a, free, [(round(r[0], 1), f"{r[1].letters} {r[1].content}") for r in ranked[:3]])
