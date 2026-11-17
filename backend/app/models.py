"""Data model.

Mirrors the AntibiogramJ Derby schema (Lab/User0, Standard, Family, Bacteria,
Experiment, Antibiogram, Plate, Antibiotic, BreakPoint, Measurement) adapted to
a multi-user service: every experiment belongs to a user and all user data is
reached through it. Bacteria data is stored inline in the antibiogram.
"""

from datetime import date, datetime, timezone

from sqlalchemy import JSON, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(100), default="")
    lab: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(100), default="")
    country: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ------------------------------------------------------------------ reference data
class Standard(Base):
    __tablename__ = "standards"
    __table_args__ = (UniqueConstraint("name", "version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(45))
    version: Mapped[str] = mapped_column(String(45))
    valid_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    susceptible_op: Mapped[str] = mapped_column(String(2))  # ">=" or ">"
    resistant_op: Mapped[str] = mapped_column(String(2))  # "<" or "<="
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)


class Family(Base):
    """Bacteria family / group as named in the standards (e.g. Enterobacteriaceae)."""

    __tablename__ = "families"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)


class Antibiotic(Base):
    __tablename__ = "antibiotics"
    __table_args__ = (UniqueConstraint("name", "drug_class", "disk_content"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    drug_class: Mapped[str] = mapped_column(String(200))
    disk_content: Mapped[str] = mapped_column(String(50))
    code: Mapped[str] = mapped_column(String(50))
    # Id the antibiotic had in the desktop AntibiogramJ (names the template folders).
    legacy_id: Mapped[int | None] = mapped_column(Integer, unique=True, nullable=True)


class Breakpoint(Base):
    __tablename__ = "breakpoints"

    id: Mapped[int] = mapped_column(primary_key=True)
    standard_id: Mapped[int] = mapped_column(ForeignKey("standards.id", ondelete="CASCADE"), index=True)
    family_id: Mapped[int] = mapped_column(ForeignKey("families.id"), index=True)
    antibiotic_id: Mapped[int] = mapped_column(ForeignKey("antibiotics.id"), index=True)
    case: Mapped[str] = mapped_column(String(1000), default="")
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    susceptible: Mapped[float | None] = mapped_column(Float, nullable=True)
    resistant: Mapped[float | None] = mapped_column(Float, nullable=True)
    comments: Mapped[str] = mapped_column(Text, default="")


# ------------------------------------------------------------------- user data
class Experiment(Base):
    __tablename__ = "experiments"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    comments: Mapped[str] = mapped_column(String(1000), default="")
    standard_id: Mapped[int] = mapped_column(ForeignKey("standards.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # "<name> (<standard> <version>)" of the experiment this one is a reinterpretation of.
    reinterpreted_from: Mapped[str | None] = mapped_column(String(250), nullable=True)

    standard: Mapped[Standard] = relationship()
    antibiograms: Mapped[list["Antibiogram"]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan", passive_deletes=True, order_by="Antibiogram.id")


class Antibiogram(Base):
    """Plates inoculated with the same organism (family, genus, species, strain, sample)."""

    __tablename__ = "antibiograms"

    id: Mapped[int] = mapped_column(primary_key=True)
    experiment_id: Mapped[int] = mapped_column(ForeignKey("experiments.id", ondelete="CASCADE"), index=True)
    family_id: Mapped[int] = mapped_column(ForeignKey("families.id"))
    genus: Mapped[str] = mapped_column(String(100), default="")
    species: Mapped[str] = mapped_column(String(100), default="")
    strain: Mapped[str] = mapped_column(String(100), default="")
    sample: Mapped[str] = mapped_column(String(100), default="")
    comments: Mapped[str] = mapped_column(String(1000), default="")
    # Results of supplementary tests used by the expert system (frontend/src/expertRules.ts), e.g. {"mec": "positive"}
    supplementary_tests: Mapped[dict] = mapped_column(JSON, default=dict)
    # EUCAST QC strain (e.g. "ATCC 25922", see app/qc.py) or "" for a clinical isolate
    qc_strain: Mapped[str] = mapped_column(String(50), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    experiment: Mapped[Experiment] = relationship(back_populates="antibiograms")
    family: Mapped[Family] = relationship()
    plates: Mapped[list["Plate"]] = relationship(
        back_populates="antibiogram", cascade="all, delete-orphan", passive_deletes=True, order_by="Plate.id")


class Plate(Base):
    __tablename__ = "plates"

    id: Mapped[int] = mapped_column(primary_key=True)
    antibiogram_id: Mapped[int] = mapped_column(ForeignKey("antibiograms.id", ondelete="CASCADE"), index=True)
    original_filename: Mapped[str] = mapped_column(String(255), default="")
    image_path: Mapped[str] = mapped_column(String(500))
    annotated_path: Mapped[str] = mapped_column(String(500))
    disk_mm: Mapped[float] = mapped_column(Float, default=6.0)
    px_per_mm: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    antibiogram: Mapped[Antibiogram] = relationship(back_populates="plates")

    @property
    def experiment_id(self) -> int:
        return self.antibiogram.experiment_id

    measurements: Mapped[list["Measurement"]] = relationship(
        back_populates="plate", cascade="all, delete-orphan", passive_deletes=True, order_by="Measurement.id")


class Measurement(Base):
    __tablename__ = "measurements"

    id: Mapped[int] = mapped_column(primary_key=True)
    plate_id: Mapped[int] = mapped_column(ForeignKey("plates.id", ondelete="CASCADE"), index=True)
    antibiotic_id: Mapped[int] = mapped_column(ForeignKey("antibiotics.id"))
    standard_id: Mapped[int] = mapped_column(ForeignKey("standards.id"))
    breakpoint_id: Mapped[int | None] = mapped_column(ForeignKey("breakpoints.id"), nullable=True)
    disk_cx: Mapped[float] = mapped_column(Float)
    disk_cy: Mapped[float] = mapped_column(Float)
    disk_r: Mapped[float] = mapped_column(Float)
    halo_r: Mapped[float] = mapped_column(Float)
    diameter_mm: Mapped[float] = mapped_column(Float)
    category: Mapped[str] = mapped_column(String(45))
    microcolonies: Mapped[bool] = mapped_column(Boolean, default=False)
    interpretation: Mapped[str] = mapped_column(String(1000), default="")
    # First interpretation of a measurement copied by a reinterpretation with another standard (None otherwise):
    # its standard, its category and whether that category was set by hand.
    original_standard_id: Mapped[int | None] = mapped_column(ForeignKey("standards.id"), nullable=True)
    original_category: Mapped[str | None] = mapped_column(String(45), nullable=True)
    original_overridden: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    plate: Mapped[Plate] = relationship(back_populates="measurements")
    antibiotic: Mapped[Antibiotic] = relationship()
    standard: Mapped[Standard] = relationship(foreign_keys=[standard_id])
    original_standard: Mapped[Standard | None] = relationship(foreign_keys=[original_standard_id])
    breakpoint: Mapped[Breakpoint | None] = relationship()


class Upload(Base):
    """An image being analysed in the wizard (deleted after a while if not saved)."""

    __tablename__ = "uploads"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    original_filename: Mapped[str] = mapped_column(String(255), default="")
    original_path: Mapped[str] = mapped_column(String(500))
    working_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LearnedTemplate(Base):
    """Disk-code image learned from a user's confirmed identification.

    Learning is per user so that one account cannot degrade the recognition of
    others; the templates shipped with AntibiogramJ are shared by everybody.
    """

    __tablename__ = "learned_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    antibiotic_id: Mapped[int] = mapped_column(ForeignKey("antibiotics.id"))
    path: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
