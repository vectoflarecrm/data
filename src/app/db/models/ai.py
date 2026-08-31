from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDMixin


class AIContext(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "ai_contexts"

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    context_type: Mapped[str] = mapped_column(String(40), nullable=False)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("contacts.id", ondelete="SET NULL")
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    regenerated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        Index(
            "uq_ai_context_company_scope",
            "company_id",
            "context_type",
            unique=True,
            postgresql_where=text("contact_id IS NULL"),
        ),
        Index(
            "uq_ai_context_contact_scope",
            "company_id",
            "context_type",
            "contact_id",
            unique=True,
            postgresql_where=text("contact_id IS NOT NULL"),
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<AIContext id={self.id} type={self.context_type} company={self.company_id}>"
