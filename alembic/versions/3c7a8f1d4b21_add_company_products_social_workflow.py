"""add company products and social workflow

Revision ID: 3c7a8f1d4b21
Revises: 92a389f336cf
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "3c7a8f1d4b21"
down_revision: str | Sequence[str] | None = "92a389f336cf"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "company_products",
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("product_id", sa.Uuid(), nullable=False),
        sa.Column("relationship_type", sa.String(30), nullable=False, server_default="SOLD"),
        sa.Column("source_evidence_id", sa.Uuid(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_evidence_id"], ["research_evidence.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("company_id", "product_id", name="uq_company_product"),
    )
    op.create_index("ix_company_products_company_id", "company_products", ["company_id"])
    op.create_index("ix_company_products_product_id", "company_products", ["product_id"])
    for name, column, type_, default in (
        ("follow_status", "VARCHAR(20)", "NOT NULL", "'NOT_FOLLOWED'"),
        ("followed_at", "TIMESTAMP WITH TIME ZONE", "NULL", None),
        ("contact_status", "VARCHAR(20)", "NOT NULL", "'NOT_CONTACTED'"),
        ("contacted_at", "TIMESTAMP WITH TIME ZONE", "NULL", None),
        ("response_status", "VARCHAR(20)", "NOT NULL", "'UNKNOWN'"),
    ):
        default_sql = f" DEFAULT {default}" if default else ""
        op.execute(f"ALTER TABLE social_accounts ADD COLUMN {name} {column} {type_}{default_sql}")


def downgrade() -> None:
    for column in ("response_status", "contacted_at", "contact_status", "followed_at", "follow_status"):
        op.drop_column("social_accounts", column)
    op.drop_index("ix_company_products_product_id", table_name="company_products")
    op.drop_index("ix_company_products_company_id", table_name="company_products")
    op.drop_table("company_products")
