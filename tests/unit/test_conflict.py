from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    EvidenceConfidence,
    MethodType,
    SourceType,
    TaskType,
    VerificationStatus,
)
from app.crawlers.mock_provider import MockCrawlerProvider, html_result
from app.db.models import Company, ContactMethod, ResearchEvidence, ResearchTask
from app.enrichment.conflict import (
    Resolution,
    classify,
    confidence_rank,
    source_priority,
)
from app.enrichment.evidence import EvidenceRecorder
from app.enrichment.pipeline import ResearchPipeline


def _row(value: str, source_type: SourceType, confidence: EvidenceConfidence) -> ResearchEvidence:
    row = ResearchEvidence(
        company_id="00000000-0000-0000-0000-000000000001",
        field_name="company.email",
        value=value,
        source_type=source_type,
        confidence=confidence,
        content_hash="-",
    )
    return row


def test_source_priority_ranks_official_pages_highest() -> None:
    assert source_priority(SourceType.OFFICIAL_CONTACT_PAGE) > source_priority(
        SourceType.IMPORTED_DATA
    )
    assert confidence_rank(EvidenceConfidence.HIGH) > confidence_rank(EvidenceConfidence.LOW)


def test_no_prior_evidence_accepts() -> None:
    verdict = classify(
        existing=[],
        value="new@conflicttest.co",
        source_type=SourceType.OFFICIAL_CONTACT_PAGE,
        confidence=EvidenceConfidence.LOW,
    )
    assert verdict.resolution == Resolution.ACCEPT


def test_same_value_wherever_recorded_accepts() -> None:
    verdict = classify(
        existing=[_row("sales@example.com", SourceType.IMPORTED_DATA, EvidenceConfidence.LOW)],
        value="sales@example.com",
        source_type=SourceType.OFFICIAL_CONTACT_PAGE,
        confidence=EvidenceConfidence.HIGH,
    )
    assert verdict.resolution == Resolution.ACCEPT


def test_low_value_does_not_overwrite_high_evidence() -> None:
    verdict = classify(
        existing=[
            _row("old@conflicttest.co", SourceType.OFFICIAL_CONTACT_PAGE, EvidenceConfidence.HIGH)
        ],
        value="new@conflicttest.co",
        source_type=SourceType.OFFICIAL_CONTACT_PAGE,
        confidence=EvidenceConfidence.LOW,
    )
    assert verdict.resolution == Resolution.CONFLICT_SKIP
    assert verdict.opposing is not None
    assert verdict.opposing.value == "old@conflicttest.co"


def test_higher_standing_incoming_may_overwrite() -> None:
    verdict = classify(
        existing=[_row("old@conflicttest.co", SourceType.IMPORTED_DATA, EvidenceConfidence.LOW)],
        value="new@conflicttest.co",
        source_type=SourceType.OFFICIAL_CONTACT_PAGE,
        confidence=EvidenceConfidence.HIGH,
    )
    assert verdict.resolution == Resolution.CONFLICT_OVERWRITE
    assert verdict.accept


def test_equal_standing_different_values_is_conflicting() -> None:
    verdict = classify(
        existing=[
            _row("old@conflicttest.co", SourceType.OFFICIAL_CONTACT_PAGE, EvidenceConfidence.MEDIUM)
        ],
        value="new@conflicttest.co",
        source_type=SourceType.OFFICIAL_CONTACT_PAGE,
        confidence=EvidenceConfidence.MEDIUM,
    )
    assert verdict.resolution == Resolution.CONFLICTING
    assert not verdict.accept


async def _site_handler(url: str, options):
    return html_result(
        url,
        (
            f"<html><body><h1>{url}</h1>"
            "<p>Email us at new@conflicttest.co or old@conflicttest.co today.</p>"
            "</body></html>"
        ),
    )


async def _run_email_discovery(session: AsyncSession, company: Company) -> None:
    task = ResearchTask(
        company_id=company.id,
        task_type=TaskType.EMAIL_DISCOVERY,
    )
    await session.flush()
    pipeline = ResearchPipeline(
        crawler=MockCrawlerProvider(handler=_site_handler),
        ai=None,
    )
    await pipeline.run_email_discovery(session, task)


@pytest.mark.asyncio
async def test_conflicting_low_method_never_overwrites_high_evidence(
    session: AsyncSession,
) -> None:
    company = Company(
        company_name="Conflict Test Co",
        website="https://conflicttest.co",
        normalized_domain="conflicttest.co",
    )
    session.add(company)
    await session.flush()

    evidence = EvidenceRecorder(session)
    await evidence.record(
        company_id=company.id,
        field_name="company.email",
        value="old@conflicttest.co",
        source_type=SourceType.OFFICIAL_CONTACT_PAGE,
        extraction_method="test",
        confidence=EvidenceConfidence.HIGH,
    )

    await _run_email_discovery(session, company)
    await session.flush()

    methods = (
        (
            await session.execute(
                select(ContactMethod).where(
                    ContactMethod.company_id == company.id,
                    ContactMethod.method_type == MethodType.EMAIL,
                )
            )
        )
        .scalars()
        .all()
    )
    method_values = {m.value for m in methods}
    assert "old@conflicttest.co" in method_values
    assert "new@conflicttest.co" not in method_values

    conflicts = (
        (
            await session.execute(
                select(ResearchEvidence).where(
                    ResearchEvidence.company_id == company.id,
                    ResearchEvidence.field_name.like("conflict.%"),
                )
            )
        )
        .scalars()
        .all()
    )
    assert conflicts
    assert any("new@conflicttest.co" in (c.value or "") for c in conflicts)


@pytest.mark.asyncio
async def test_method_recorded_when_incoming_dominates(session: AsyncSession) -> None:
    company = Company(
        company_name="Conflict Test Co 2",
        website="https://conflicttest2.co",
        normalized_domain="conflicttest2.co",
    )
    session.add(company)
    await session.flush()

    evidence = EvidenceRecorder(session)
    await evidence.record(
        company_id=company.id,
        field_name="company.email",
        value="old@conflicttest.co",
        source_type=SourceType.IMPORTED_DATA,
        extraction_method="import",
        confidence=EvidenceConfidence.LOW,
    )

    await _run_email_discovery(session, company)
    await session.flush()

    methods = (
        (
            await session.execute(
                select(ContactMethod).where(
                    ContactMethod.company_id == company.id,
                    ContactMethod.method_type == MethodType.EMAIL,
                )
            )
        )
        .scalars()
        .all()
    )
    values = {m.value for m in methods}
    assert "new@conflicttest.co" in values


@pytest.mark.asyncio
async def test_verified_survives_lower_evidence(session: AsyncSession) -> None:
    """A VERIFIED contact method is not silently downgraded by regex discovery."""
    company = Company(
        company_name="Conflict Test Co 3",
        website="https://conflicttest3.co",
        normalized_domain="conflicttest3.co",
    )
    session.add(company)
    await session.flush()
    from app.enrichment.recorders import ContactMethodRecorder, ContactRecorder

    contact = await ContactRecorder(session).upsert(
        company_id=company.id,
        full_name=company.company_name,
        confidence=0.2,
    )
    method = await ContactMethodRecorder(session).upsert(
        contact_id=contact.id,
        company_id=company.id,
        method=MethodType.EMAIL,
        value="old@conflicttest.co",
        verification=VerificationStatus.VERIFIED,
        confidence=0.95,
    )
    assert method is not None
    await session.flush()

    await _run_email_discovery(session, company)
    await session.flush()

    refreshed = (
        (await session.execute(select(ContactMethod).where(ContactMethod.id == method.id)))
        .scalars()
        .first()
    )
    assert refreshed is not None
    assert refreshed.verification_status == VerificationStatus.VERIFIED
