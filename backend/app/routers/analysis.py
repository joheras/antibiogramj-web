"""Image-analysis wizard (workspace/wizard/step*.java).

1. upload        -> store the image and suggest the plate region
2. process       -> crop + optional automatic brightness/contrast
3. disks         -> detect antibiotic disks (user then edits them)
4. identify      -> read the code printed on every disk
5. halos         -> measure inhibition zones and categorise them (S/I/R)
The plate is saved through ``POST /api/plates``.
"""

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import cv2
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import storage
from ..auth import current_user
from ..config import settings
from ..cv import processing as cvp
from ..cv.matching import best_match
from ..db import get_db
from ..models import Antibiotic, Breakpoint, Family, Standard, Upload, User
from ..schemas import (BreakpointOut, CircleIO, DisksOut, HaloResult, HalosIn, HalosOut, Identification, IdentifyIn,
                       IdentifyOut, ProcessIn, ProcessOut, UploadOut)
from ..standards import categorise
from ..templates import templates_for

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


def px_per_mm(disks: list[CircleIO], disk_mm: float) -> float:
    """Image scale from the known physical diameter of the antibiotic disks (step3_2)."""
    return sum(2 * d.r for d in disks) / len(disks) / disk_mm


def diameter_mm(halo_r: float, scale: float) -> float:
    return round(2 * halo_r / scale, 1)


def get_upload(db: Session, user: User, upload_id: str) -> Upload:
    upload = db.get(Upload, upload_id)
    if upload is None or upload.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image not found")
    return upload


def _working(upload: Upload):
    if not upload.working_path:
        raise HTTPException(status.HTTP_409_CONFLICT, "The image has not been pre-processed yet")
    return storage.load_image(upload.working_path)


def purge_old_uploads(db: Session) -> None:
    limit = datetime.now(timezone.utc) - timedelta(hours=settings.upload_ttl_hours)
    for upload in db.scalars(select(Upload)):
        created = upload.created_at if upload.created_at.tzinfo else upload.created_at.replace(tzinfo=timezone.utc)
        if created < limit:
            storage.delete(upload.original_path)
            storage.delete(upload.working_path)
            db.delete(upload)
    db.commit()


@router.post("/uploads", response_model=UploadOut, status_code=201)
def upload_image(file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(current_user)):
    data = file.file.read(settings.max_upload_mb * 1024 * 1024 + 1)
    try:
        image = storage.decode_image(data)
    except storage.ImageError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    upload = Upload(id=uuid.uuid4().hex, owner_id=user.id, original_filename=(file.filename or "")[:255],
                    original_path=storage.new_rel_path(f"uploads/{user.id}"))
    storage.save_image(image, upload.original_path)
    db.add(upload)
    db.commit()
    plate = cvp.detect_plate(image)
    h, w = image.shape[:2]
    return UploadOut(upload_id=upload.id, width=w, height=h, plate=CircleIO(**plate.as_dict()) if plate else None)


@router.get("/uploads/{upload_id}/image")
def upload_image_file(upload_id: str, stage: str = "working", db: Session = Depends(get_db),
                      user: User = Depends(current_user)):
    upload = get_upload(db, user, upload_id)
    rel = upload.working_path if stage == "working" else upload.original_path
    if not rel:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image not available")
    return FileResponse(storage.abs_path(rel), media_type="image/png", headers={"Cache-Control": "private, no-store"})


@router.post("/uploads/{upload_id}/process", response_model=ProcessOut)
def process(upload_id: str, body: ProcessIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    upload = get_upload(db, user, upload_id)
    image = storage.load_image(upload.original_path)
    if body.crop:
        c = body.crop
        try:
            image = cvp.crop(image, round(c.cx - c.r), round(c.cy - c.r), round(2 * c.r), round(2 * c.r))
        except ValueError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e))
    h, w = image.shape[:2]
    scale = settings.working_max_side / max(h, w)
    if scale < 1:
        image = cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    if body.auto_contrast:
        image = cvp.enhance_contrast(image)
    old = upload.working_path
    upload.working_path = storage.new_rel_path(f"uploads/{user.id}")
    storage.save_image(image, upload.working_path)
    storage.delete(old)
    db.commit()
    return ProcessOut(width=image.shape[1], height=image.shape[0])


@router.post("/uploads/{upload_id}/disks", response_model=DisksOut)
def disks(upload_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    image = _working(get_upload(db, user, upload_id))
    return DisksOut(disks=[CircleIO(**d.as_dict()) for d in cvp.detect_disks(image)])


@router.post("/uploads/{upload_id}/identify", response_model=IdentifyOut)
def identify(upload_id: str, body: IdentifyIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    image = _working(get_upload(db, user, upload_id))
    templates = templates_for(db, user.id)
    crops = [cvp.disk_crop(image, cvp.Circle(d.cx, d.cy, d.r)) for d in body.disks]
    with ThreadPoolExecutor(max_workers=4) as pool:
        matches = list(pool.map(lambda c: best_match(c, templates) if c.size else (None, 0), crops))
    return IdentifyOut(results=[Identification(antibiotic_id=a, score=s) for a, s in matches])


@router.post("/uploads/{upload_id}/halos", response_model=HalosOut)
def halos(upload_id: str, body: HalosIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if not body.disks or len(body.disks) != len(body.antibiotic_ids):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "One antibiotic is required for every disk")
    image = _working(get_upload(db, user, upload_id))
    standard = db.get(Standard, body.standard_id)
    if standard is None or db.get(Family, body.family_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown standard or bacteria family")
    found = set(db.scalars(select(Antibiotic.id).where(Antibiotic.id.in_(body.antibiotic_ids))))
    if found != set(body.antibiotic_ids):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown antibiotic")

    scale = px_per_mm(body.disks, body.disk_mm)
    brightness = cvp.brightness_channel(image)
    global_mean = float(brightness.mean())
    results = []
    for disk, antibiotic_id in zip(body.disks, body.antibiotic_ids):
        halo = cvp.detect_halo(brightness, cvp.Circle(disk.cx, disk.cy, disk.r), global_mean)
        candidates = db.scalars(select(Breakpoint).where(
            Breakpoint.standard_id == standard.id, Breakpoint.family_id == body.family_id,
            Breakpoint.antibiotic_id == antibiotic_id).order_by(Breakpoint.id)).all()
        chosen = candidates[0] if candidates else None
        diameter = diameter_mm(halo.r, scale)
        results.append(HaloResult(halo_r=round(halo.r, 2), diameter_mm=diameter,
                                  breakpoints=[BreakpointOut.model_validate(b) for b in candidates],
                                  breakpoint_id=chosen.id if chosen else None,
                                  category=categorise(diameter, chosen, standard)))
    return HalosOut(px_per_mm=scale, results=results)
