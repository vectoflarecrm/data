from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import CompanyStatus, ProductCategory, ResearchStatus
from app.db.models import (
    AIContext,
    Brand,
    Company,
    CompanyBrand,
    CompanyEvent,
    CompanyProduct,
    Contact,
    ContactMethod,
    LeadScore,
    Product,
    ResearchEvidence,
    SocialAccount,
)
from app.repositories.base import BaseRepository
from app.schemas.common import Page, to_page

# SQLAlchemy ORM models are converted to Pydantic schemas at the API boundary.
PageResult = Page[Any]


class CompanyRepository(BaseRepository[Company]):
    model = Company

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session)

    async def get_by_domain(self, normalized_domain: str) -> Company | None:
        query = select(Company).where(Company.normalized_domain == normalized_domain)
        return (await self.session.execute(query)).scalar_one_or_none()

    async def list_filtered(
        self,
        *,
        query: str | None = None,
        country_code: str | None = None,
        country: str | None = None,
        company_status: CompanyStatus | None = None,
        research_status: ResearchStatus | None = None,
        is_type: str | None = None,
        product_category: ProductCategory | None = None,
        min_lead_score: float | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> Page[Any]:
        filters: list[ColumnElement[bool]] = []
        if query:
            like = f"%{query.lower()}%"
            filters.append(
                or_(
                    func.lower(Company.company_name).like(like),
                    func.lower(Company.normalized_domain).like(like),
                )
            )
        if country_code:
            filters.append(Company.country_code == country_code.upper())
        if country:
            filters.append(Company.country.ilike(country))
        if company_status:
            filters.append(Company.company_status == company_status)
        if research_status:
            filters.append(Company.research_status == research_status)
        if is_type:
            filters.append(Company.company_type.any(is_type))  # type: ignore[arg-type, union-attr]
        if product_category is not None:
            filters.append(
                Company.id.in_(
                    select(CompanyProduct.company_id)
                    .join(Product, Product.id == CompanyProduct.product_id)
                    .where(Product.category == product_category)
                )
            )
        if min_lead_score is not None:
            filters.append(Company.lead_score >= min_lead_score)
        return await self.list_paginated(
            page=page,
            page_size=page_size,
            order_by=Company.company_name,
            filters=filters,
        )

    async def get_with_details(self, company_id: uuid.UUID) -> Company | None:
        query = (
            select(Company)
            .where(Company.id == company_id)
            .options(
                selectinload(Company.contacts).selectinload(Contact.methods),
                selectinload(Company.contacts).selectinload(Contact.social_accounts),
                selectinload(Company.social_accounts),
                selectinload(Company.brands).selectinload(CompanyBrand.brand),
                selectinload(Company.events),
                selectinload(Company.evidence),
            )
        )
        return (await self.session.execute(query)).scalar_one_or_none()

    async def list_contacts(
        self, company_id: uuid.UUID, page: int = 1, page_size: int = 50
    ) -> Page[Any]:
        filters = [Contact.company_id == company_id]
        total = (
            await self.session.execute(select(func.count()).select_from(Contact).where(*filters))
        ).scalar_one()
        result = await self.session.execute(
            select(Contact)
            .where(*filters)
            .options(selectinload(Contact.methods), selectinload(Contact.social_accounts))
            .order_by(Contact.full_name)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        items = list(result.scalars().unique().all())
        return to_page(items, total, page, page_size)

    async def list_social(
        self, company_id: uuid.UUID, page: int = 1, page_size: int = 50
    ) -> Page[Any]:
        return await self.list_paginated(
            page=page,
            page_size=page_size,
            order_by=SocialAccount.platform,
            filters=[SocialAccount.company_id == company_id],
            model=SocialAccount,
        )

    async def list_brands(
        self, company_id: uuid.UUID, page: int = 1, page_size: int = 50
    ) -> Page[Any]:
        query = (
            select(CompanyBrand)
            .where(CompanyBrand.company_id == company_id)
            .options(selectinload(CompanyBrand.brand))
            .order_by(CompanyBrand.relationship_type)
        )
        total = (
            await self.session.execute(
                select(func.count())
                .select_from(CompanyBrand)
                .where(CompanyBrand.company_id == company_id)
            )
        ).scalar_one()
        result = await self.session.execute(query.offset((page - 1) * page_size).limit(page_size))
        items = list(result.scalars().unique().all())
        return to_page(items, total, page, page_size)

    async def list_evidence(
        self, company_id: uuid.UUID, page: int = 1, page_size: int = 50
    ) -> Page[Any]:
        return await self.list_paginated(
            page=page,
            page_size=page_size,
            order_by=ResearchEvidence.discovered_at.desc(),
            filters=[ResearchEvidence.company_id == company_id],
            model=ResearchEvidence,
        )

    async def list_events(
        self, company_id: uuid.UUID, page: int = 1, page_size: int = 50
    ) -> Page[Any]:
        return await self.list_paginated(
            page=page,
            page_size=page_size,
            order_by=CompanyEvent.event_date.desc(),
            filters=[CompanyEvent.company_id == company_id],
            model=CompanyEvent,
        )

    async def get_score(self, company_id: uuid.UUID) -> LeadScore | None:
        query = select(LeadScore).where(LeadScore.company_id == company_id)
        return (await self.session.execute(query)).scalar_one_or_none()

    async def export_all(self) -> list[Company]:
        result = await self.session.execute(
            select(Company).options(
                selectinload(Company.contacts),
                selectinload(Company.contact_methods),
                selectinload(Company.social_accounts),
                selectinload(Company.brands).selectinload(CompanyBrand.brand),
            )
        )
        return list(result.scalars().unique().all())


class ContactRepository(BaseRepository[Contact]):
    model = Contact


class ContactMethodRepository(BaseRepository[ContactMethod]):
    model = ContactMethod


class SocialAccountRepository(BaseRepository[SocialAccount]):
    model = SocialAccount


class BrandRepository(BaseRepository[Brand]):
    model = Brand

    async def get_by_name(self, name: str) -> Brand | None:
        query = select(Brand).where(func.lower(Brand.name) == name.lower())
        return (await self.session.execute(query)).scalar_one_or_none()


class CompanyBrandRepository(BaseRepository[CompanyBrand]):
    model = CompanyBrand


class EventRepository(BaseRepository[CompanyEvent]):
    model = CompanyEvent


class ProductRepository(BaseRepository[Product]):
    model = Product


class EvidenceRepository(BaseRepository[ResearchEvidence]):
    model = ResearchEvidence

    async def get_by_hash(self, content_hash: str) -> ResearchEvidence | None:
        query = select(ResearchEvidence).where(ResearchEvidence.content_hash == content_hash)
        return (await self.session.execute(query)).scalar_one_or_none()


class ScoreRepository(BaseRepository[LeadScore]):
    model = LeadScore

    async def get_by_company(self, company_id: uuid.UUID) -> LeadScore | None:
        query = select(LeadScore).where(LeadScore.company_id == company_id)
        return (await self.session.execute(query)).scalar_one_or_none()


class AIContextRepository(BaseRepository[AIContext]):
    model = AIContext

    async def list_by_company(self, company_id: uuid.UUID) -> list[AIContext]:
        query = (
            select(AIContext)
            .where(AIContext.company_id == company_id)
            .order_by(AIContext.context_type, AIContext.contact_id)
        )
        return list((await self.session.execute(query)).scalars().all())

    def _scoped(
        self, company_id: uuid.UUID, context_type: str, contact_id: uuid.UUID | None = None
    ):
        query = select(AIContext).where(
            AIContext.company_id == company_id,
            AIContext.context_type == context_type,
        )
        if contact_id is None:
            query = query.where(AIContext.contact_id.is_(None))
        else:
            query = query.where(AIContext.contact_id == contact_id)
        return query

    async def get_scope(
        self, company_id: uuid.UUID, context_type: str, contact_id: uuid.UUID | None = None
    ) -> AIContext | None:
        return (
            await self.session.execute(self._scoped(company_id, context_type, contact_id))
        ).scalar_one_or_none()

    async def replace(
        self,
        company_id: uuid.UUID,
        context_type: str,
        content: str,
        contact_id: uuid.UUID | None = None,
    ) -> AIContext:
        """Regenerable context: remove any prior row for the scope, then write a fresh one."""
        for existing in (
            await self.session.execute(self._scoped(company_id, context_type, contact_id))
        ).scalars():
            await self.session.delete(existing)
        await self.session.flush()
        row = AIContext(
            company_id=company_id, context_type=context_type, contact_id=contact_id, content=content
        )
        self.session.add(row)
        await self.session.flush()
        return row
