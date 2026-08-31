from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    BusinessOrPersonal,
    EventType,
    EvidenceConfidence,
    Importance,
    MethodType,
    Platform,
    PurchasingRole,
    SourceType,
    VerificationStatus,
)
from app.db.models import Company
from app.enrichment.evidence import EvidenceRecorder
from app.enrichment.recorders import (
    BrandRecorder,
    ContactMethodRecorder,
    ContactRecorder,
    EventRecorder,
    SocialRecorder,
)
from app.enrichment.scoring import describe_company, lead_score_result, score_company


async def _add_company(session: AsyncSession, name: str, **kw) -> Company:
    kw.setdefault("company_type", [])
    kw.setdefault("target_markets", [])
    company = Company(company_name=name, **kw)
    session.add(company)
    await session.flush()
    return company


async def _rich_contacts(session: AsyncSession, company: Company, name: str = "Jane Buyer") -> None:
    contact = await ContactRecorder(session).upsert(
        company_id=company.id,
        full_name=name,
        job_title="Head of Purchasing",
        role=PurchasingRole.BUYER,
        confidence=0.9,
    )
    slug = name.replace(" ", "-").lower()
    await ContactMethodRecorder(session).upsert(
        contact_id=contact.id,
        company_id=company.id,
        method=MethodType.EMAIL,
        value=f"{slug}@example-buyer.io",
        verification=VerificationStatus.VERIFIED,
        confidence=0.95,
    )
    await ContactMethodRecorder(session).upsert(
        contact_id=contact.id,
        company_id=company.id,
        method=MethodType.PHONE,
        value="+49 40 555 0100",
        verification=VerificationStatus.VERIFIED,
        confidence=0.8,
    )
    await SocialRecorder(session).upsert(
        company_id=company.id,
        contact_id=contact.id,
        platform=Platform.LINKEDIN,
        profile_url=f"https://www.linkedin.com/in/{slug}",
        display_name=name,
        business_or_personal=BusinessOrPersonal.BUSINESS,
        verification=VerificationStatus.VERIFIED,
        confidence=0.9,
    )


async def _products(session: AsyncSession, company: Company, count: int) -> None:
    evidence = EvidenceRecorder(session)
    for i in range(count):
        await evidence.record(
            company_id=company.id,
            field_name="product.SUP",
            value=f"Aqua SUP {i}",
            source_type=SourceType.OFFICIAL_PRODUCT_PAGE,
            extraction_method="ai",
            confidence=EvidenceConfidence.HIGH,
        )


async def _buying_signals(session: AsyncSession, company: Company) -> None:
    evidence = EvidenceRecorder(session)
    row = await evidence.record(
        company_id=company.id,
        field_name="buying_signal.TRADE_SHOW",
        value="trade show participation",
        source_type=SourceType.OFFICIAL_WEBSITE,
        extraction_method="rules",
        confidence=EvidenceConfidence.MEDIUM,
    )
    await EventRecorder(session).record(
        company_id=company.id,
        event_type=EventType.TRADE_SHOW,
        title="Trade show booth 2026",
        description="Annual trade show participation",
        importance=Importance.MEDIUM,
        evidence_id=row.id if row else None,
        event_date=date.today() - timedelta(days=7),
    )


async def test_excellent_lead(session: AsyncSession) -> None:
    company = await _add_company(
        session,
        "Aqua Trade GmbH",
        website="https://aquatrade.io",
        normalized_domain="aquatrade.io",
        country="Germany",
        country_code="DE",
        description="B2B distributor and manufacturer",
        industry="Watersports",
        company_type=["MANUFACTURER", "DISTRIBUTOR"],
        target_markets=["DE", "AT", "CH"],
        manufacturer=True,
        distributor=True,
        main_products_summary="SUP, KAYAK, PUMP, LIFE_JACKET",
    )
    company.last_researched_at = datetime.now(UTC)
    await _products(session, company, 6)
    await _buying_signals(session, company)
    await _rich_contacts(session, company)
    await _rich_contacts(session, company, "Mark Smith")
    await BrandRecorder(session).link(company_id=company.id, brand_name="AquaBrand")

    components = await describe_company(session, company)
    result = lead_score_result(components)
    assert result["product_fit"] >= 75
    assert result["company_fit"] == 100
    assert result["market_fit"] >= 90
    assert result["contact_quality"] >= 70
    assert result["purchasing_potential"] >= 70
    assert result["total_score"] >= 75
    assert result["grade"] in ("A+", "A", "B")


async def test_poor_lead(session: AsyncSession) -> None:
    company = await _add_company(session, "Unknown Co")
    components = await describe_company(session, company)
    result = lead_score_result(components)
    assert result["total_score"] <= 25
    assert result["grade"] == "F"


async def test_high_potential_but_incomplete(session: AsyncSession) -> None:
    company = await _add_company(
        session,
        "Products Ltd",
        website="https://productsltd.io",
        normalized_domain="productsltd.io",
        country_code="NL",
        country="Netherlands",
        description="Runs broad product catalog",
        company_type=["DISTRIBUTOR"],
        distributor=True,
        main_products_summary="SUP, KAYAK, RIB",
        last_researched_at=datetime.now(UTC),
    )
    await _products(session, company, 8)

    components = await describe_company(session, company)
    result = lead_score_result(components)
    assert result["product_fit"] >= 90
    assert result["purchasing_potential"] <= 30
    assert result["contact_quality"] <= 30
    assert result["data_completeness"] < 70


async def test_complete_but_low_potential(session: AsyncSession) -> None:
    company = await _add_company(
        session,
        "Rental Services US",
        website="https://rentalservices.us",
        normalized_domain="rentalservices.us",
        country="United States",
        country_code="US",
        description="Full service provider",
        company_type=["SERVICE_PROVIDER"],
        main_products_summary="",
        last_researched_at=datetime.now(UTC),
    )
    await _rich_contacts(session, company)

    components = await describe_company(session, company)
    result = lead_score_result(components)
    assert result["contact_quality"] >= 40
    assert result["product_fit"] <= 20
    assert result["company_fit"] <= 40


async def test_score_company_persists_row(session: AsyncSession) -> None:
    company = await _add_company(
        session, "Scored Co", company_type=["DISTRIBUTOR"], distributor=True
    )
    lead = await score_company(session, company)
    await session.flush()

    from app.enrichment.scoring import target_priority_hours

    assert lead.company_id == company.id
    assert lead.total_score == company.lead_score
    assert lead.grade in ("A", "B", "C", "D", "F")
    assert target_priority_hours(lead) >= 14 * 24
    assert company.next_research_at is not None
    # Scoring again upserts, not duplicates.
    lead2 = await score_company(session, company)
    await session.flush()
    assert lead2.id == lead.id
