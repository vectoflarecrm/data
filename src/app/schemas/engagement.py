from __future__ import annotations

import uuid
from datetime import date, datetime

from app.core.enums import (
    BrandRelationship,
    EventType,
    Importance,
    ProductCategory,
)
from app.schemas.common import ORMModel


class ProductCreate(ORMModel):
    name: str
    category: ProductCategory | None = None
    subcategory: str | None = None
    description: str | None = None


class ProductRead(ORMModel):
    id: uuid.UUID
    name: str
    category: ProductCategory | None
    subcategory: str | None
    description: str | None
    created_at: datetime
    updated_at: datetime | None


class BrandCreate(ORMModel):
    name: str
    website: str | None = None


class BrandRead(ORMModel):
    id: uuid.UUID
    name: str
    website: str | None
    created_at: datetime
    updated_at: datetime | None


class CompanyBrandCreate(ORMModel):
    brand_id: uuid.UUID
    relationship_type: BrandRelationship = BrandRelationship.DISTRIBUTOR
    source_evidence_id: uuid.UUID | None = None


class CompanyBrandRead(ORMModel):
    id: uuid.UUID
    company_id: uuid.UUID
    brand_id: uuid.UUID
    brand_name: str | None = None
    relationship_type: BrandRelationship
    created_at: datetime


class EventCreate(ORMModel):
    event_type: EventType
    event_date: date | None = None
    title: str | None = None
    description: str | None = None
    importance: Importance = Importance.MEDIUM
    source_evidence_id: uuid.UUID | None = None


class EventRead(ORMModel):
    id: uuid.UUID
    company_id: uuid.UUID
    event_type: EventType
    event_date: date | None
    title: str | None
    description: str | None
    importance: Importance
    created_at: datetime
