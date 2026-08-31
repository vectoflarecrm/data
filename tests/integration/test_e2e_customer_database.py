from __future__ import annotations

import csv
import io
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.ai.mock_provider import MockAIProvider
from app.ai.schema import (
    CompanyResearchResult,
    ContactListResult,
    ContactPointResult,
    ContactResearchResult,
    EvidenceClaimResult,
    ProductListResult,
    ProductResearchResult,
    SocialProfileResult,
    SocialResearchResult,
)
from app.core.enums import (
    BusinessOrPersonal,
    EvidenceConfidence,
    Platform,
    ProductCategory,
    PurchasingRole,
    ResearchLevel,
    SourceType,
    TaskStatus,
    TaskType,
    VerificationStatus,
)
from app.core.time import utcnow
from app.crawlers.mock_provider import MockCrawlerProvider, html_result
from app.db.base import Base
from app.db.models import (
    AIContext,
    Company,
    Contact,
    LeadScore,
    ResearchEvidence,
    ResearchTask,
    SocialAccount,
)
from app.import_export.csv_exporter import export_companies
from app.import_export.csv_importer import CsvImporter
from app.research.executor import dispatch
from app.research.providers import (
    configure_research_providers,
    reset_research_providers,
)
from app.research.register import register_all

_ROOT = Path(__file__).resolve().parents[2]
_SENTINEL_HTML = "New store opening soon. order@watersports.io +1 415 555 0100"


async def _site_handler(url: str, options):
    return html_result(
        url,
        (
            "<html><head><title>Watersports Co</title></head><body><h1>Watersports Co</h1>"
            f"<p>{_SENTINEL_HTML}</p>"
            '<a href="https://wa.me/4155550101">WhatsApp</a>'
            '<a href="https://www.linkedin.com/company/watersports-co">LinkedIn</a>'
            "</body></html>"
        ),
    )


def _mock_ai_provider() -> MockAIProvider:
    provider = MockAIProvider()
    provider.handlers["CompanyResearchResult"] = CompanyResearchResult(
        description="B2B watersports operation",
        company_type=["DISTRIBUTOR"],
        main_products=[ProductCategory.SUP],
        brands=["AquaBrand"],
        evidence=[
            EvidenceClaimResult(
                field_name="company.description",
                value="B2B watersports operation",
                source_type=SourceType.OFFICIAL_WEBSITE,
                extraction_method="ai",
                confidence=EvidenceConfidence.HIGH,
            )
        ],
        confidence=0.9,
    )
    provider.handlers["ProductListResult"] = ProductListResult(
        products=[
            ProductResearchResult(
                product_name="Aqua SUP 10'",
                category=ProductCategory.SUP,
                brand="AquaBrand",
                description="Recreational touring board",
                url="https://watersports.io/products/aqua-sup",
                confidence=0.9,
            )
        ]
    )
    provider.handlers["ContactListResult"] = ContactListResult(
        contacts=[
            ContactResearchResult(
                name="Jane Buyer",
                title="Head of Purchasing",
                role=PurchasingRole.BUYER,
                confidence=0.8,
                email=ContactPointResult(
                    value="jane@watersports.io",
                    verification=VerificationStatus.UNVERIFIED,
                    confidence=0.9,
                ),
            )
        ]
    )
    provider.handlers["SocialResearchResult"] = SocialResearchResult(
        accounts=[
            SocialProfileResult(
                platform=Platform.LINKEDIN,
                url="https://www.linkedin.com/company/watersports-co",
                handle="watersports-co",
                business_or_personal=BusinessOrPersonal.BUSINESS,
                confidence=0.9,
            )
        ]
    )
    return provider


async def _execute(session: AsyncSession, task: ResearchTask) -> None:
    task.status = TaskStatus.RUNNING
    task.started_at = utcnow()
    outcome = await dispatch(session, task)
    if outcome.status == "completed":
        task.status = TaskStatus.COMPLETED
        task.completed_at = utcnow()
        task.worker_id = None
        task.error_message = None
        task.result_summary = outcome.summary
    else:
        task.status = TaskStatus.FAILED
        task.error_message = outcome.error or "unknown error"
    await session.flush()


@pytest.fixture
async def e2e(database_url: str):
    import app.db.models  # noqa: F401

    engine = create_async_engine(database_url, poolclass=NullPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    configure_research_providers(
        crawler=MockCrawlerProvider(handler=_site_handler),
        ai=_mock_ai_provider(),
    )
    await engine.dispose()
    yield factory
    reset_research_providers()


async def test_end_to_end_pipeline(e2e) -> None:
    register_all()

    # 1. CSV import
    csv_text = (_ROOT / "sample_customer_database.csv").read_text(encoding="utf-8-sig")
    async with e2e() as session:
        report = await CsvImporter(session).import_text(csv_text)
        affected = await session.execute(select(func.count()).select_from(Company))
        created = affected.scalar_one()
        await session.commit()

    assert report.rows_processed == 25
    assert report.companies_created == 23
    assert report.companies_updated == 2
    assert report.invalid_emails == []
    assert report.invalid_urls == []
    assert created == 23

    # 2. Normalization
    async with e2e() as session:
        companies = list(
            (await session.execute(select(Company).order_by(Company.company_name))).scalars()
        )
        assert all(c.normalized_domain for c in companies)
        assert all(c.country for c in companies)

        # 3. Research queue
        from app.research.queue import ResearchTaskRepository

        repo = ResearchTaskRepository(session)
        for company in companies:
            await repo.create(company.id, TaskType.FULL_ENRICHMENT)
            await repo.create(company.id, TaskType.LEAD_SCORING)
        pending = await session.execute(
            select(func.count())
            .select_from(ResearchTask)
            .where(ResearchTask.status == TaskStatus.PENDING)
        )
        assert pending.scalar_one() == 46
        await session.commit()

    # 4-9. Crawler mock + Gemini mock -> evidence/contacts/social/scoring/context
    async with e2e() as session:
        tasks = list(
            (
                await session.execute(select(ResearchTask).order_by(ResearchTask.scheduled_at))
            ).scalars()
        )
        for task in tasks:
            await _execute(session, task)
        await session.commit()

        companies = list(
            (await session.execute(select(Company).order_by(Company.company_name))).scalars()
        )
        assert len(companies) == 23
        assert all(c.research_level == ResearchLevel.L8 for c in companies)
        assert all(c.lead_score is not None for c in companies)

        ids = [c.id for c in companies]
        evidence_counts = {
            row[0]: row[1]
            for row in (
                await session.execute(
                    select(ResearchEvidence.company_id, func.count()).group_by(
                        ResearchEvidence.company_id
                    )
                )
            ).all()
        }
        for cid in ids:
            assert evidence_counts.get(cid, 0) >= 1

        contact_counts = {
            row[0]: row[1]
            for row in (
                await session.execute(
                    select(Contact.company_id, func.count()).group_by(Contact.company_id)
                )
            ).all()
        }
        social_counts = {
            row[0]: row[1]
            for row in (
                await session.execute(
                    select(SocialAccount.company_id, func.count()).group_by(
                        SocialAccount.company_id
                    )
                )
            ).all()
        }
        for cid in ids:
            assert contact_counts.get(cid, 0) >= 1
            assert social_counts.get(cid, 0) >= 1

        score_rows = (
            await session.execute(select(func.count()).select_from(LeadScore))
        ).scalar_one()
        assert score_rows == 23

        # 9. Regenerate AI context objects for every company (deterministic).
        from app.enrichment.ai_context import generate_company_contexts

        for company in companies:
            await generate_company_contexts(session, company)
        await session.flush()
        context_rows = (
            await session.execute(select(func.count()).select_from(AIContext))
        ).scalar_one()
        assert context_rows >= 23 * 3

        failed = (
            await session.execute(
                select(func.count())
                .select_from(ResearchTask)
                .where(ResearchTask.status == TaskStatus.FAILED)
            )
        ).scalar_one()
        assert failed == 0

    # 10. Export
    async with e2e() as session:
        exported = await export_companies(session)
    rows = list(csv.DictReader(io.StringIO(exported)))
    names = {row["Company"] for row in rows}
    assert len(names) == 23
    assert len(rows) >= len(names)  # one export row per contact
    assert "Ace Wakeboards" in names
    assert "Sol Marina Rentals" in names
    # merged duplicates were not exported as new rows
    assert "Ace Wakeboards Ltd" not in names
