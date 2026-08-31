from __future__ import annotations

import uuid

from pydantic import BaseModel


class EnqueueAllResponse(BaseModel):
    company_id: uuid.UUID
    enqueued: list[str]
    already_pending: list[str]


class RunResponse(BaseModel):
    claimed: int
    completed: int
    retried: int
    failed: int
