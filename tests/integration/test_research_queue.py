from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.enums import TaskStatus, TaskType
from app.core.time import utcnow
from app.db.base import Base
from app.db.models import Company, ResearchTask, ResearchTaskAttempt
from app.research.queue import ResearchTaskRepository


@pytest.fixture
async def factory(database_url: str):
    import app.db.models  # noqa: F401

    engine = create_async_engine(database_url, poolclass=NullPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()

    from app.db.session import dispose_engine, init_engine

    await init_engine(database_url)
    f = get_session_factory()
    yield f
    await dispose_engine()


def get_session_factory():
    from app.db.session import get_session_factory

    return get_session_factory()


async def _add_company(session: AsyncSession, name: str) -> Company:
    company = Company(company_name=name, normalized_domain=name.lower().replace(" ", "") + ".io")
    session.add(company)
    await session.flush()
    return company


@pytest.mark.asyncio
async def test_claim_complete_lifecycle(factory) -> None:
    async with factory() as session:
        company = await _add_company(session, "Queue Test Co")
        repo = ResearchTaskRepository(session)
        task = await repo.create(company.id, TaskType.COMPANY_RESEARCH, priority=90)
        await session.commit()

        claimed = await repo.claim(worker_id="w1")
        assert len(claimed) == 1
        assert claimed[0].id == task.id
        assert claimed[0].status == TaskStatus.RUNNING
        assert claimed[0].worker_id == "w1"
        assert claimed[0].started_at is not None
        attempts = await session.execute(select(ResearchTaskAttempt).where(ResearchTaskAttempt.task_id == task.id))
        attempt = attempts.scalar_one()
        assert attempt.attempt_number == 1
        assert attempt.worker_id == "w1"
        assert attempt.status == TaskStatus.RUNNING

        # A second claim must not see the RUNNING task.
        assert await repo.claim(worker_id="w2") == []

        await repo.complete(task, "ok")
        await session.commit()

    async with factory() as session:
        task = await session.get(ResearchTask, task.id)
        assert task.status == TaskStatus.COMPLETED
        assert task.worker_id is None
        attempt = (await session.execute(select(ResearchTaskAttempt).where(ResearchTaskAttempt.task_id == task.id))).scalar_one()
        assert attempt.status == TaskStatus.COMPLETED
        assert attempt.finished_at is not None


@pytest.mark.asyncio
async def test_retry_backoff_and_exhaustion(factory) -> None:
    async with factory() as session:
        company = await _add_company(session, "Retry Co")
        repo = ResearchTaskRepository(session)
        await repo.create(company.id, TaskType.PHONE_DISCOVERY, priority=10, max_attempts=3)
        await session.commit()

        claimed = await repo.claim(worker_id="w1")
        scheduled = await repo.schedule_retry(claimed[0], "NETWORK_ERROR")
        assert scheduled is True
        assert claimed[0].status == TaskStatus.RETRY
        assert claimed[0].attempts == 1
        assert claimed[0].next_retry_at > utcnow()
        attempt = (await session.execute(select(ResearchTaskAttempt).where(ResearchTaskAttempt.task_id == claimed[0].id))).scalar_one()
        assert attempt.status == TaskStatus.RETRY
        assert attempt.finished_at is not None
        await session.commit()

        # Not due yet: nothing claimable.
        assert await repo.claim(worker_id="w2") == []

        # Force due and exhaust retries.
        claimed[0].next_retry_at = utcnow() - timedelta(seconds=1)
        await session.commit()

        claimed = await repo.claim(worker_id="w3")
        assert len(claimed) == 1
        scheduled = await repo.schedule_retry(claimed[0], "TIMEOUT")
        assert scheduled is True
        assert claimed[0].attempts == 2
        claimed[0].next_retry_at = utcnow() - timedelta(seconds=1)
        await session.commit()

        claimed = await repo.claim(worker_id="w4")
        scheduled = await repo.schedule_retry(claimed[0], "TIMEOUT")
        assert scheduled is False
        assert claimed[0].status == TaskStatus.FAILED
        await session.commit()


@pytest.mark.asyncio
async def test_requeue_stale(factory) -> None:
    async with factory() as session:
        company = await _add_company(session, "Stale Co")
        repo = ResearchTaskRepository(session)
        await repo.create(company.id, TaskType.CONTACT_DISCOVERY)
        await session.commit()

        task = (await select_tasks(session))[0]
        task.status = TaskStatus.RUNNING
        task.worker_id = "dead-worker"
        task.started_at = utcnow() - timedelta(hours=2)
        await session.commit()

        count = await repo.requeue_stale(staleness_seconds=60)
        assert count == 1
        task = await session.get(ResearchTask, task.id)
        assert task.status == TaskStatus.PENDING
        assert task.worker_id is None


@pytest.mark.asyncio
async def test_idempotent_enqueue(factory) -> None:
    async with factory() as session:
        company = await _add_company(session, "Idem Co")
        repo = ResearchTaskRepository(session)
        first = await repo.create(company.id, TaskType.LEAD_SCORING)
        second = await repo.create(company.id, TaskType.LEAD_SCORING)
        await session.commit()
        assert first.id == second.id
        tasks = await select_tasks(session)
        assert len(tasks) == 1


@pytest.mark.asyncio
async def test_multi_worker_no_duplicate_processing(factory) -> None:
    async with factory() as session:
        company = await _add_company(session, "Multi Co")
        repo = ResearchTaskRepository(session)
        for i, task_type in enumerate(
            [
                TaskType.COMPANY_RESEARCH,
                TaskType.PRODUCT_RESEARCH,
                TaskType.BRAND_RESEARCH,
                TaskType.CONTACT_DISCOVERY,
                TaskType.EMAIL_DISCOVERY,
                TaskType.PHONE_DISCOVERY,
                TaskType.SOCIAL_DISCOVERY,
                TaskType.LEAD_SCORING,
            ]
        ):
            await repo.create(company.id, task_type, priority=50 + i * 2)
        await session.commit()

    ledger: dict = {}
    lock = asyncio.Lock()

    async def worker(worker_id: str) -> None:
        async with factory() as session:
            repo = ResearchTaskRepository(session)
            while True:
                claimed = await repo.claim(worker_id=worker_id, limit=1)
                if not claimed:
                    break
                task = claimed[0]
                async with lock:
                    assert task.id not in ledger, f"task {task.id} processed twice"
                    ledger[task.id] = worker_id
                await repo.complete(task, "done")
                await asyncio.sleep(0.01)
                await session.commit()

    await asyncio.gather(worker("worker-a"), worker("worker-b"), worker("worker-c"))

    assert len(ledger) == 8
    async with factory() as session:
        tasks = await select_tasks(session)
        assert all(t.status == TaskStatus.COMPLETED for t in tasks)


async def select_tasks(session: AsyncSession) -> list[ResearchTask]:
    result = await session.execute(select(ResearchTask))
    return list(result.scalars().all())
