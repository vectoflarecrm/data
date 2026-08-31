from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import (
    BrandRelationship,
    CompanyStatus,
    EventType,
    Importance,
    ResearchLevel,
    ResearchStatus,
)
from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.db.models.contact import Contact, ContactMethod, SocialAccount
    from app.db.models.evidence import ResearchEvidence
    from app.db.models.product import CompanyProduct
    from app.db.models.research import ResearchTask


class Company(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "companies"
    __table_args__ = (
        CheckConstraint(
            "founded_year IS NULL OR founded_year BETWEEN 1000 AND EXTRACT(YEAR FROM CURRENT_DATE)::int",
            name="ck_companies_founded_year",
        ),
        CheckConstraint(
            "company_score IS NULL OR company_score BETWEEN 0 AND 100",
            name="ck_companies_company_score",
        ),
        CheckConstraint(
            "lead_score IS NULL OR lead_score BETWEEN 0 AND 100",
            name="ck_companies_lead_score",
        ),
    )

    company_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    legal_name: Mapped[str | None] = mapped_column(String(255))
    trading_name: Mapped[str | None] = mapped_column(String(255))
    website: Mapped[str | None] = mapped_column(String(500))
    normalized_domain: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)
    country: Mapped[str | None] = mapped_column(String(100))
    country_code: Mapped[str | None] = mapped_column(String(2), index=True)
    region: Mapped[str | None] = mapped_column(String(150))
    city: Mapped[str | None] = mapped_column(String(150))
    address: Mapped[str | None] = mapped_column(String(500))
    postal_code: Mapped[str | None] = mapped_column(String(50))
    industry: Mapped[str | None] = mapped_column(String(150))
    company_type: Mapped[list[str] | None] = mapped_column(ARRAY(String(50)))
    business_model: Mapped[str | None] = mapped_column(String(255))
    founded_year: Mapped[int | None] = mapped_column(Integer)
    employee_range: Mapped[str | None] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(Text)
    main_products_summary: Mapped[str | None] = mapped_column(Text)
    target_markets: Mapped[list[str] | None] = mapped_column(ARRAY(String(100)))

    manufacturer: Mapped[bool] = mapped_column(Boolean, default=False)
    importer: Mapped[bool] = mapped_column(Boolean, default=False)
    distributor: Mapped[bool] = mapped_column(Boolean, default=False)
    wholesaler: Mapped[bool] = mapped_column(Boolean, default=False)
    retailer: Mapped[bool] = mapped_column(Boolean, default=False)
    ecommerce: Mapped[bool] = mapped_column(Boolean, default=False)
    rental: Mapped[bool] = mapped_column(Boolean, default=False)
    oem: Mapped[bool] = mapped_column(Boolean, default=False)

    company_status: Mapped[CompanyStatus] = mapped_column(default=CompanyStatus.UNKNOWN)
    research_status: Mapped[ResearchStatus] = mapped_column(default=ResearchStatus.NEW, index=True)
    research_level: Mapped[ResearchLevel] = mapped_column(default=ResearchLevel.L0)
    company_score: Mapped[float | None] = mapped_column(Float)
    lead_score: Mapped[float | None] = mapped_column(Float, index=True)
    last_researched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_research_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    contacts: Mapped[list[Contact]] = relationship(  # noqa: F821
        back_populates="company", cascade="all, delete-orphan"
    )
    contact_methods: Mapped[list[ContactMethod]] = relationship(  # noqa: F821
        back_populates="company",
        cascade="all, delete-orphan",
        primaryjoin="Company.id == foreign(ContactMethod.company_id)",
    )
    social_accounts: Mapped[list[SocialAccount]] = relationship(  # noqa: F821
        back_populates="company", cascade="all, delete-orphan"
    )
    brands: Mapped[list[CompanyBrand]] = relationship(  # noqa: F821
        back_populates="company", cascade="all, delete-orphan"
    )
    events: Mapped[list[CompanyEvent]] = relationship(  # noqa: F821
        back_populates="company", cascade="all, delete-orphan"
    )
    evidence: Mapped[list[ResearchEvidence]] = relationship(  # noqa: F821
        back_populates="company", cascade="all, delete-orphan"
    )
    tasks: Mapped[list[ResearchTask]] = relationship(  # noqa: F821
        back_populates="company", cascade="all, delete-orphan"
    )
    products: Mapped[list[CompanyProduct]] = relationship(  # noqa: F821
        back_populates="company", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Company id={self.id} name={self.company_name!r}>"


class Brand(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "brands"
    __table_args__ = (UniqueConstraint("name", name="uq_brand_name"),)

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    website: Mapped[str | None] = mapped_column(String(500))

    company_links: Mapped[list[CompanyBrand]] = relationship(  # noqa: F821
        back_populates="brand", cascade="all, delete-orphan"
    )


class CompanyBrand(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "company_brands"
    __table_args__ = (
        UniqueConstraint(
            "company_id", "brand_id", "relationship_type", name="uq_company_brand_rel"
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    brand_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("brands.id", ondelete="CASCADE"), nullable=False, index=True
    )
    relationship_type: Mapped[BrandRelationship] = mapped_column(
        default=BrandRelationship.DISTRIBUTOR
    )
    source_evidence_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("research_evidence.id", ondelete="SET NULL")
    )

    company: Mapped[Company] = relationship(back_populates="brands")
    brand: Mapped[Brand] = relationship(back_populates="company_links")


class CompanyEvent(Base, UUIDMixin):
    __tablename__ = "company_events"

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event_type: Mapped[EventType] = mapped_column(nullable=False)
    event_date: Mapped[date | None] = mapped_column(Date)
    title: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    importance: Mapped[Importance] = mapped_column(default=Importance.MEDIUM)
    source_evidence_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("research_evidence.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    company: Mapped[Company] = relationship(back_populates="events")
