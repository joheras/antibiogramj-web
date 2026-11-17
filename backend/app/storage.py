"""File storage for images. Paths stored in the DB are relative to ``data_dir``."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

import cv2
import numpy as np

from .config import settings

cv2.setNumThreads(2)


class ImageError(ValueError):
    pass


def abs_path(rel: str) -> Path:
    path = (settings.data_dir / rel).resolve()
    if settings.data_dir.resolve() not in path.parents:
        raise ValueError("Invalid storage path")
    return path


def new_rel_path(folder: str, ext: str = ".png") -> str:
    return f"{folder}/{uuid.uuid4().hex}{ext}"


def decode_image(data: bytes) -> np.ndarray:
    """Decode an uploaded image (PNG, JPEG, TIFF, BMP...) to BGR uint8."""
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise ImageError(f"The image exceeds {settings.max_upload_mb} MB")
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ImageError("The file is not a supported image")
    if image.shape[0] * image.shape[1] > settings.max_image_pixels:
        raise ImageError("The image resolution is too large")
    if image.dtype != np.uint8:
        image = cv2.normalize(image, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    elif image.shape[2] == 4:
        image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
    return image


def save_image(image: np.ndarray, rel: str) -> None:
    path = abs_path(rel)
    path.parent.mkdir(parents=True, exist_ok=True)
    ext = path.suffix.lower()
    params = [cv2.IMWRITE_JPEG_QUALITY, 92] if ext in (".jpg", ".jpeg") else []
    if not cv2.imwrite(str(path), image, params):
        raise OSError(f"Could not write {rel}")


def load_image(rel: str) -> np.ndarray:
    image = cv2.imread(str(abs_path(rel)), cv2.IMREAD_COLOR)
    if image is None:
        raise FileNotFoundError(rel)
    return image


def delete(rel: str | None) -> None:
    if rel:
        abs_path(rel).unlink(missing_ok=True)


def copy(src: str, dst: str) -> None:
    path = abs_path(dst)
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(abs_path(src), path)
