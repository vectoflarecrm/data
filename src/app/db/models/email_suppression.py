from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.db.models.company import Company
    from app.db.models.contact import Contact


class EmailSuppression(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "email_suppressions"
    __table_args__ = (UniqueConstraint("normalized_email", name="uq_email_suppression_email"),)

    normalized_email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    original_email: Mapped[str | None] = mapped_column(String(500))
    reason: Mapped[str] = mapped_column(String(100), nullable=False, default="UNKNOWN")
    details: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(String(255))
    suppressed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"), index=True
    )
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("contacts.id", ondelete="SET NULL"), index=True
    )

    company: Mapped[Company | None] = relationship()  # noqa: F821
    contact: Mapped[Contact | None] = relationship()  # noqa: F821
