from __future__ import annotations

import csv
import hashlib
import io
import re
import uuid

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    BrandRelationship,
    CompanyStatus,
    MethodType,
    Platform,
    ResearchLevel,
    ResearchStatus,
    SourceType,
    TaskStatus,
    TaskType,
)
from app.core.normalization import (
    is_valid_email,
    is_valid_url,
    normalize_domain,
    normalize_email,
    normalize_full_name,
    normalize_name,
    normalize_phone,
)
from app.core.product_categories import map_product_category
from app.db.models import (
    Brand,
    Company,
    CompanyBrand,
    CompanyProduct,
    Contact,
    ContactMethod,
    EmailSuppression,
    Product,
    ResearchEvidence,
    ResearchTask,
    SocialAccount,
)
from app.enrichment.discovery import is_direct_contact_email

_TRUE_VALUES = {"1", "true", "yes", "y", "t"}
_SPLIT_RE = re.compile(r"[;,.|/]+|\band\b|\b&\b")

_COLUMN_ALIASES: dict[str, set[str]] = {
    "company_name": {"company", "company name", "company_name", "business name"},
    "name": {"name"},
    "legal_name": {"legal name", "legal_name"},
    "trading_name": {"trading name", "trading_name"},
    "website": {"website", "url", "web", "web site", "website url"},
    "country": {"country"},
    "country_code": {"country code", "country_code", "cc", "iso code"},
    "region": {"region", "state", "province"},
    "city": {"city"},
    "address": {"address", "street address", "street"},
    "postal_code": {"postal code", "postal_code", "zip code", "zip", "postcode"},
    "industry": {"industry", "sector"},
    "company_type": {"company type", "company_type", "business type", "type"},
    "business_model": {"business model", "business_model", "model"},
    "founded_year": {"founded year", "founded_year", "year founded", "founded"},
    "employee_range": {"employee range", "employee_range", "employees", "size", "headcount"},
    "description": {"description", "about", "company description"},
    "products": {"products", "product", "product category", "product categories", "product lines"},
    "target_markets": {"target markets", "target_market", "markets"},
    "notes": {"notes", "note", "remarks", "comments", "internal notes"},
    "manufacturer": {"manufacturer"},
    "importer": {"importer"},
    "distributor": {"distributor", "dealer"},
    "wholesaler": {"wholesaler"},
    "retailer": {"retailer", "retail"},
    "ecommerce": {"ecommerce", "e-commerce", "online store", "online"},
    "rental": {"rental", "rentals"},
    "oem": {"oem"},
    "contact_name": {"contact", "contact name", "contact_name", "person", "full name", "full_name"},
    "first_name": {"first name", "first_name", "given name"},
    "last_name": {"last name", "last_name", "surname", "family name"},
    "title": {"title", "job title", "job_title", "position", "role"},
    "email": {"email", "email address", "email_address", "e-mail"},
    "phone": {"phone", "telephone", "tel", "phone number", "phone_number", "mobile"},
    "whatsapp": {"whatsapp", "whatsapp number", "whatsapp_phone", "whatsapp phone"},
    "linkedin": {"linkedin", "linkedin url", "linkedin_url", "linkedin profile"},
    "instagram": {"instagram", "instagram url", "instagram_url"},
    "facebook": {"facebook", "facebook url", "facebook_url"},
    "brands": {"brands", "brand", "brand names", "brands carried"},
    "email_reason": {"reason", "error reason", "email reason", "failure reason"},
    "email_details": {"details", "error details", "email details", "notes"},
}

_COMPANY_SCALAR_FIELDS = (
    "legal_name",
    "trading_name",
    "country",
    "country_code",
    "region",
    "city",
    "address",
    "postal_code",
    "industry",
    "business_model",
    "founded_year",
    "employee_range",
    "description",
)
_COMPANY_TYPE_MAP = {
    "manufacturer": "MANUFACTURER",
    "importer": "IMPORTER",
    "distributor": "DISTRIBUTOR",
    "wholesaler": "WHOLESALER",
    "retailer": "RETAILER",
    "ecommerce": "ECOMMERCE",
    "rental": "RENTAL",
    "oem": "OEM",
}
_FLAG_TO_COMPANY_TYPE = {
    "manufacturer": "MANUFACTURER",
    "importer": "IMPORTER",
    "distributor": "DISTRIBUTOR",
    "wholesaler": "WHOLESALER",
    "retailer": "RETAILER",
    "ecommerce": "ECOMMERCE",
    "rental": "RENTAL",
    "oem": "OEM",
}

_METHOD_FIELDS = {
    "email": MethodType.EMAIL,
    "phone": MethodType.PHONE,
    "whatsapp": MethodType.WHATSAPP,
}
_SOCIAL_FIELDS = {
    "linkedin": Platform.LINKEDIN,
    "instagram": Platform.INSTAGRAM,
    "facebook": Platform.FACEBOOK,
}


class ImportReport(BaseModel):
    rows_processed: int = 0
    companies_created: int = 0
    companies_updated: int = 0
    contacts_created: int = 0
    contacts_updated: int = 0
    evidence_created: int = 0
    brands_linked: int = 0
    products_linked: int = 0
    research_tasks_created: int = 0
    potential_duplicates: list[str] = Field(default_factory=list)
    invalid_emails: list[str] = Field(default_factory=list)
    invalid_urls: list[str] = Field(default_factory=list)
    missing_websites: list[str] = Field(default_factory=list)
    missing_countries: list[str] = Field(default_factory=list)
    conflicting_values: list[str] = Field(default_factory=list)
    rows_requiring_review: list[str] = Field(default_factory=list)

    @property
    def summary(self) -> dict[str, object]:
        return {
            "Rows processed": self.rows_processed,
            "Companies created": self.companies_created,
            "Companies updated": self.companies_updated,
            "Contacts created": self.contacts_created,
            "Contacts updated": self.contacts_updated,
            "Evidence created": self.evidence_created,
            "Brands linked": self.brands_linked,
            "Products linked": self.products_linked,
            "Research tasks created": self.research_tasks_created,
            "Potential duplicates": self.potential_duplicates,
            "Invalid emails": self.invalid_emails,
            "Invalid URLs": self.invalid_urls,
            "Missing websites": self.missing_websites,
            "Missing countries": self.missing_countries,
            "Conflicting values": self.conflicting_values,
            "Rows requiring review": self.rows_requiring_review,
        }


def _content_hash(source_type: SourceType, field_name: str, value: str, scope: str) -> str:
    return hashlib.sha256(f"{source_type}|{field_name}|{value}|{scope}".encode()).hexdigest()


async def _evidence_exists(session: AsyncSession, content_hash: str, company_id: uuid.UUID) -> bool:
    stmt = select(ResearchEvidence.id).where(
        ResearchEvidence.content_hash == content_hash,
        ResearchEvidence.company_id == company_id,
    )
    return (await session.execute(stmt)).scalars().first() is not None


def _split_list(value: str | None) -> list[str]:
    if not value:
        return []
    parts = [normalize_name(p) for p in _SPLIT_RE.split(value) if normalize_name(p)]
    seen: list[str] = []
    for p in parts:
        if p.lower() not in {s.lower() for s in seen}:
            seen.append(p)
    return seen


def _parse_bool(value: str | None) -> bool:
    if not value:
        return False
    return value.strip().lower() in _TRUE_VALUES


def _detect_columns(headers: list[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for header in headers:
        key = normalize_name(header).lower()
        for canonical, aliases in _COLUMN_ALIASES.items():
            if key in aliases:
                mapping[header] = canonical
                break
    if "company_name" not in mapping.values() and "name" in mapping.values():
        mapping = {h: ("company_name" if v == "name" else v) for h, v in mapping.items()}
    return mapping


def _normalize_row(row: dict[str, str], mapped: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for header, canonical in mapped.items():
        value = row.get(header)
        if value is not None:
            out.setdefault(canonical, str(value).strip().strip("\ufeff"))
    return out


class CsvImporter:
    """Import companies from CSV text into the database.

    The importer normalizes values, deduplicates companies by normalized domain
    (or normalized name), merges incomplete records, records every imported value
    as IMPORTED_DATA evidence, never silently overwrites existing data on
    conflict, and enqueues website-discovery research tasks when websites are
    missing.
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.report = ImportReport()

    async def import_text(self, text: str, *, suppression_only: bool = False) -> ImportReport:
        self.report = ImportReport()
        rows = list(csv.DictReader(io.StringIO(text)))
        if not rows:
            return self.report
        mapped = _detect_columns(list(rows[0].keys()))
        for row in rows:
            self.report.rows_processed += 1
            normalized = _normalize_row(row, mapped)
            if suppression_only:
                await self._process_suppression(normalized)
            else:
                await self._process_row(normalized)
        return self.report

    async def _process_suppression(self, row: dict[str, str]) -> None:
        raw = row.get("email") or row.get("email_address")
        if not raw:
            self.report.rows_requiring_review.append("missing email")
            return
        normalized = normalize_email(raw)
        if not normalized or not is_valid_email(normalized):
            self.report.invalid_emails.append(raw)
            return
        existing = (await self.session.execute(
            select(EmailSuppression).where(EmailSuppression.normalized_email == normalized)
        )).scalars().first()
        if existing is None:
            self.session.add(EmailSuppression(
                normalized_email=normalized,
                original_email=raw,
                reason=row.get("email_reason") or "UNKNOWN",
                details=row.get("email_details"),
                source="CSV_IMPORT",
            ))
        else:
            existing.reason = row.get("email_reason") or existing.reason
            existing.details = row.get("email_details") or existing.details

    async def _process_row(self, row: dict[str, str]) -> None:
        name = row.get("company_name") or row.get("name") or row.get("contact_name") or ""
        if not name:
            self.report.rows_requiring_review.append(row.get("_source", "row"))
            return
        name = normalize_name(name)

        website: str | None = row.get("website") or None
        domain = normalize_domain(website) if website else None
        if website and not is_valid_url(website):
            fixed = (
                f"https://{website}" if not website.startswith(("http://", "https://")) else website
            )
            if "." in fixed and " " not in fixed and is_valid_url(fixed):
                website = fixed
                domain = normalize_domain(website)
            else:
                self.report.invalid_urls.append(website)
                website = None
                domain = None

        company, created = await self._resolve_company(name, domain)
        if created:
            self.report.companies_created += 1
            company.company_name = name
            company.website = website
            company.normalized_domain = domain
            company.country = row.get("country")
            company.country_code = row.get("country_code")
            company.region = row.get("region")
            company.city = row.get("city")
            company.address = row.get("address")
            company.postal_code = row.get("postal_code")
            company.industry = row.get("industry")
            company.business_model = row.get("business_model")
            company.founded_year = self._to_int(row.get("founded_year"))
            company.employee_range = row.get("employee_range")
            company.description = row.get("notes") or row.get("description")
            company.company_type = self._detect_company_types(row)
            company_target_markets = _split_list(row.get("target_markets"))
            if company_target_markets:
                company.target_markets = company_target_markets
            company.company_status = CompanyStatus.UNKNOWN
            company.research_status = ResearchStatus.NEW
            company.research_level = ResearchLevel.L0
            self.session.add(company)
            await self.session.flush()
        else:
            self.report.companies_updated += 1
            await self._merge_scalar_fields(company, row)
            merged_types = list(company.company_type or [])
            for t in self._detect_company_types(row):
                if t not in merged_types:
                    merged_types.append(t)
            company.company_type = merged_types
            if company.website:
                if website and normalize_domain(company.website) != domain:
                    self.report.conflicting_values.append(
                        f"{company.company_name}: website '{company.website}' vs '{website}'"
                    )
            elif website:
                company.website = website
            if not company.description and (row.get("notes") or row.get("description")):
                company.description = row.get("notes") or row.get("description")

        if self._no_value(row.get("country")):
            self.report.missing_countries.append(company.company_name)
        if company.normalized_domain is None:
            self.report.missing_websites.append(company.company_name)
            await self._ensure_website_discovery_task(company)

        await self._record_company_evidence(company, row)
        await self._process_products(company, row)
        await self._process_brands(company, row)
        await self._process_contact(company, row)

    async def _resolve_company(self, name: str, domain: str | None) -> tuple[Company, bool]:
        if domain:
            stmt = select(Company).where(Company.normalized_domain == domain)
            result = (await self.session.execute(stmt)).scalars().all()
            if len(result) > 1:
                self.report.potential_duplicates.extend(c.company_name for c in result[1:])
                self.report.rows_requiring_review.extend(c.company_name for c in result[1:])
            if result:
                return result[0], False
            stmt2 = select(Company).where(func.lower(Company.company_name) == name.lower())
            by_name = (await self.session.execute(stmt2)).scalars().all()
            if by_name:
                self.report.potential_duplicates.append(f"{name} (by name)")
                self.report.rows_requiring_review.append(name)
                return by_name[0], False
            return Company(), True

        stmt = select(Company).where(func.lower(Company.company_name) == name.lower())
        result = (await self.session.execute(stmt)).scalars().all()
        if len(result) > 1:
            self.report.potential_duplicates.extend(c.company_name for c in result[1:])
            self.report.rows_requiring_review.extend(c.company_name for c in result[1:])
        if result:
            return result[0], False
        return Company(), True

    async def _merge_scalar_fields(self, company: Company, row: dict[str, str]) -> None:
        for field in _COMPANY_SCALAR_FIELDS:
            incoming = row.get(field)
            if not incoming:
                continue
            current = getattr(company, field)
            if current is None or current == "":
                setattr(company, field, incoming)
                continue
            if field == "founded_year":
                incoming_int = self._to_int(incoming)
                if incoming_int is not None and current != incoming_int:
                    if current is None:
                        company.founded_year = incoming_int
                    else:
                        self.report.conflicting_values.append(
                            f"{company.company_name}: {field} '{current}' vs '{incoming}'"
                        )
                continue
            if str(current).strip().lower() != str(incoming).strip().lower():
                self.report.conflicting_values.append(
                    f"{company.company_name}: {field} '{current}' vs '{incoming}'"
                )

    async def _ensure_website_discovery_task(self, company: Company) -> None:
        stmt = select(ResearchTask).where(
            ResearchTask.company_id == company.id,
            ResearchTask.task_type == TaskType.COMPANY_DISCOVERY,
            ResearchTask.status.in_([TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.RETRY]),
        )
        existing = (await self.session.execute(stmt)).scalars().first()
        if existing is None:
            self.session.add(
                ResearchTask(
                    company_id=company.id,
                    task_type=TaskType.COMPANY_DISCOVERY,
                    priority=50,
                    status=TaskStatus.PENDING,
                )
            )
            self.report.research_tasks_created += 1

    async def _record_company_evidence(self, company: Company, row: dict[str, str]) -> None:
        import_evidence_fields = [
            "company_name",
            "website",
            "country",
            "country_code",
            "region",
            "city",
            "address",
            "postal_code",
            "industry",
            "company_type",
            "business_model",
            "founded_year",
            "employee_range",
            "description",
            "target_markets",
        ]
        for field in import_evidence_fields:
            value = row.get(field)
            if not value:
                continue
            content_hash = _content_hash(SourceType.IMPORTED_DATA, field, value, str(company.id))
            if await _evidence_exists(self.session, content_hash, company.id):
                continue
            self.session.add(
                ResearchEvidence(
                    company_id=company.id,
                    field_name=field,
                    value=value,
                    source_type=SourceType.IMPORTED_DATA,
                    evidence_text=value,
                    confidence="MEDIUM",
                    content_hash=content_hash,
                )
            )
            self.report.evidence_created += 1

    async def _process_products(self, company: Company, row: dict[str, str]) -> None:
        tokens = _split_list(row.get("products"))
        if not tokens:
            return
        company.main_products_summary = "; ".join(tokens)
        for token in tokens:
            category = map_product_category(token)
            if category is None:
                continue
            existing = (
                (
                    await self.session.execute(
                        select(Product).where(func.lower(Product.name) == token.lower())
                    )
                )
                .scalars()
                .first()
            )
            if existing is None:
                existing = Product(name=token, category=category)
                self.session.add(existing)
                await self.session.flush()
            link = (
                await self.session.execute(
                    select(CompanyProduct.id).where(
                        CompanyProduct.company_id == company.id,
                        CompanyProduct.product_id == existing.id,
                    )
                )
            ).scalars().first()
            if link is None:
                self.session.add(CompanyProduct(company_id=company.id, product_id=existing.id))
                self.report.products_linked += 1

    async def _process_brands(self, company: Company, row: dict[str, str]) -> None:
        for token in _split_list(row.get("brands")):
            brand = (
                (
                    await self.session.execute(
                        select(Brand).where(func.lower(Brand.name) == token.lower())
                    )
                )
                .scalars()
                .first()
            )
            if brand is None:
                brand = Brand(name=token)
                self.session.add(brand)
                await self.session.flush()
            link_exists = (
                (
                    await self.session.execute(
                        select(CompanyBrand.id).where(
                            CompanyBrand.company_id == company.id,
                            CompanyBrand.brand_id == brand.id,
                        )
                    )
                )
                .scalars()
                .first()
            )
            if link_exists is None:
                self.session.add(
                    CompanyBrand(
                        company_id=company.id,
                        brand_id=brand.id,
                        relationship_type=BrandRelationship.DISTRIBUTOR,
                    )
                )
            self.report.brands_linked += 1

    async def _process_contact(self, company: Company, row: dict[str, str]) -> None:
        full_name = normalize_full_name(
            row.get("first_name"), row.get("last_name")
        ) or normalize_name(row.get("contact_name") or "")

        email = row.get("email")
        email_n = None
        if email:
            normalized_email = normalize_email(email)
            if not is_valid_email(normalized_email) or not is_direct_contact_email(normalized_email):
                self.report.invalid_emails.append(email)
                email = None
            else:
                email_n = normalized_email

        phone = row.get("phone")
        phone_n = normalize_phone(phone) if phone else None
        # An imported WhatsApp value has no explicit public WhatsApp signal.
        # Keep it out of contact methods until a wa.me/API link is verified.
        whatsapp = None

        contact_fields = [
            full_name,
            email,
            phone,
            whatsapp,
            row.get("title"),
            row.get("linkedin"),
            row.get("instagram"),
            row.get("facebook"),
        ]
        if not any(contact_fields):
            return

        contact = None
        if email_n:
            contact = await self._find_contact_by_method(company.id, MethodType.EMAIL, email_n)
        if contact is None and full_name:
            contact = (
                (
                    await self.session.execute(
                        select(Contact).where(
                            Contact.company_id == company.id,
                            func.lower(Contact.full_name) == full_name.lower(),
                        )
                    )
                )
                .scalars()
                .first()
            )
        if contact is None and phone_n:
            contact = await self._find_contact_by_method(company.id, MethodType.PHONE, phone_n)

        if contact is None:
            contact = Contact(
                company_id=company.id,
                full_name=full_name or "Unknown Contact",
                first_name=normalize_name(row.get("first_name") or ""),
                last_name=normalize_name(row.get("last_name") or ""),
                job_title=normalize_name(row.get("title") or ""),
            )
            self.session.add(contact)
            await self.session.flush()
            self.report.contacts_created += 1
        else:
            self.report.contacts_updated += 1
            if contact.full_name == "Unknown Contact" and full_name:
                contact.full_name = full_name
            if not contact.first_name and row.get("first_name"):
                contact.first_name = normalize_name(row["first_name"])
            if not contact.last_name and row.get("last_name"):
                contact.last_name = normalize_name(row["last_name"])
            if not contact.job_title and row.get("title"):
                contact.job_title = normalize_name(row["title"])

        for key, method_type, raw_value, norm_value in [
            ("email", MethodType.EMAIL, email, email_n),
            ("phone", MethodType.PHONE, phone, phone_n),
        ]:
            if not raw_value or norm_value is None:
                continue
            if method_type == MethodType.EMAIL:
                suppressed = (await self.session.execute(
                    select(EmailSuppression.id).where(EmailSuppression.normalized_email == norm_value)
                )).scalars().first()
                if suppressed is not None:
                    continue
            if await self._method_exists(company.id, contact.id, method_type, norm_value):
                continue
            is_primary = await self._needs_primary(company.id, contact.id)
            self.session.add(
                ContactMethod(
                    contact_id=contact.id,
                    company_id=company.id,
                    method_type=method_type,
                    value=raw_value,
                    normalized_value=norm_value,
                    is_primary=is_primary,
                    is_business=True,
                    verification_status="INFERRED",
                    confidence=0.6,
                )
            )
            content_hash = _content_hash(
                SourceType.IMPORTED_DATA, f"{key}:{contact.id}", norm_value, str(company.id)
            )
            if await _evidence_exists(self.session, content_hash, company.id):
                continue
            self.session.add(
                ResearchEvidence(
                    company_id=company.id,
                    contact_id=contact.id,
                    field_name=key,
                    value=norm_value,
                    source_type=SourceType.IMPORTED_DATA,
                    evidence_text=raw_value,
                    source_url=row.get("website") or None,
                    confidence="MEDIUM",
                    content_hash=content_hash,
                )
            )
            self.report.evidence_created += 1

        for key, platform in _SOCIAL_FIELDS.items():
            value = row.get(key)
            if not value:
                continue
            value = value.strip()
            if not value.startswith(("http://", "https://")):
                value = f"https://{value}"
            if not is_valid_url(value):
                self.report.invalid_urls.append(value)
                continue
            existing = (
                (
                    await self.session.execute(
                        select(SocialAccount.id).where(
                            SocialAccount.company_id == company.id,
                            SocialAccount.platform == platform,
                            SocialAccount.profile_url == value,
                        )
                    )
                )
                .scalars()
                .first()
            )
            if existing is None:
                self.session.add(
                    SocialAccount(
                        company_id=company.id,
                        contact_id=contact.id if full_name else None,
                        platform=platform,
                        profile_url=value,
                        verification_status="INFERRED",
                        confidence=0.6,
                    )
                )

    async def _find_contact_by_method(
        self, company_id: uuid.UUID, method_type: MethodType, norm_value: str
    ) -> Contact | None:
        stmt = (
            select(Contact)
            .join(ContactMethod, ContactMethod.contact_id == Contact.id)
            .where(
                ContactMethod.company_id == company_id,
                ContactMethod.method_type == method_type,
                ContactMethod.normalized_value == norm_value,
            )
        )
        return (await self.session.execute(stmt)).scalars().first()

    async def _method_exists(
        self, company_id: uuid.UUID, contact_id: uuid.UUID, method_type: MethodType, norm_value: str
    ) -> bool:
        stmt = select(ContactMethod.id).where(
            ContactMethod.company_id == company_id,
            ContactMethod.contact_id == contact_id,
            ContactMethod.method_type == method_type,
            ContactMethod.normalized_value == norm_value,
        )
        return (await self.session.execute(stmt)).scalars().first() is not None

    async def _needs_primary(self, company_id: uuid.UUID, contact_id: uuid.UUID) -> bool:
        stmt = select(ContactMethod.id).where(
            ContactMethod.company_id == company_id,
            ContactMethod.contact_id == contact_id,
            ContactMethod.is_primary.is_(True),
        )
        return (await self.session.execute(stmt)).scalars().first() is None

    def _detect_company_types(self, row: dict[str, str]) -> list[str]:
        types: list[str] = []
        raw = row.get("company_type")
        for token in _split_list(raw):
            token = token.upper().replace(" ", "_")
            if token in _COMPANY_TYPE_MAP.values() and token not in types:
                types.append(token)
        for flag, ctype in _FLAG_TO_COMPANY_TYPE.items():
            if _parse_bool(row.get(flag)) and ctype not in types:
                types.append(ctype)
        return types

    @staticmethod
    def _to_int(value: str | None) -> int | None:
        if not value:
            return None
        digits = re.sub(r"\D", "", value)
        return int(digits) if digits else None

    @staticmethod
    def _no_value(value: str | None) -> bool:
        return not value or not value.strip()
