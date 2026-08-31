from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.api.dependencies import DbSession
from app.core.config import get_settings
from app.import_export.csv_importer import CsvImporter, ImportReport

router = APIRouter(prefix="/imports", tags=["imports"])

_MAX_BYTES = get_settings().max_csv_upload_mb * 1024 * 1024


@router.post("/csv", response_model=ImportReport, status_code=status.HTTP_201_CREATED)
async def import_csv(session: DbSession, file: UploadFile = File(...)) -> ImportReport:
    content = await file.read()
    if len(content) > _MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"CSV upload exceeds {get_settings().max_csv_upload_mb} MB limit",
        )
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    importer = CsvImporter(session)
    report = await importer.import_text(text)
    await session.commit()
    return report
