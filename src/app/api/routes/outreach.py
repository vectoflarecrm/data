from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.dependencies import DbSession
from app.core.config import get_settings
from app.core.normalization import is_valid_email, normalize_email
from app.db.models import Campaign, EmailSuppression, Outreach, OutreachEvent
from app.import_export.csv_importer import CsvImporter
from app.schemas.outreach import (
    CampaignCreate,
    CampaignRead,
    OutreachCreate,
    OutreachEventRead,
    OutreachRead,
)
from app.services.email_suppression import get_email_suppression

router = APIRouter(prefix="/outreach", tags=["outreach"])
_MAX_BYTES = get_settings().max_csv_upload_mb * 1024 * 1024


@router.post("/campaigns", response_model=CampaignRead, status_code=status.HTTP_201_CREATED)
async def create_campaign(payload: CampaignCreate, session: DbSession) -> CampaignRead:
    row = Campaign(**payload.model_dump())
    session.add(row)
    await session.flush()
    return CampaignRead.model_validate(row)


@router.post("", response_model=OutreachRead, status_code=status.HTTP_201_CREATED)
async def prepare_outreach(payload: OutreachCreate, session: DbSession) -> OutreachRead:
    data = payload.model_dump()
    if data["channel"].upper() == "EMAIL":
        email = data.get("recipient_email")
        normalized = normalize_email(email) if email else ""
        if not is_valid_email(normalized):
            raise HTTPException(status_code=400, detail="A valid recipient email is required")
        suppression = await get_email_suppression(session, normalized)
        data["recipient_email"] = email
        data["normalized_recipient_email"] = normalized
        data["suppression_checked_at"] = datetime.now(UTC)
        data["suppression_status"] = "SUPPRESSED" if suppression else "CLEAR"
        data["suppression_reason"] = suppression.reason if suppression else None
        if suppression:
            raise HTTPException(status_code=409, detail="Recipient email is suppressed")
    row = Outreach(**data)
    session.add(row)
    await session.flush()
    return OutreachRead.model_validate(row)


@router.get("", response_model=list[OutreachRead])
async def list_outreach(session: DbSession, campaign_id: str | None = None) -> list[OutreachRead]:
    query = select(Outreach).options(selectinload(Outreach.events)).order_by(Outreach.created_at.desc())
    if campaign_id:
        query = query.where(Outreach.campaign_id == campaign_id)
    rows = (await session.execute(query.limit(200))).scalars().all()
    return [OutreachRead.model_validate(row) for row in rows]


@router.get("/{outreach_id}/events", response_model=list[OutreachEventRead])
async def list_outreach_events(outreach_id: str, session: DbSession) -> list[OutreachEventRead]:
    rows = (await session.execute(select(OutreachEvent).where(OutreachEvent.outreach_id == outreach_id).order_by(OutreachEvent.occurred_at))).scalars().all()
    return [OutreachEventRead.model_validate(row) for row in rows]


@router.post("/email-check", response_model=dict[str, object])
async def check_email(email: str, session: DbSession) -> dict[str, object]:
    normalized = normalize_email(email)
    suppression = await get_email_suppression(session, normalized) if is_valid_email(normalized) else None
    return {
        "email": normalized,
        "suppressed": suppression is not None,
        "reason": suppression.reason if suppression else None,
        "details": suppression.details if suppression else None,
    }


@router.post("/suppressions/csv", response_model=dict[str, int], status_code=status.HTTP_201_CREATED)
async def import_suppressions(session: DbSession, file: UploadFile = File(...)) -> dict[str, int]:
    content = await file.read()
    if len(content) > _MAX_BYTES:
        raise HTTPException(status_code=413, detail="CSV upload exceeds configured limit")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    importer = CsvImporter(session)
    before = (await session.execute(select(func.count()).select_from(EmailSuppression))).scalar_one()
    await importer.import_text(text, suppression_only=True)
    await session.commit()
    after = (await session.execute(select(func.count()).select_from(EmailSuppression))).scalar_one()
    return {"rows_processed": importer.report.rows_processed, "suppressions_created": after - before}
