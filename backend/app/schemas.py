from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------------- auth
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(default="", max_length=100)
    lab: str = Field(default="", max_length=200)
    city: str = Field(default="", max_length=100)
    country: str = Field(default="", max_length=100)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=128)


class UserOut(ORM):
    id: int
    email: str
    name: str
    lab: str
    city: str
    country: str


# ----------------------------------------------------------------- catalogue
class StandardOut(ORM):
    id: int
    name: str
    version: str
    valid_from: date | None
    susceptible_op: str
    resistant_op: str
    is_default: bool


class FamilyOut(ORM):
    id: int
    name: str


class AntibioticOut(ORM):
    id: int
    name: str
    drug_class: str
    disk_content: str
    code: str


class BreakpointOut(ORM):
    id: int
    standard_id: int
    family_id: int
    antibiotic_id: int
    case: str
    available: bool
    susceptible: float | None
    resistant: float | None
    comments: str


# --------------------------------------------------------------- experiments
class ExperimentIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    comments: str = Field(default="", max_length=1000)
    standard_id: int | None = None


class ExperimentOut(ORM):
    id: int
    name: str
    comments: str
    standard_id: int
    created_at: datetime


class ExperimentSummary(ExperimentOut):
    antibiogram_count: int
    plate_count: int


class BacteriaIn(BaseModel):
    family_id: int
    genus: str = Field(default="", max_length=100)
    species: str = Field(default="", max_length=100)
    strain: str = Field(default="", max_length=100)
    sample: str = Field(default="", max_length=100)
    comments: str = Field(default="", max_length=1000)


class CircleIO(BaseModel):
    cx: float
    cy: float
    r: float = Field(gt=0)


class MeasurementOut(ORM):
    id: int
    antibiotic: AntibioticOut
    breakpoint: BreakpointOut | None
    standard_id: int
    disk_cx: float
    disk_cy: float
    disk_r: float
    halo_r: float
    diameter_mm: float
    category: str
    microcolonies: bool
    interpretation: str


class PlateOut(ORM):
    id: int
    antibiogram_id: int
    experiment_id: int
    original_filename: str
    disk_mm: float
    px_per_mm: float
    created_at: datetime
    measurements: list[MeasurementOut]


class AntibiogramOut(ORM):
    id: int
    experiment_id: int
    family: FamilyOut
    genus: str
    species: str
    strain: str
    sample: str
    comments: str
    created_at: datetime
    plates: list[PlateOut]


class ExperimentDetail(ExperimentOut):
    standard: StandardOut
    antibiograms: list[AntibiogramOut]


# ------------------------------------------------------------------ analysis
class UploadOut(BaseModel):
    upload_id: str
    width: int
    height: int
    plate: CircleIO | None


class ProcessIn(BaseModel):
    crop: CircleIO | None = None  # crop to the bounding box of this circle
    auto_contrast: bool = False


class ProcessOut(BaseModel):
    width: int
    height: int


class DisksOut(BaseModel):
    disks: list[CircleIO]


class IdentifyIn(BaseModel):
    disks: list[CircleIO] = Field(max_length=40)


class Identification(BaseModel):
    antibiotic_id: int | None
    score: int


class IdentifyOut(BaseModel):
    results: list[Identification]


class HalosIn(BaseModel):
    disks: list[CircleIO] = Field(max_length=40)
    antibiotic_ids: list[int] = Field(max_length=40)
    family_id: int
    standard_id: int
    disk_mm: float = Field(default=6.0, gt=0, le=50)


class HaloResult(BaseModel):
    halo_r: float
    diameter_mm: float
    breakpoints: list[BreakpointOut]
    breakpoint_id: int | None
    category: str


class HalosOut(BaseModel):
    px_per_mm: float
    results: list[HaloResult]


class MeasurementIn(BaseModel):
    antibiotic_id: int
    breakpoint_id: int | None = None
    disk: CircleIO
    halo_r: float = Field(gt=0)
    category: str | None = None  # manual override; computed when omitted
    microcolonies: bool = False
    interpretation: str = Field(default="", max_length=1000)


class PlateIn(BaseModel):
    upload_id: str
    antibiogram_id: int | None = None
    experiment_id: int | None = None
    bacteria: BacteriaIn | None = None
    disk_mm: float = Field(default=6.0, gt=0, le=50)
    measurements: list[MeasurementIn] = Field(min_length=1, max_length=40)
