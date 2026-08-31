from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.db.base import Base
from app.db.models import Company, Contact, ContactMethod, Product, ResearchTask
from app.import_export.csv_exporter import export_companies
from app.import_export.csv_importer import CsvImporter

SAMPLE_CSV = """Company,Website,Country,Region,City,Address,Industry,Company Type,Products,Brands,First Name,Last Name,Title,Email,Phone,WhatsApp,LinkedIn,Notes
Aqua Marina GmbH,https://www.aqua-marina.io,Germany,North Rhine-Westphalia,Düsseldorf,Oststrasse 12,,Distributor,SUPs; Kayaks,Starboard; Fanatic,Anna,Müller,Purchasing Manager,anna@aqua-marina.io,+49 211 555100,,https://linkedin.com/in/anna-mueller,Official distributor
Blue Water Sports,bluewater.io,Greece,,Athens,,,Importer,Inflatables,,Giorgos,Papas,Owner,giorgos@bluewater.io,,,,,
Tide Outdoor,,,France,,Marseille,,Wholesaler,Kayaks,,Claude,Moreau,Buyer,,+33 6 12 34 56 78,,,"""


@pytest.fixture
async def dbengine(database_url: str):
    import app.db.models  # noqa: F401

    engine = create_async_engine(database_url, poolclass=NullPool)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()
    yield database_url


@pytest.fixture
async def session(dbengine: str):
    from app.db.session import dispose_engine, get_session_factory, init_engine

    await init_engine(dbengine)
    factory = get_session_factory()
    async with factory() as s:
        yield s
    await dispose_engine()


async def _rows(session: AsyncSession, model):
    from sqlalchemy import select

    result = await session.execute(select(model))
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_import_creates_company_contact_evidence(session: AsyncSession) -> None:
    importer = CsvImporter(session)
    report = await importer.import_text(SAMPLE_CSV)
    await session.commit()

    assert report.rows_processed == 3
    assert report.companies_created == 3
    assert report.contacts_created == 3
    assert report.evidence_created > 0
    assert report.research_tasks_created == 1  # Tide Outdoor has no website
    assert "Tide Outdoor" in report.missing_websites

    companies = await _rows(session, Company)
    assert len(companies) == 3

    contacts = await _rows(session, Contact)
    assert len(contacts) == 3

    methods = await _rows(session, ContactMethod)
    assert any(m.method_type == "EMAIL" for m in methods)


@pytest.mark.asyncio
async def test_reimport_does_not_create_duplicates(session: AsyncSession) -> None:
    importer = CsvImporter(session)
    first = await importer.import_text(SAMPLE_CSV)
    await session.commit()

    second = await importer.import_text(SAMPLE_CSV)
    await session.commit()

    assert first.companies_created == 3
    assert second.companies_created == 0
    assert second.companies_updated == 3
    assert second.contacts_created == 0
    assert second.contacts_updated == 3
    assert len(await _rows(session, Company)) == 3
    assert len(await _rows(session, Contact)) == 3
    assert (
        len(await _rows(session, ContactMethod)) == 4
    )  # Anna: email+phone, Giorgos: email, Claude: phone


@pytest.mark.asyncio
async def test_export_reimport_roundtrip(session: AsyncSession) -> None:
    importer = CsvImporter(session)
    await importer.import_text(SAMPLE_CSV)
    await session.commit()

    exported = await export_companies(session)
    assert "Aqua Marina GmbH" in exported

    importer2 = CsvImporter(session)
    report = await importer2.import_text(exported)
    await session.commit()

    assert report.companies_created == 0
    assert report.contacts_created == 0
    assert len(await _rows(session, Company)) == 3
    assert len(await _rows(session, Product)) >= 1


@pytest.mark.asyncio
async def test_import_creates_product_and_task_for_missing_site(session: AsyncSession) -> None:
    importer = CsvImporter(session)
    await importer.import_text(SAMPLE_CSV)
    await session.commit()

    tasks = await _rows(session, ResearchTask)
    assert len(tasks) == 1
    assert tasks[0].task_type == "COMPANY_DISCOVERY"

    products = await _rows(session, Product)
    assert len(products) >= 1
    names = {p.name for p in products}
    assert {"SUPs", "Kayaks"} & names


@pytest.mark.asyncio
async def test_invalid_email_and_conflict_detection(session: AsyncSession) -> None:
    csv_text = "Company,Website,Country,Email\nWave Riders,https://waves.io,USA,not-an-email\n"
    importer = CsvImporter(session)
    report = await importer.import_text(csv_text)
    await session.commit()
    assert report.invalid_emails == ["not-an-email"]

    csv2 = (
        "Company,Website,Country,Email,City\n"
        "Wave Riders,https://waves.io,France,wave@waves.io,Lyon\n"
        "Wave Riders,https://waves.io,SPAIN,wave@waves.io,\n"
    )
    importer2 = CsvImporter(session)
    report2 = await importer2.import_text(csv2)
    await session.commit()
    assert report2.companies_created == 0
    assert report2.companies_updated == 2
    assert len(report2.conflicting_values) >= 1  # France vs SPAIN
    assert report2.contacts_created == 1
