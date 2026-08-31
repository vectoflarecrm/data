from __future__ import annotations

import csv
import io

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.enums import MethodType, Platform
from app.db.models import Company, CompanyBrand, Contact

EXPORT_HEADERS = [
    "Company",
    "Legal Name",
    "Trading Name",
    "Website",
    "Country",
    "Country Code",
    "Region",
    "City",
    "Address",
    "Postal Code",
    "Industry",
    "Company Type",
    "Business Model",
    "Founded Year",
    "Employee Range",
    "Description",
    "Products",
    "Target Markets",
    "Notes",
    "Manufacturer",
    "Importer",
    "Distributor",
    "Wholesaler",
    "Retailer",
    "Ecommerce",
    "Rental",
    "OEM",
    "First Name",
    "Last Name",
    "Title",
    "Email",
    "Phone",
    "WhatsApp",
    "LinkedIn",
    "Instagram",
    "Facebook",
    "Brands",
]


def _flags(company: Company) -> dict[str, str]:
    return {
        "Manufacturer": "yes" if company.manufacturer else "",
        "Importer": "yes" if company.importer else "",
        "Distributor": "yes" if company.distributor else "",
        "Wholesaler": "yes" if company.wholesaler else "",
        "Retailer": "yes" if company.retailer else "",
        "Ecommerce": "yes" if company.ecommerce else "",
        "Rental": "yes" if company.rental else "",
        "OEM": "yes" if company.oem else "",
    }


def _contacts_rows(company: Company) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    contacts = company.contacts
    if not contacts:
        return [{}]
    for contact in contacts:
        base = {
            "First Name": contact.first_name or "",
            "Last Name": contact.last_name or "",
            "Title": contact.job_title or "",
            "Email": "",
            "Phone": "",
            "WhatsApp": "",
            "LinkedIn": "",
            "Instagram": "",
            "Facebook": "",
        }
        for method in contact.methods:
            key = {
                MethodType.EMAIL: "Email",
                MethodType.PHONE: "Phone",
                MethodType.WHATSAPP: "WhatsApp",
            }.get(method.method_type)
            if key and not base[key]:
                base[key] = method.value
        for social in contact.social_accounts:
            key = {
                Platform.LINKEDIN: "LinkedIn",
                Platform.INSTAGRAM: "Instagram",
                Platform.FACEBOOK: "Facebook",
            }.get(social.platform)
            if key and not base[key]:
                base[key] = social.profile_url or ""
        rows.append(base)
    return rows


def companies_to_rows(companies: list[Company]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for company in companies:
        markers = _flags(company)
        brands = "; ".join(link.brand.name for link in company.brands if link.brand)
        for contact_row in _contacts_rows(company):
            row: dict[str, str] = {
                "Company": company.company_name,
                "Legal Name": company.legal_name or "",
                "Trading Name": company.trading_name or "",
                "Website": company.website or "",
                "Country": company.country or "",
                "Country Code": company.country_code or "",
                "Region": company.region or "",
                "City": company.city or "",
                "Address": company.address or "",
                "Postal Code": company.postal_code or "",
                "Industry": company.industry or "",
                "Company Type": ", ".join(company.company_type or [])
                if company.company_type
                else "",
                "Business Model": company.business_model or "",
                "Founded Year": str(company.founded_year) if company.founded_year else "",
                "Employee Range": company.employee_range or "",
                "Description": company.description or "",
                "Products": company.main_products_summary or "",
                "Target Markets": ", ".join(company.target_markets or []),
                "Notes": "",
                "Brands": brands,
            }
            row.update(markers)
            row.update(contact_row)
            out.append(row)
    return out


async def export_companies(session: AsyncSession) -> str:
    result = await session.execute(
        select(Company).options(
            selectinload(Company.contacts).selectinload(Contact.methods),
            selectinload(Company.contacts).selectinload(Contact.social_accounts),
            selectinload(Company.social_accounts),
            selectinload(Company.brands).selectinload(CompanyBrand.brand),
        )
    )
    companies = list(result.scalars().unique().all())
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=EXPORT_HEADERS, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(companies_to_rows(companies))
    return buffer.getvalue()
