from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="ABJ_", extra="ignore")

    database_url: str = f"sqlite:///{BASE_DIR / 'data' / 'antibiogramj.db'}"
    data_dir: Path = BASE_DIR / "data"
    seed_dir: Path = BASE_DIR / "seed"

    # Auth. ``secret_key`` MUST be overridden in production (ABJ_SECRET_KEY).
    secret_key: str = "change-me-in-production"
    token_ttl_hours: int = 24 * 7
    cookie_secure: bool = False  # set to true behind HTTPS
    allow_registration: bool = True

    # Uploads
    max_upload_mb: int = 30
    max_image_pixels: int = 40_000_000
    working_max_side: int = 1600  # analysis resolution after cropping
    upload_ttl_hours: int = 24

    # Learning: maximum number of learned templates per antibiotic and user
    templates_per_antibiotic: int = 10

    # Disk-code OCR (docs/disk-reading.md): readings with a confidence >= ocr_auto_accept are accepted
    # without review; below that the templates are used as fallback and the OCR candidates are suggested.
    ocr_enabled: bool = True
    ocr_auto_accept: float = -2.0

    cors_origins: list[str] = []


settings = Settings()
