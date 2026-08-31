from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.enums import (
    CompanyType,
    EvidenceConfidence,
    MethodType,
    PurchasingRole,
    VerificationStatus,
)
from app.core.time import utcnow
from app.db.models import (
    Company,
    CompanyBrand,
    CompanyEvent,
    Contact,
    ContactMethod,
    LeadScore,
    ResearchEvidence,
    SocialAccount,
)

# Company roles that make a company a researchable buyer (vs pure service provider).
_BOOST_TYPES = {
    CompanyType.MANUFACTURER,
    CompanyType.BRAND_OWNER,
    CompanyType.OEM,
    CompanyType.ODM,
    CompanyType.IMPORTER,
    CompanyType.DISTRIBUTOR,
    CompanyType.WHOLESALER,
    CompanyType.RETAILER,
    CompanyType.DEALER,
    CompanyType.RENTAL,
    CompanyType.ECOMMERCE,
}

_DECISION_ROLES = {
    PurchasingRole.DECISION_MAKER,
    PurchasingRole.BUYER,
    PurchasingRole.EXECUTIVE,
    PurchasingRole.INFLUENCER,
}

_TARGET_MARKETS = {
    "US",
    "CA",
    "MX",
    "BR",
    "AR",
    "CL",
    "GB",
    "UK",
    "IE",
    "FR",
    "DE",
    "AT",
    "CH",
    "NL",
    "BE",
    "ES",
    "PT",
    "IT",
    "SE",
    "NO",
    "DK",
    "FI",
    "PL",
    "AU",
    "NZ",
    "JP",
    "KR",
    "CN",
    "TH",
    "ID",
    "SG",
    "AE",
    "SA",
}

_GRADES = ((90, "A+"), (80, "A"), (70, "B"), (60, "C"))


def _grade(score: float) -> str:
    for threshold, grade in _GRADES:
        if score >= threshold:
            return grade
    return "F"


def _markets(company: Company) -> set[str]:
    codes = {m.strip().upper() for m in (company.target_markets or [])}
    codes |= {m.strip().upper() for m in (company.country_code or "").split(",") if m.strip()}
    codes |= {(company.country or "").strip().upper()} | {c for c in codes if c}
    return {c for c in codes if c}


async def _count(session: AsyncSession, stmt) -> int:
    return (await session.execute(stmt)).scalar_one()


async def _evidences(session: AsyncSession, company_id: uuid.UUID, field_like: str) -> list[str]:
    stmt = select(ResearchEvidence.value).where(
        ResearchEvidence.company_id == company_id,
        ResearchEvidence.field_name.like(field_like),
        ResearchEvidence.value.is_not(None),
    )
    return [value for value in (await session.execute(stmt)).scalars().all() if value is not None]


async def describe_company(session: AsyncSession, company: Company) -> dict:
    """Deterministic component scores (0-100) for one company."""
    cid = company.id

    contacts = await _count(
        session, select(func.count()).select_from(Contact).where(Contact.company_id == cid)
    )
    verified_methods = await _count(
        session,
        select(func.count())
        .select_from(ContactMethod)
        .where(
            ContactMethod.company_id == cid,
            ContactMethod.verification_status == VerificationStatus.VERIFIED,
        ),
    )
    emails = await _count(
        session,
        select(func.count())
        .select_from(ContactMethod)
        .where(ContactMethod.company_id == cid, ContactMethod.method_type == MethodType.EMAIL),
    )
    phones = await _count(
        session,
        select(func.count())
        .select_from(ContactMethod)
        .where(
            ContactMethod.company_id == cid,
            ContactMethod.method_type.in_(
                (MethodType.PHONE, MethodType.MOBILE, MethodType.WHATSAPP)
            ),
        ),
    )
    socials = await _count(
        session,
        select(func.count()).select_from(SocialAccount).where(SocialAccount.company_id == cid),
    )
    brands = await _count(
        session,
        select(func.count()).select_from(CompanyBrand).where(CompanyBrand.company_id == cid),
    )
    events = await _count(
        session,
        select(func.count()).select_from(CompanyEvent).where(CompanyEvent.company_id == cid),
    )

    decision_contacts = await _count(
        session,
        select(func.count())
        .select_from(Contact)
        .where(Contact.company_id == cid, Contact.purchasing_role.in_(_DECISION_ROLES)),
    )

    # -- product fit ------------------------------------------------------
    categories = await _evidences(session, cid, "product.%")
    summary = [s for s in (company.main_products_summary or "").split(",") if s.strip()]
    product_depth = len(categories) + len(summary)
    if product_depth >= 5:
        product_fit = 100.0
    elif product_depth:
        product_fit = 50.0 + 10.0 * min(product_depth, 5)
    elif await _evidences(session, cid, "buying_signal.%"):
        product_fit = 35.0
    else:
        product_fit = 10.0

    # -- company fit ------------------------------------------------------
    types = {CompanyType(t) for t in (company.company_type or []) if t}
    if types & _BOOST_TYPES or company.manufacturer or company.distributor or company.importer:
        company_fit = 100.0
    elif types & {CompanyType.SERVICE_PROVIDER, CompanyType.OTHER}:
        company_fit = 40.0
    else:
        company_fit = 20.0

    # -- market fit -------------------------------------------------------
    if _markets(company) & _TARGET_MARKETS:
        market_fit = 90.0
    elif company.country or company.country_code:
        market_fit = 45.0
    else:
        market_fit = 5.0

    # -- purchasing potential ----------------------------------------------
    if decision_contacts:
        potential = 70.0 + 30.0 * min(decision_contacts, 2) / 2.0
    elif contacts:
        potential = 30.0
    else:
        potential = 5.0

    # -- contact quality ---------------------------------------------------
    quality = 10.0 * min(contacts, 3) + 8.0 * min(verified_methods, 4) + 5.0 * min(emails, 4)
    quality += 4.0 * min(phones, 4) + 3.0 * min(socials, 4) + 8.0 * min(decision_contacts, 2)
    contact_quality = min(100.0, quality)

    # -- growth signals ----------------------------------------------------
    now = datetime.now(UTC)
    month_ago = now - timedelta(days=30)
    recent_events = await _count(
        session,
        select(func.count())
        .select_from(CompanyEvent)
        .where(CompanyEvent.company_id == cid, CompanyEvent.event_date >= month_ago),
    )
    signals = min(100.0, 25.0 * events + 25.0 * recent_events + 20.0)
    growth_signals = 100.0 if signals >= 100 else (signals if events else 0.0)

    # -- data completeness --------------------------------------------------
    fields = [
        bool(company.website or company.normalized_domain),
        bool(company.country or company.country_code),
        bool(company.description),
        bool(company.industry),
        bool(company.company_type),
        contacts > 0,
        emails > 0,
        phones > 0,
        socials > 0,
        brands > 0,
        product_depth > 0,
        bool(categories),
    ] + await _completeness_fields(session, cid)
    data_completeness = 100.0 * sum(fields) / max(len(fields), 1)

    # -- recent activity ----------------------------------------------------
    researched_at = company.last_researched_at
    activity = 0.0
    if researched_at:
        age_days = (now - researched_at).total_seconds() / 86400
        if age_days <= 30:
            activity = 100.0
        elif age_days <= 90:
            activity = 70.0
        elif age_days <= 180:
            activity = 40.0
        else:
            activity = 15.0
    elif events:
        activity = 30.0

    return {
        "product_fit": round(product_fit, 2),
        "company_fit": round(company_fit, 2),
        "market_fit": round(market_fit, 2),
        "purchasing_potential": round(potential, 2),
        "contact_quality": round(contact_quality, 2),
        "growth_signals": round(growth_signals, 2),
        "data_completeness": round(data_completeness, 2),
        "recent_activity": round(activity, 2),
        "contacts": contacts,
        "emails": emails,
        "phones": phones,
        "socials": socials,
        "brands": brands,
        "events": events,
        "verified_methods": verified_methods,
        "decision_makers": decision_contacts,
    }


async def _completeness_fields(session: AsyncSession, company_id: uuid.UUID) -> list[bool]:
    evidence_high = (
        await _count(
            session,
            select(func.count())
            .select_from(ResearchEvidence)
            .where(
                ResearchEvidence.company_id == company_id,
                ResearchEvidence.confidence == EvidenceConfidence.HIGH,
            ),
        )
    ) > 0
    return [evidence_high]


def total_with(components: dict, settings=None) -> float:
    settings = settings or get_settings()
    weights = settings.scoring_weights
    weighted = sum(components.get(k, 0.0) * weights[k] for k in weights)
    total = weighted / max(sum(weights.values()), 1)
    return round(total, 2)


def lead_score_result(components: dict, settings=None) -> dict:
    settings = settings or get_settings()
    total = total_with(components, settings)
    return {
        "product_fit": components["product_fit"],
        "company_fit": components["company_fit"],
        "market_fit": components["market_fit"],
        "purchasing_potential": components["purchasing_potential"],
        "contact_quality": components["contact_quality"],
        "growth_signals": components["growth_signals"],
        "data_completeness": components["data_completeness"],
        "recent_activity": components["recent_activity"],
        "total_score": total,
        "grade": _grade(total),
        "breakdown": {k: v for k, v in components.items() if k not in ("total_score", "grade")},
    }


async def apply_lead_score(session: AsyncSession, company: Company, components: dict) -> LeadScore:
    """Upsert the lead score row for a company from deterministic components."""
    result = lead_score_result(components)
    lead = (
        await session.execute(select(LeadScore).where(LeadScore.company_id == company.id))
    ).scalars()
    existing = lead.first()
    if existing is None:
        existing = LeadScore(company_id=company.id)
        session.add(existing)
    existing.product_fit = result["product_fit"]
    existing.company_fit = result["company_fit"]
    existing.market_fit = result["market_fit"]
    existing.purchasing_potential = result["purchasing_potential"]
    existing.contact_quality = result["contact_quality"]
    existing.growth_signals = result["growth_signals"]
    existing.data_completeness = result["data_completeness"]
    existing.recent_activity = result["recent_activity"]
    existing.total_score = result["total_score"]
    existing.grade = result["grade"]
    existing.breakdown = result["breakdown"]
    existing.calculated_at = utcnow()
    existing.scoring_version = "v1"
    company.lead_score = result["total_score"]
    company.next_research_at = utcnow() + timedelta(hours=target_priority_hours(existing))
    await session.flush()
    return existing


async def score_company(session: AsyncSession, company: Company) -> LeadScore:
    components = await describe_company(session, company)
    return await apply_lead_score(session, company, components)


def target_priority_hours(score: LeadScore) -> int:
    """Scheduling hint: how soon to re-research based on total score."""
    if score.total_score >= 85:
        return 14 * 24
    if score.total_score >= 70:
        return 30 * 24
    if score.total_score >= 50:
        return 45 * 24
    return 90 * 24
