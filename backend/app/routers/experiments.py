"""Experiments, antibiograms and plates owned by the current user."""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .. import storage
from ..auth import current_user
from ..cv import processing as cvp
from ..db import get_db
from ..excel import experiment_workbook
from ..models import Antibiogram, Antibiotic, Breakpoint, Experiment, Family, Measurement, Plate, Standard, User
from ..schemas import (AntibiogramUpdate, ExperimentDetail, ExperimentIn, ExperimentOut, ExperimentSummary, PlateIn,
                       PlateOut, ReinterpretIn)
from ..standards import CATEGORIES, categorise, pick_breakpoint
from ..templates import learn
from .analysis import diameter_mm, get_upload, px_per_mm

router = APIRouter(prefix="/api", tags=["experiments"])

_NOT_FOUND = "Not found"


def _experiment(db: Session, user: User, experiment_id: int, full: bool = False) -> Experiment:
    query = select(Experiment).where(Experiment.id == experiment_id, Experiment.owner_id == user.id)
    if full:
        query = query.options(selectinload(Experiment.antibiograms).selectinload(Antibiogram.plates)
                              .selectinload(Plate.measurements))
    experiment = db.scalar(query)
    if experiment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)
    return experiment


def _antibiogram(db: Session, user: User, antibiogram_id: int) -> Antibiogram:
    antibiogram = db.scalar(select(Antibiogram).join(Experiment).where(
        Antibiogram.id == antibiogram_id, Experiment.owner_id == user.id))
    if antibiogram is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)
    return antibiogram


def _plate(db: Session, user: User, plate_id: int) -> Plate:
    plate = db.scalar(select(Plate).join(Antibiogram).join(Experiment).where(
        Plate.id == plate_id, Experiment.owner_id == user.id))
    if plate is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NOT_FOUND)
    return plate


def _delete_plate_files(plates: list[Plate]) -> None:
    for p in plates:
        storage.delete(p.image_path)
        storage.delete(p.annotated_path)


# --------------------------------------------------------------- experiments
@router.get("/experiments", response_model=list[ExperimentSummary])
def list_experiments(db: Session = Depends(get_db), user: User = Depends(current_user)):
    antibiograms = (select(Antibiogram.experiment_id, func.count(Antibiogram.id).label("n"))
                    .group_by(Antibiogram.experiment_id).subquery())
    plates = (select(Antibiogram.experiment_id, func.count(Plate.id).label("n")).join(Plate)
              .group_by(Antibiogram.experiment_id).subquery())
    rows = db.execute(
        select(Experiment, func.coalesce(antibiograms.c.n, 0), func.coalesce(plates.c.n, 0))
        .outerjoin(antibiograms, antibiograms.c.experiment_id == Experiment.id)
        .outerjoin(plates, plates.c.experiment_id == Experiment.id)
        .where(Experiment.owner_id == user.id).order_by(Experiment.created_at.desc())).all()
    return [ExperimentSummary(**ExperimentOut.model_validate(e).model_dump(), antibiogram_count=a, plate_count=p)
            for e, a, p in rows]


@router.post("/experiments", response_model=ExperimentOut, status_code=201)
def create_experiment(body: ExperimentIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if body.standard_id is None:
        standard = db.scalar(select(Standard).order_by(Standard.is_default.desc(), Standard.id))
    else:
        standard = db.get(Standard, body.standard_id)
    if standard is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown standard")
    experiment = Experiment(owner_id=user.id, name=body.name, comments=body.comments, standard_id=standard.id)
    db.add(experiment)
    db.commit()
    return experiment


@router.get("/experiments/{experiment_id}", response_model=ExperimentDetail)
def get_experiment(experiment_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return _experiment(db, user, experiment_id, full=True)


@router.patch("/experiments/{experiment_id}", response_model=ExperimentOut)
def update_experiment(experiment_id: int, body: ExperimentIn, db: Session = Depends(get_db),
                      user: User = Depends(current_user)):
    experiment = _experiment(db, user, experiment_id)
    experiment.name, experiment.comments = body.name, body.comments
    db.commit()
    return experiment


@router.delete("/experiments/{experiment_id}", status_code=204)
def delete_experiment(experiment_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    experiment = _experiment(db, user, experiment_id, full=True)
    plates = [p for a in experiment.antibiograms for p in a.plates]
    db.delete(experiment)
    db.commit()
    _delete_plate_files(plates)


@router.get("/experiments/{experiment_id}/export.xlsx")
def export_experiment(experiment_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    experiment = _experiment(db, user, experiment_id, full=True)
    content = experiment_workbook(experiment)
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in experiment.name)[:60] or "experiment"
    return Response(content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.xlsx"'})


@router.post("/experiments/{experiment_id}/reinterpret", response_model=ExperimentOut, status_code=201)
def reinterpret_experiment(experiment_id: int, body: ReinterpretIn, db: Session = Depends(get_db),
                           user: User = Depends(current_user)):
    """Copy of the experiment with every measured diameter categorised with another standard.

    The original experiment is not modified. Each copied measurement keeps its first interpretation (standard,
    category and whether it was set by hand); manual categories are not carried over, they are recalculated.
    Antibiotics or families without a breakpoint in the new standard become "Not available".
    """
    source = _experiment(db, user, experiment_id, full=True)
    standard = db.get(Standard, body.standard_id)
    if standard is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown standard")
    if standard.id == source.standard_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "The experiment already uses this standard")
    # "E. coli (EUCAST 6.0)" -> "E. coli (EUCAST 16.1)", not "E. coli (EUCAST 6.0) (EUCAST 16.1)"
    source_suffix = f" ({source.standard.name} {source.standard.version})"
    base = source.name.removesuffix(source_suffix) or source.name
    copy = Experiment(owner_id=user.id, name=body.name or f"{base} ({standard.name} {standard.version})"[:100],
                      comments=source.comments, standard_id=standard.id,
                      reinterpreted_from=f"{base}{source_suffix}"[:250])
    db.add(copy)
    db.flush()

    # Antibiotics with the same name and disk may be listed under another drug class in each standard.
    same_disk: dict[tuple[str, str], list[int]] = {}
    for a in db.scalars(select(Antibiotic).order_by(Antibiotic.id)):
        same_disk.setdefault((a.name.lower(), a.disk_content), []).append(a.id)
    breakpoints: dict[tuple[int, int], list[Breakpoint]] = {}
    for b in db.scalars(select(Breakpoint).where(Breakpoint.standard_id == standard.id).order_by(Breakpoint.id)):
        breakpoints.setdefault((b.family_id, b.antibiotic_id), []).append(b)

    new_files: list[str] = []
    try:
        for a in source.antibiograms:
            antibiogram = Antibiogram(experiment_id=copy.id, family_id=a.family_id, genus=a.genus, species=a.species,
                                      strain=a.strain, sample=a.sample, comments=a.comments,
                                      supplementary_tests=dict(a.supplementary_tests or {}), qc_strain=a.qc_strain,
                                      created_at=a.created_at)
            db.add(antibiogram)
            db.flush()
            for p in a.plates:
                image = storage.load_image(p.image_path)
                plate = Plate(antibiogram_id=antibiogram.id, original_filename=p.original_filename,
                              image_path=storage.new_rel_path(f"plates/{user.id}", Path(p.image_path).suffix),
                              annotated_path=storage.new_rel_path(f"plates/{user.id}", ".jpg"),
                              disk_mm=p.disk_mm, px_per_mm=p.px_per_mm, created_at=p.created_at)
                db.add(plate)
                db.flush()
                annotations, used = [], {m.antibiotic_id for m in p.measurements}
                for m in p.measurements:
                    antibiotic_id, candidates = m.antibiotic_id, breakpoints.get((a.family_id, m.antibiotic_id), [])
                    if not candidates:
                        for other in same_disk.get((m.antibiotic.name.lower(), m.antibiotic.disk_content), []):
                            if other not in used and breakpoints.get((a.family_id, other)):
                                used.discard(antibiotic_id)
                                used.add(other)
                                antibiotic_id, candidates = other, breakpoints[(a.family_id, other)]
                                break
                    breakpoint = pick_breakpoint(candidates, m.breakpoint.case if m.breakpoint else None)
                    category = categorise(m.diameter_mm, breakpoint, standard)
                    if m.original_standard_id is None:
                        original = (m.standard_id, m.category,
                                    m.category != categorise(m.diameter_mm, m.breakpoint, m.standard))
                    else:
                        original = (m.original_standard_id, m.original_category, m.original_overridden)
                    db.add(Measurement(plate_id=plate.id, antibiotic_id=antibiotic_id, standard_id=standard.id,
                                       breakpoint_id=breakpoint.id if breakpoint else None, disk_cx=m.disk_cx,
                                       disk_cy=m.disk_cy, disk_r=m.disk_r, halo_r=m.halo_r,
                                       diameter_mm=m.diameter_mm, category=category, microcolonies=m.microcolonies,
                                       interpretation=m.interpretation, original_standard_id=original[0],
                                       original_category=original[1], original_overridden=original[2]))
                    annotations.append({
                        "disk": cvp.Circle(m.disk_cx, m.disk_cy, m.disk_r), "halo_r": m.halo_r,
                        "code": m.antibiotic.code, "category": category,
                        "s_r": breakpoint.susceptible * p.px_per_mm / 2 if breakpoint and breakpoint.susceptible else None,
                        "r_r": breakpoint.resistant * p.px_per_mm / 2 if breakpoint and breakpoint.resistant else None,
                    })
                new_files += [plate.image_path, plate.annotated_path]
                storage.copy(p.image_path, plate.image_path)
                storage.save_image(cvp.render_annotations(image, annotations), plate.annotated_path)
        db.commit()
    except Exception:
        db.rollback()
        for rel in new_files:
            storage.delete(rel)
        raise
    return copy


# -------------------------------------------------------------- antibiograms
@router.patch("/antibiograms/{antibiogram_id}", status_code=204)
def update_antibiogram(antibiogram_id: int, body: AntibiogramUpdate, db: Session = Depends(get_db),
                       user: User = Depends(current_user)):
    """Organism data (the family selects the breakpoints and cannot change) and supplementary tests."""
    antibiogram = _antibiogram(db, user, antibiogram_id)
    for field, value in body.model_dump().items():
        setattr(antibiogram, field, value)
    db.commit()


@router.delete("/antibiograms/{antibiogram_id}", status_code=204)
def delete_antibiogram(antibiogram_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    antibiogram = _antibiogram(db, user, antibiogram_id)
    plates = list(antibiogram.plates)
    db.delete(antibiogram)
    db.commit()
    _delete_plate_files(plates)


# -------------------------------------------------------------------- plates
@router.post("/plates", response_model=PlateOut, status_code=201)
def create_plate(body: PlateIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    upload = get_upload(db, user, body.upload_id)
    if not upload.working_path:
        raise HTTPException(status.HTTP_409_CONFLICT, "The image has not been pre-processed yet")

    if body.antibiogram_id is not None:
        antibiogram = _antibiogram(db, user, body.antibiogram_id)
    elif body.experiment_id is not None and body.bacteria is not None:
        _experiment(db, user, body.experiment_id)
        if db.get(Family, body.bacteria.family_id) is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown bacteria family")
        antibiogram = Antibiogram(experiment_id=body.experiment_id, **body.bacteria.model_dump())
        db.add(antibiogram)
        db.flush()
    else:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "Give an antibiogram, or an experiment and the bacteria data")

    standard = antibiogram.experiment.standard
    antibiotic_ids = [m.antibiotic_id for m in body.measurements]
    if len(set(antibiotic_ids)) != len(antibiotic_ids):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Each antibiotic can appear only once per plate")
    antibiotics = {a.id: a for a in db.scalars(select(Antibiotic).where(Antibiotic.id.in_(antibiotic_ids)))}
    if len(antibiotics) != len(antibiotic_ids):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown antibiotic")

    image = storage.load_image(upload.working_path)
    scale = px_per_mm([m.disk for m in body.measurements], body.disk_mm)
    plate = Plate(antibiogram_id=antibiogram.id, original_filename=upload.original_filename,
                  image_path=upload.working_path, annotated_path=storage.new_rel_path(f"plates/{user.id}", ".jpg"),
                  disk_mm=body.disk_mm, px_per_mm=scale)
    db.add(plate)
    db.flush()

    annotations = []
    for m in body.measurements:
        candidates = db.scalars(select(Breakpoint).where(
            Breakpoint.standard_id == standard.id, Breakpoint.family_id == antibiogram.family_id,
            Breakpoint.antibiotic_id == m.antibiotic_id).order_by(Breakpoint.id)).all()
        if m.breakpoint_id is None:
            breakpoint = candidates[0] if candidates else None
        else:
            breakpoint = next((b for b in candidates if b.id == m.breakpoint_id), None)
            if breakpoint is None:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Breakpoint does not apply")
        diameter = diameter_mm(m.halo_r, scale)
        category = m.category if m.category in CATEGORIES else categorise(diameter, breakpoint, standard)
        db.add(Measurement(plate_id=plate.id, antibiotic_id=m.antibiotic_id, standard_id=standard.id,
                           breakpoint_id=breakpoint.id if breakpoint else None, disk_cx=m.disk.cx,
                           disk_cy=m.disk.cy, disk_r=m.disk.r, halo_r=m.halo_r, diameter_mm=diameter,
                           category=category, microcolonies=m.microcolonies, interpretation=m.interpretation))
        disk = cvp.Circle(m.disk.cx, m.disk.cy, m.disk.r)
        annotations.append({
            "disk": disk, "halo_r": m.halo_r, "code": antibiotics[m.antibiotic_id].code, "category": category,
            "s_r": breakpoint.susceptible * scale / 2 if breakpoint and breakpoint.susceptible else None,
            "r_r": breakpoint.resistant * scale / 2 if breakpoint and breakpoint.resistant else None,
        })
        learn(db, user.id, m.antibiotic_id, cvp.disk_crop(image, disk))

    storage.save_image(cvp.render_annotations(image, annotations), plate.annotated_path)
    original = upload.original_path
    db.delete(upload)
    db.commit()
    storage.delete(original)
    db.refresh(plate)
    return plate


@router.get("/plates/{plate_id}", response_model=PlateOut)
def get_plate(plate_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return _plate(db, user, plate_id)


@router.get("/plates/{plate_id}/image")
def plate_image(plate_id: int, annotated: bool = False, db: Session = Depends(get_db),
                user: User = Depends(current_user)):
    plate = _plate(db, user, plate_id)
    rel = plate.annotated_path if annotated else plate.image_path
    media = "image/jpeg" if rel.endswith(".jpg") else "image/png"
    return FileResponse(storage.abs_path(rel), media_type=media, headers={"Cache-Control": "private, max-age=3600"})


@router.delete("/plates/{plate_id}", status_code=204)
def delete_plate(plate_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    plate = _plate(db, user, plate_id)
    antibiogram_id = plate.antibiogram_id
    db.delete(plate)
    db.flush()
    if not db.scalar(select(func.count(Plate.id)).where(Plate.antibiogram_id == antibiogram_id)):
        db.delete(db.get(Antibiogram, antibiogram_id))  # an antibiogram without plates is meaningless
    db.commit()
    _delete_plate_files([plate])
