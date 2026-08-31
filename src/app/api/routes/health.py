from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import text

from app.db.session import get_session_factory

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    db_status = "ok"
    try:
        factory = get_session_factory()
        async with factory() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        db_status = "unavailable"
    return {"status": "ok", "database": db_status}
