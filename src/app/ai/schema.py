from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import (
    ActivityLevel,
    BusinessOrPersonal,
    CompanyType,
    EventType,
    EvidenceConfidence,
    MethodType,
    Platform,
    ProductCategory,
    PurchasingRole,
    Seniority,
    SourceType,
    VerificationStatus,
)

STRICT = ConfigDict(extra="forbid")


class EvidenceClaimResult(BaseModel):
    """A single typed fact the AI extracted, ready for evidence persistence."""

    model_config = STRICT

    field_name: str
    value: str | None
    source_url: str | None = None
    source_type: SourceType = SourceType.OTHER
    evidence_text: str | None = None
    extraction_method: str = "ai"
    confidence: EvidenceConfidence = EvidenceConfidence.UNKNOWN


class ContactPointResult(BaseModel):
    model_config = STRICT

    method: MethodType = MethodType.EMAIL
    value: str
    source_url: str | None = None
    verification: VerificationStatus = VerificationStatus.UNVERIFIED
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)



class SocialProfileResult(BaseModel):
    model_config = STRICT

    platform: Platform
    url: str
    handle: str | None = None
    business_or_personal: BusinessOrPersonal = BusinessOrPersonal.UNKNOWN
    activity_level: ActivityLevel = ActivityLevel.UNKNOWN
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class BuyingSignalResult(BaseModel):
    model_config = STRICT

    signal_type: EventType
    description: str | None = None
    source_url: str | None = None
    detected_at: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class ContactResearchResult(BaseModel):
    model_config = STRICT

    name: str
    source_url: str | None = None
    title: str | None = None

    role: PurchasingRole = PurchasingRole.UNKNOWN
    seniority: Seniority = Seniority.UNKNOWN
    company_name: str | None = None
    company_domain: str | None = None
    email: ContactPointResult | None = None
    phones: list[ContactPointResult] = Field(default_factory=list)
    social_accounts: list[SocialProfileResult] = Field(default_factory=list)
    decision_power_likely: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    notes: str | None = None


class ContactListResult(BaseModel):
    """Batch wrapper for contact discovery output (list of people)."""

    model_config = STRICT

    contacts: list[ContactResearchResult] = Field(default_factory=list)


class CompanyResearchResult(BaseModel):
    model_config = STRICT

    description: str | None = None
    company_type: list[CompanyType] = Field(default_factory=list)
    main_products: list[ProductCategory] = Field(default_factory=list)
    brands: list[str] = Field(default_factory=list)
    social_accounts: list[SocialProfileResult] = Field(default_factory=list)
    buying_signals: list[BuyingSignalResult] = Field(default_factory=list)
    contacts: list[ContactResearchResult] = Field(default_factory=list)
    evidence: list[EvidenceClaimResult] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class ProductResearchResult(BaseModel):
    model_config = STRICT

    product_name: str
    category: ProductCategory = ProductCategory.OTHER
    brand: str | None = None
    description: str | None = None
    url: str | None = None
    evidence: list[EvidenceClaimResult] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class ProductListResult(BaseModel):
    model_config = STRICT

    products: list[ProductResearchResult] = Field(default_factory=list)


class SocialResearchResult(BaseModel):
    model_config = STRICT

    accounts: list[SocialProfileResult] = Field(default_factory=list)
    evidence: list[EvidenceClaimResult] = Field(default_factory=list)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class LeadScoreResult(BaseModel):
    model_config = STRICT

    product_fit: float = Field(default=0.0, ge=0.0, le=100.0)
    company_fit: float = Field(default=0.0, ge=0.0, le=100.0)
    market_fit: float = Field(default=0.0, ge=0.0, le=100.0)
    purchasing_potential: float = Field(default=0.0, ge=0.0, le=100.0)
    contact_quality: float = Field(default=0.0, ge=0.0, le=100.0)
    growth_signals: float = Field(default=0.0, ge=0.0, le=100.0)
    total_score: float = Field(default=0.0, ge=0.0, le=100.0)
    grade: str | None = None
    summary: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
