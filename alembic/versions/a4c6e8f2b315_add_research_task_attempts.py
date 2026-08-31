"""add research task attempts

Revision ID: a4c6e8f2b315
Revises: 9b3d5e7f2c14
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4c6e8f2b315"
down_revision: str | Sequence[str] | None = "9b3d5e7f2c14"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "research_task_attempts",
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("worker_id", sa.String(length=100), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="RUNNING"),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("result_summary", sa.Text(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["task_id"], ["research_tasks.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("task_id", "attempt_number", name="uq_research_task_attempt_number"),
    )
    op.create_index("ix_research_task_attempts_task_id", "research_task_attempts", ["task_id"])
    op.create_index("ix_research_task_attempts_id", "research_task_attempts", ["id"])


def downgrade() -> None:
    op.drop_index("ix_research_task_attempts_id", table_name="research_task_attempts")
    op.drop_index("ix_research_task_attempts_task_id", table_name="research_task_attempts")
    op.drop_table("research_task_attempts")
