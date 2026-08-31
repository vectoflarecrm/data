from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import (
    ActivityLevel,
    BusinessOrPersonal,
    ContactStatus,
    DecisionPower,
    MethodType,
    Platform,
    PrivacyLabel,
    PurchasingRole,
    RoleType,
    Seniority,
    VerificationStatus,
)
from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.db.models.company import Company


class Contact(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "contacts"
    __table_args__ = (UniqueConstraint("id", "company_id", name="uq_contacts_id_company"),)

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    first_name: Mapped[str | None] = mapped_column(String(150))
    last_name: Mapped[str | None] = mapped_column(String(150))
    full_name: Mapped[str] = mapped_column(String(300), nullable=False, index=True)
    job_title: Mapped[str | None] = mapped_column(String(255))
    department: Mapped[str | None] = mapped_column(String(150))
    seniority: Mapped[Seniority | None] = mapped_column(default=Seniority.UNKNOWN)
    role_type: Mapped[RoleType | None] = mapped_column(default=RoleType.UNKNOWN)
    purchasing_role: Mapped[PurchasingRole | None] = mapped_column(
        default=PurchasingRole.UNKNOWN, index=True
    )
    decision_power: Mapped[DecisionPower | None] = mapped_column(default=DecisionPower.UNKNOWN)
    linkedin_url: Mapped[str | None] = mapped_column(String(500))
    bio: Mapped[str | None] = mapped_column(Text)
    status: Mapped[ContactStatus] = mapped_column(default=ContactStatus.UNKNOWN)
    confidence: Mapped[float | None] = mapped_column(Float)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    company: Mapped[Company] = relationship(  # noqa: F821
        back_populates="contacts"
    )
    methods: Mapped[list[ContactMethod]] = relationship(  # noqa: F821
        back_populates="contact", cascade="all, delete-orphan"
    )
    social_accounts: Mapped[list[SocialAccount]] = relationship(  # noqa: F821
        back_populates="contact", cascade="all, delete-orphan"
    )


class ContactMethod(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "contact_methods"
    __table_args__ = (
        UniqueConstraint(
            "contact_id",
            "method_type",
            "normalized_value",
            name="uq_contact_method_value",
        ),
        ForeignKeyConstraint(
            ["contact_id", "company_id"],
            ["contacts.id", "contacts.company_id"],
            ondelete="CASCADE",
            name="fk_contact_methods_contact_company",
        ),
    )

    contact_id: Mapped[uuid.UUID] = mapped_column(nullable=False, index=True)
    company_id: Mapped[uuid.UUID] = mapped_column(nullable=False, index=True)
    method_type: Mapped[MethodType] = mapped_column(nullable=False)
    value: Mapped[str] = mapped_column(String(500), nullable=False)
    normalized_value: Mapped[str | None] = mapped_column(String(500))
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    is_business: Mapped[bool] = mapped_column(Boolean, default=True)
    public_or_private: Mapped[PrivacyLabel] = mapped_column(default=PrivacyLabel.UNKNOWN)
    verification_status: Mapped[VerificationStatus] = mapped_column(
        default=VerificationStatus.UNVERIFIED
    )
    confidence: Mapped[float | None] = mapped_column(Float)
    source_evidence_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("research_evidence.id", ondelete="SET NULL")
    )
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    contact: Mapped[Contact] = relationship(back_populates="methods")
    company: Mapped[Company] = relationship(  # noqa: F821
        back_populates="contact_methods",
        primaryjoin="Company.id == foreign(ContactMethod.company_id)",
    )


class SocialAccount(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "social_accounts"
    __table_args__ = (
        CheckConstraint(
            "profile_url IS NOT NULL OR username IS NOT NULL",
            name="ck_social_account_identity",
        ),
        ForeignKeyConstraint(
            ["company_id"], ["companies.id"], ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["contact_id", "company_id"],
            ["contacts.id", "contacts.company_id"],
            ondelete="CASCADE",
            name="fk_social_accounts_contact_company",
        ),
        Index(
            "uq_social_company_platform_username",
            "company_id",
            "platform",
            "username",
            unique=True,
            postgresql_where=text("username IS NOT NULL"),
        ),
        Index(
            "uq_social_company_platform_url",
            "company_id",
            "platform",
            "profile_url",
            unique=True,
            postgresql_where=text("profile_url IS NOT NULL"),
        ),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(nullable=False, index=True)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(index=True)
    platform: Mapped[Platform] = mapped_column(nullable=False, index=True)
    profile_url: Mapped[str | None] = mapped_column(String(500))
    username: Mapped[str | None] = mapped_column(String(255))
    display_name: Mapped[str | None] = mapped_column(String(255))
    business_or_personal: Mapped[BusinessOrPersonal] = mapped_column(
        default=BusinessOrPersonal.UNKNOWN
    )
    followers: Mapped[int | None] = mapped_column(Integer)
    activity_level: Mapped[ActivityLevel] = mapped_column(default=ActivityLevel.UNKNOWN)
    verification_status: Mapped[VerificationStatus] = mapped_column(
        default=VerificationStatus.UNVERIFIED
    )
    confidence: Mapped[float | None] = mapped_column(Float)
    source_evidence_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("research_evidence.id", ondelete="SET NULL")
    )
    follow_status: Mapped[str] = mapped_column(String(20), default="NOT_FOLLOWED")
    followed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    contact_status: Mapped[str] = mapped_column(String(20), default="NOT_CONTACTED")
    contacted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    response_status: Mapped[str] = mapped_column(String(20), default="UNKNOWN")
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    company: Mapped[Company] = relationship(  # noqa: F821
        back_populates="social_accounts"
    )
    contact: Mapped[Contact | None] = relationship(back_populates="social_accounts")
