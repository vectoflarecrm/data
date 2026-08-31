"""align runtime schema

Revision ID: c7e9a1b4d528
Revises: b6d8f1a3c427
"""
from collections.abc import Sequence

from alembic import op

revision: str = "c7e9a1b4d528"
down_revision: str | Sequence[str] | None = "b6d8f1a3c427"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("companies", "ai_context")
    op.drop_constraint("fk_contact_methods_company_id_companies", "contact_methods", type_="foreignkey")
    op.drop_constraint("fk_ai_context_contact_company", "ai_contexts", type_="foreignkey")
    op.create_foreign_key("fk_ai_contexts_contact_id_contacts", "ai_contexts", "contacts", ["contact_id"], ["id"], ondelete="SET NULL")
    op.drop_constraint("fk_outreach_contact_company", "outreach", type_="foreignkey")
    op.create_foreign_key("fk_outreach_contact_id_contacts", "outreach", "contacts", ["contact_id"], ["id"], ondelete="SET NULL")
    op.drop_constraint("fk_evidence_contact_company", "research_evidence", type_="foreignkey")
    op.create_foreign_key("fk_research_evidence_contact_id_contacts", "research_evidence", "contacts", ["contact_id"], ["id"], ondelete="SET NULL")
    op.execute("ALTER TABLE research_task_attempts ALTER COLUMN status DROP DEFAULT")
    op.alter_column("research_task_attempts", "status", type_=__import__("sqlalchemy").Enum("PENDING", "RUNNING", "COMPLETED", "FAILED", "RETRY", "CANCELLED", name="taskstatus", create_type=False), postgresql_using="status::taskstatus")
    op.alter_column("research_task_attempts", "status", server_default="RUNNING")
    op.drop_constraint("uq_research_task_attempt_number", "research_task_attempts", type_="unique")
    op.create_unique_constraint("uq_research_task_attempt_number", "research_task_attempts", ["task_id", "attempt_number"])
    op.drop_constraint("uq_social_profile", "social_accounts", type_="unique")


def downgrade() -> None:
    op.create_unique_constraint("uq_social_profile", "social_accounts", ["company_id", "platform", "profile_url"])
    op.drop_constraint("uq_research_task_attempt_number", "research_task_attempts", type_="unique")
    op.create_index("uq_research_task_attempt_number", "research_task_attempts", ["task_id", "attempt_number"], unique=True)
    op.alter_column("research_task_attempts", "status", type_=__import__("sqlalchemy").Text(), postgresql_using="status::text")
    op.drop_constraint("fk_research_evidence_contact_id_contacts", "research_evidence", type_="foreignkey")
    op.create_foreign_key("fk_evidence_contact_company", "research_evidence", "contacts", ["contact_id", "company_id"], ["id", "company_id"], ondelete="SET NULL")
    op.drop_constraint("fk_outreach_contact_id_contacts", "outreach", type_="foreignkey")
    op.create_foreign_key("fk_outreach_contact_company", "outreach", "contacts", ["contact_id", "company_id"], ["id", "company_id"], ondelete="SET NULL")
    op.drop_constraint("fk_ai_contexts_contact_id_contacts", "ai_contexts", type_="foreignkey")
    op.create_foreign_key("fk_ai_context_contact_company", "ai_contexts", "contacts", ["contact_id", "company_id"], ["id", "company_id"], ondelete="SET NULL")
    op.add_column("companies", __import__("sqlalchemy").Column("ai_context", __import__("sqlalchemy").Text(), nullable=True))
    op.create_foreign_key("fk_contact_methods_company_id_companies", "contact_methods", "companies", ["company_id"], ["id"], ondelete="CASCADE")
