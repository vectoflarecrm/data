"""remove redundant primary-key indexes

Revision ID: d8f2a4c6e139
Revises: c7e9a1b4d528
"""
from collections.abc import Sequence

from alembic import op

revision: str = "d8f2a4c6e139"
down_revision: str | Sequence[str] | None = "c7e9a1b4d528"
branch_labels = None
depends_on = None

_TABLES = (
    "ai_contexts", "brands", "companies", "company_brands", "company_events",
    "contact_methods", "contacts", "lead_scores", "outreach_events", "products",
    "research_evidence", "research_task_attempts", "research_tasks", "social_accounts",
)


def upgrade() -> None:
    for table in _TABLES:
        op.drop_index(f"ix_{table}_id", table_name=table)


def downgrade() -> None:
    for table in _TABLES:
        op.create_index(f"ix_{table}_id", table, ["id"])
