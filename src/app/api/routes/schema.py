from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import inspect

from app.api.dependencies import DbSession
from app.db.session import get_session_factory

router = APIRouter(prefix="/database", tags=["database"])


@router.get("/schema", response_model=list[dict[str, object]])
async def get_database_schema(session: DbSession) -> list[dict[str, object]]:
    def inspect_schema(sync_connection):
        inspector = inspect(sync_connection)
        result = []
        for table_name in sorted(inspector.get_table_names()):
            columns = [
                {
                    "name": column["name"],
                    "type": str(column["type"]),
                    "nullable": column["nullable"],
                    "default": column["default"],
                }
                for column in inspector.get_columns(table_name)
            ]
            result.append({"table": table_name, "columns": columns})
        return result

    factory = get_session_factory()
    async with factory() as reflection_session:
        connection = await reflection_session.connection()
        return await connection.run_sync(inspect_schema)
