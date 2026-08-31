from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import PurchasingRole
from app.db.models import AIContext, Company, Contact
from app.enrichment.ai_context import (
    build_buying_signal_summary,
    build_company_intelligence,
    build_contact_intelligence,
    build_outreach_preparation,
    generate_company_contexts,
)
from tests.unit.test_scoring import (
    _add_company,
    _buying_signals,
    _products,
    _rich_contacts,
)


async def _seed(session: AsyncSession) -> Company:
    company = await _add_company(
        session,
        "Aqua Trade GmbH",
        website="https://aquatrade.io",
        normalized_domain="aquatrade.io",
        country="Germany",
        country_code="DE",
        description="B2B distributor",
        company_type=["MANUFACTURER", "DISTRIBUTOR"],
        manufacturer=True,
        distributor=True,
        main_products_summary="SUP, KAYAK, PUMP",
        last_researched_at=datetime.now(UTC),
    )
    await _products(session, company, 3)
    await _buying_signals(session, company)
    await _rich_contacts(session, company)
    await session.flush()
    return company


async def test_generate_company_contexts(session: AsyncSession) -> None:
    company = await _seed(session)
    rows = await generate_company_contexts(session, company)
    await session.flush()

    by_type: dict[str, list[AIContext]] = {}
    for row in rows:
        by_type.setdefault(row.context_type, []).append(row)
    assert set(by_type) == {
        "COMPANY_INTELLIGENCE",
        "CONTACT_INTELLIGENCE",
        "BUYING_SIGNAL_SUMMARY",
        "OUTREACH_PREPARATION",
    }
    # One company + one contact-level context for the seeded contact.
    assert len(by_type["CONTACT_INTELLIGENCE"]) == 1

    company_text = by_type["COMPANY_INTELLIGENCE"][0].content
    assert "Aqua Trade GmbH" in company_text
    assert "SUP, KAYAK, PUMP" in company_text
    assert "Germany" in company_text

    contact_text = by_type["CONTACT_INTELLIGENCE"][0].content
    assert "Jane Buyer" in contact_text
    assert "jane-buyer@example-buyer.io" in contact_text
    assert "linkedin.com" in contact_text

    signal_text = by_type["BUYING_SIGNAL_SUMMARY"][0].content
    assert "Trade show booth 2026" in signal_text

    prep = json.loads(by_type["OUTREACH_PREPARATION"][0].content)
    assert prep["company_name"] == "Aqua Trade GmbH"
    assert prep["best_contact"] == "Jane Buyer"
    assert prep["channel"] == "jane-buyer@example-buyer.io"
    assert isinstance(prep["talking_points"], list)
    assert prep["score"] is None  # no lead score written yet


async def test_contexts_are_regenerable(session: AsyncSession) -> None:
    company = await _seed(session)
    first = await generate_company_contexts(session, company)
    await session.flush()
    first_company = next(r for r in first if r.context_type == "COMPANY_INTELLIGENCE").content

    second = await generate_company_contexts(session, company)
    await session.flush()
    second_company = next(r for r in second if r.context_type == "COMPANY_INTELLIGENCE").content
    assert first_company == second_company

    # No duplicates: exactly one company-level row per context type.
    for context_type in ("COMPANY_INTELLIGENCE", "OUTREACH_PREPARATION", "BUYING_SIGNAL_SUMMARY"):
        count = (
            await session.execute(
                select(func.count())
                .select_from(AIContext)
                .where(
                    AIContext.company_id == company.id,
                    AIContext.context_type == context_type,
                )
            )
        ).scalar_one()
        assert count == 1


async def test_no_fabrication_when_data_absent(session: AsyncSession) -> None:
    company = await _add_company(session, "Empty Co")
    text = await build_company_intelligence(session, company)
    assert "not listed" in text

    contact = Contact(
        company_id=company.id, full_name="Ghost Lee", purchasing_role=PurchasingRole.UNKNOWN
    )
    session.add(contact)
    await session.flush()
    contact_text = await build_contact_intelligence(session, company, contact)
    assert "none listed" in contact_text

    prep = json.loads(await build_outreach_preparation(session, company))
    assert prep["best_contact"] is None
    assert prep["channel"] is None
    assert prep["signal_context"] == []

    summary = await build_buying_signal_summary(session, company)
    assert "No explicit buying signals recorded." in summary
