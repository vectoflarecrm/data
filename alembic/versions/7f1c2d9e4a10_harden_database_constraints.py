"""harden database constraints

Revision ID: 7f1c2d9e4a10
Revises: 5e9c0d3f8a12
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "7f1c2d9e4a10"
down_revision: str | Sequence[str] | None = "5e9c0d3f8a12"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("uq_evidence_hash", "research_evidence", type_="unique")
    op.create_unique_constraint(
        "uq_evidence_company_hash_field",
        "research_evidence",
        ["company_id", "content_hash", "field_name"],
    )

    op.create_index(
        "uq_active_research_task",
        "research_tasks",
        ["company_id", "task_type"],
        unique=True,
        postgresql_where=sa.text("status IN ('PENDING', 'RUNNING', 'RETRY')"),
    )

    op.drop_constraint("uq_ai_context_scope", "ai_contexts", type_="unique")
    op.create_index(
        "uq_ai_context_company_scope",
        "ai_contexts",
        ["company_id", "context_type"],
        unique=True,
        postgresql_where=sa.text("contact_id IS NULL"),
    )
    op.create_index(
        "uq_ai_context_contact_scope",
        "ai_contexts",
        ["company_id", "context_type", "contact_id"],
        unique=True,
        postgresql_where=sa.text("contact_id IS NOT NULL"),
    )
    op.drop_constraint(
        "fk_ai_contexts_contact_id_contacts", "ai_contexts", type_="foreignkey"
    )
    op.create_foreign_key(
        "fk_ai_contexts_contact_id_contacts",
        "ai_contexts",
        "contacts",
        ["contact_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_ai_contexts_contact_id_contacts", "ai_contexts", type_="foreignkey"
    )
    op.create_foreign_key(
        "fk_ai_contexts_contact_id_contacts",
        "ai_contexts",
        "contacts",
        ["contact_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_index("uq_ai_context_contact_scope", table_name="ai_contexts")
    op.drop_index("uq_ai_context_company_scope", table_name="ai_contexts")
    op.create_unique_constraint(
        "uq_ai_context_scope", "ai_contexts", ["company_id", "context_type", "contact_id"]
    )

    op.drop_index("uq_active_research_task", table_name="research_tasks")

    op.drop_constraint(
        "uq_evidence_company_hash_field", "research_evidence", type_="unique"
    )
    op.create_unique_constraint("uq_evidence_hash", "research_evidence", ["content_hash"])
