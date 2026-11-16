import os
import tempfile
from io import BytesIO
from pathlib import Path

_tmp = tempfile.mkdtemp()
os.environ["ABJ_DATA_DIR"] = _tmp
os.environ["ABJ_DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["ABJ_SECRET_KEY"] = "test-secret"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from openpyxl import load_workbook  # noqa: E402

from app.main import app  # noqa: E402

IMAGES = Path(__file__).parent / "images"
EXPECTED_PLATE_1 = {"Tetracycline", "Cefotaxime", "Amoxicillin-clavulanic acid", "Cefoxitin", "Chloramphenicol",
                    "Ceftazidime", "Ampicillin"}


def client_for(email: str) -> TestClient:
    c = TestClient(app)
    c.__enter__()
    r = c.post("/api/auth/register", json={"email": email, "password": "secret-pass", "name": "T", "lab": "L"})
    assert r.status_code == 201, r.text
    return c


@pytest.fixture(scope="module")
def alice():
    return client_for("alice@example.org")


@pytest.fixture(scope="module")
def bob():
    return client_for("bob@example.org")


def test_auth_required():
    with TestClient(app) as c:
        assert c.get("/api/experiments").status_code == 401
        assert c.get("/api/catalog/standards").status_code == 401


def test_login_logout(alice):
    with TestClient(app) as c:
        assert c.post("/api/auth/login", json={"email": "alice@example.org", "password": "nope-nope"}).status_code == 401
        assert c.post("/api/auth/login", json={"email": "ALICE@example.org", "password": "secret-pass"}).status_code == 200
        assert c.get("/api/auth/me").json()["email"] == "alice@example.org"
        c.post("/api/auth/logout")
        assert c.get("/api/auth/me").status_code == 401


def test_duplicate_registration(alice):
    with TestClient(app) as c:
        r = c.post("/api/auth/register", json={"email": "alice@example.org", "password": "another-pass"})
        assert r.status_code == 409


def test_categorisation_rules():
    from app.models import Breakpoint, Standard
    from app.standards import categorise
    eucast = Standard(susceptible_op=">=", resistant_op="<")
    clsi = Standard(susceptible_op=">=", resistant_op="<=")
    bp = Breakpoint(available=True, susceptible=19, resistant=16)
    assert categorise(19, bp, eucast) == "Susceptible"
    assert categorise(16, bp, eucast) == "Intermediate"
    assert categorise(16, bp, clsi) == "Resistant"
    assert categorise(15.9, bp, eucast) == "Resistant"
    assert categorise(20, None, eucast) == "Not available"


def test_full_analysis_flow(alice, bob):
    standards = alice.get("/api/catalog/standards").json()
    default = standards[0]
    assert default["is_default"] and (default["name"], default["version"]) == ("EUCAST", "16.1")
    eucast = next(s for s in standards if (s["name"], s["version"]) == ("EUCAST", "6.0"))
    families = {f["name"]: f["id"] for f in alice.get("/api/catalog/families").json()}
    antibiotics = {a["id"]: a for a in alice.get("/api/catalog/antibiotics").json()}

    new_exp = alice.post("/api/experiments", json={"name": "Default standard"}).json()
    assert new_exp["standard_id"] == default["id"]
    assert alice.delete(f"/api/experiments/{new_exp['id']}").status_code == 204

    exp = alice.post("/api/experiments", json={"name": "E. coli 7825", "comments": "test",
                                               "standard_id": eucast["id"]}).json()
    assert exp["standard_id"] == eucast["id"]

    # 1. upload
    data = (IMAGES / "1.tiff").read_bytes()
    r = alice.post("/api/analysis/uploads", files={"file": ("1.tiff", data, "image/tiff")})
    assert r.status_code == 201, r.text
    up = r.json()
    assert up["plate"] is not None
    uid = up["upload_id"]
    assert bob.post(f"/api/analysis/uploads/{uid}/disks").status_code == 404  # isolation

    # 2. crop + contrast
    r = alice.post(f"/api/analysis/uploads/{uid}/process", json={"crop": up["plate"], "auto_contrast": True})
    assert r.status_code == 200 and max(r.json()["width"], r.json()["height"]) <= 1600
    assert alice.get(f"/api/analysis/uploads/{uid}/image").headers["content-type"] == "image/png"

    # 3. disks
    disks = alice.post(f"/api/analysis/uploads/{uid}/disks").json()["disks"]
    assert len(disks) == 7

    # 4. identification with the bundled templates
    results = alice.post(f"/api/analysis/uploads/{uid}/identify", json={"disks": disks}).json()["results"]
    ids = [x["antibiotic_id"] for x in results]
    assert {antibiotics[i]["name"] for i in ids} == EXPECTED_PLATE_1

    # 5. halos
    body = {"disks": disks, "antibiotic_ids": ids, "family_id": families["Enterobacteriaceae"],
            "standard_id": eucast["id"], "disk_mm": 6}
    halos = alice.post(f"/api/analysis/uploads/{uid}/halos", json=body).json()
    assert len(halos["results"]) == 7
    by_name = {antibiotics[i]["name"]: h for i, h in zip(ids, halos["results"])}
    assert by_name["Cefoxitin"]["diameter_mm"] > 15
    assert by_name["Cefoxitin"]["category"] == "Resistant"  # EUCAST 6.0 screen: S >= 19 mm
    assert by_name["Chloramphenicol"]["category"] == "Susceptible"  # ~22.8 mm, S >= 17
    assert by_name["Ampicillin"]["category"] == "Resistant"  # no zone, S >= 14

    # 6. save the plate (with a manual correction of one halo)
    measurements = [{"antibiotic_id": i, "breakpoint_id": h["breakpoint_id"], "disk": d, "halo_r": h["halo_r"]}
                    for i, h, d in zip(ids, halos["results"], disks)]
    measurements[0]["microcolonies"] = True
    measurements[0]["interpretation"] = "checked"
    plate_in = {"upload_id": uid, "experiment_id": exp["id"], "disk_mm": 6, "measurements": measurements,
                "bacteria": {"family_id": families["Enterobacteriaceae"], "genus": "Escherichia",
                             "species": "coli", "strain": "7825", "sample": "1"}}
    assert bob.post("/api/plates", json=plate_in).status_code == 404  # bob cannot use alice's upload
    r = alice.post("/api/plates", json=plate_in)
    assert r.status_code == 201, r.text
    plate = r.json()
    assert len(plate["measurements"]) == 7
    assert alice.get(f"/api/plates/{plate['id']}/image?annotated=true").headers["content-type"] == "image/jpeg"
    assert alice.post(f"/api/analysis/uploads/{uid}/disks").status_code == 404  # upload consumed

    # Bob sees nothing of Alice
    assert bob.get("/api/experiments").json() == []
    assert bob.get(f"/api/experiments/{exp['id']}").status_code == 404
    assert bob.get(f"/api/plates/{plate['id']}").status_code == 404
    assert bob.get(f"/api/plates/{plate['id']}/image").status_code == 404
    assert bob.delete(f"/api/plates/{plate['id']}").status_code == 404

    detail = alice.get(f"/api/experiments/{exp['id']}").json()
    assert len(detail["antibiograms"]) == 1 and detail["antibiograms"][0]["species"] == "coli"
    assert detail["antibiograms"][0]["supplementary_tests"] == {}

    # Organism data and supplementary tests of the expert system
    ab_id = detail["antibiograms"][0]["id"]
    update = {"genus": "Escherichia", "species": "coli", "strain": "7825", "sample": "1", "comments": "edited",
              "supplementary_tests": {"esbl": "positive", "carbapenemase": "OXA-48"}}
    assert bob.patch(f"/api/antibiograms/{ab_id}", json=update).status_code == 404
    assert alice.patch(f"/api/antibiograms/{ab_id}", json={**update, "supplementary_tests": {"esbl": "maybe"}}).status_code == 422
    assert alice.patch(f"/api/antibiograms/{ab_id}", json=update).status_code == 204
    edited = alice.get(f"/api/experiments/{exp['id']}").json()["antibiograms"][0]
    assert edited["comments"] == "edited" and edited["supplementary_tests"] == update["supplementary_tests"]
    summary = alice.get("/api/experiments").json()[0]
    assert summary["antibiogram_count"] == 1 and summary["plate_count"] == 1

    # Excel export
    r = alice.get(f"/api/experiments/{exp['id']}/export.xlsx")
    assert r.status_code == 200
    wb = load_workbook(BytesIO(r.content))
    assert wb.sheetnames == ["Summary", "Antibiogram 1"]
    assert wb["Summary"].max_row == 5 + 7
    assert "Susceptible, increased exposure" not in {c.value for c in wb["Summary"]["L"]}  # EUCAST 6.0: I = Intermediate

    # Learned templates for Alice only
    from app.db import SessionLocal
    from app.models import LearnedTemplate
    with SessionLocal() as db:
        owners = {t.owner_id for t in db.query(LearnedTemplate)}
    assert len(owners) == 1

    # Deleting the only plate removes the antibiogram
    assert alice.delete(f"/api/plates/{plate['id']}").status_code == 204
    assert alice.get(f"/api/experiments/{exp['id']}").json()["antibiograms"] == []
    assert alice.delete(f"/api/experiments/{exp['id']}").status_code == 204


def test_rejects_non_images(alice):
    r = alice.post("/api/analysis/uploads", files={"file": ("x.png", b"not an image", "image/png")})
    assert r.status_code == 422


def test_eucast_16_standard():
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session

    from app.config import settings
    from app.db import Base
    from app.main import SEED_STANDARDS, seed_standards
    from app.models import Antibiotic, Breakpoint, Family, Standard
    from app.standards import categorise, load_standard

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        # An existing database with only the original standards gets the new one added.
        legacy_ids: dict = {}
        for filename, is_default in [("EUCAST-6.0.xml", True), ("CLSI-2015.xml", False)]:
            load_standard(db, settings.seed_dir / "standards" / filename, is_default, legacy_ids)
        db.commit()
        before = {(b.id, b.standard_id, b.susceptible, b.resistant) for b in db.scalars(select(Breakpoint))}
        seed_standards(db)
        seed_standards(db)  # idempotent
        standards = {(s.name, s.version): s for s in db.scalars(select(Standard))}
        assert len(standards) == len(SEED_STANDARDS)
        new = standards[("EUCAST", "16.1")]
        assert new.is_default and not standards[("EUCAST", "6.0")].is_default
        assert before <= {(b.id, b.standard_id, b.susceptible, b.resistant) for b in db.scalars(select(Breakpoint))}

        # Enterobacterales, ceftazidime 10 µg: S >= 22 mm, R < 19 mm (shared antibiotic and family).
        family = db.scalar(select(Family).where(Family.name == "Enterobacteriaceae"))
        caz = db.scalar(select(Antibiotic).where(Antibiotic.name == "Ceftazidime", Antibiotic.disk_content == "10"))
        assert caz.legacy_id is not None  # same disk as EUCAST 6.0, keeps its templates
        bp = db.scalar(select(Breakpoint).where(Breakpoint.standard_id == new.id, Breakpoint.family_id == family.id,
                                                Breakpoint.antibiotic_id == caz.id))
        assert (bp.susceptible, bp.resistant) == (22, 19)
        assert categorise(22, bp, new) == "Susceptible"
        assert categorise(20, bp, new) == "Intermediate"
        assert categorise(18, bp, new) == "Resistant"


def test_add_missing_columns():
    """Databases created before the expert system get the supplementary_tests column."""
    from sqlalchemy import create_engine, inspect, text

    from app.main import add_missing_columns

    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE antibiograms (id INTEGER PRIMARY KEY, genus VARCHAR(100))"))
        conn.execute(text("INSERT INTO antibiograms (id, genus) VALUES (1, 'Escherichia')"))
    add_missing_columns(engine)
    add_missing_columns(engine)  # idempotent
    assert "supplementary_tests" in {c["name"] for c in inspect(engine).get_columns("antibiograms")}
    with engine.connect() as conn:
        assert conn.execute(text("SELECT supplementary_tests FROM antibiograms")).scalar() is None
