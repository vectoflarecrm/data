from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.enums import TaskStatus, TaskType
from app.core.time import utcnow
from app.db.models import ResearchTask, ResearchTaskAttempt
from app.repositories.base import BaseRepository

BACKOFF_STEPS_SECONDS = (300, 1800, 7200, 43200)


def next_retry_at(attempts: int) -> datetime:
    """Exponential backoff deadline based on completed attempts."""
    settings = get_settings()
    steps = (
        (settings.retry_backoff_seconds,)
        if settings.retry_backoff_seconds
        else BACKOFF_STEPS_SECONDS
    )
    idx = max(0, min(attempts - 1, len(steps) - 1))
    return utcnow() + timedelta(seconds=steps[idx])


class NoTaskAvailable(Exception):
    pass


class ResearchTaskRepository(BaseRepository[ResearchTask]):
    """PostgreSQL-backed task queue using FOR UPDATE SKIP LOCKED."""

    model = ResearchTask

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def create(  # type: ignore[override]
        self,
        company_id: uuid.UUID,
        task_type: TaskType,
        **values,
    ) -> ResearchTask:
        company_id = company_id
        task_type = task_type
        priority = values.pop("priority", 50)
        scheduled_at = values.pop("scheduled_at", None)
        max_attempts = values.pop("max_attempts", None)
        allow_duplicates = values.pop("allow_duplicates", False)
        if values:
            raise TypeError(f"unexpected task fields: {', '.join(values)}")

        max_attempts = max_attempts or get_settings().task_max_attempts
        if not allow_duplicates:
            existing = await self._active_task(company_id, task_type)
            if existing is not None:
                existing.priority = max(existing.priority, priority)
                return existing
        else:
            # Duplicate runs must use a distinct task type scope. The database
            # intentionally prevents multiple active tasks for one company/type;
            # callers should complete the current task before enqueueing another.
            raise ValueError("allow_duplicates is incompatible with active task uniqueness")
        task = ResearchTask(
            company_id=company_id,
            task_type=task_type,
            priority=priority,
            scheduled_at=scheduled_at or utcnow(),
            max_attempts=max_attempts,
        )
        self.session.add(task)
        await self.session.flush()
        return task

    async def claim(
        self, worker_id: str, limit: int = 1, task_types: list[TaskType] | None = None
    ) -> list[ResearchTask]:
        """Atomically claim the highest-priority due tasks for a worker."""
        now = utcnow()
        stmt = (
            select(ResearchTask)
            .where(ResearchTask.status.in_([TaskStatus.PENDING, TaskStatus.RETRY]))
            .where(ResearchTask.scheduled_at <= now)
            .where((ResearchTask.next_retry_at.is_(None)) | (ResearchTask.next_retry_at <= now))
            .order_by(ResearchTask.priority.desc(), ResearchTask.scheduled_at.asc())
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        if task_types:
            stmt = stmt.where(ResearchTask.task_type.in_(task_types))
        result = (await self.session.execute(stmt)).scalars().all()
        for task in result:
            task.status = TaskStatus.RUNNING
            task.worker_id = worker_id
            task.started_at = now
            self.session.add(
                ResearchTaskAttempt(
                    task_id=task.id,
                    attempt_number=task.attempts + 1,
                    worker_id=worker_id,
                    started_at=now,
                    heartbeat_at=now,
                )
            )
        if result:
            await self.session.flush()
        return list(result)

    async def complete(self, task: ResearchTask, summary: str | None = None) -> None:
        task.status = TaskStatus.COMPLETED
        task.completed_at = utcnow()
        task.worker_id = None
        task.error_message = None
        task.next_retry_at = None
        task.result_summary = summary
        await self._finish_attempt(task, TaskStatus.COMPLETED, summary=summary)
        await self.session.flush()

    async def fail(self, task: ResearchTask, error_message: str) -> None:
        task.status = TaskStatus.FAILED
        task.worker_id = None
        task.error_message = error_message
        task.next_retry_at = None
        await self._finish_attempt(task, TaskStatus.FAILED, error_message=error_message)
        await self.session.flush()

    async def schedule_retry(self, task: ResearchTask, error_message: str) -> bool:
        """Move a task to RETRY with exponential backoff.

        Returns True if a retry was scheduled, False if the task was exhausted
        and must be marked FAILED.
        """
        task.attempts += 1
        if task.attempts >= task.max_attempts:
            await self.fail(task, error_message)
            return False
        task.status = TaskStatus.RETRY
        task.error_message = error_message
        task.next_retry_at = next_retry_at(task.attempts)
        task.worker_id = None
        await self._finish_attempt(task, TaskStatus.RETRY, error_message=error_message)
        await self.session.flush()
        return True

    async def requeue_stale(self, staleness_seconds: int) -> int:
        """Return RUNNING tasks whose worker crashed back to PENDING."""
        cutoff = utcnow() - timedelta(seconds=staleness_seconds)
        stmt = (
            select(ResearchTask)
            .where(ResearchTask.status == TaskStatus.RUNNING)
            .where(ResearchTask.started_at.is_not(None))
            .where(
                (
                    ~select(ResearchTaskAttempt.id)
                    .where(ResearchTaskAttempt.task_id == ResearchTask.id)
                    .exists()
                )
                | (
                    select(ResearchTaskAttempt.heartbeat_at)
                    .where(ResearchTaskAttempt.task_id == ResearchTask.id)
                    .order_by(ResearchTaskAttempt.attempt_number.desc())
                    .limit(1)
                    .scalar_subquery() < cutoff
                )
            )
            .with_for_update(skip_locked=True)
        )
        tasks = (await self.session.execute(stmt)).scalars().all()
        for task in tasks:
            task.status = TaskStatus.PENDING
            task.scheduled_at = utcnow()
            task.next_retry_at = None
            task.worker_id = None
            await self._finish_attempt(task, TaskStatus.FAILED, error_message="stale task requeued")
        if tasks:
            await self.session.flush()
        return len(tasks)

    async def heartbeat(self, task: ResearchTask) -> None:
        attempt = await self._current_attempt(task)
        if attempt is not None:
            attempt.heartbeat_at = utcnow()
            await self.session.flush()

    async def _current_attempt(self, task: ResearchTask) -> ResearchTaskAttempt | None:
        stmt = (
            select(ResearchTaskAttempt)
            .where(ResearchTaskAttempt.task_id == task.id)
            .order_by(ResearchTaskAttempt.attempt_number.desc())
            .limit(1)
        )
        return (await self.session.execute(stmt)).scalars().first()

    async def _finish_attempt(
        self,
        task: ResearchTask,
        status: TaskStatus,
        *,
        summary: str | None = None,
        error_message: str | None = None,
    ) -> None:
        attempt = await self._current_attempt(task)
        if attempt is not None and attempt.finished_at is None:
            attempt.status = status
            attempt.finished_at = utcnow()
            attempt.result_summary = summary
            attempt.error_message = error_message

    async def stats(self) -> dict[str, int]:
        rows = await self.session.execute(
            select(ResearchTask.status, func.count()).group_by(ResearchTask.status)
        )
        return {str(status): count for status, count in rows.all()}

    async def active_task(self, company_id: uuid.UUID, task_type: TaskType) -> ResearchTask | None:
        return await self._active_task(company_id, task_type)

    async def _has_active_task(self, company_id: uuid.UUID, task_type: TaskType) -> bool:
        return await self._active_task(company_id, task_type) is not None

    async def _active_task(self, company_id: uuid.UUID, task_type: TaskType) -> ResearchTask | None:
        stmt = select(ResearchTask).where(
            ResearchTask.company_id == company_id,
            ResearchTask.task_type == task_type,
            ResearchTask.status.in_([TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.RETRY]),
        )
        return (await self.session.execute(stmt)).scalars().first()

    async def get(self, task_id: uuid.UUID) -> ResearchTask | None:
        return await self.session.get(ResearchTask, task_id)
