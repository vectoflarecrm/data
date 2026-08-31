from __future__ import annotations

import uuid
from datetime import datetime

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
from app.schemas.common import ORMModel


class ContactCreate(ORMModel):
    first_name: str | None = None
    last_name: str | None = None
    full_name: str
    job_title: str | None = None
    department: str | None = None
    seniority: Seniority = Seniority.UNKNOWN
    role_type: RoleType = RoleType.UNKNOWN
    purchasing_role: PurchasingRole = PurchasingRole.UNKNOWN
    decision_power: DecisionPower = DecisionPower.UNKNOWN
    linkedin_url: str | None = None
    bio: str | None = None
    status: ContactStatus = ContactStatus.UNKNOWN
    confidence: float | None = None


class ContactUpdate(ORMModel):
    first_name: str | None = None
    last_name: str | None = None
    full_name: str | None = None
    job_title: str | None = None
    department: str | None = None
    seniority: Seniority | None = None
    role_type: RoleType | None = None
    purchasing_role: PurchasingRole | None = None
    decision_power: DecisionPower | None = None
    linkedin_url: str | None = None
    bio: str | None = None
    status: ContactStatus | None = None
    confidence: float | None = None


class ContactRead(ORMModel):
    id: uuid.UUID
    company_id: uuid.UUID
    first_name: str | None
    last_name: str | None
    full_name: str
    job_title: str | None
    department: str | None
    seniority: Seniority | None
    role_type: RoleType | None
    purchasing_role: PurchasingRole | None
    decision_power: DecisionPower | None
    linkedin_url: str | None
    bio: str | None
    status: ContactStatus
    confidence: float | None
    created_at: datetime
    updated_at: datetime | None
    last_verified_at: datetime | None


class ContactMethodCreate(ORMModel):
    method_type: MethodType
    value: str
    normalized_value: str | None = None
    is_primary: bool = False
    is_business: bool = True
    public_or_private: PrivacyLabel = PrivacyLabel.UNKNOWN
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    confidence: float | None = None
    source_evidence_id: uuid.UUID | None = None


class ContactMethodRead(ORMModel):
    id: uuid.UUID
    contact_id: uuid.UUID
    company_id: uuid.UUID
    method_type: MethodType
    value: str
    normalized_value: str | None
    is_primary: bool
    is_business: bool
    public_or_private: PrivacyLabel
    verification_status: VerificationStatus
    confidence: float | None
    verified_at: datetime | None
    created_at: datetime


class SocialAccountCreate(ORMModel):
    platform: Platform
    profile_url: str | None = None
    username: str | None = None
    display_name: str | None = None
    business_or_personal: BusinessOrPersonal = BusinessOrPersonal.UNKNOWN
    followers: int | None = None
    activity_level: ActivityLevel = ActivityLevel.UNKNOWN
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    confidence: float | None = None
    follow_status: str = "NOT_FOLLOWED"
    followed_at: datetime | None = None
    contact_status: str = "NOT_CONTACTED"
    contacted_at: datetime | None = None
    response_status: str = "UNKNOWN"


class SocialAccountRead(ORMModel):
    id: uuid.UUID
    company_id: uuid.UUID
    contact_id: uuid.UUID | None
    platform: Platform
    profile_url: str | None
    username: str | None
    display_name: str | None
    business_or_personal: BusinessOrPersonal
    followers: int | None
    activity_level: ActivityLevel
    verification_status: VerificationStatus
    confidence: float | None
    follow_status: str
    followed_at: datetime | None
    contact_status: str
    contacted_at: datetime | None
    response_status: str
    last_checked_at: datetime | None
    created_at: datetime
