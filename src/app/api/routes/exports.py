from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

from app.api.dependencies import DbSession
from app.import_export.csv_exporter import export_companies

router = APIRouter(prefix="/exports", tags=["exports"])


@router.get("/companies.csv", response_class=PlainTextResponse)
async def export_companies_csv(
    session: DbSession,
) -> PlainTextResponse:
    content = await export_companies(session)
    return PlainTextResponse(
        content,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="companies.csv"'},
    )
