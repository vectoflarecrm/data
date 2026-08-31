from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.ai.mock_provider import MockAIProvider
from app.ai.schema import (
    CompanyResearchResult,
    ContactListResult,
    ContactPointResult,
    ContactResearchResult,
    EvidenceClaimResult,
    ProductListResult,
    ProductResearchResult,
    SocialProfileResult,
    SocialResearchResult,
)
from app.core.enums import (
    BusinessOrPersonal,
    EvidenceConfidence,
    Platform,
    ProductCategory,
    PurchasingRole,
    SourceType,
    VerificationStatus,
)
from app.crawlers.mock_provider import MockCrawlerProvider, html_result
from app.db.base import Base
from app.db.session import dispose_engine, init_engine
from app.main import create_app
from app.research.providers import (
    configure_research_providers,
    reset_research_providers,
)

_SITE_TEXT = (
    "Research Co is a global watersports distributor. New store opening soon. "
    "Download catalog 2026. Contact sales@researchco.io or call +1 415 555 0100. "
    "Our purchasing manager can be reached at jane@researchco.io."
)


async def _research_site_handler(url: str, options):
    return html_result(
        url,
        (
            f"<html><head><title>Research Co</title></head><body><h1>Research Co</h1>"
            f"<p>{_SITE_TEXT}</p>"
            '<a href="https://wa.me/4155550101">WhatsApp</a>'
            '<a href="https://www.linkedin.com/company/researchco">LinkedIn</a>'
            "</body></html>"
        ),
    )


def _mock_ai_provider() -> MockAIProvider:
    provider = MockAIProvider()
    provider.handlers["CompanyResearchResult"] = CompanyResearchResult(
        description="B2B distributor of paddle sports gear",
        company_type=["DISTRIBUTOR"],
        main_products=[ProductCategory.SUP, ProductCategory.INFLATABLE_SUP],
        brands=["AquaBrand"],
        evidence=[
            EvidenceClaimResult(
                field_name="company.description",
                value="B2B distributor of paddle sports gear",
                source_type=SourceType.OFFICIAL_WEBSITE,
                extraction_method="ai",
                confidence=EvidenceConfidence.HIGH,
            )
        ],
        confidence=0.9,
    )
    provider.handlers["ProductListResult"] = ProductListResult(
        products=[
            ProductResearchResult(
                product_name="Aqua SUP 10'",
                category=ProductCategory.SUP,
                brand="AquaBrand",
                description="Recreational touring board",
                url="https://researchco.io/products/aqua-sup",
                confidence=0.9,
            )
        ]
    )
    provider.handlers["ContactListResult"] = ContactListResult(
        contacts=[
            ContactResearchResult(
                name="Jane Buyer",
                title="Head of Purchasing",
                role=PurchasingRole.BUYER,
                confidence=0.8,
                email=ContactPointResult(
                    value="jane@researchco.io",
                    verification=VerificationStatus.UNVERIFIED,
                    confidence=0.9,
                ),
            )
        ]
    )
    provider.handlers["SocialResearchResult"] = SocialResearchResult(
        accounts=[
            SocialProfileResult(
                platform=Platform.LINKEDIN,
                url="https://www.linkedin.com/company/researchco",
                handle="researchco",
                business_or_personal=BusinessOrPersonal.BUSINESS,
                confidence=0.9,
            )
        ]
    )
    return provider


@pytest.fixture
async def client(database_url: str):
    import app.db.models  # noqa: F401

    engine = create_async_engine(database_url, poolclass=NullPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()

    configure_research_providers(
        crawler=MockCrawlerProvider(handler=_research_site_handler),
        ai=_mock_ai_provider(),
    )
    await init_engine(database_url)
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    reset_research_providers()
    await dispose_engine()


@pytest.mark.asyncio
async def test_company_crud_flow(client: AsyncClient) -> None:
    payload = {
        "company_name": "Aqua Marina GmbH",
        "website": "https://www.aqua-marina.io",
        "country": "Germany",
        "country_code": "DE",
        "industry": "Watersports",
        "company_type": ["DISTRIBUTOR", "IMPORTER"],
        "target_markets": ["Germany", "Austria"],
        "distributor": True,
        "importer": True,
    }
    r = await client.post("/companies", json=payload)
    assert r.status_code == 201
    body = r.json()
    assert body["company_name"] == payload["company_name"]
    assert body["normalized_domain"] == "aqua-marina.io"
    company_id = body["id"]

    r = await client.get(f"/companies/{company_id}")
    assert r.status_code == 200
    assert r.json()["country_code"] == "DE"

    r = await client.patch(f"/companies/{company_id}", json={"city": "Hamburg"})
    assert r.status_code == 200
    assert r.json()["city"] == "Hamburg"

    r = await client.get("/companies", params={"country_code": "DE"})
    assert r.status_code == 200
    page = r.json()
    assert page["total"] >= 1
    assert page["items"][0]["normalized_domain"] == "aqua-marina.io"

    r = await client.delete(f"/companies/{company_id}")
    assert r.status_code == 204

    r = await client.get(f"/companies/{company_id}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_contact_and_nested_resources(client: AsyncClient) -> None:
    r = await client.post(
        "/companies",
        json={
            "company_name": "Blue Water Sports",
            "normalized_domain": "bluewater.io",
            "distributor": True,
        },
    )
    company_id = r.json()["id"]

    r = await client.post(
        f"/companies/{company_id}/contacts",
        json={
            "full_name": "Anna Müller",
            "job_title": "Purchasing Manager",
            "role_type": "PURCHASING_MANAGER",
            "purchasing_role": "DECISION_MAKER",
        },
    )
    assert r.status_code == 201
    contact_id = r.json()["id"]

    r = await client.post(
        f"/companies/{company_id}/contacts/{contact_id}/methods",
        json={
            "method_type": "EMAIL",
            "value": "anna@bluewater.io",
            "is_primary": True,
            "verification_status": "VERIFIED",
        },
    )
    assert r.status_code == 201
    assert r.json()["value"] == "anna@bluewater.io"

    r = await client.post(
        f"/companies/{company_id}/contacts/{contact_id}/social",
        json={
            "platform": "LINKEDIN",
            "profile_url": "https://www.linkedin.com/in/anna-mueller",
            "business_or_personal": "BUSINESS",
        },
    )
    assert r.status_code == 201

    r = await client.get(f"/companies/{company_id}/contacts")
    assert r.status_code == 200
    contact = r.json()["items"][0]
    assert contact["full_name"] == "Anna Müller"


@pytest.mark.asyncio
async def test_product_evidence_brand_event_score(client: AsyncClient) -> None:
    r = await client.post(
        "/companies",
        json={"company_name": "Tide Outdoor", "normalized_domain": "tideout.io"},
    )
    company_id = r.json()["id"]

    r = await client.post("/companies", json={"company_name": "Temp", "website": "bad-url"})
    assert r.status_code == 422

    r = await client.post(
        f"/companies/{company_id}/products",
        json={"name": "Inflatable Touring SUP", "category": "TOURING_SUP"},
    )
    assert r.status_code == 201
    assert r.json()["category"] == "TOURING_SUP"

    r = await client.post(
        f"/companies/{company_id}/evidence",
        json={
            "field_name": "company_type",
            "value": "DISTRIBUTOR",
            "source_url": "https://tideout.io/about",
            "source_type": "OFFICIAL_WEBSITE",
            "content_hash": "hash-tideout-1",
        },
    )
    assert r.status_code == 201
    assert r.json()["source_domain"] == "tideout.io"

    r = await client.post(
        f"/companies/{company_id}/evidence",
        json={
            "field_name": "company_type",
            "value": "DISTRIBUTOR",
            "source_url": "https://tideout.io/about",
            "source_type": "OFFICIAL_WEBSITE",
            "content_hash": "hash-tideout-1",
        },
    )
    assert r.status_code == 201  # idempotent dedup by content_hash

    r = await client.post(
        f"/companies/{company_id}/events",
        json={
            "event_type": "EXPANSION",
            "title": "New warehouse",
            "description": "Opened new distribution warehouse",
            "importance": "HIGH",
        },
    )
    assert r.status_code == 201

    r = await client.get(f"/companies/{company_id}/events")
    assert r.status_code == 200
    assert r.json()["items"][0]["event_type"] == "EXPANSION"

    r = await client.get(f"/companies/{company_id}/score")
    assert r.status_code == 200
    assert r.json() is None


@pytest.mark.asyncio
async def test_company_context_endpoints(client: AsyncClient) -> None:
    r = await client.post(
        "/companies",
        json={
            "company_name": "Context Co",
            "country_code": "DE",
            "website": "https://contextco.io",
        },
    )
    assert r.status_code == 201
    company_id = r.json()["id"]

    r = await client.post(
        f"/companies/{company_id}/context/rebuild", json={"context_type": None, "ai": False}
    )
    assert r.status_code == 200
    rows = r.json()
    types = {row["context_type"] for row in rows}
    assert types == {"COMPANY_INTELLIGENCE", "OUTREACH_PREPARATION", "BUYING_SIGNAL_SUMMARY"}

    company_row = next(row for row in rows if row["context_type"] == "COMPANY_INTELLIGENCE")
    assert "Context Co" in company_row["content"]

    r = await client.get(f"/companies/{company_id}/context")
    assert r.status_code == 200
    assert len(r.json()) == len(rows)

    r = await client.post(
        f"/companies/{company_id}/context/rebuild",
        json={"context_type": "OUTREACH_PREPARATION", "ai": False},
    )
    assert r.status_code == 200
    rebuilt = r.json()
    assert all(row["context_type"] == "OUTREACH_PREPARATION" for row in rebuilt)


@pytest.mark.asyncio
async def test_stats_endpoint(client: AsyncClient) -> None:
    r = await client.get("/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["companies_total"] >= 0
    assert "research_tasks_pending" in body


@pytest.mark.asyncio
async def test_import_export_endpoints(client: AsyncClient) -> None:
    csv_text = (
        "Company,Website,Country,Email,WhatSApp\n"
        "Bay Watersports,https://baywatersports.io,Netherlands,info@baywatersports.io,\n"
    )
    r = await client.post("/imports/csv", files={"file": ("companies.csv", csv_text, "text/csv")})
    assert r.status_code == 201
    body = r.json()
    assert body["companies_created"] == 1
    assert body["companies_updated"] == 0

    r = await client.get("/exports/companies.csv")
    assert r.status_code == 200
    assert "Bay Watersports" in r.text
    assert r.headers["content-type"].startswith("text/csv")

    r = await client.post("/imports/csv", files={"file": ("companies.csv", csv_text, "text/csv")})
    assert r.status_code == 201
    body = r.json()
    assert body["companies_created"] == 0
    assert body["companies_updated"] == 1


@pytest.mark.asyncio
async def test_research_task_endpoints(client: AsyncClient) -> None:
    r = await client.post(
        "/companies",
        json={"company_name": "Research Co", "website": "https://researchco.io"},
    )
    company_id = r.json()["id"]

    r = await client.post(
        "/research/tasks",
        json={"company_id": company_id, "task_type": "COMPANY_RESEARCH", "priority": 95},
    )
    assert r.status_code == 201
    task_id = r.json()["id"]

    r = await client.post(
        "/research/tasks",
        json={"company_id": company_id, "task_type": "COMPANY_RESEARCH"},
    )
    assert r.status_code == 201
    assert r.json()["id"] == task_id  # idempotent: no duplicate task

    r = await client.get(f"/research/tasks?company_id={company_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1

    r = await client.post(
        "/research/tasks", json={"company_id": "not-a-uuid", "task_type": "LEAD_SCORING"}
    )
    assert r.status_code == 422

    r = await client.post(f"/research/{company_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["already_pending"] == ["COMPANY_RESEARCH"]
    assert set(body["enqueued"]) == {
        "PRODUCT_RESEARCH",
        "CONTACT_DISCOVERY",
        "SOCIAL_DISCOVERY",
        "LEAD_SCORING",
    }

    r = await client.post("/research/run?limit=5")
    assert r.status_code == 200
    body = r.json()
    assert body["claimed"] == 5  # COMPANY, PRODUCT, CONTACT, SOCIAL, LEAD_SCORING
    assert body["completed"] == 5
    assert body["failed"] == 0
    assert body["retried"] == 0

    r = await client.get(f"/research/tasks?company_id={company_id}")
    assert r.status_code == 200
    assert r.json()["total"] == 5

    r = await client.get(f"/companies/{company_id}")
    assert r.status_code == 200
    assert "B2B distributor" in (r.json().get("description") or "")

    r = await client.get(f"/companies/{company_id}/contacts")
    assert r.status_code == 200
    assert r.json()["total"] == 1  # Jane Buyer from contact discovery

    r = await client.get(f"/companies/{company_id}/social")
    assert r.status_code == 200
    assert r.json()["total"] >= 1

    r = await client.get(f"/companies/{company_id}/brands")
    assert r.status_code == 200
    assert r.json()["total"] >= 1

    r = await client.get(f"/companies/{company_id}/evidence")
    assert r.status_code == 200
    assert r.json()["total"] >= 1


@pytest.mark.asyncio
async def test_full_enrichment_pipeline(client: AsyncClient) -> None:
    r = await client.post(
        "/companies",
        json={"company_name": "Waves Global", "website": "https://wavesglobal.io"},
    )
    assert r.status_code == 201
    company_id = r.json()["id"]

    r = await client.post(
        "/research/tasks",
        json={"company_id": company_id, "task_type": "FULL_ENRICHMENT"},
    )
    assert r.status_code == 201

    r = await client.post("/research/run?limit=2")
    assert r.status_code == 200
    body = r.json()
    assert body["claimed"] == 1
    assert body["completed"] == 1
    assert body["failed"] == 0

    r = await client.get(f"/companies/{company_id}")
    assert r.status_code == 200
    assert r.json()["research_level"] == "L8"
    assert r.json()["research_status"] == "FULLY_ENRICHED"
    assert "B2B distributor" in (r.json().get("description") or "")
    # Regression: research AI company type must be awaited and applied, not skipped.
    assert "DISTRIBUTOR" in (r.json().get("company_type") or [])

    r = await client.get(f"/companies/{company_id}/contacts")
    assert r.status_code == 200
    assert r.json()["total"] >= 2  # Jane Buyer + company-level general contact

    r = await client.get(f"/companies/{company_id}/social")
    assert r.status_code == 200
    assert r.json()["total"] >= 1

    r = await client.get(f"/companies/{company_id}/brands")
    assert r.status_code == 200
    brand_names = {b["brand_name"] for b in r.json()["items"]}
    assert "AquaBrand" in brand_names

    r = await client.get(f"/companies/{company_id}/evidence")
    assert r.status_code == 200
    assert r.json()["total"] >= 8

    r = await client.get(f"/companies/{company_id}/events")
    assert r.status_code == 200
    event_types = {e["event_type"] for e in r.json()["items"]}
    assert {"NEW_STORE", "CATALOG_RELEASE"}.issubset(event_types)

    r = await client.get(f"/companies/{company_id}/products")
    assert r.status_code == 200
    assert any(p["name"] == "Aqua SUP 10'" for p in r.json()["items"])
