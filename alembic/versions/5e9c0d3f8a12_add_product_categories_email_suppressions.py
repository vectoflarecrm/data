"""add product categories and email suppressions

Revision ID: 5e9c0d3f8a12
Revises: 4d8b9c2e7f10
"""
from collections.abc import Sequence
import sqlalchemy as sa
from alembic import op

revision: str = "5e9c0d3f8a12"
down_revision: str | Sequence[str] | None = "4d8b9c2e7f10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "email_suppressions",
        sa.Column("normalized_email", sa.String(320), nullable=False),
        sa.Column("original_email", sa.String(500), nullable=True),
        sa.Column("reason", sa.String(100), nullable=False, server_default="UNKNOWN"),
        sa.Column("details", sa.Text(), nullable=True),
        sa.Column("source", sa.String(255), nullable=True),
        sa.Column("suppressed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("contact_id", sa.Uuid(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["contact_id"], ["contacts.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("normalized_email", name="uq_email_suppression_email"),
    )
    op.create_index("ix_email_suppressions_normalized_email", "email_suppressions", ["normalized_email"])
    op.create_index("ix_email_suppressions_company_id", "email_suppressions", ["company_id"])
    op.create_index("ix_email_suppressions_contact_id", "email_suppressions", ["contact_id"])


def downgrade() -> None:
    op.drop_index("ix_email_suppressions_contact_id", table_name="email_suppressions")
    op.drop_index("ix_email_suppressions_company_id", table_name="email_suppressions")
    op.drop_index("ix_email_suppressions_normalized_email", table_name="email_suppressions")
    op.drop_table("email_suppressions")
