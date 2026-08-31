from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.normalization import normalize_email
from app.db.models import EmailSuppression


async def get_email_suppression(
    session: AsyncSession, email: str
) -> EmailSuppression | None:
    normalized = normalize_email(email)
    if not normalized:
        return None
    return (
        await session.execute(
            select(EmailSuppression).where(EmailSuppression.normalized_email == normalized)
        )
    ).scalars().first()


async def is_email_suppressed(session: AsyncSession, email: str) -> bool:
    return await get_email_suppression(session, email) is not None
