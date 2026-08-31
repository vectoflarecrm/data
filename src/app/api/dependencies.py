from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.repositories.company import CompanyRepository

DbSession = Annotated[AsyncSession, Depends(get_db)]


async def get_company_or_404(
    session: DbSession,
    company_id: uuid.UUID = Path(...),
) -> uuid.UUID:
    repo = CompanyRepository(session)
    company = await repo.get(company_id)
    if company is None:
        raise HTTPException(status_code=404, detail="Company not found")
    return company_id
