from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.db.base import Base


def _test_database_url() -> str:
    settings = Settings()
    configured = settings.test_database_url
    if configured:
        return configured
    # Derive from the main URL by swapping the database name.
    base = settings.database_url
    return base.rsplit("/", 1)[0] + "/watersports_test"


def _admin_url(database_url: str) -> str:
    """Connect to the server-level `postgres` database for create/drop."""
    return database_url.rsplit("/", 1)[0] + "/postgres"


async def _ensure_test_database() -> str:
    url = _test_database_url()
    engine = create_async_engine(_admin_url(url), isolation_level="AUTOCOMMIT", poolclass=NullPool)
    dbname = url.rsplit("/", 1)[-1]
    async with engine.connect() as conn:
        exists = await conn.execute(
            text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": dbname}
        )
        if exists.scalar() is None:
            await conn.execute(text(f'CREATE DATABASE "{dbname}"'))
    await engine.dispose()
    return url


@pytest_asyncio.fixture(scope="session")
async def database_url() -> str:
    return await _ensure_test_database()


@pytest_asyncio.fixture(scope="session")
async def engine(database_url: str):
    engine = create_async_engine(database_url, poolclass=NullPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def session(engine) -> AsyncSession:
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with factory() as session:
        yield session
        await session.rollback()


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()
