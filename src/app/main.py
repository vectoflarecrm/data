from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import (
    companies,
    dashboard,
    exports,
    health,
    imports,
    outreach,
    research,
    schema,
    stats,
)
from app.core.config import Settings, get_settings
from app.core.logging import setup_logging


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    setup_logging(settings.log_level)

    from app.research.register import register_all

    register_all()

    app = FastAPI(title=settings.app_name, version="0.1.0")
    app.state.settings = settings
    app.mount("/static", StaticFiles(directory="src/app/static"), name="static")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(stats.router)
    app.include_router(companies.router)
    app.include_router(imports.router)
    app.include_router(exports.router)
    app.include_router(research.router)
    app.include_router(outreach.router)
    app.include_router(dashboard.router)
    app.include_router(schema.router)

    @app.on_event("startup")
    async def startup() -> None:
        from app.db.session import init_engine

        await init_engine()

    @app.on_event("shutdown")
    async def shutdown() -> None:
        from app.db.session import dispose_engine

        await dispose_engine()

    return app


app = create_app()
