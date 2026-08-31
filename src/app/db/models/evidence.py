from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import EvidenceConfidence, SourceType
from app.db.base import Base
from app.db.models.mixins import UUIDMixin

if TYPE_CHECKING:
    from app.db.models.company import Company


class ResearchEvidence(Base, UUIDMixin):
    __tablename__ = "research_evidence"
    __table_args__ = (
        UniqueConstraint(
            "company_id",
            "content_hash",
            "field_name",
            name="uq_evidence_company_hash_field",
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("contacts.id", ondelete="SET NULL"), index=True
    )
    field_name: Mapped[str] = mapped_column(String(150), nullable=False, index=True)
    value: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(String(1000))
    source_domain: Mapped[str | None] = mapped_column(String(255), index=True)
    source_type: Mapped[SourceType] = mapped_column(nullable=False)
    evidence_text: Mapped[str | None] = mapped_column(Text)
    extraction_method: Mapped[str | None] = mapped_column(String(100))
    confidence: Mapped[EvidenceConfidence] = mapped_column(default=EvidenceConfidence.UNKNOWN)
    discovered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    is_current: Mapped[bool] = mapped_column(default=True, nullable=False, index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    company: Mapped[Company] = relationship(  # noqa: F821
        back_populates="evidence"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Evidence id={self.id} field={self.field_name} conf={self.confidence}>"
