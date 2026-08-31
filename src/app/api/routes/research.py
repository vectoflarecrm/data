from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status

from app.api.dependencies import DbSession, get_company_or_404
from app.core.enums import TaskStatus, TaskType
from app.db.models import ResearchTask
from app.research.queue import ResearchTaskRepository
from app.schemas.common import Page, to_page
from app.schemas.evidence import TaskCreate, TaskRead
from app.schemas.research import EnqueueAllResponse, RunResponse

router = APIRouter(prefix="/research", tags=["research"])


@router.get("/tasks", response_model=Page[TaskRead])
async def list_research_tasks(
    session: DbSession,
    company_id: uuid.UUID | None = None,
    task_type: TaskType | None = None,
    status_filter: TaskStatus | None = Query(default=None, alias="status"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> Page[TaskRead]:
    filters = []
    if company_id:
        filters.append(ResearchTask.company_id == company_id)
    if task_type:
        filters.append(ResearchTask.task_type == task_type)
    if status_filter:
        filters.append(ResearchTask.status == status_filter)
    repo = ResearchTaskRepository(session)
    tasks = await repo.list_paginated(
        page=page,
        page_size=page_size,
        order_by=ResearchTask.scheduled_at,
        filters=filters,
        model=ResearchTask,
    )
    items = [TaskRead.model_validate(t) for t in tasks.items]
    return to_page(items, tasks.total, tasks.page, tasks.page_size)


@router.post("/tasks", response_model=TaskRead, status_code=status.HTTP_201_CREATED)
async def create_research_task(payload: TaskCreate, session: DbSession) -> TaskRead:
    repo = ResearchTaskRepository(session)
    task = await repo.create(
        company_id=payload.company_id,
        task_type=payload.task_type,
        priority=payload.priority,
        scheduled_at=payload.scheduled_at,
    )
    await session.commit()
    return TaskRead.model_validate(task)


@router.post("/run", response_model=RunResponse)
async def run_now(
    session: DbSession,
    limit: int = Query(1, ge=1, le=50),
) -> RunResponse:
    """Synchronously process the next `limit` due tasks using the current executor."""
    from app.research.executor import dispatch

    repo = ResearchTaskRepository(session)
    claimed = await repo.claim(worker_id="api-run", limit=limit)
    completed = 0
    failed = 0
    retried = 0
    for task in claimed:
        from app.research.workers import TaskOutcome

        try:
            outcome = await dispatch(session, task)
        except Exception as exc:  # noqa: BLE001
            outcome = TaskOutcome(status="retry", error=str(exc))
        if outcome.status == "completed":
            await repo.complete(task, outcome.summary)
            completed += 1
        elif outcome.status == "retry":
            await repo.schedule_retry(task, outcome.error or "retry")
            retried += 1
        else:
            await repo.fail(task, outcome.error or "failed")
            failed += 1
    await session.commit()
    return RunResponse(claimed=len(claimed), completed=completed, retried=retried, failed=failed)


@router.post("/{company_id}", response_model=EnqueueAllResponse)
async def enqueue_all_for_company(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> EnqueueAllResponse:
    repo = ResearchTaskRepository(session)
    types = [
        TaskType.COMPANY_RESEARCH,
        TaskType.CONTACT_DISCOVERY,
        TaskType.PRODUCT_RESEARCH,
        TaskType.SOCIAL_DISCOVERY,
        TaskType.LEAD_SCORING,
    ]
    created: list[str] = []
    existing: list[str] = []
    for task_type in types:
        if await repo.active_task(company_id=company_id, task_type=task_type):
            existing.append(task_type.value)
            continue
        await repo.create(company_id=company_id, task_type=task_type)
        created.append(task_type.value)
    await session.commit()
    return EnqueueAllResponse(company_id=company_id, enqueued=created, already_pending=existing)
