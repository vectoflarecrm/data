from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.db.session import dispose_engine, init_engine


@pytest.mark.asyncio
async def test_health_returns_ok(database_url: str) -> None:
    from app.api.routes import health
    from app.main import create_app

    await init_engine(database_url)
    app = create_app()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        dashboard_response = await client.get("/dashboard")
        assert dashboard_response.status_code == 200
        assert "研究任务" in dashboard_response.text
        static_response = await client.get("/static/dashboard.js?v=2")
        assert static_response.status_code == 200
        assert "product_category" in static_response.text
        assert "dashboard.js" in dashboard_response.text
        assert "/context/rebuild" not in dashboard_response.text
        assert "Outreach 管理" in dashboard_response.text
        assert "loadOutreach" in static_response.text
        assert "loadRelated" in static_response.text
        assert "showCompany" in static_response.text
        assert "修改公司信息" in static_response.text
        assert "renderCompanyEditor" in static_response.text
        assert "edit-row" in static_response.text
        assert "PATCH" in static_response.text
        assert "loadCompanies" in static_response.text
        assert static_response.text.count("currentCompanyPage") == 0
        assert "数据库结构" in dashboard_response.text
        assert "loadSchema" in static_response.text
        assert "loadCompanies" in static_response.text
        assert "let companyPage" not in static_response.text
        assert "companyPageInfo" in dashboard_response.text
        assert "研究任务" in dashboard_response.text

        schema_response = await client.get("/database/schema")
        assert schema_response.status_code == 200
        assert isinstance(schema_response.json(), list)
        response = await client.get("/health")
    await dispose_engine()

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"
    assert health.router is not None
