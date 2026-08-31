from __future__ import annotations

import uuid
from typing import Any, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import select

from app.api.dependencies import DbSession, get_company_or_404
from app.core.enums import CompanyStatus, ProductCategory, ResearchStatus
from app.core.normalization import is_valid_url, normalize_domain
from app.db.models import CompanyBrand, CompanyProduct, Product
from app.repositories.company import (
    AIContextRepository,
    CompanyBrandRepository,
    CompanyRepository,
    ContactMethodRepository,
    ContactRepository,
    EventRepository,
    EvidenceRepository,
    ProductRepository,
    ScoreRepository,
    SocialAccountRepository,
)
from app.schemas.ai import AIContextRead, ContextRebuildRequest
from app.schemas.common import Page
from app.schemas.company import CompanyCreate, CompanyRead, CompanyUpdate
from app.schemas.contact import (
    ContactCreate,
    ContactMethodCreate,
    ContactMethodRead,
    ContactRead,
    ContactUpdate,
    SocialAccountCreate,
    SocialAccountRead,
)
from app.schemas.engagement import (
    CompanyBrandCreate,
    CompanyBrandRead,
    EventCreate,
    EventRead,
    ProductCreate,
    ProductRead,
)
from app.schemas.evidence import EvidenceCreate, EvidenceRead, LeadScoreRead

router = APIRouter(prefix="/companies", tags=["companies"])

T = TypeVar("T")


def _to_page(page_data: Page, mapper) -> Page:
    return Page[Any](
        items=[mapper(item) for item in page_data.items],
        total=page_data.total,
        page=page_data.page,
        page_size=page_data.page_size,
        pages=page_data.pages,
    )


@router.get("", response_model=Page[CompanyRead])
async def list_companies(
    session: DbSession,
    q: str | None = None,
    country_code: str | None = None,
    country: str | None = None,
    status_filter: CompanyStatus | None = Query(default=None, alias="status"),
    research_status: ResearchStatus | None = None,
    is_type: str | None = None,
    product_category: ProductCategory | None = None,
    min_lead_score: float | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
) -> Page[CompanyRead]:
    result = await CompanyRepository(session).list_filtered(
        query=q,
        country_code=country_code,
        country=country,
        company_status=status_filter,
        research_status=research_status,
        is_type=is_type,
        product_category=product_category,
        min_lead_score=min_lead_score,
        page=page,
        page_size=page_size,
    )
    return _to_page(result, CompanyRead.model_validate)


@router.post("", response_model=CompanyRead, status_code=status.HTTP_201_CREATED)
async def create_company(payload: CompanyCreate, session: DbSession) -> CompanyRead:
    repo = CompanyRepository(session)
    if payload.website and not is_valid_url(payload.website):
        raise HTTPException(status_code=422, detail="Invalid website URL")
    data = payload.model_dump()
    if not data.get("normalized_domain") and data.get("website"):
        data["normalized_domain"] = normalize_domain(data["website"])
    company = await repo.create(**data)
    return CompanyRead.model_validate(company)


@router.get("/{company_id}", response_model=CompanyRead)
async def get_company(
    session: DbSession, company_id: uuid.UUID = Depends(get_company_or_404)
) -> CompanyRead:
    company = await CompanyRepository(session).get(company_id)
    return CompanyRead.model_validate(company)


@router.patch("/{company_id}", response_model=CompanyRead)
async def update_company(
    payload: CompanyUpdate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> CompanyRead:
    repo = CompanyRepository(session)
    company = await repo.get(company_id)
    if company is None:
        raise HTTPException(status_code=404, detail="Company not found")
    data = payload.model_dump(exclude_unset=True)
    if "website" in data and data["website"]:
        data["normalized_domain"] = normalize_domain(data["website"])
    company = await repo.update(company, **data)
    return CompanyRead.model_validate(company)


@router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_company(
    session: DbSession, company_id: uuid.UUID = Depends(get_company_or_404)
) -> None:
    company = await CompanyRepository(session).get(company_id)
    await session.delete(company)
    await session.flush()


@router.get("/{company_id}/contacts", response_model=Page[ContactRead])
async def list_company_contacts(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    page: int = 1,
    page_size: int = Query(50, ge=1, le=200),
) -> Page[ContactRead]:
    result = await CompanyRepository(session).list_contacts(company_id, page, page_size)
    return _to_page(result, ContactRead.model_validate)


@router.post(
    "/{company_id}/contacts",
    response_model=ContactRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_company_contact(
    payload: ContactCreate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> ContactRead:
    contact = await ContactRepository(session).create(company_id=company_id, **payload.model_dump())
    return ContactRead.model_validate(contact)


@router.patch("/{company_id}/contacts/{contact_id}", response_model=ContactRead)
async def update_contact(
    payload: ContactUpdate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    contact_id: uuid.UUID = Path(...),
) -> ContactRead:
    repo = ContactRepository(session)
    contact = await repo.get(contact_id)
    if contact is None or contact.company_id != company_id:
        raise HTTPException(status_code=404, detail="Contact not found")
    contact = await repo.update(contact, **payload.model_dump(exclude_unset=True))
    return ContactRead.model_validate(contact)


@router.post(
    "/{company_id}/contacts/{contact_id}/methods",
    response_model=ContactMethodRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_contact_method(
    payload: ContactMethodCreate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    contact_id: uuid.UUID = Path(...),
) -> ContactMethodRead:
    data = payload.model_dump()
    if data.get("verification_status") == "INFERRED" and data.get("confidence") is None:
        data["confidence"] = 0.2
    data["normalized_value"] = data.get("normalized_value") or data.get("value")
    method = await ContactMethodRepository(session).create(
        contact_id=contact_id, company_id=company_id, **data
    )
    return ContactMethodRead.model_validate(method)


@router.post(
    "/{company_id}/contacts/{contact_id}/social",
    response_model=SocialAccountRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_contact_social(
    payload: SocialAccountCreate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    contact_id: uuid.UUID = Path(...),
) -> SocialAccountRead:
    account = await SocialAccountRepository(session).create(
        company_id=company_id, contact_id=contact_id, **payload.model_dump()
    )
    return SocialAccountRead.model_validate(account)


@router.get("/{company_id}/products", response_model=Page[ProductRead])
async def list_company_products(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    category: ProductCategory | None = None,
    page: int = 1,
    page_size: int = Query(50, ge=1, le=200),
) -> Page[ProductRead]:
    filters: list[Any] = []
    if category:
        filters.append(Product.category == category)
    filters.append(Product.id.in_(select(CompanyProduct.product_id).where(CompanyProduct.company_id == company_id)))
    result = await ProductRepository(session).list_paginated(
        page=page, page_size=page_size, order_by=Product.name, filters=filters
    )
    return _to_page(result, ProductRead.model_validate)


@router.post(
    "/{company_id}/products",
    response_model=ProductRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_product(payload: ProductCreate, session: DbSession) -> ProductRead:
    product = await ProductRepository(session).create(**payload.model_dump())
    return ProductRead.model_validate(product)


def _company_brand_read(cb: CompanyBrand) -> CompanyBrandRead:
    data = CompanyBrandRead.model_validate(cb).model_dump()
    data["brand_name"] = cb.brand.name if cb.brand else None
    return CompanyBrandRead(**data)


@router.get("/{company_id}/brands", response_model=Page[CompanyBrandRead])
async def list_company_brands(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    page: int = 1,
    page_size: int = Query(50, ge=1, le=200),
) -> Page[CompanyBrandRead]:
    result = await CompanyRepository(session).list_brands(company_id, page, page_size)
    return _to_page(result, _company_brand_read)


@router.post(
    "/{company_id}/brands",
    response_model=CompanyBrandRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_company_brand(
    payload: CompanyBrandCreate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> CompanyBrandRead:
    link = await CompanyBrandRepository(session).create(
        company_id=company_id, **payload.model_dump()
    )
    return _company_brand_read(link)


@router.get("/{company_id}/social", response_model=Page[SocialAccountRead])
async def list_company_social(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    page: int = 1,
    page_size: int = Query(50, ge=1, le=200),
) -> Page[SocialAccountRead]:
    result = await CompanyRepository(session).list_social(company_id, page, page_size)
    return _to_page(result, SocialAccountRead.model_validate)


@router.post(
    "/{company_id}/social",
    response_model=SocialAccountRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_company_social(
    payload: SocialAccountCreate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> SocialAccountRead:
    account = await SocialAccountRepository(session).create(
        company_id=company_id, **payload.model_dump()
    )
    return SocialAccountRead.model_validate(account)


@router.get("/{company_id}/evidence", response_model=Page[EvidenceRead])
async def list_company_evidence(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    page: int = 1,
    page_size: int = Query(50, ge=1, le=200),
) -> Page[EvidenceRead]:
    result = await CompanyRepository(session).list_evidence(company_id, page, page_size)
    return _to_page(result, EvidenceRead.model_validate)


@router.post(
    "/{company_id}/evidence",
    response_model=EvidenceRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_company_evidence(
    payload: EvidenceCreate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> EvidenceRead:
    repo = EvidenceRepository(session)
    if payload.content_hash:
        existing = await repo.get_by_hash(payload.content_hash)
        if existing:
            return EvidenceRead.model_validate(existing)
    data = payload.model_dump()
    if data.get("source_url"):
        data["source_domain"] = data.get("source_domain") or normalize_domain(data["source_url"])
    evidence = await repo.create(company_id=company_id, **data)
    return EvidenceRead.model_validate(evidence)


@router.get("/{company_id}/events", response_model=Page[EventRead])
async def list_company_events(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
    page: int = 1,
    page_size: int = Query(50, ge=1, le=200),
) -> Page[EventRead]:
    result = await CompanyRepository(session).list_events(company_id, page, page_size)
    return _to_page(result, EventRead.model_validate)


@router.post(
    "/{company_id}/events",
    response_model=EventRead,
    status_code=status.HTTP_201_CREATED,
)
async def add_company_event(
    payload: EventCreate,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> EventRead:
    event = await EventRepository(session).create(company_id=company_id, **payload.model_dump())
    return EventRead.model_validate(event)


@router.get("/{company_id}/score", response_model=LeadScoreRead | None)
async def get_company_score(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> LeadScoreRead | None:
    score = await ScoreRepository(session).get_by_company(company_id)
    if score is None:
        return None
    return LeadScoreRead.model_validate(score)


@router.get("/{company_id}/context", response_model=list[AIContextRead])
async def list_company_context(
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> list[AIContextRead]:
    rows = await AIContextRepository(session).list_by_company(company_id)
    return [AIContextRead.model_validate(row) for row in rows]


@router.post("/{company_id}/context/rebuild", response_model=list[AIContextRead])
async def rebuild_company_context(
    payload: ContextRebuildRequest,
    session: DbSession,
    company_id: uuid.UUID = Depends(get_company_or_404),
) -> list[AIContextRead]:
    from app.enrichment.ai_context import generate_company_contexts
    from app.repositories.company import CompanyRepository

    company = await CompanyRepository(session).get(company_id)
    if company is None:
        raise HTTPException(status_code=404, detail="Company not found")
    rows = await generate_company_contexts(session, company, use_ai=payload.ai)
    if payload.context_type:
        rows = [row for row in rows if row.context_type == payload.context_type]
    return [AIContextRead.model_validate(row) for row in rows]
