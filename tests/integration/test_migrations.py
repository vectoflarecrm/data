from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

PROJECT_ROOT = Path(__file__).resolve().parents[2]
VENV_BIN = PROJECT_ROOT / ".venv" / "bin"
MIGRATION_DB = "watersports_alembic_test"


def _database_base() -> str:
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
    from app.core.config import Settings

    return Settings().database_url.rsplit("/", 1)[0] + "/postgres"


def _migration_url() -> str:
    return _database_base().rsplit("/", 1)[0] + f"/{MIGRATION_DB}"


def _run_alembic(args: list[str], url: str) -> None:
    env = os.environ.copy()
    env["DATABASE_URL"] = url
    result = subprocess.run(
        [str(VENV_BIN / "alembic"), *args],
        cwd=PROJECT_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"alembic {args} failed:\n{result.stdout}\n{result.stderr}"


@pytest_asyncio.fixture(scope="session")
async def migration_database() -> str:
    admin = create_async_engine(_database_base(), isolation_level="AUTOCOMMIT", poolclass=NullPool)
    async with admin.connect() as conn:
        await conn.execute(text(f'DROP DATABASE IF EXISTS "{MIGRATION_DB}"'))
        await conn.execute(text(f'CREATE DATABASE "{MIGRATION_DB}"'))
    await admin.dispose()
    return _migration_url()


async def _tables(url: str) -> set[str]:
    engine = create_async_engine(url, poolclass=NullPool)
    async with engine.connect() as conn:
        rows = await conn.execute(
            text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        )
        result = {row[0] for row in rows}
    await engine.dispose()
    return result


@pytest.mark.asyncio
async def test_alembic_upgrade_downgrade_cycle(migration_database: str) -> None:
    url = migration_database

    _run_alembic(["upgrade", "head"], url)
    tables = await _tables(url)
    assert "companies" in tables
    assert "contacts" in tables
    assert "contact_methods" in tables
    assert "social_accounts" in tables
    assert "products" in tables
    assert "brands" in tables
    assert "company_brands" in tables
    assert "company_events" in tables
    assert "research_evidence" in tables
    assert "outreach_events" in tables
    assert "research_tasks" in tables
    assert "research_task_attempts" in tables
    assert "lead_scores" in tables
    assert "ai_contexts" in tables
    assert "campaigns" in tables
    assert "outreach" in tables
    assert "company_products" in tables
    assert "email_suppressions" in tables
    assert "alembic_version" in tables

    _run_alembic(["downgrade", "base"], url)
    tables = await _tables(url)
    app_tables = {
        "companies",
        "contacts",
        "contact_methods",
        "social_accounts",
        "products",
        "brands",
        "company_brands",
        "company_events",
        "research_evidence",
        "outreach_events",
        "research_tasks",
        "research_task_attempts",
        "lead_scores",
        "ai_contexts",
        "campaigns",
        "outreach",
        "company_products",
        "email_suppressions",
    }
    assert not (app_tables & tables)

    # Idempotency: upgrading twice is safe (second upgrade is a no-op).
    _run_alembic(["upgrade", "head"], url)
    _run_alembic(["upgrade", "head"], url)
