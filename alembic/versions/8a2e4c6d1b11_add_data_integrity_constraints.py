"""add data integrity constraints

Revision ID: 8a2e4c6d1b11
Revises: 7f1c2d9e4a10
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8a2e4c6d1b11"
down_revision: str | Sequence[str] | None = "7f1c2d9e4a10"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_check_constraint(
        "ck_companies_founded_year", "companies",
        "founded_year IS NULL OR founded_year BETWEEN 1000 AND EXTRACT(YEAR FROM CURRENT_DATE)::int",
    )
    op.create_check_constraint("ck_companies_company_score", "companies", "company_score IS NULL OR company_score BETWEEN 0 AND 100")
    op.create_check_constraint("ck_companies_lead_score", "companies", "lead_score IS NULL OR lead_score BETWEEN 0 AND 100")
    op.create_check_constraint(
        "ck_lead_scores_range", "lead_scores",
        "product_fit BETWEEN 0 AND 100 AND company_fit BETWEEN 0 AND 100 AND market_fit BETWEEN 0 AND 100 AND purchasing_potential BETWEEN 0 AND 100 AND contact_quality BETWEEN 0 AND 100 AND growth_signals BETWEEN 0 AND 100 AND data_completeness BETWEEN 0 AND 100 AND recent_activity BETWEEN 0 AND 100 AND total_score BETWEEN 0 AND 100",
    )
    op.create_check_constraint(
        "ck_social_account_identity", "social_accounts",
        "profile_url IS NOT NULL OR username IS NOT NULL",
    )
    op.create_index(
        "uq_social_company_platform_username", "social_accounts",
        ["company_id", "platform", "username"], unique=True,
        postgresql_where=sa.text("username IS NOT NULL"),
    )
    op.create_index(
        "uq_social_company_platform_url", "social_accounts",
        ["company_id", "platform", "profile_url"], unique=True,
        postgresql_where=sa.text("profile_url IS NOT NULL"),
    )
    for _column, definition in {
        "recipient_email": sa.Column("recipient_email", sa.String(500)),
        "normalized_recipient_email": sa.Column("normalized_recipient_email", sa.String(320)),
        "suppression_checked_at": sa.Column("suppression_checked_at", sa.DateTime(timezone=True)),
        "suppression_status": sa.Column("suppression_status", sa.String(20)),
        "suppression_reason": sa.Column("suppression_reason", sa.String(100)),
    }.items():
        op.add_column("outreach", definition)
    op.create_index("ix_outreach_normalized_recipient_email", "outreach", ["normalized_recipient_email"])
    op.create_check_constraint(
        "ck_outreach_email_recipient", "outreach",
        "channel <> 'EMAIL' OR normalized_recipient_email IS NOT NULL",
    )
    op.create_index(
        "uq_outreach_campaign_recipient", "outreach",
        ["campaign_id", "normalized_recipient_email"], unique=True,
        postgresql_where=sa.text("campaign_id IS NOT NULL AND normalized_recipient_email IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_outreach_campaign_recipient", table_name="outreach")
    op.drop_constraint("ck_outreach_email_recipient", "outreach", type_="check")
    op.drop_index("ix_outreach_normalized_recipient_email", table_name="outreach")
    for column in ("suppression_reason", "suppression_status", "suppression_checked_at", "normalized_recipient_email", "recipient_email"):
        op.drop_column("outreach", column)
    op.drop_index("uq_social_company_platform_url", table_name="social_accounts")
    op.drop_index("uq_social_company_platform_username", table_name="social_accounts")
    op.drop_constraint("ck_social_account_identity", "social_accounts", type_="check")
    op.drop_constraint("ck_lead_scores_range", "lead_scores", type_="check")
    op.drop_constraint("ck_companies_lead_score", "companies", type_="check")
    op.drop_constraint("ck_companies_company_score", "companies", type_="check")
    op.drop_constraint("ck_companies_founded_year", "companies", type_="check")
