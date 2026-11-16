"""Authentication: bcrypt password hashes and a JWT in an httpOnly cookie.

The cookie is ``SameSite=Strict`` so it is never sent on cross-site requests
(CSRF protection) and it is not readable from JavaScript (XSS hardening).
"""

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import User

COOKIE_NAME = "abj_session"
_ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def set_session_cookie(response: Response, user: User) -> None:
    expires = datetime.now(timezone.utc) + timedelta(hours=settings.token_ttl_hours)
    token = jwt.encode({"sub": str(user.id), "exp": expires}, settings.secret_key, algorithm=_ALGORITHM)
    response.set_cookie(COOKIE_NAME, token, max_age=settings.token_ttl_hours * 3600, httponly=True,
                        secure=settings.cookie_secure, samesite="strict", path="/")


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=settings.cookie_secure, samesite="strict")


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    unauthorized = HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise unauthorized
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[_ALGORITHM])
        user = db.get(User, int(payload["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError):
        raise unauthorized
    if user is None:
        raise unauthorized
    return user
