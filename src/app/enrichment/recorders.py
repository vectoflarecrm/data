from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import (
    ActivityLevel,
    BrandRelationship,
    BusinessOrPersonal,
    ContactStatus,
    DecisionPower,
    EventType,
    Importance,
    MethodType,
    Platform,
    PurchasingRole,
    Seniority,
    VerificationStatus,
)
from app.db.models import (
    Brand,
    Company,
    CompanyBrand,
    CompanyEvent,
    Contact,
    ContactMethod,
    SocialAccount,
)


def _norm_name(value: str | None) -> str:
    return " ".join((value or "").split()).lower()


def _method_norm(method: MethodType, value: str) -> str | None:
    value = value.strip()
    if method in (MethodType.EMAIL,):
        return value.lower()
    if method in (MethodType.PHONE, MethodType.MOBILE, MethodType.WHATSAPP):
        digits = "".join(ch for ch in value if ch.isdigit())
        if value.startswith("+"):
            return "+" + digits
        return digits or None
    return value


class ContactRecorder:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.created = 0
        self.updated = 0

    async def upsert(
        self,
        *,
        company_id: uuid.UUID,
        full_name: str,
        first_name: str | None = None,
        last_name: str | None = None,
        job_title: str | None = None,
        role: PurchasingRole = PurchasingRole.UNKNOWN,
        seniority: Seniority = Seniority.UNKNOWN,
        decision_power: DecisionPower = DecisionPower.UNKNOWN,
        linkedin_url: str | None = None,
        confidence: float = 0.0,
        evidence_id: uuid.UUID | None = None,
        apply_updates: bool = True,
    ) -> Contact:
        existing = await self.find(company_id, full_name)
        if existing is not None:
            if not apply_updates:
                return existing
            if not existing.first_name and first_name:
                existing.first_name = first_name
            if not existing.last_name and last_name:
                existing.last_name = last_name
            if not existing.job_title and job_title:
                existing.job_title = job_title
            if (
                existing.purchasing_role == PurchasingRole.UNKNOWN
                and role != PurchasingRole.UNKNOWN
            ):
                existing.purchasing_role = role
            if existing.seniority == Seniority.UNKNOWN and seniority != Seniority.UNKNOWN:
                existing.seniority = seniority
            if not existing.linkedin_url and linkedin_url:
                existing.linkedin_url = linkedin_url
            existing.confidence = max(existing.confidence or 0.0, confidence)
            self.updated += 1
            return existing
        contact = Contact(
            company_id=company_id,
            full_name=full_name,
            first_name=first_name,
            last_name=last_name,
            job_title=job_title,
            purchasing_role=role if role != PurchasingRole.UNKNOWN else None,
            seniority=seniority if seniority != Seniority.UNKNOWN else None,
            decision_power=decision_power if decision_power != DecisionPower.UNKNOWN else None,
            linkedin_url=linkedin_url,
            status=ContactStatus.ACTIVE,
            confidence=confidence,
        )
        self.session.add(contact)
        await self.session.flush()
        self.created += 1
        return contact

    async def find(self, company_id: uuid.UUID, full_name: str) -> Contact | None:
        stmt = select(Contact).where(
            Contact.company_id == company_id,
            Contact.full_name == full_name,
        )
        return (await self.session.execute(stmt)).scalars().first()


class ContactMethodRecorder:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.created = 0
        self.skipped = 0

    async def upsert(
        self,
        *,
        contact_id: uuid.UUID,
        company_id: uuid.UUID,
        method: MethodType,
        value: str,
        verification: VerificationStatus = VerificationStatus.UNVERIFIED,
        confidence: float = 0.0,
        is_business: bool = True,
        evidence_id: uuid.UUID | None = None,
        source_url: str | None = None,
    ) -> ContactMethod | None:
        normalized = _method_norm(method, value)
        if not value.strip() or normalized == "":
            return None
        stmt = select(ContactMethod).where(
            ContactMethod.contact_id == contact_id,
            ContactMethod.method_type == method,
            ContactMethod.normalized_value == normalized,
        )
        existing = (await self.session.execute(stmt)).scalars().first()
        if existing is not None:
            if (
                existing.verification_status == VerificationStatus.UNVERIFIED
                and verification != VerificationStatus.UNVERIFIED
            ):
                existing.verification_status = verification
            if (existing.confidence or 0.0) < confidence:
                existing.confidence = confidence
            self.skipped += 1
            return existing
        row = ContactMethod(
            contact_id=contact_id,
            company_id=company_id,
            method_type=method,
            value=value,
            normalized_value=normalized,
            is_business=is_business,
            public_or_private=_public_or_private(is_business),
            verification_status=verification,
            confidence=confidence,
            source_evidence_id=evidence_id,
        )
        self.session.add(row)
        await self.session.flush()
        self.created += 1
        return row


class SocialRecorder:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.created = 0
        self.skipped = 0

    async def upsert(
        self,
        *,
        company_id: uuid.UUID,
        platform: Platform,
        profile_url: str,
        contact_id: uuid.UUID | None = None,
        display_name: str | None = None,
        business_or_personal: BusinessOrPersonal = BusinessOrPersonal.UNKNOWN,
        activity_level: ActivityLevel = ActivityLevel.UNKNOWN,
        verification: VerificationStatus = VerificationStatus.UNVERIFIED,
        confidence: float = 0.0,
        evidence_id: uuid.UUID | None = None,
    ) -> SocialAccount | None:
        if not profile_url.strip():
            return None
        stmt = select(SocialAccount).where(
            SocialAccount.company_id == company_id,
            SocialAccount.platform == platform,
            SocialAccount.profile_url == profile_url,
        )
        existing = (await self.session.execute(stmt)).scalars().first()
        if existing is not None:
            if (
                existing.business_or_personal == BusinessOrPersonal.UNKNOWN
                and business_or_personal != BusinessOrPersonal.UNKNOWN
            ):
                existing.business_or_personal = business_or_personal
            if (existing.confidence or 0.0) < confidence:
                existing.confidence = confidence
            self.skipped += 1
            return existing
        row = SocialAccount(
            company_id=company_id,
            contact_id=contact_id,
            platform=platform,
            profile_url=profile_url,
            display_name=display_name,
            business_or_personal=business_or_personal,
            activity_level=activity_level,
            verification_status=verification,
            confidence=confidence,
            source_evidence_id=evidence_id,
        )
        self.session.add(row)
        await self.session.flush()
        self.created += 1
        return row


class BrandRecorder:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.created = 0

    async def link(
        self,
        *,
        company_id: uuid.UUID,
        brand_name: str,
        relationship: BrandRelationship = BrandRelationship.OWNED,
        evidence_id: uuid.UUID | None = None,
    ) -> CompanyBrand | None:
        name = brand_name.strip()
        if not name:
            return None
        brand_stmt = select(Brand).where(Brand.name == name)
        brand = (await self.session.execute(brand_stmt)).scalars().first()
        if brand is None:
            brand = Brand(name=name)
            self.session.add(brand)
            await self.session.flush()
            self.created += 1
        link_stmt = select(CompanyBrand).where(
            CompanyBrand.company_id == company_id,
            CompanyBrand.brand_id == brand.id,
            CompanyBrand.relationship_type == relationship,
        )
        existing = (await self.session.execute(link_stmt)).scalars().first()
        if existing is not None:
            return existing
        row = CompanyBrand(
            company_id=company_id,
            brand_id=brand.id,
            relationship_type=relationship,
            source_evidence_id=evidence_id,
        )
        self.session.add(row)
        await self.session.flush()
        return row


class EventRecorder:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.created = 0
        self.skipped = 0

    async def record(
        self,
        *,
        company_id: uuid.UUID,
        event_type: EventType,
        title: str,
        description: str | None = None,
        importance: Importance = Importance.MEDIUM,
        evidence_id: uuid.UUID | None = None,
        event_date: datetime | None = None,
    ) -> CompanyEvent | None:
        clean_title = " ".join((title or "").split())[:255]
        if not clean_title:
            return None
        stmt = select(CompanyEvent).where(
            CompanyEvent.company_id == company_id,
            CompanyEvent.event_type == event_type,
            CompanyEvent.title == clean_title,
        )
        existing = (await self.session.execute(stmt)).scalars().first()
        if existing is not None:
            self.skipped += 1
            return existing
        row = CompanyEvent(
            company_id=company_id,
            event_type=event_type,
            title=clean_title,
            description=description,
            importance=importance,
            source_evidence_id=evidence_id,
        )
        self.session.add(row)
        await self.session.flush()
        self.created += 1
        return row


class CompanyResearchUpdater:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    @staticmethod
    def _better(current, new) -> bool:
        return bool(new) and (current is None or current == "" or current == " ")

    async def apply_description(self, company: Company, description: str | None) -> bool:
        if self._better(company.description, description):
            company.description = description
            return True
        return False

    async def apply_type(self, company: Company, types: list[str]) -> None:
        """Apply only positively-known type flags; never silently drop existing ones."""
        known = {getattr(t, "value", t) for t in types} if types else set()
        if not known:
            return
        company.company_type = sorted(set(company.company_type or []) | known)
        for value, attr in (
            ("MANUFACTURER", "manufacturer"),
            ("IMPORTER", "importer"),
            ("DISTRIBUTOR", "distributor"),
            ("WHOLESALER", "wholesaler"),
            ("RETAILER", "retailer"),
            ("ECOMMERCE", "ecommerce"),
            ("RENTAL", "rental"),
            ("OEM", "oem"),
            ("ODM", "oem"),
        ):
            if value in known:
                setattr(company, attr, True)

    async def mark_researched(self, company: Company, level: str, status: str) -> None:
        from app.core.enums import ResearchLevel, ResearchStatus

        company.research_level = ResearchLevel(level)
        company.research_status = ResearchStatus(status)
        company.last_researched_at = datetime.now(UTC)


def _public_or_private(is_business: bool):
    from app.core.enums import PrivacyLabel

    return PrivacyLabel.PUBLIC if is_business else PrivacyLabel.UNKNOWN
