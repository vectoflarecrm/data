from __future__ import annotations

import argparse
import asyncio
import contextlib
import signal
import uuid
from collections.abc import Callable
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import ResearchTask
from app.db.session import dispose_engine, get_session_factory, init_engine
from app.research.queue import ResearchTaskRepository

POLL_INTERVAL_SECONDS = 1.0


class TaskExecutor(Protocol):
    """Executes a single claimed research task.

    Returns a TaskOutcome describing how the worker should finalize the task.
    """

    async def __call__(self, session: AsyncSession, task: ResearchTask) -> TaskOutcome: ...


class TaskOutcome:
    __slots__ = ("status", "summary", "error")

    def __init__(self, status: str, summary: str | None = None, error: str | None = None) -> None:
        self.status = status  # "completed" | "retry" | "failed"
        self.summary = summary
        self.error = error


async def process_one(session: AsyncSession, task: ResearchTask, executor: TaskExecutor) -> None:
    repo = ResearchTaskRepository(session)
    heartbeat_stop = asyncio.Event()

    async def heartbeat_loop() -> None:
        interval = max(1.0, get_settings().task_staleness_seconds / 3)
        while not heartbeat_stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(heartbeat_stop.wait(), timeout=interval)
            if not heartbeat_stop.is_set():
                await repo.heartbeat(task)
                await session.commit()

    heartbeat_task = asyncio.create_task(heartbeat_loop())
    try:
        outcome = await executor(session, task)
    except Exception as exc:  # noqa: BLE001
        await repo.schedule_retry(task, str(exc))
    else:
        if outcome.status == "completed":
            await repo.complete(task, outcome.summary)
        elif outcome.status == "retry":
            await repo.schedule_retry(task, outcome.error or "retry")
        else:
            await repo.fail(task, outcome.error or "failed")
    finally:
        heartbeat_stop.set()
        await heartbeat_task


async def worker_loop(
    worker_id: str,
    executor: TaskExecutor,
    *,
    stop_event: asyncio.Event | None = None,
    poll_interval: float = POLL_INTERVAL_SECONDS,
) -> None:
    settings = get_settings()
    stop_event = stop_event or asyncio.Event()
    while not stop_event.is_set():
        factory = get_session_factory()
        async with factory() as session:
            repo = ResearchTaskRepository(session)
            await repo.requeue_stale(settings.task_staleness_seconds)
            claimed = await repo.claim(worker_id=worker_id, limit=1)
            if not claimed:
                await session.commit()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop_event.wait(), timeout=poll_interval)
                continue
            task = claimed[0]
            try:
                await process_one(session, task, executor)
                await session.commit()
            except Exception:  # noqa: BLE001
                await session.rollback()


async def run_workers(
    executor: TaskExecutor, count: int | None = None, stop_event: asyncio.Event | None = None
) -> None:
    count = count or get_settings().research_workers
    await init_engine()
    base = uuid.uuid4().hex[:8]
    tasks = [worker_loop(f"{base}-{i}", executor, stop_event=stop_event) for i in range(count)]
    await asyncio.gather(*tasks)


def _signal_stop(stop_event: asyncio.Event) -> Callable[[int, object], None]:
    def handler(signum: int, frame: object) -> None:
        stop_event.set()

    return handler


def main() -> None:
    parser = argparse.ArgumentParser(prog="workers", description="Research worker")
    parser.add_argument("--workers", type=int, default=None)
    args = parser.parse_args()

    def default_executor(session, task):  # pragma: no cover - placeholder
        from app.research.executor import dispatch
        from app.research.register import register_all

        register_all()
        return dispatch(session, task)

    stop_event = asyncio.Event()
    loop = asyncio.new_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)
    try:
        loop.run_until_complete(
            run_workers(default_executor, count=args.workers, stop_event=stop_event)
        )
    finally:
        loop.run_until_complete(dispose_engine())


if __name__ == "__main__":
    main()
