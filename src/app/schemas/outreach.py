from __future__ import annotations

import uuid
from datetime import datetime

from app.schemas.common import ORMModel


class CampaignCreate(ORMModel):
    name: str
    description: str | None = None
    status: str = "DRAFT"
    channel: str = "EMAIL"


class CampaignRead(CampaignCreate):
    id: uuid.UUID
    started_at: datetime | None
    ended_at: datetime | None
    created_at: datetime
    updated_at: datetime | None


class OutreachCreate(ORMModel):
    company_id: uuid.UUID
    contact_id: uuid.UUID | None = None
    campaign_id: uuid.UUID | None = None
    channel: str = "EMAIL"
    subject: str | None = None
    message: str | None = None
    status: str = "PREPARED"
    recipient_email: str | None = None


class OutreachEventRead(ORMModel):
    id: uuid.UUID
    outreach_id: uuid.UUID
    event_type: str
    provider_message_id: str | None
    occurred_at: datetime
    payload: dict | None


class OutreachRead(OutreachCreate):
    id: uuid.UUID
    sent_at: datetime | None
    replied_at: datetime | None
    normalized_recipient_email: str | None
    suppression_checked_at: datetime | None
    suppression_status: str | None
    suppression_reason: str | None
    created_at: datetime
    updated_at: datetime | None
    events: list[OutreachEventRead] = []
