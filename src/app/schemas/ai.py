from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.common import ORMModel

CONTEXT_TYPES = Literal[
    "COMPANY_INTELLIGENCE",
    "CONTACT_INTELLIGENCE",
    "BUYING_SIGNAL_SUMMARY",
    "OUTREACH_PREPARATION",
]


class AIContextRead(ORMModel):
    id: uuid.UUID
    company_id: uuid.UUID
    context_type: str
    contact_id: uuid.UUID | None
    content: str
    created_at: datetime
    updated_at: datetime | None
    regenerated_at: datetime | None


class ContextRebuildRequest(BaseModel):
    context_type: CONTEXT_TYPES | None = None
    ai: bool = False
