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

from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402

IMAGES = Path(__file__).parent / "images"
EXPECTED_PLATE_1 = {"Tetracycline", "Cefotaxime", "Amoxicillin-clavulanic acid", "Cefoxitin", "Chloramphenicol",
                    "Ceftazidime", "Ampicillin"}
# Codes read by OCR on plate 1, in disk order (None: not read with enough confidence).
PLATE_1_OCR = ["TE 30", "CTX 30", "FOX 30", "AMC 30", None, "CAZ 30", "AMP 10"]


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
    assert up["quality"]["warnings"] == []  # a good photo raises no quality warning
    uid = up["upload_id"]
    assert bob.post(f"/api/analysis/uploads/{uid}/disks").status_code == 404  # isolation

    # 2. crop + contrast
    r = alice.post(f"/api/analysis/uploads/{uid}/process", json={"crop": up["plate"], "auto_contrast": True})
    assert r.status_code == 200 and max(r.json()["width"], r.json()["height"]) <= 1600
    assert alice.get(f"/api/analysis/uploads/{uid}/image").headers["content-type"] == "image/png"

    # 3. disks
    disks = alice.post(f"/api/analysis/uploads/{uid}/disks").json()["disks"]
    assert len(disks) == 7

    # 4. identification: OCR of the printed codes, bundled templates as fallback
    results = alice.post(f"/api/analysis/uploads/{uid}/identify",
                         json={"disks": disks, "family_id": families["Enterobacteriaceae"],
                               "standard_id": eucast["id"]}).json()["results"]
    ids = [x["antibiotic_id"] for x in results]
    assert {antibiotics[i]["name"] for i in ids} == EXPECTED_PLATE_1
    # Six codes are read by OCR with confidence; the almost invisible "C 30" falls back to the templates
    # and is marked for review, with the right code among the OCR suggestions.
    assert [x["code_read"] if x["source"] == "ocr" else None for x in results] == PLATE_1_OCR
    for x in results:
        assert x["review"] == (x["source"] != "ocr")
        assert x["source"] == "ocr" or antibiotics[x["antibiotic_id"]]["name"] == "Chloramphenicol"
        assert 1 <= len(x["suggestions"]) <= 3 and x["suggestions"][0]["confidence"] == x["confidence"]
        if x["source"] == "ocr":
            assert x["confidence"] >= -2 and x["suggestions"][0]["antibiotic_id"] == x["antibiotic_id"]
    chloramphenicol = results[PLATE_1_OCR.index(None)]
    assert "Chloramphenicol" in {antibiotics[s["antibiotic_id"]]["name"] for s in chloramphenicol["suggestions"]}
    # Without OCR (turned off, or onnxruntime / the model missing) the templates alone are used, as before.
    settings.ocr_enabled = False
    try:
        plain = alice.post(f"/api/analysis/uploads/{uid}/identify", json={"disks": disks}).json()["results"]
    finally:
        settings.ocr_enabled = True
    assert [x["antibiotic_id"] for x in plain] == ids
    assert all(x["source"] == "template" and not x["review"] and not x["suggestions"] for x in plain)

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
    ampicillin = next(i for i, m in enumerate(measurements) if antibiotics[m["antibiotic_id"]]["name"] == "Ampicillin")
    measurements[ampicillin]["category"] = "Intermediate"  # manual override (computed: Resistant)
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
    assert wb["Summary"].max_row == 6 + 7
    assert "Susceptible, increased exposure" not in {c.value for c in wb["Summary"]["L"]}  # EUCAST 6.0: I = Intermediate
    assert {c.value for c in wb["Summary"]["U"]} == {None, "QC result"}  # not a QC strain

    # Quality control: the antibiogram marked as E. coli ATCC 25922
    assert alice.patch(f"/api/antibiograms/{ab_id}", json={**update, "qc_strain": "ATCC 99999"}).status_code == 422
    assert alice.patch(f"/api/antibiograms/{ab_id}", json={**update, "qc_strain": "ATCC 25922"}).status_code == 204
    assert alice.get(f"/api/experiments/{exp['id']}").json()["antibiograms"][0]["qc_strain"] == "ATCC 25922"
    wb = load_workbook(BytesIO(alice.get(f"/api/experiments/{exp['id']}/export.xlsx").content))
    rows = {r[7]: r for r in wb["Summary"].iter_rows(min_row=7, values_only=True)}
    assert wb["Summary"]["B4"].value.startswith("EUCAST QC Tables v 16.0")
    assert rows["Chloramphenicol"][17:21] == ("ATCC 25922", "21-27", "24", "In range")  # ~22.8 mm
    assert rows["Ampicillin"][17:21] == ("ATCC 25922", "15-22", "18-19", "Out of range (too small)")  # no zone
    assert wb["Antibiogram 1"]["A8"].value == "QC strain"

    # Reinterpretation with another standard: a new experiment, the original is not modified
    eucast16 = default
    before = alice.get(f"/api/experiments/{exp['id']}").json()
    assert bob.post(f"/api/experiments/{exp['id']}/reinterpret", json={"standard_id": eucast16["id"]}).status_code == 404
    assert alice.post(f"/api/experiments/{exp['id']}/reinterpret", json={"standard_id": eucast["id"]}).status_code == 422
    r = alice.post(f"/api/experiments/{exp['id']}/reinterpret", json={"standard_id": eucast16["id"]})
    assert r.status_code == 201, r.text
    copy = r.json()
    assert copy["name"] == "E. coli 7825 (EUCAST 16.1)" and copy["reinterpreted_from"] == "E. coli 7825 (EUCAST 6.0)"
    assert copy["standard_id"] == eucast16["id"]
    assert alice.get(f"/api/experiments/{exp['id']}").json() == before
    copied = alice.get(f"/api/experiments/{copy['id']}").json()
    assert copied["standard"]["version"] == "16.1"
    [cab] = copied["antibiograms"]
    assert cab["supplementary_tests"] == update["supplementary_tests"] and cab["species"] == "coli"
    [cplate] = cab["plates"]
    old = {m["antibiotic"]["name"]: m for m in before["antibiograms"][0]["plates"][0]["measurements"]}
    new = {m["antibiotic"]["name"]: m for m in cplate["measurements"]}
    assert set(new) == set(old)
    for name, m in new.items():
        assert m["standard_id"] == eucast16["id"] and m["original_standard_id"] == eucast["id"]
        assert m["original_category"] == old[name]["category"] and m["diameter_mm"] == old[name]["diameter_mm"]
        assert m["original_overridden"] == (name == "Ampicillin")
        assert m["breakpoint"] is None or m["breakpoint"]["standard_id"] == eucast16["id"]
    assert old["Ampicillin"]["category"] == "Intermediate" and new["Ampicillin"]["category"] == "Resistant"
    assert new["Chloramphenicol"]["category"] == "Not available"  # no Enterobacterales breakpoint in 16.1
    caz = new["Ceftazidime"]  # 16.1: S >= 22, R < 19
    assert caz["breakpoint"]["susceptible"] == 22 and caz["breakpoint"]["resistant"] == 19
    assert alice.get(f"/api/plates/{cplate['id']}/image?annotated=true").status_code == 200

    # A second reinterpretation keeps the first interpretation; CLSI 2015 has almost no disk breakpoints
    clsi = next(s for s in standards if s["name"] == "CLSI")
    copy2 = alice.post(f"/api/experiments/{copy['id']}/reinterpret", json={"standard_id": clsi["id"], "name": "CLSI"}).json()
    assert copy2["name"] == "CLSI" and copy2["reinterpreted_from"] == "E. coli 7825 (EUCAST 16.1)"
    ms = alice.get(f"/api/experiments/{copy2['id']}").json()["antibiograms"][0]["plates"][0]["measurements"]
    assert {m["category"] for m in ms} == {"Not available"}
    assert {m["original_standard_id"] for m in ms} == {eucast["id"]}
    assert next(m for m in ms if m["antibiotic"]["name"] == "Ampicillin")["original_overridden"] is True

    wb = load_workbook(BytesIO(alice.get(f"/api/experiments/{copy['id']}/export.xlsx").content))
    header = [c.value for c in wb["Summary"][6]]
    row = {h: c.value for h, c in zip(header, wb["Summary"][7])}
    assert row["Family"] == "Enterobacterales" and row["Standard"] == "EUCAST 16.1"
    assert row["Original standard"] == "EUCAST 6.0"
    amp = next(r for r in wb["Summary"].iter_rows(min_row=7, values_only=True) if r[7] == "Ampicillin")
    assert amp[header.index("Original category")] == "Intermediate (set manually)"

    # The copies have their own image files
    assert alice.delete(f"/api/experiments/{copy2['id']}").status_code == 204
    assert alice.get(f"/api/plates/{cplate['id']}/image").status_code == 200

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
    assert alice.get(f"/api/plates/{cplate['id']}/image?annotated=true").status_code == 200
    assert alice.delete(f"/api/experiments/{copy['id']}").status_code == 204


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
    add_missing_columns(engine)  # idempotent (and tables that do not exist are skipped)
    assert {"supplementary_tests", "qc_strain"} <= {c["name"] for c in inspect(engine).get_columns("antibiograms")}
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE standards (id INTEGER PRIMARY KEY)"))
        conn.execute(text("CREATE TABLE measurements (id INTEGER PRIMARY KEY, category VARCHAR(45))"))
        conn.execute(text("INSERT INTO measurements (id, category) VALUES (1, 'Resistant')"))
    add_missing_columns(engine)
    assert {"original_standard_id", "original_category", "original_overridden"} <= {
        c["name"] for c in inspect(engine).get_columns("measurements")}
    with engine.connect() as conn:
        assert conn.execute(text("SELECT supplementary_tests FROM antibiograms")).scalar() is None
        assert conn.execute(text("SELECT qc_strain FROM antibiograms")).scalar() == ""


def test_qc_tables():
    """EUCAST QC Tables v 16.0, zone diameters (checked by hand against the PDF)."""
    from app import qc

    ecoli = qc.strain("ATCC 25922")
    assert ecoli["name"] == "Escherichia coli ATCC 25922"
    assert qc.qc_range(ecoli, "Amikacin", "30") == {"agent": "Amikacin", "disk_content": "30", "min": 19, "max": 26,
                                                     "use": "routine", "target": "22-23"}
    assert qc.qc_range(ecoli, "Fosfomycin iv", "200")["min"] == 26  # superscript note 14 not read as "20014"
    assert qc.qc_range(ecoli, "Cefuroxime oral", "30")["max"] == 26
    assert qc.qc_range(qc.strain("ATCC 29213"), "Benzylpenicillin", "1 unit")["target"] == "15"
    assert qc.qc_range(qc.strain("ATCC 51299"), "Vancomycin", "5")["expected_category"] == "R"
    assert qc.result(ecoli, "Amikacin", "30", 18.5) == (qc.qc_range(ecoli, "Amikacin", "30"), "in")  # rounds to 19
    assert qc.result(ecoli, "Amikacin", "30", 26.6)[1] == "high"
    assert qc.result(ecoli, "Mupirocin", "200", 20) == (None, "no-range")


def test_photo_quality():
    """No warning on the sample photo; the degraded versions are flagged."""
    import cv2

    from app.cv import quality
    from app.cv.processing import detect_disks, detect_plate

    image = cv2.imread(str(IMAGES / "1.tiff"))
    h, w = image.shape[:2]

    def warnings(img):
        return quality.check(img, detect_plate(img))["warnings"]

    assert warnings(image) == []
    assert warnings(cv2.GaussianBlur(image, (0, 0), 2 * max(h, w) / 1600)) == ["blur"]
    assert warnings(cv2.resize(image, None, fx=0.35, fy=0.35, interpolation=cv2.INTER_AREA)) == ["low_resolution"]
    assert warnings(image[:, int(w * 0.2):]) == ["plate_cut"]
    assert warnings(cv2.copyMakeBorder(image, h // 2, h // 2, w // 2, w // 2, cv2.BORDER_CONSTANT,
                                       value=(40, 40, 40))) == ["plate_small"]
    glare = image.copy()
    cv2.ellipse(glare, (int(w * 0.4), int(h * 0.35)), (int(w * 0.12), int(h * 0.04)), 30, 0, 360, (255, 255, 255), -1)
    assert warnings(glare) == ["glare"]
    disks = image.copy()  # over-exposed white disks are not glare
    for d in detect_disks(image):
        cv2.circle(disks, (int(d.cx), int(d.cy)), int(d.r), (255, 255, 255), -1)
    assert warnings(disks) == []
