from __future__ import annotations

import hashlib
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.schema import EvidenceClaimResult
from app.core.enums import EvidenceConfidence, SourceType, VerificationStatus
from app.db.models import ResearchEvidence


def evidence_hash(
    *, company_id: uuid.UUID, source_type: SourceType, field_name: str, value: str
) -> str:
    """Company-scoped content hash; identical evidence across imports reuses one row."""
    return hashlib.sha256(f"{source_type}|{field_name}|{value}|{company_id}".encode()).hexdigest()


class EvidenceRecorder:
    """Persists typed claims as evidence rows, deduped by company-scoped content hash."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.recorded = 0
        self.skipped_duplicates = 0

    async def record(
        self,
        *,
        company_id: uuid.UUID,
        field_name: str,
        value: str | None,
        source_url: str | None = None,
        source_domain: str | None = None,
        source_type: SourceType = SourceType.OTHER,
        evidence_text: str | None = None,
        extraction_method: str = "ai",
        confidence: EvidenceConfidence = EvidenceConfidence.UNKNOWN,
        contact_id: uuid.UUID | None = None,
    ) -> ResearchEvidence | None:
        if value is None and not evidence_text:
            return None
        h = evidence_hash(
            company_id=company_id,
            source_type=source_type,
            field_name=field_name,
            value=value or evidence_text or "",
        )
        existing = await self._find(company_id, h)
        if existing is not None:
            self.skipped_duplicates += 1
            return existing
        row = ResearchEvidence(
            company_id=company_id,
            contact_id=contact_id,
            field_name=field_name,
            value=value,
            source_url=source_url,
            source_domain=source_domain or _domain_of(source_url),
            source_type=source_type,
            evidence_text=evidence_text,
            extraction_method=extraction_method,
            confidence=confidence,
            content_hash=h,
        )
        self.session.add(row)
        await self.session.flush()
        self.recorded += 1
        return row

    async def record_claim(
        self,
        *,
        company_id: uuid.UUID,
        claim: EvidenceClaimResult,
        source_url: str | None = None,
        contact_id: uuid.UUID | None = None,
    ) -> ResearchEvidence | None:
        return await self.record(
            company_id=company_id,
            contact_id=contact_id,
            field_name=claim.field_name,
            value=claim.value,
            source_url=claim.source_url or source_url,
            source_type=claim.source_type,
            evidence_text=claim.evidence_text,
            extraction_method=claim.extraction_method,
            confidence=claim.confidence,
        )

    async def _find(self, company_id: uuid.UUID, h: str) -> ResearchEvidence | None:
        stmt = select(ResearchEvidence).where(
            ResearchEvidence.content_hash == h,
            ResearchEvidence.company_id == company_id,
        )
        return (await self.session.execute(stmt)).scalars().first()


def _domain_of(url: str | None) -> str | None:
    from urllib.parse import urlsplit

    if not url:
        return None
    return (urlsplit(url).netloc or "").lower() or None


def verification_to_confidence(status: VerificationStatus) -> EvidenceConfidence:
    if status == VerificationStatus.VERIFIED:
        return EvidenceConfidence.HIGH
    if status == VerificationStatus.INFERRED:
        return EvidenceConfidence.LOW
    if status == VerificationStatus.CONFLICTING:
        return EvidenceConfidence.MEDIUM
    return EvidenceConfidence.UNKNOWN
