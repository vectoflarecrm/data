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


def extract_contact_fields(company: Company) -> dict[str, str | None]:
    """Extract primary contact info from the first contact record."""
    result: dict[str, str | None] = {
        "first_name": None,
        "last_name": None,
        "full_name": None,
        "title": None,
        "department": None,
        "linkedin_url": None,
        "tel": None,
        "email": None,
        "cellphone": None,
        "whatsapp": None,
    }
    if not company.contacts:
        return result
    contact = company.contacts[0]
    result["first_name"] = contact.first_name
    result["last_name"] = contact.last_name
    result["full_name"] = contact.full_name
    result["title"] = contact.job_title
    result["department"] = contact.department
    result["linkedin_url"] = contact.linkedin_url
    for method in contact.methods:
        mtype = str(method.method_type).lower()
        value = method.value
        if "email" in mtype and not result["email"]:
            result["email"] = value
        elif "phone" in mtype or "tel" in mtype or "cell" in mtype or "mobile" in mtype:
            if "whatsapp" in mtype or "wa.me" in (value or ""):
                result["whatsapp"] = value
            elif not result["cellphone"]:
                result["cellphone"] = value
            elif not result["tel"]:
                result["tel"] = value
    return result


def social_accounts_json(company: Company) -> str | None:
    """Collect all social accounts for the company."""
    accounts: list[dict[str, str | None]] = []
    seen: set[str] = set()
    for contact in company.contacts:
        for acc in contact.social_accounts:
            key = f"{acc.platform}:{acc.username or acc.profile_url}"
            if key in seen:
                continue
            seen.add(key)
            accounts.append({
                "platform": str(acc.platform),
                "url": acc.profile_url,
                "username": acc.username,
                "display_name": acc.display_name,
            })
    return json.dumps(accounts, ensure_ascii=False) if accounts else None


def products_services_text(company: Company) -> str | None:
    """Build a products & services summary text."""
    parts: list[str] = []
    if company.main_products_summary:
        parts.append(company.main_products_summary)
    product_names = [
        link.product.name
        for link in company.products
        if link.product is not None
    ]
    if product_names:
        parts.append(", ".join(dict.fromkeys(product_names)))
    return " | ".join(parts) if parts else None


def business_tag_text(company: Company) -> str | None:
    """Build business tag from company type flags."""
    tags: list[str] = []
    flag_map = [
        (company.distributor, "Distributor"),
        (company.wholesaler, "Wholesaler"),
        (company.retailer, "Dealer"),
        (company.ecommerce, "E-commerce"),
        (company.rental, "Rental/User"),
        (company.manufacturer, "Manufacturer"),
        (company.oem, "OEM"),
        (company.importer, "Importer"),
    ]
    for flag, tag in flag_map:
        if flag and tag not in tags:
            tags.append(tag)
    return ", ".join(tags) if tags else None


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
    contact = extract_contact_fields(company)
    street_address = company.address or None
    zip_city = " ".join([p for p in [company.postal_code, company.city] if p]) or None
    products = products_services_text(company)
    biz_tag = business_tag_text(company)
    social = social_accounts_json(company)
    company_type_str = ", ".join(company.company_type) if company.company_type else None
    target_markets_str = ", ".join(company.target_markets) if company.target_markets else None
    remarks = "数据来源：本地 PostgreSQL 公司与联系人记录；等待 Worker 网页核验。"
    return (
        "INSERT INTO customers "
        "(company_id, domain, status, company_name, first_name, last_name, full_name, title, department, linkedin_url, "
        "street_address, zip_city, country, country_code, region, city, postal_code, tel, email, cellphone, whatsapp, "
        "products_services, business_tag, industry, company_type, business_model, founded_year, employee_range, "
        "description, target_markets, legal_name, trading_name, normalized_domain, "
        "is_manufacturer, is_importer, is_distributor, is_wholesaler, is_retailer, is_ecommerce, is_rental, is_oem, "
        "social_accounts, customer_segment, personas_and_solutions, remarks) VALUES ("
        f"{sql_literal(company_id)}, {sql_literal(domain)}, 'pending', "
        f"{sql_literal(company.company_name)}, "
        f"{sql_literal(contact['first_name'])}, {sql_literal(contact['last_name'])}, "
        f"{sql_literal(contact['full_name'])}, {sql_literal(contact['title'])}, "
        f"{sql_literal(contact['department'])}, {sql_literal(contact['linkedin_url'])}, "
        f"{sql_literal(street_address)}, {sql_literal(zip_city)}, "
        f"{sql_literal(company.country)}, {sql_literal(company.country_code)}, "
        f"{sql_literal(company.region)}, {sql_literal(company.city)}, "
        f"{sql_literal(company.postal_code)}, "
        f"{sql_literal(contact['tel'])}, {sql_literal(contact['email'])}, "
        f"{sql_literal(contact['cellphone'])}, {sql_literal(contact['whatsapp'])}, "
        f"{sql_literal(products)}, {sql_literal(biz_tag)}, "
        f"{sql_literal(company.industry)}, {sql_literal(company_type_str)}, "
        f"{sql_literal(company.business_model)}, {company.founded_year or 'NULL'}, "
        f"{sql_literal(company.employee_range)}, "
        f"{sql_literal(company.description)}, {sql_literal(target_markets_str)}, "
        f"{sql_literal(company.legal_name)}, {sql_literal(company.trading_name)}, "
        f"{sql_literal(company.normalized_domain)}, "
        f"{int(bool(company.manufacturer))}, {int(bool(company.importer))}, "
        f"{int(bool(company.distributor))}, {int(bool(company.wholesaler))}, "
        f"{int(bool(company.retailer))}, {int(bool(company.ecommerce))}, "
        f"{int(bool(company.rental))}, {int(bool(company.oem))}, "
        f"{sql_literal(social)}, "
        f"{sql_literal(segment)}, {sql_literal(details)}, {sql_literal(remarks)}) "
        "ON CONFLICT(company_id) DO UPDATE SET "
        "domain=excluded.domain, "
        "company_name=COALESCE(customers.company_name, excluded.company_name), "
        "first_name=COALESCE(customers.first_name, excluded.first_name), "
        "last_name=COALESCE(customers.last_name, excluded.last_name), "
        "full_name=COALESCE(customers.full_name, excluded.full_name), "
        "title=COALESCE(customers.title, excluded.title), "
        "department=COALESCE(customers.department, excluded.department), "
        "linkedin_url=COALESCE(customers.linkedin_url, excluded.linkedin_url), "
        "street_address=COALESCE(customers.street_address, excluded.street_address), "
        "zip_city=COALESCE(customers.zip_city, excluded.zip_city), "
        "country=COALESCE(customers.country, excluded.country), "
        "country_code=COALESCE(customers.country_code, excluded.country_code), "
        "region=COALESCE(customers.region, excluded.region), "
        "city=COALESCE(customers.city, excluded.city), "
        "postal_code=COALESCE(customers.postal_code, excluded.postal_code), "
        "tel=COALESCE(customers.tel, excluded.tel), "
        "email=COALESCE(customers.email, excluded.email), "
        "cellphone=COALESCE(customers.cellphone, excluded.cellphone), "
        "whatsapp=COALESCE(customers.whatsapp, excluded.whatsapp), "
        "products_services=COALESCE(customers.products_services, excluded.products_services), "
        "business_tag=COALESCE(customers.business_tag, excluded.business_tag), "
        "industry=COALESCE(customers.industry, excluded.industry), "
        "company_type=COALESCE(customers.company_type, excluded.company_type), "
        "business_model=COALESCE(customers.business_model, excluded.business_model), "
        "founded_year=COALESCE(customers.founded_year, excluded.founded_year), "
        "employee_range=COALESCE(customers.employee_range, excluded.employee_range), "
        "description=COALESCE(customers.description, excluded.description), "
        "target_markets=COALESCE(customers.target_markets, excluded.target_markets), "
        "legal_name=COALESCE(customers.legal_name, excluded.legal_name), "
        "trading_name=COALESCE(customers.trading_name, excluded.trading_name), "
        "normalized_domain=COALESCE(customers.normalized_domain, excluded.normalized_domain), "
        "is_manufacturer=COALESCE(customers.is_manufacturer, excluded.is_manufacturer), "
        "is_importer=COALESCE(customers.is_importer, excluded.is_importer), "
        "is_distributor=COALESCE(customers.is_distributor, excluded.is_distributor), "
        "is_wholesaler=COALESCE(customers.is_wholesaler, excluded.is_wholesaler), "
        "is_retailer=COALESCE(customers.is_retailer, excluded.is_retailer), "
        "is_ecommerce=COALESCE(customers.is_ecommerce, excluded.is_ecommerce), "
        "is_rental=COALESCE(customers.is_rental, excluded.is_rental), "
        "is_oem=COALESCE(customers.is_oem, excluded.is_oem), "
        "social_accounts=COALESCE(customers.social_accounts, excluded.social_accounts), "
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
