from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import TaskType
from app.db.models import ResearchTask
from app.research.workers import TaskExecutor, TaskOutcome

HANDLERS: dict[TaskType, TaskExecutor] = {}


def register_handler(task_type: TaskType, handler: TaskExecutor) -> None:
    HANDLERS[task_type] = handler


async def dispatch(session: AsyncSession, task: ResearchTask) -> TaskOutcome:
    handler = HANDLERS.get(task.task_type)
    if handler is None:
        return TaskOutcome(
            status="failed",
            error=f"No handler registered for task type {task.task_type.value}",
        )
    return await handler(session, task)
