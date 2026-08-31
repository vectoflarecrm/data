from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Company, Contact, ResearchEvidence


class AIWritePolicyError(ValueError):
    """Raised when an AI result tries to write outside the approved boundary."""


# Identity and operational fields are deliberately excluded. They require a
# human/API update or a separately reviewed import workflow.
AI_COMPANY_FIELDS = frozenset(
    {
        "company.description",
        "company.company_type",
        "company.main_products_summary",
    }
)
AI_CONTACT_FIELDS = frozenset(
    {
        "contact.full_name",
        "contact.job_title",
        "contact.department",
        "contact.seniority",
        "contact.purchasing_role",
        "contact.decision_power",
        "contact.linkedin_url",
        "contact.bio",
    }
)


class AIWritePolicy:
    """Apply only evidence-backed AI candidates to safe, non-identity fields."""

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    @staticmethod
    def _valid_evidence(
        evidence: ResearchEvidence | None,
        *,
        company_id: uuid.UUID,
        field_name: str,
    ) -> bool:
        return bool(
            evidence is not None
            and evidence.company_id == company_id
            and evidence.field_name == field_name
            and evidence.extraction_method in {"ai", "ai_candidate"}
        )

    def require_company_field(self, field_name: str) -> None:
        if field_name not in AI_COMPANY_FIELDS:
            raise AIWritePolicyError(f"AI cannot write company field: {field_name}")

    def require_contact_field(self, field_name: str) -> None:
        if field_name not in AI_CONTACT_FIELDS:
            raise AIWritePolicyError(f"AI cannot write contact field: {field_name}")

    async def apply_company_description(
        self,
        company: Company,
        value: str | None,
        evidence: ResearchEvidence | None,
    ) -> bool:
        field_name = "company.description"
        self.require_company_field(field_name)
        if not value or not self._valid_evidence(
            evidence, company_id=company.id, field_name=field_name
        ):
            return False
        # A non-empty value may have been entered by a user or import. Do not
        # let an AI run silently replace it; a reviewed conflict workflow can.
        if company.description:
            return False
        company.description = value
        return True

    async def apply_company_type(
        self,
        company: Company,
        types: list[str],
        evidence: list[ResearchEvidence],
    ) -> bool:
        field_name = "company.company_type"
        self.require_company_field(field_name)
        if not types or not any(
            self._valid_evidence(row, company_id=company.id, field_name=field_name)
            for row in evidence
        ):
            return False
        known = {getattr(value, "value", value) for value in types if value}
        if not known:
            return False
        before = set(company.company_type or [])
        company.company_type = sorted(before | known)
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
        return bool(known - before)

    async def apply_products_summary(
        self,
        company: Company,
        value: str | None,
        evidence: ResearchEvidence | None,
    ) -> bool:
        field_name = "company.main_products_summary"
        self.require_company_field(field_name)
        if not value or not self._valid_evidence(
            evidence, company_id=company.id, field_name=field_name
        ):
            return False
        incoming = [part.strip() for part in value.split(",") if part.strip()]
        current = [part.strip() for part in (company.main_products_summary or "").split(",") if part.strip()]
        merged = list(dict.fromkeys(current + incoming))
        if merged == current:
            return False
        company.main_products_summary = ", ".join(merged)
        return True

    async def apply_contact_field(
        self,
        contact: Contact,
        *,
        field_name: str,
        value: Any,
        evidence: ResearchEvidence | None,
    ) -> bool:
        self.require_contact_field(field_name)
        if not value or not self._valid_evidence(
            evidence, company_id=contact.company_id, field_name=field_name
        ):
            return False
        attribute = field_name.removeprefix("contact.")
        if attribute == "full_name":
            return False if contact.full_name else False
        if getattr(contact, attribute, None):
            return False
        setattr(contact, attribute, value)
        return True

    async def apply_contact_name(
        self,
        contact: Contact,
        value: str,
        evidence: ResearchEvidence | None,
    ) -> bool:
        # Names identify a person and are never replaced. A new contact row is
        # created from the candidate name before this method is called.
        self.require_contact_field("contact.full_name")
        return bool(value and self._valid_evidence(
            evidence, company_id=contact.company_id, field_name="contact.full_name"
        ))
