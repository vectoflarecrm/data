"""add history and audit metadata

Revision ID: b6d8f1a3c427
Revises: a4c6e8f2b315
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b6d8f1a3c427"
down_revision: str | Sequence[str] | None = "a4c6e8f2b315"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("research_evidence", sa.Column("observed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False))
    op.add_column("research_evidence", sa.Column("is_current", sa.Boolean(), server_default=sa.true(), nullable=False))
    op.add_column("research_evidence", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_research_evidence_is_current", "research_evidence", ["is_current"])

    op.add_column("lead_scores", sa.Column("scoring_version", sa.String(40), server_default="v1", nullable=False))
    op.add_column("lead_scores", sa.Column("calculated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False))

    op.create_table(
        "outreach_events",
        sa.Column("outreach_id", sa.Uuid(), nullable=False),
        sa.Column("event_type", sa.String(30), nullable=False),
        sa.Column("provider_message_id", sa.String(255), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["outreach_id"], ["outreach.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_outreach_events_outreach_id", "outreach_events", ["outreach_id"])
    op.create_index("ix_outreach_events_id", "outreach_events", ["id"])
    op.create_index("ix_outreach_events_provider_message_id", "outreach_events", ["provider_message_id"])
    op.create_index("ix_outreach_events_outreach_occurred", "outreach_events", ["outreach_id", "occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_outreach_events_outreach_occurred", table_name="outreach_events")
    op.drop_index("ix_outreach_events_provider_message_id", table_name="outreach_events")
    op.drop_index("ix_outreach_events_id", table_name="outreach_events")
    op.drop_index("ix_outreach_events_outreach_id", table_name="outreach_events")
    op.drop_table("outreach_events")
    op.drop_column("lead_scores", "calculated_at")
    op.drop_column("lead_scores", "scoring_version")
    op.drop_index("ix_research_evidence_is_current", table_name="research_evidence")
    op.drop_column("research_evidence", "expires_at")
    op.drop_column("research_evidence", "is_current")
    op.drop_column("research_evidence", "observed_at")
