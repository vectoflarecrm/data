from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

_engine: Any = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


async def init_engine(database_url: str | None = None) -> None:
    """Initialize the global async engine (idempotent). Used by the app factory and tests."""
    global _engine, _session_factory
    settings = get_settings()
    url = database_url or settings.database_url
    if _engine is not None:
        await _engine.dispose()
    _engine = create_async_engine(url, pool_pre_ping=True)
    _session_factory = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)


async def dispose_engine() -> None:
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    if _session_factory is None:
        raise RuntimeError("Engine not initialized. Call init_engine() first.")
    return _session_factory


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
