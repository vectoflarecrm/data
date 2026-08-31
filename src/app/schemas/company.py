from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import Field

from app.core.enums import (
    CompanyStatus,
    CompanyType,
    ResearchLevel,
    ResearchStatus,
)
from app.schemas.common import ORMModel


class CompanyCreate(ORMModel):
    company_name: str
    legal_name: str | None = None
    trading_name: str | None = None
    website: str | None = None
    normalized_domain: str | None = None
    country: str | None = None
    country_code: str | None = None
    region: str | None = None
    city: str | None = None
    address: str | None = None
    postal_code: str | None = None
    industry: str | None = None
    company_type: list[CompanyType] | None = None
    business_model: str | None = None
    founded_year: int | None = Field(default=None, ge=1400, le=2100)
    employee_range: str | None = None
    description: str | None = None
    main_products_summary: str | None = None
    target_markets: list[str] | None = None
    manufacturer: bool = False
    importer: bool = False
    distributor: bool = False
    wholesaler: bool = False
    retailer: bool = False
    ecommerce: bool = False
    rental: bool = False
    oem: bool = False
    company_status: CompanyStatus = CompanyStatus.UNKNOWN
    research_status: ResearchStatus = ResearchStatus.NEW
    research_level: ResearchLevel = ResearchLevel.L0


class CompanyUpdate(ORMModel):
    company_name: str | None = None
    legal_name: str | None = None
    trading_name: str | None = None
    website: str | None = None
    normalized_domain: str | None = None
    country: str | None = None
    country_code: str | None = None
    region: str | None = None
    city: str | None = None
    address: str | None = None
    postal_code: str | None = None
    industry: str | None = None
    company_type: list[CompanyType] | None = None
    business_model: str | None = None
    founded_year: int | None = None
    employee_range: str | None = None
    description: str | None = None
    main_products_summary: str | None = None
    target_markets: list[str] | None = None
    manufacturer: bool | None = None
    importer: bool | None = None
    distributor: bool | None = None
    wholesaler: bool | None = None
    retailer: bool | None = None
    ecommerce: bool | None = None
    rental: bool | None = None
    oem: bool | None = None
    company_status: CompanyStatus | None = None
    research_status: ResearchStatus | None = None
    research_level: ResearchLevel | None = None


class CompanyRead(ORMModel):
    id: uuid.UUID
    company_name: str
    legal_name: str | None
    trading_name: str | None
    website: str | None
    normalized_domain: str | None
    country: str | None
    country_code: str | None
    region: str | None
    city: str | None
    address: str | None
    postal_code: str | None
    industry: str | None
    company_type: list[CompanyType] | None
    business_model: str | None
    founded_year: int | None
    employee_range: str | None
    description: str | None
    main_products_summary: str | None
    target_markets: list[str] | None
    manufacturer: bool
    importer: bool
    distributor: bool
    wholesaler: bool
    retailer: bool
    ecommerce: bool
    rental: bool
    oem: bool
    company_status: CompanyStatus
    research_status: ResearchStatus
    research_level: ResearchLevel
    company_score: float | None
    lead_score: float | None
    created_at: datetime
    updated_at: datetime | None
    last_researched_at: datetime | None
    next_research_at: datetime | None
