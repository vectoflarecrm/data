from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from sqlalchemy import func, or_, select
from sqlalchemy.orm import selectinload

from app.db.models import Company, CompanyProduct, Contact
from app.db.session import dispose_engine, get_session_factory, init_engine

SEGMENT_FLAGS = (
    ("distributor", "Distributor"),
    ("wholesaler", "Distributor"),
    ("importer", "Distributor"),
    ("retailer", "Dealer"),
    ("ecommerce", "Dealer"),
    ("rental", "User"),
    ("manufacturer", "Manufacturer"),
    ("oem", "Manufacturer"),
)


def sql_literal(value: str | None) -> str:
    """Return a safely escaped SQLite string literal or NULL."""
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def company_segment(company: Company) -> str | None:
    segments: list[str] = []
    for field, segment in SEGMENT_FLAGS:
        if getattr(company, field, False) and segment not in segments:
            segments.append(segment)
    description = (company.description or "").lower()
    for marker, segment in (
        ("[distributor]", "Distributor"),
        ("[dealer]", "Dealer"),
        ("[user]", "User"),
        ("[manufacturer]", "Manufacturer"),
    ):
        if marker in description and segment not in segments:
            segments.append(segment)
    return ", ".join(segments) or None


def contact_payload(company: Company) -> list[dict[str, object]]:
    contacts: list[dict[str, object]] = []
    for contact in company.contacts:
        methods = [
            {
                "type": str(method.method_type),
                "value": method.value,
                "verification_status": str(method.verification_status),
            }
            for method in contact.methods
        ]
        social = [
            {
                "platform": str(account.platform),
                "url": account.profile_url,
                "username": account.username,
            }
            for account in contact.social_accounts
        ]
        contacts.append(
            {
                "first_name": contact.first_name,
                "last_name": contact.last_name,
                "full_name": contact.full_name,
                "title": contact.job_title,
                "methods": methods,
                "social_accounts": social,
            }
        )
    return contacts


def company_json(company: Company) -> str:
    products = [
        {
            "name": link.product.name,
            "category": str(link.product.category) if link.product.category else None,
            "relationship_type": link.relationship_type,
        }
        for link in company.products
        if link.product is not None
    ]
    payload = {
        "source": "local_postgresql",
        "company_name": company.company_name,
        "legal_name": company.legal_name,
        "trading_name": company.trading_name,
        "country": company.country,
        "country_code": company.country_code,
        "region": company.region,
        "city": company.city,
        "address": company.address,
        "postal_code": company.postal_code,
        "industry": company.industry,
        "company_type": company.company_type or [],
        "business_model": company.business_model,
        "employee_range": company.employee_range,
        "description": company.description,
        "products_summary": company.main_products_summary,
        "target_markets": company.target_markets or [],
        "products": products,
        "contacts": contact_payload(company),
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def customer_statement(company: Company) -> str:
    company_id = str(company.id)
    domain = company.website or (
        f"https://{company.normalized_domain}" if company.normalized_domain else None
    )
    segment = company_segment(company)
    details = company_json(company)
    remarks = "数据来源：本地 PostgreSQL 公司与联系人记录；等待 Worker 网页核验。"
    return (
        "INSERT INTO customers "
        "(company_id, domain, status, customer_segment, personas_and_solutions, remarks) VALUES ("
        f"{sql_literal(company_id)}, {sql_literal(domain)}, 'pending', "
        f"{sql_literal(segment)}, {sql_literal(details)}, {sql_literal(remarks)}) "
        "ON CONFLICT(company_id) DO UPDATE SET "
        "domain=excluded.domain, "
        "customer_segment=COALESCE(customers.customer_segment, excluded.customer_segment), "
        "personas_and_solutions=COALESCE(customers.personas_and_solutions, excluded.personas_and_solutions), "
        "remarks=COALESCE(customers.remarks, excluded.remarks), "
        "updated_at=CURRENT_TIMESTAMP;"
    )


async def load_companies() -> tuple[list[Company], int]:
    await init_engine()
    try:
        factory = get_session_factory()
        async with factory() as session:
            total = await session.scalar(select(func.count()).select_from(Company))
            result = await session.execute(
                select(Company)
                .where(or_(Company.website.is_not(None), Company.normalized_domain.is_not(None)))
                .order_by(Company.company_name)
                .options(
                    selectinload(Company.contacts).selectinload(Contact.methods),
                    selectinload(Company.contacts).selectinload(Contact.social_accounts),
                    selectinload(Company.products).selectinload(CompanyProduct.product),
                )
            )
            companies = list(result.scalars().unique().all())
    finally:
        await dispose_engine()
    return companies, int(total or 0) - len(companies)


def write_sql(output: Path, companies: list[Company]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "-- Generated from local PostgreSQL; safe to re-run. "
        "Existing AI fields are preserved.\n"
    )
    statements = "\n".join(customer_statement(company) for company in companies)
    output.write_text(f"{header}{statements}\n", encoding="utf-8")


def write_chunks(output_dir: Path, companies: list[Company], chunk_size: int) -> int:
    output_dir.mkdir(parents=True, exist_ok=True)
    for old_file in output_dir.glob("*.sql"):
        old_file.unlink()
    chunks = [
        companies[index : index + chunk_size]
        for index in range(0, len(companies), chunk_size)
    ]
    for index, chunk in enumerate(chunks, start=1):
        write_sql(output_dir / f"customers_{index:03d}.sql", chunk)
    return len(chunks)


async def export(output: Path, output_dir: Path | None, chunk_size: int) -> tuple[int, int, int]:
    companies, skipped = await load_companies()
    if output_dir is not None:
        chunks = write_chunks(output_dir, companies, chunk_size)
    else:
        write_sql(output, companies)
        chunks = 1
    return len(companies), skipped, chunks


def main() -> None:
    parser = argparse.ArgumentParser(description="Export local companies for Cloudflare D1")
    parser.add_argument("--output", type=Path, default=Path("data/exports/d1_customers.sql"))
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Write multiple small SQL files instead of one large SQL file",
    )
    parser.add_argument("--chunk-size", type=int, default=50)
    args = parser.parse_args()
    if args.chunk_size < 1:
        parser.error("--chunk-size must be positive")

    imported, skipped, chunks = asyncio.run(export(args.output, args.output_dir, args.chunk_size))
    destination = args.output_dir or args.output
    print(f"Generated {destination}: {imported} companies with websites/domains")
    print(f"Skipped {skipped} companies without a website/domain")
    print(f"SQL files: {chunks}")
    print("No remote database was modified; execute the files with Wrangler when ready.")


if __name__ == "__main__":
    main()
