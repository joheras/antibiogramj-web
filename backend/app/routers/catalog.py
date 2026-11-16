"""Reference data shared by all users: standards, bacteria families, antibiotics, breakpoints."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_user
from ..db import get_db
from ..models import Antibiotic, Breakpoint, Family, Standard
from ..schemas import AntibioticOut, BreakpointOut, FamilyOut, StandardOut

router = APIRouter(prefix="/api/catalog", tags=["catalog"], dependencies=[Depends(current_user)])


@router.get("/standards", response_model=list[StandardOut])
def standards(db: Session = Depends(get_db)):
    return db.scalars(select(Standard).order_by(Standard.is_default.desc(), Standard.name, Standard.version)).all()


@router.get("/families", response_model=list[FamilyOut])
def families(db: Session = Depends(get_db)):
    return db.scalars(select(Family).order_by(Family.name)).all()


@router.get("/antibiotics", response_model=list[AntibioticOut])
def antibiotics(db: Session = Depends(get_db)):
    return db.scalars(select(Antibiotic).order_by(Antibiotic.name, Antibiotic.disk_content)).all()


@router.get("/breakpoints", response_model=list[BreakpointOut])
def breakpoints(standard_id: int, family_id: int, db: Session = Depends(get_db)):
    return db.scalars(select(Breakpoint).where(Breakpoint.standard_id == standard_id,
                                               Breakpoint.family_id == family_id).order_by(Breakpoint.id)).all()
