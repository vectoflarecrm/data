from __future__ import annotations

import uuid
from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import EvidenceConfidence, SourceType, VerificationStatus
from app.db.models import ContactMethod, ResearchEvidence
from app.enrichment.evidence import evidence_hash

# Higher = more trustworthy source for the same fact.
SOURCE_PRIORITY: dict[SourceType, int] = {
    SourceType.OFFICIAL_CONTACT_PAGE: 100,
    SourceType.OFFICIAL_TEAM_PAGE: 100,
    SourceType.OFFICIAL_CATALOG: 90,
    SourceType.OFFICIAL_PRODUCT_PAGE: 90,
    SourceType.OFFICIAL_WEBSITE: 85,
    SourceType.OFFICIAL_SOCIAL: 80,
    SourceType.LINKEDIN: 80,
    SourceType.TRADE_PUBLICATION: 60,
    SourceType.SEARCH_RESULT: 60,
    SourceType.INDUSTRY_DIRECTORY: 60,
    SourceType.IMPORTED_DATA: 50,
    SourceType.OTHER: 40,
}

CONFIDENCE_RANK: dict[EvidenceConfidence, int] = {
    EvidenceConfidence.HIGH: 4,
    EvidenceConfidence.MEDIUM: 3,
    EvidenceConfidence.LOW: 2,
    EvidenceConfidence.UNKNOWN: 1,
}


class Resolution(StrEnum):
    """Conflict resolution for an incoming fact vs existing evidence."""

    ACCEPT = "ACCEPT"
    CONFLICT_SKIP = "CONFLICT_SKIP"  # existing evidence dominates; do not overwrite
    CONFLICT_OVERWRITE = "CONFLICT_OVERWRITE"  # incoming dominates; overwrite is allowed
    CONFLICTING = "CONFLICTING"  # equal standing, different values; surface and keep apart


@dataclass
class Verdict:
    resolution: Resolution
    opposing: ResearchEvidence | None = None

    @property
    def accept(self) -> bool:
        return self.resolution in (Resolution.ACCEPT, Resolution.CONFLICT_OVERWRITE)


def source_priority(source_type: SourceType) -> int:
    return SOURCE_PRIORITY.get(source_type, 40)


def confidence_rank(confidence: EvidenceConfidence) -> int:
    return CONFIDENCE_RANK.get(confidence, 1)


def same_norm(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def classify(
    *,
    existing: list[ResearchEvidence],
    value: str,
    source_type: SourceType,
    confidence: EvidenceConfidence,
) -> Verdict:
    """Decide whether an incoming value may be recorded given prior evidence.

    Rules:
    - no prior evidence, or identical value already backed -> ACCEPT
    - existing enjoys strictly higher (source, confidence): keep existing -> CONFLICT_SKIP
    - incoming strictly higher:           -> CONFLICT_OVERWRITE
    - equal standing but different value: -> CONFLICTING
    """
    relevant = [
        row
        for row in existing
        if row.value and row.value != value and not same_norm(row.value, value)
    ]
    if not relevant:
        return Verdict(Resolution.ACCEPT)
    incoming_rank = (source_priority(source_type), confidence_rank(confidence))
    best = max(
        relevant,
        key=lambda row: (source_priority(row.source_type), confidence_rank(row.confidence)),
    )
    best_rank = (source_priority(best.source_type), confidence_rank(best.confidence))
    if incoming_rank > best_rank:
        return Verdict(Resolution.CONFLICT_OVERWRITE, opposing=best)
    if incoming_rank == best_rank:
        return Verdict(Resolution.CONFLICTING, opposing=best)
    return Verdict(Resolution.CONFLICT_SKIP, opposing=best)


class ConflictDetector:
    """Queries prior evidence and records conflicts; never mutates winner evidence itself."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def evidence_for(
        self, company_id: uuid.UUID, field_name: str, value: str
    ) -> list[ResearchEvidence]:
        """Evidence rows for the same field — or any row backing the same value.

        This catches cross-field conflicts (e.g. an email claimed by the contact
        extractor under ``contact.email`` when the company regex already stored it
        under ``company.email``).
        """
        stmt = select(ResearchEvidence).where(
            ResearchEvidence.company_id == company_id,
            or_(
                ResearchEvidence.field_name == field_name,
                ResearchEvidence.value == value,
            ),
        )
        return list((await self.session.execute(stmt)).scalars().all())

    async def resolve(
        self,
        *,
        company_id: uuid.UUID,
        field_name: str,
        value: str,
        source_type: SourceType,
        confidence: EvidenceConfidence,
    ) -> Verdict:
        existing = await self.evidence_for(company_id, field_name, value)
        return classify(
            existing=existing, value=value, source_type=source_type, confidence=confidence
        )

    async def record_conflict(
        self,
        *,
        company_id: uuid.UUID,
        field_name: str,
        primary_value: str,
        opposing_value: str,
        opposing_field: str | None = None,
    ) -> ResearchEvidence | None:
        if not primary_value or not opposing_value:
            return None
        conflict_field = f"conflict.{opposing_field or field_name}"
        value = f"{opposing_value} <-> {primary_value}"
        conflict = ResearchEvidence(
            company_id=company_id,
            field_name=conflict_field,
            value=value,
            source_type=SourceType.OTHER,
            extraction_method="conflict-rules",
            confidence=EvidenceConfidence.UNKNOWN,
            content_hash=evidence_hash(
                company_id=company_id,
                source_type=SourceType.OTHER,
                field_name=conflict_field,
                value=value,
            ),
        )
        self.session.add(conflict)
        await self.session.flush()
        return conflict

    async def flag_contact_method_conflict(self, *, method: ContactMethod) -> None:
        method.verification_status = VerificationStatus.CONFLICTING
