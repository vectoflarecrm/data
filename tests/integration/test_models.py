from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from app.core.enums import (
    BrandRelationship,
    MethodType,
    Platform,
    ProductCategory,
    PurchasingRole,
    ResearchStatus,
    RoleType,
    SourceType,
    TaskStatus,
    TaskType,
)
from app.db.models import (
    Brand,
    Company,
    CompanyBrand,
    CompanyEvent,
    Contact,
    ContactMethod,
    LeadScore,
    Product,
    ResearchEvidence,
    ResearchTask,
    SocialAccount,
)


@pytest.mark.asyncio
async def test_company_crud_and_unique_domain(session) -> None:
    company = Company(
        company_name="Aqua Marina",
        website="https://www.aqua-marina.io",
        normalized_domain="aqua-marina.io",
        country="Germany",
        country_code="DE",
        company_type=["DISTRIBUTOR", "IMPORTER"],
        target_markets=["Germany", "Austria"],
    )
    session.add(company)
    await session.flush()

    result = await session.execute(
        select(Company).where(Company.normalized_domain == "aqua-marina.io")
    )
    fetched = result.scalar_one()
    assert fetched.company_name == "Aqua Marina"
    assert "DISTRIBUTOR" in fetched.company_type
    assert fetched.research_status == ResearchStatus.NEW

    session.add(Company(company_name="Duplicate", normalized_domain="aqua-marina.io"))
    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()


@pytest.mark.asyncio
async def test_company_contact_method_social_relationship(session) -> None:
    company = Company(company_name="Blue Water Sports", normalized_domain="bluewater.io")
    session.add(company)
    await session.flush()

    contact = Contact(
        company_id=company.id,
        first_name="Anna",
        last_name="Müller",
        full_name="Anna Müller",
        job_title="Purchasing Manager",
        role_type=RoleType.PURCHASING_MANAGER,
        purchasing_role=PurchasingRole.DECISION_MAKER,
    )
    session.add(contact)
    await session.flush()

    email = ContactMethod(
        contact_id=contact.id,
        company_id=company.id,
        method_type=MethodType.EMAIL,
        value="anna@bluewater.io",
        normalized_value="anna@bluewater.io",
        is_primary=True,
    )
    session.add(email)

    social = SocialAccount(
        company_id=company.id,
        contact_id=contact.id,
        platform=Platform.LINKEDIN,
        profile_url="https://www.linkedin.com/in/anna-mueller",
        username="anna-mueller",
        business_or_personal="BUSINESS",
    )
    session.add(social)
    await session.flush()

    result = await session.execute(
        select(Contact)
        .where(Contact.company_id == company.id)
        .options(selectinload(Contact.methods), selectinload(Contact.social_accounts))
    )
    fetched = result.scalar_one()
    assert fetched.methods[0].value == "anna@bluewater.io"
    assert fetched.social_accounts[0].platform == Platform.LINKEDIN
    assert fetched.full_name == "Anna Müller"


@pytest.mark.asyncio
async def test_cross_company_contact_references_are_rejected(session) -> None:
    first = Company(company_name="First Co", normalized_domain="first.example")
    second = Company(company_name="Second Co", normalized_domain="second.example")
    session.add_all([first, second])
    await session.flush()
    contact = Contact(company_id=first.id, full_name="First Contact")
    session.add(contact)
    await session.flush()

    session.add(
        ContactMethod(
            contact_id=contact.id,
            company_id=second.id,
            method_type=MethodType.EMAIL,
            value="contact@example.com",
            normalized_value="contact@example.com",
        )
    )
    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()


@pytest.mark.asyncio
async def test_company_brand_relationship(session) -> None:
    company = Company(company_name="Bay Distributors", normalized_domain="baydist.io")
    brand = Brand(name="Aquafarer")
    session.add_all([company, brand])
    await session.flush()

    link = CompanyBrand(
        company_id=company.id,
        brand_id=brand.id,
        relationship_type=BrandRelationship.DISTRIBUTOR,
    )
    session.add(link)
    await session.flush()

    result = await session.execute(
        select(Brand).where(Brand.name == "Aquafarer").options(selectinload(Brand.company_links))
    )
    fetched = result.scalar_one()
    assert fetched.company_links[0].company_id == company.id

    session.add(
        CompanyBrand(
            company_id=company.id,
            brand_id=brand.id,
            relationship_type=BrandRelationship.DISTRIBUTOR,
        )
    )
    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()


@pytest.mark.asyncio
async def test_product_and_evidence(session) -> None:
    product = Product(name="Touring Inflatable SUP", category=ProductCategory.TOURING_SUP)
    session.add(product)
    await session.flush()

    company = Company(company_name="Paddle House", normalized_domain="paddlehouse.io")
    session.add(company)
    await session.flush()

    evidence = ResearchEvidence(
        company_id=company.id,
        field_name="website",
        value="https://paddlehouse.io",
        source_url="https://paddlehouse.io",
        source_domain="paddlehouse.io",
        source_type=SourceType.OFFICIAL_WEBSITE,
        evidence_text="Official site",
        content_hash="abc123",
    )
    session.add(evidence)
    await session.flush()

    dup = ResearchEvidence(
        company_id=company.id,
        field_name="website",
        value="https://paddlehouse.io",
        content_hash="abc123",
        source_type=SourceType.OFFICIAL_WEBSITE,
    )
    session.add(dup)
    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()


@pytest.mark.asyncio
async def test_research_task_and_lead_score(session) -> None:
    company = Company(company_name="Current Marine", normalized_domain="current.io")
    session.add(company)
    await session.flush()

    task = ResearchTask(
        company_id=company.id,
        task_type=TaskType.COMPANY_RESEARCH,
        priority=80,
        status=TaskStatus.PENDING,
    )
    session.add(task)
    await session.flush()

    score = LeadScore(company_id=company.id, total_score=93.5, grade="A+")
    session.add(score)
    await session.flush()

    result = await session.execute(select(ResearchTask).where(ResearchTask.id == task.id))
    assert result.scalar_one().company_id == company.id

    session.add(LeadScore(company_id=company.id, total_score=10))
    with pytest.raises(IntegrityError):
        await session.flush()
    await session.rollback()


@pytest.mark.asyncio
async def test_event_and_cascade_delete(session) -> None:
    company = Company(company_name="Tide Outdoor", normalized_domain="tideout.io")
    session.add(company)
    await session.flush()
    contact = Contact(company_id=company.id, full_name="Jonas Berg")
    session.add(contact)
    await session.flush()
    session.add(
        CompanyEvent(
            company_id=company.id,
            event_type="EXPANSION",
            title="New warehouse",
            description="Opened a new distribution warehouse",
        )
    )
    await session.flush()

    await session.delete(company)
    await session.flush()

    count = await session.execute(select(Contact.id).where(Contact.id == contact.id))
    assert count.scalar() is None
