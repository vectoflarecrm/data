from __future__ import annotations

import json
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import MethodType, PurchasingRole, VerificationStatus
from app.db.models import (
    AIContext,
    Company,
    CompanyBrand,
    CompanyEvent,
    Contact,
    ContactMethod,
    LeadScore,
    ResearchEvidence,
    SocialAccount,
)
from app.repositories.company import AIContextRepository

CONTEXT_TYPES = (
    "COMPANY_INTELLIGENCE",
    "CONTACT_INTELLIGENCE",
    "BUYING_SIGNAL_SUMMARY",
    "OUTREACH_PREPARATION",
)

_DECISION_ROLES = {
    PurchasingRole.DECISION_MAKER,
    PurchasingRole.BUYER,
    PurchasingRole.EXECUTIVE,
    PurchasingRole.INFLUENCER,
}


async def _contacts(session: AsyncSession, company_id: uuid.UUID) -> list[Contact]:
    query = (
        select(Contact).where(Contact.company_id == company_id).order_by(Contact.confidence.desc())
    )
    return list((await session.execute(query)).scalars().all())


async def _methods(session: AsyncSession, company_id: uuid.UUID) -> list[ContactMethod]:
    query = select(ContactMethod).where(ContactMethod.company_id == company_id)
    return list((await session.execute(query)).scalars().all())


async def _socials(session: AsyncSession, company_id: uuid.UUID) -> list[SocialAccount]:
    query = select(SocialAccount).where(SocialAccount.company_id == company_id)
    return list((await session.execute(query)).scalars().all())


async def _events(session: AsyncSession, company_id: uuid.UUID) -> list[CompanyEvent]:
    query = (
        select(CompanyEvent)
        .where(CompanyEvent.company_id == company_id)
        .order_by(CompanyEvent.event_date.desc().nullslast())
    )
    return list((await session.execute(query)).scalars().all())


async def _buying_evidence(session: AsyncSession, company_id: uuid.UUID) -> list[ResearchEvidence]:
    query = select(ResearchEvidence).where(
        ResearchEvidence.company_id == company_id,
        ResearchEvidence.field_name.like("buying_signal.%"),
    )
    return list((await session.execute(query)).scalars().all())


def _method_label(method: ContactMethod) -> str:
    verification = method.verification_status.value if method.verification_status else "UNKNOWN"
    return f"{method.method_type.value} {method.value} [{verification}]"


async def build_company_intelligence(session: AsyncSession, company: Company) -> str:
    cid = company.id
    contacts = await _contacts(session, cid)
    methods = await _methods(session, cid)
    socials = await _socials(session, cid)
    events = await _events(session, cid)
    signals = await _buying_evidence(session, cid)
    brands = (
        await session.execute(
            select(func.count()).select_from(CompanyBrand).where(CompanyBrand.company_id == cid)
        )
    ).scalar_one()
    score = (
        await session.execute(select(LeadScore).where(LeadScore.company_id == cid))
    ).scalar_one_or_none()

    lines = [
        f"# {company.company_name}",
        "",
        f"- Website: {company.website or company.normalized_domain or 'not listed'}",
        f"- Country: {company.country or '-'} ({company.country_code or '-'})",
        f"- Business type: {', '.join(company.company_type or []) or 'unknown'}",
        f"- Industry: {company.industry or 'unknown'}",
        f"- Founded: {company.founded_year or 'unknown'} | Employees: {company.employee_range or 'unknown'}",
        f"- Products (summary): {company.main_products_summary or 'not listed'}",
        f"- Contacts: {len(contacts)} | methods: {len(methods)} | socials: {len(socials)}",
        f"- Brands carried: {brands} | events: {len(events)} | buying signals: {len(signals)}",
    ]
    if score:
        lines.extend(
            [
                "",
                f"Lead score: {score.total_score:.0f} ({score.grade}) "
                f"[product {score.product_fit:.0f}, company {score.company_fit:.0f}, "
                f"market {score.market_fit:.0f}, potential {score.purchasing_potential:.0f}, "
                f"contacts {score.contact_quality:.0f}, signals {score.growth_signals:.0f}, "
                f"completeness {score.data_completeness:.0f}]",
            ]
        )
    if company.description:
        lines.append("")
        lines.append(f"Description: {company.description[:400]}")
    return "\n".join(lines)


async def build_contact_intelligence(
    session: AsyncSession, company: Company, contact: Contact
) -> str:
    methods = [m for m in await _methods(session, company.id) if m.contact_id == contact.id]
    socials = [s for s in await _socials(session, company.id) if s.contact_id == contact.id]
    lines = [
        f"# {contact.full_name or 'unknown'} @ {company.company_name}",
        "",
        f"- Job title: {contact.job_title or 'unknown'}",
        f"- Purchasing role: {contact.purchasing_role.value if contact.purchasing_role else 'unknown'}",
        f"- Decision power: {contact.decision_power.value if contact.decision_power else 'unknown'}",
        f"- Seniority: {contact.seniority.value if contact.seniority else 'unknown'}",
        f"- Confidence: {contact.confidence or 0:.2f}",
        "- Contact methods:",
    ]
    if methods:
        for method in methods:
            lines.append(f"  - {_method_label(method)}")
    else:
        lines.append("  - none listed")
    if socials:
        lines.append("- Social profiles:")
        for social in socials:
            lines.append(f"  - {social.platform.value}: {social.profile_url}")
    return "\n".join(lines)


async def build_buying_signal_summary(session: AsyncSession, company: Company) -> str:
    events = await _events(session, company.id)
    signals = await _buying_evidence(session, company.id)
    lines = [f"# Buying signals — {company.company_name}", ""]
    if signals:
        lines.append(f"{len(signals)} signal(s) detected:")
        for item in signals:
            lines.append(
                f"- ({item.extraction_method or 'rules'}, {item.confidence.value}) {item.value}"
            )
    else:
        lines.append("No explicit buying signals recorded.")
    if events:
        lines.append("")
        lines.append(f"{len(events)} tracked event(s):")
        for event in events[:10]:
            lines.append(
                f"- {event.event_date or 'date unknown'} | {event.event_type.value} | "
                f"{event.title} ({event.importance.value})"
            )
    else:
        lines.append("No tracked events.")
    return "\n".join(lines)


async def build_outreach_preparation(session: AsyncSession, company: Company) -> str:
    contacts = await _contacts(session, company.id)
    methods = await _methods(session, company.id)
    signals = await _buying_evidence(session, company.id)
    score = (
        await session.execute(select(LeadScore).where(LeadScore.company_id == company.id))
    ).scalar_one_or_none()

    def contact_rank(contact: Contact) -> float:
        role = contact.purchasing_role
        rank = 10.0 if role in _DECISION_ROLES else 0.0
        rank += (contact.confidence or 0) * 10.0
        mine = [m for m in methods if m.contact_id == contact.id]
        verified = sum(1 for m in mine if m.verification_status == VerificationStatus.VERIFIED)
        rank += 5.0 * min(verified, 30)
        return rank

    ranked = [c for c in contacts if contact_rank(c) > 0]
    best = max(ranked, key=contact_rank) if ranked else None
    channel = None
    if best:
        mine = [m for m in methods if m.contact_id == best.id]
        for m in mine:
            if (
                m.method_type == MethodType.EMAIL
                and m.verification_status == VerificationStatus.VERIFIED
            ):
                channel = m.value
                break
        if channel is None:
            for m in mine:
                if m.method_type == MethodType.EMAIL:
                    channel = m.value
                    break
        if channel is None:
            for m in mine:
                if m.method_type in (MethodType.PHONE, MethodType.MOBILE):
                    channel = m.value
                    break

    cadence_hours = None
    if score:
        from app.enrichment.scoring import target_priority_hours

        cadence_hours = target_priority_hours(score)

    talking_points: list[str] = []
    prep: dict[str, object] = {
        "company_id": str(company.id),
        "company_name": company.company_name,
        "best_contact": best.full_name if best else None,
        "contact_title": best.job_title if best else None,
        "channel": channel,
        "subject": f"Watersports catalog & buying conversation — {company.company_name}",
        "talking_points": talking_points,
        "signal_context": [s.value for s in signals[:5]],
        "score": round(score.total_score, 1) if score else None,
        "grade": score.grade if score else None,
        "suggested_recadence_hours": cadence_hours,
    }
    if company.main_products_summary:
        talking_points.append(company.main_products_summary)
    if company.country:
        talking_points.append(f"Reach {company.company_name} in {company.country}.")
    return json.dumps(prep, indent=2)


async def generate_company_contexts(
    session: AsyncSession, company: Company, *, use_ai: bool = False
) -> list[AIContext]:
    """Derive all AI context objects for a company from underlying data."""
    repo = AIContextRepository(session)
    company_row = await repo.replace(
        company.id, "COMPANY_INTELLIGENCE", await build_company_intelligence(session, company)
    )
    signal_row = await repo.replace(
        company.id, "BUYING_SIGNAL_SUMMARY", await build_buying_signal_summary(session, company)
    )
    outreach_row = await repo.replace(
        company.id, "OUTREACH_PREPARATION", await build_outreach_preparation(session, company)
    )
    rows = [company_row, signal_row, outreach_row]

    for contact in await _contacts(session, company.id):
        rows.append(
            await repo.replace(
                company.id,
                "CONTACT_INTELLIGENCE",
                await build_contact_intelligence(session, company, contact),
                contact_id=contact.id,
            )
        )

    if use_ai:
        rows = [await _polish(session, company.id, row) for row in rows]
    return rows


async def _polish(session: AsyncSession, company_id: uuid.UUID, row: AIContext) -> AIContext:
    if row.context_type == "OUTREACH_PREPARATION":
        return row  # structured object; keep deterministic values
    try:
        from app.research.providers import get_research_ai

        provider = get_research_ai()
        polished = await provider.complete(
            system=(
                "You condense intelligence notes into a tighter professional brief. "
                "Do not invent facts. Keep all figures and names. Max 15 lines."
            ),
            prompt=row.content,
        )
    except Exception:
        return row
    repo = AIContextRepository(session)
    return await repo.replace(
        company_id, row.context_type, polished.strip(), contact_id=row.contact_id
    )
