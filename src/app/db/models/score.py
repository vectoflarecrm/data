from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, CheckConstraint, DateTime, Float, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDMixin


class LeadScore(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "lead_scores"
    __table_args__ = (
        CheckConstraint(
            "product_fit BETWEEN 0 AND 100 AND company_fit BETWEEN 0 AND 100 "
            "AND market_fit BETWEEN 0 AND 100 AND purchasing_potential BETWEEN 0 AND 100 "
            "AND contact_quality BETWEEN 0 AND 100 AND growth_signals BETWEEN 0 AND 100 "
            "AND data_completeness BETWEEN 0 AND 100 AND recent_activity BETWEEN 0 AND 100 "
            "AND total_score BETWEEN 0 AND 100",
            name="ck_lead_scores_range",
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    product_fit: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    company_fit: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    market_fit: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    purchasing_potential: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    contact_quality: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    growth_signals: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    data_completeness: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    recent_activity: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    total_score: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    grade: Mapped[str | None] = mapped_column(String(4))
    breakdown: Mapped[dict | None] = mapped_column(JSON)
    scoring_version: Mapped[str] = mapped_column(String(40), nullable=False, default="v1")
    calculated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<LeadScore id={self.id} total={self.total_score} grade={self.grade}>"
