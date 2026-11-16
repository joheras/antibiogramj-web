from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import clear_session_cookie, current_user, hash_password, set_session_cookie, verify_password
from ..config import settings
from ..db import get_db
from ..models import User
from ..schemas import LoginIn, RegisterIn, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Computed once so failed logins for unknown e-mails take as long as real ones.
_DUMMY_HASH = hash_password("timing-equaliser")


@router.post("/register", response_model=UserOut, status_code=201)
def register(body: RegisterIn, response: Response, db: Session = Depends(get_db)):
    if not settings.allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Registration is disabled")
    email = body.email.lower()
    if db.scalar(select(User).where(func.lower(User.email) == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this e-mail already exists")
    user = User(email=email, password_hash=hash_password(body.password), name=body.name, lab=body.lab,
                city=body.city, country=body.country)
    db.add(user)
    db.commit()
    set_session_cookie(response, user)
    return user


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(func.lower(User.email) == body.email.lower()))
    if not verify_password(body.password, user.password_hash if user else _DUMMY_HASH) or user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong e-mail or password")
    set_session_cookie(response, user)
    return user


@router.post("/logout", status_code=204)
def logout(response: Response):
    clear_session_cookie(response)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user
