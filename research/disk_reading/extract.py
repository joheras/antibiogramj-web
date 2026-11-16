"""Extract disk crops from the sample plates (same pipeline as the app)."""
import sys, glob, os
from pathlib import Path
import cv2, numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app.cv.processing import detect_plate, crop, enhance_contrast, detect_disks, disk_crop

def plate_disks(path):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    p = detect_plate(img)
    if p is not None:
        img = crop(img, p.cx - p.r, p.cy - p.r, 2 * p.r, 2 * p.r)
    img = enhance_contrast(img)
    return img, detect_disks(img)

if __name__ == "__main__":
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    for f in sys.argv[2:]:
        name = Path(f).stem
        img, disks = plate_disks(f)
        crops = [cv2.resize(disk_crop(img, d), (160, 160)) for d in disks]
        for i, c in enumerate(crops):
            cv2.imwrite(str(out / f"{name}_{i}.png"), c)
        vis = img.copy()
        for i, d in enumerate(disks):
            cv2.putText(vis, str(i), (int(d.cx), int(d.cy - d.r)), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 4)
        cv2.imwrite(str(out / f"{name}_plate.jpg"), cv2.resize(vis, (800, int(800 * vis.shape[0] / vis.shape[1]))))
        if crops:
            cv2.imwrite(str(out / f"{name}_montage.png"), np.hstack(crops))
        print(name, len(disks))
