"""enforce contact/company consistency

Revision ID: 9b3d5e7f2c14
Revises: 8a2e4c6d1b11
"""
from collections.abc import Sequence

from alembic import op

revision: str = "9b3d5e7f2c14"
down_revision: str | Sequence[str] | None = "8a2e4c6d1b11"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("uq_contacts_id_company", "contacts", ["id", "company_id"])
    op.drop_constraint("fk_contact_methods_contact_id_contacts", "contact_methods", type_="foreignkey")
    op.create_foreign_key(
        "fk_contact_methods_contact_company", "contact_methods", "contacts",
        ["contact_id", "company_id"], ["id", "company_id"], ondelete="CASCADE",
    )
    op.drop_constraint("fk_social_accounts_contact_id_contacts", "social_accounts", type_="foreignkey")
    op.create_foreign_key(
        "fk_social_accounts_contact_company", "social_accounts", "contacts",
        ["contact_id", "company_id"], ["id", "company_id"], ondelete="CASCADE",
    )
    op.drop_constraint("fk_research_evidence_contact_id_contacts", "research_evidence", type_="foreignkey")
    op.create_foreign_key(
        "fk_evidence_contact_company", "research_evidence", "contacts",
        ["contact_id", "company_id"], ["id", "company_id"], ondelete="SET NULL",
    )
    op.drop_constraint("fk_ai_contexts_contact_id_contacts", "ai_contexts", type_="foreignkey")
    op.create_foreign_key(
        "fk_ai_context_contact_company", "ai_contexts", "contacts",
        ["contact_id", "company_id"], ["id", "company_id"], ondelete="SET NULL",
    )
    op.drop_constraint("fk_outreach_contact_id_contacts", "outreach", type_="foreignkey")
    op.create_foreign_key(
        "fk_outreach_contact_company", "outreach", "contacts",
        ["contact_id", "company_id"], ["id", "company_id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    for table, name, ondelete in (
        ("outreach", "fk_outreach_contact_company", "SET NULL"),
        ("ai_contexts", "fk_ai_context_contact_company", "SET NULL"),
        ("research_evidence", "fk_evidence_contact_company", "SET NULL"),
        ("social_accounts", "fk_social_accounts_contact_company", "CASCADE"),
        ("contact_methods", "fk_contact_methods_contact_company", "CASCADE"),
    ):
        op.drop_constraint(name, table, type_="foreignkey")
    op.create_foreign_key("fk_outreach_contact_id_contacts", "outreach", "contacts", ["contact_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("fk_ai_contexts_contact_id_contacts", "ai_contexts", "contacts", ["contact_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("fk_research_evidence_contact_id_contacts", "research_evidence", "contacts", ["contact_id"], ["id"], ondelete="SET NULL")
    op.create_foreign_key("fk_social_accounts_contact_id_contacts", "social_accounts", "contacts", ["contact_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("fk_contact_methods_contact_id_contacts", "contact_methods", "contacts", ["contact_id"], ["id"], ondelete="CASCADE")
    op.drop_constraint("uq_contacts_id_company", "contacts", type_="unique")
