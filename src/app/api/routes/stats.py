from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.dependencies import DbSession
from app.core.enums import MethodType
from app.db.models import (
    Company,
    Contact,
    ContactMethod,
    LeadScore,
    ResearchEvidence,
    ResearchTask,
    SocialAccount,
)
from app.schemas.evidence import Stats

router = APIRouter(tags=["stats"])


@router.get("/stats", response_model=Stats)
async def get_stats(session: DbSession) -> Stats:
    companies_total = (
        await session.execute(select(func.count()).select_from(Company))
    ).scalar_one()

    companies_researched = (
        await session.execute(
            select(func.count()).select_from(Company).where(Company.research_level != "L0")
        )
    ).scalar_one()

    contacts_total = (await session.execute(select(func.count()).select_from(Contact))).scalar_one()

    verified_contacts = (
        await session.execute(
            select(func.count()).select_from(Contact).where(Contact.last_verified_at.is_not(None))
        )
    ).scalar_one()

    emails_found = (
        await session.execute(
            select(func.count())
            .select_from(ContactMethod)
            .where(ContactMethod.method_type == MethodType.EMAIL)
        )
    ).scalar_one()

    phones_found = (
        await session.execute(
            select(func.count())
            .select_from(ContactMethod)
            .where(ContactMethod.method_type.in_([MethodType.PHONE, MethodType.MOBILE]))
        )
    ).scalar_one()

    public_whatsapp_found = (
        await session.execute(
            select(func.count())
            .select_from(ContactMethod)
            .where(ContactMethod.method_type == MethodType.WHATSAPP)
        )
    ).scalar_one()

    social_accounts_found = (
        await session.execute(select(func.count()).select_from(SocialAccount))
    ).scalar_one()

    high_confidence_records = (
        await session.execute(
            select(func.count())
            .select_from(ResearchEvidence)
            .where(ResearchEvidence.confidence == "HIGH")
        )
    ).scalar_one()

    research_tasks_pending = (
        await session.execute(
            select(func.count()).select_from(ResearchTask).where(ResearchTask.status == "PENDING")
        )
    ).scalar_one()

    research_tasks_failed = (
        await session.execute(
            select(func.count())
            .select_from(ResearchTask)
            .where(ResearchTask.status.in_(["FAILED", "RETRY"]))
        )
    ).scalar_one()

    a_plus_leads = (
        await session.execute(
            select(func.count()).select_from(LeadScore).where(LeadScore.grade == "A+")
        )
    ).scalar_one()

    a_leads = (
        await session.execute(
            select(func.count()).select_from(LeadScore).where(LeadScore.grade == "A")
        )
    ).scalar_one()

    lead_scores_total = (
        await session.execute(select(func.count()).select_from(LeadScore))
    ).scalar_one()

    return Stats(
        companies_total=companies_total,
        companies_researched=companies_researched,
        contacts_total=contacts_total,
        verified_contacts=verified_contacts,
        emails_found=emails_found,
        phones_found=phones_found,
        public_whatsapp_found=public_whatsapp_found,
        social_accounts_found=social_accounts_found,
        high_confidence_records=high_confidence_records,
        research_tasks_pending=research_tasks_pending,
        research_tasks_failed=research_tasks_failed,
        a_plus_leads=a_plus_leads,
        a_leads=a_leads,
        lead_scores_total=lead_scores_total,
    )
