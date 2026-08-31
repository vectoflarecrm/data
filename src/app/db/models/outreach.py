from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDMixin


class Campaign(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "campaigns"

    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="DRAFT")
    channel: Mapped[str] = mapped_column(String(20), default="EMAIL")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    outreach: Mapped[list[Outreach]] = relationship(back_populates="campaign", cascade="all, delete-orphan")  # noqa: F821


class Outreach(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "outreach"
    __table_args__ = (
        CheckConstraint(
            "channel <> 'EMAIL' OR normalized_recipient_email IS NOT NULL",
            name="ck_outreach_email_recipient",
        ),
        Index(
            "uq_outreach_campaign_recipient",
            "campaign_id",
            "normalized_recipient_email",
            unique=True,
            postgresql_where=text("campaign_id IS NOT NULL AND normalized_recipient_email IS NOT NULL"),
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("contacts.id", ondelete="SET NULL"), index=True
    )
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("campaigns.id", ondelete="SET NULL"), index=True)
    channel: Mapped[str] = mapped_column(String(20), nullable=False, default="EMAIL")
    subject: Mapped[str | None] = mapped_column(String(500))
    message: Mapped[str | None] = mapped_column(Text)
    recipient_email: Mapped[str | None] = mapped_column(String(500))
    normalized_recipient_email: Mapped[str | None] = mapped_column(String(320), index=True)
    suppression_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    suppression_status: Mapped[str | None] = mapped_column(String(20))
    suppression_reason: Mapped[str | None] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="PREPARED")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    campaign: Mapped[Campaign | None] = relationship(back_populates="outreach")
    events: Mapped[list[OutreachEvent]] = relationship(  # noqa: F821
        back_populates="outreach", cascade="all, delete-orphan", order_by="OutreachEvent.occurred_at"
    )


class OutreachEvent(Base, UUIDMixin):
    __tablename__ = "outreach_events"
    __table_args__ = (Index("ix_outreach_events_outreach_occurred", "outreach_id", "occurred_at"),)

    outreach_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("outreach.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(String(30), nullable=False)
    provider_message_id: Mapped[str | None] = mapped_column(String(255), index=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    payload: Mapped[dict | None] = mapped_column(JSON)

    outreach: Mapped[Outreach] = relationship(back_populates="events")
