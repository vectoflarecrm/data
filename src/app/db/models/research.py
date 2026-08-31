from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import TaskStatus, TaskType
from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.db.models.company import Company


class ResearchTask(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "research_tasks"
    __table_args__ = (
        Index(
            "ix_research_claim",
            "status",
            "priority",
            "scheduled_at",
            postgresql_where=text("status IN ('PENDING', 'RETRY')"),
        ),
        Index(
            "uq_active_research_task",
            "company_id",
            "task_type",
            unique=True,
            postgresql_where=text("status IN ('PENDING', 'RUNNING', 'RETRY')"),
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    task_type: Mapped[TaskType] = mapped_column(nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    status: Mapped[TaskStatus] = mapped_column(
        default=TaskStatus.PENDING, nullable=False, index=True
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    scheduled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    worker_id: Mapped[str | None] = mapped_column(String(100))
    error_message: Mapped[str | None] = mapped_column(Text)
    result_summary: Mapped[str | None] = mapped_column(Text)

    company: Mapped[Company] = relationship(back_populates="tasks")  # noqa: F821
    execution_attempts: Mapped[list[ResearchTaskAttempt]] = relationship(  # noqa: F821
        back_populates="task",
        cascade="all, delete-orphan",
        order_by="ResearchTaskAttempt.attempt_number",
    )


class ResearchTaskAttempt(Base, UUIDMixin):
    __tablename__ = "research_task_attempts"
    __table_args__ = (
        UniqueConstraint("task_id", "attempt_number", name="uq_research_task_attempt_number"),
    )

    task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("research_tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    worker_id: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[TaskStatus] = mapped_column(nullable=False, default=TaskStatus.RUNNING)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)
    result_summary: Mapped[str | None] = mapped_column(Text)

    task: Mapped[ResearchTask] = relationship(back_populates="execution_attempts")
