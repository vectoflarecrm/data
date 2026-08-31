from __future__ import annotations

import uuid
from datetime import datetime

from app.core.enums import (
    EvidenceConfidence,
    SourceType,
    TaskStatus,
    TaskType,
)
from app.schemas.common import ORMModel


class EvidenceCreate(ORMModel):
    contact_id: uuid.UUID | None = None
    field_name: str
    value: str | None = None
    source_url: str | None = None
    source_domain: str | None = None
    source_type: SourceType = SourceType.OTHER
    evidence_text: str | None = None
    extraction_method: str | None = None
    confidence: EvidenceConfidence = EvidenceConfidence.UNKNOWN
    content_hash: str | None = None


class EvidenceRead(ORMModel):
    id: uuid.UUID
    company_id: uuid.UUID
    contact_id: uuid.UUID | None
    field_name: str
    value: str | None
    source_url: str | None
    source_domain: str | None
    source_type: SourceType
    evidence_text: str | None
    extraction_method: str | None
    confidence: EvidenceConfidence
    discovered_at: datetime
    verified_at: datetime | None
    observed_at: datetime
    is_current: bool
    expires_at: datetime | None
    content_hash: str
    created_at: datetime


class TaskCreate(ORMModel):
    company_id: uuid.UUID
    task_type: TaskType
    priority: int = 50
    scheduled_at: datetime | None = None


class TaskRead(ORMModel):
    id: uuid.UUID
    company_id: uuid.UUID
    task_type: TaskType
    priority: int
    status: TaskStatus
    attempts: int
    max_attempts: int
    scheduled_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    next_retry_at: datetime | None
    worker_id: str | None
    error_message: str | None
    result_summary: str | None
    created_at: datetime
    updated_at: datetime | None


class LeadScoreRead(ORMModel):
    id: uuid.UUID
    company_id: uuid.UUID
    product_fit: float
    company_fit: float
    market_fit: float
    purchasing_potential: float
    contact_quality: float
    growth_signals: float
    data_completeness: float
    recent_activity: float
    total_score: float
    grade: str | None
    breakdown: dict | None
    scoring_version: str
    calculated_at: datetime


class Stats(ORMModel):
    companies_total: int
    companies_researched: int
    contacts_total: int
    verified_contacts: int
    emails_found: int
    phones_found: int
    public_whatsapp_found: int
    social_accounts_found: int
    high_confidence_records: int
    research_tasks_pending: int
    research_tasks_failed: int
    a_plus_leads: int
    a_leads: int
    lead_scores_total: int
