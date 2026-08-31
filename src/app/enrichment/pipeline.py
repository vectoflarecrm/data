from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.schema import (
    CompanyResearchResult,
    ContactListResult,
    ContactResearchResult,
    ProductListResult,
    SocialResearchResult,
)
from app.core.config import get_settings
from app.core.enums import (
    BrandRelationship,
    EventType,
    EvidenceConfidence,
    Importance,
    MethodType,
    Platform,
    PurchasingRole,
    SourceType,
    VerificationStatus,
)
from app.crawlers.orchestrator import CrawlOrchestrator
from app.crawlers.schema import CrawlOptions, CrawlSessionResult
from app.db.models import Company, CompanyProduct, EmailSuppression, Product
from app.enrichment.ai_write import AIWritePolicy
from app.enrichment.conflict import ConflictDetector
from app.enrichment.discovery import (
    detect_buying_signals,
    extract_emails,
    extract_phones,
    extract_social_links,
    extract_whatsapp_numbers,
)
from app.enrichment.evidence import EvidenceRecorder, verification_to_confidence
from app.enrichment.recorders import (
    BrandRecorder,
    CompanyResearchUpdater,
    ContactMethodRecorder,
    ContactRecorder,
    EventRecorder,
    SocialRecorder,
)
from app.research.prompts import (
    company_research_prompt,
    contacts_prompt,
    products_prompt,
    social_prompt,
)
from app.research.workers import TaskOutcome

logger = logging.getLogger(__name__)


def _settings():
    return get_settings()


def _page_budget() -> int:
    return _settings().research_page_text_budget


def _page_block(url: str, text: str) -> str:
    text = " ".join(text.split())
    return f"## {url}\n{text[: _page_budget()]}"


def _crawl_text(results: list) -> str:
    blocks = [_page_block(r.url, r.text) for r in results if r.ok and r.text]
    return "\n\n".join(blocks)


def _summary(session_result: CrawlSessionResult) -> str:
    return (
        f"fetched={session_result.fetched} failed={session_result.failed} "
        f"truncated={session_result.truncated}"
    )


class ResearchPipeline:
    """Orchestrates crawler + AI providers into persisted research per task type."""

    def __init__(self, crawler, ai) -> None:
        self.crawler = crawler
        self.ai = ai
        self.orchestrator = CrawlOrchestrator()
        self._crawl_cache: dict[uuid.UUID, CrawlSessionResult] = {}

    # -- helpers ---------------------------------------------------------
    def _crawl_options(
        self, website: str, *, limits: int | None = None, depth: int | None = None
    ) -> CrawlOptions:
        s = _settings()
        return CrawlOptions(
            url=website,
            max_depth=depth if depth is not None else s.max_depth,
            page_limit=limits if limits is not None else s.max_pages_per_company,
            delay_seconds=s.request_delay_seconds,
            timeout_seconds=s.httpx_timeout_seconds,
            respect_robots=True,
        )

    async def _site_crawl(self, company: Company) -> CrawlSessionResult:
        cached = self._crawl_cache.get(company.id)
        if cached is not None:
            return cached
        website = _resolve_website(company)
        if not website:
            raise ValueError("no website or domain to research")
        return await self.orchestrator.crawl_site(
            self.crawler, website, self._crawl_options(website)
        )

    async def _company(self, session: AsyncSession, company_id: uuid.UUID) -> Company | None:
        return (
            (await session.execute(select(Company).where(Company.id == company_id)))
            .scalars()
            .first()
        )

    async def _conflict_guard(
        self,
        session: AsyncSession,
        *,
        company_id: uuid.UUID,
        field_name: str,
        value: str,
        source_type: SourceType,
        confidence: EvidenceConfidence,
    ) -> bool:
        """Do not silently overwrite higher-confidence evidence; record conflicts instead."""
        detector = ConflictDetector(session)
        verdict = await detector.resolve(
            company_id=company_id,
            field_name=field_name,
            value=value,
            source_type=source_type,
            confidence=confidence,
        )
        if verdict.accept:
            return True
        if verdict.opposing is not None:
            await detector.record_conflict(
                company_id=company_id,
                field_name=field_name,
                primary_value=value,
                opposing_value=verdict.opposing.value or "",
            )
        return False

    async def _record_company_contacts(
        self,
        session: AsyncSession,
        company: Company,
        contacts: list[ContactResearchResult],
        evidence: EvidenceRecorder,
    ) -> int:
        changed = 0
        contact_recorder = ContactRecorder(session)
        method_recorder = ContactMethodRecorder(session)
        social_recorder = SocialRecorder(session)
        for item in contacts:
            await evidence.record(
                company_id=company.id,
                field_name="contact.full_name",
                value=item.name,
                source_type=SourceType.OFFICIAL_TEAM_PAGE,
                extraction_method="ai",
                confidence=(
                    EvidenceConfidence.HIGH
                    if item.confidence >= 0.8
                    else EvidenceConfidence.MEDIUM
                    if item.confidence >= 0.5
                    else EvidenceConfidence.LOW
                ),
            )
            contact = await contact_recorder.upsert(
                company_id=company.id,
                full_name=item.name,
                confidence=item.confidence,
                apply_updates=False,
            )
            changed += 1
            field_candidates = (
                ("contact.job_title", item.title),
                ("contact.seniority", item.seniority),
                ("contact.purchasing_role", item.role),
                ("contact.linkedin_url", _linkedin_of(item)),
            )
            for field_name, candidate in field_candidates:
                if candidate is None or candidate == "" or getattr(candidate, "value", candidate) in {
                    "UNKNOWN",
                    "",
                }:
                    continue
                candidate_value = getattr(candidate, "value", candidate)
                candidate_evidence = await evidence.record(
                    company_id=company.id,
                    contact_id=contact.id,
                    field_name=field_name,
                    value=str(candidate_value),
                    source_type=SourceType.OFFICIAL_TEAM_PAGE,
                    extraction_method="ai",
                    confidence=(
                        EvidenceConfidence.HIGH
                        if item.confidence >= 0.8
                        else EvidenceConfidence.MEDIUM
                        if item.confidence >= 0.5
                        else EvidenceConfidence.LOW
                    ),
                )
                if candidate_evidence is not None:
                    await AIWritePolicy(session).apply_contact_field(
                        contact,
                        field_name=field_name,
                        value=candidate,
                        evidence=candidate_evidence,
                    )
            verified = _verified_from_confidence(item.confidence)
            source_type: SourceType = SourceType.OFFICIAL_TEAM_PAGE
            if item.email is not None and await self._conflict_guard(
                session,
                company_id=company.id,
                field_name="contact.email",
                value=item.email.value,
                source_type=source_type,
                confidence=verification_to_confidence(item.email.verification),
            ):
                result = await evidence.record(
                    company_id=company.id,
                    contact_id=contact.id,
                    field_name="contact.email",
                    value=item.email.value,
                    source_type=source_type,
                    extraction_method="ai",
                    confidence=verification_to_confidence(item.email.verification),
                )
                await method_recorder.upsert(
                    contact_id=contact.id,
                    company_id=company.id,
                    method=MethodType.EMAIL,
                    value=item.email.value,
                    verification=item.email.verification,
                    confidence=item.email.confidence,
                    evidence_id=result.id if result else None,
                )
            for phone in item.phones:
                if not await self._conflict_guard(
                    session,
                    company_id=company.id,
                    field_name="contact.phone",
                    value=phone.value,
                    source_type=source_type,
                    confidence=verification_to_confidence(phone.verification),
                ):
                    continue
                recovered = await evidence.record(
                    company_id=company.id,
                    contact_id=contact.id,
                    field_name="contact.phone",
                    value=phone.value,
                    source_type=source_type,
                    extraction_method="ai",
                    confidence=verification_to_confidence(phone.verification),
                )
                await method_recorder.upsert(
                    contact_id=contact.id,
                    company_id=company.id,
                    method=phone.method,
                    value=phone.value,
                    verification=phone.verification,
                    confidence=phone.confidence,
                    evidence_id=recovered.id if recovered else None,
                )
            for social in item.social_accounts:
                if not await self._conflict_guard(
                    session,
                    company_id=company.id,
                    field_name=f"contact.social.{social.platform.value}",
                    value=social.url,
                    source_type=SourceType.OFFICIAL_SOCIAL,
                    confidence=EvidenceConfidence.MEDIUM
                    if social.confidence >= 0.5
                    else EvidenceConfidence.LOW,
                ):
                    continue
                evidence_row = await evidence.record(
                    company_id=company.id,
                    contact_id=contact.id,
                    field_name=f"contact.social.{social.platform.value}",
                    value=social.url,
                    source_type=SourceType.OFFICIAL_SOCIAL,
                    extraction_method="ai",
                    confidence=EvidenceConfidence.MEDIUM
                    if social.confidence >= 0.5
                    else EvidenceConfidence.LOW,
                )
                await social_recorder.upsert(
                    company_id=company.id,
                    contact_id=contact.id,
                    platform=social.platform,
                    profile_url=social.url,
                    display_name=social.handle,
                    business_or_personal=social.business_or_personal,
                    verification=verified,
                    confidence=social.confidence,
                    evidence_id=evidence_row.id if evidence_row else None,
                )
        return changed

    # -- tasks -----------------------------------------------------------
    async def run_company_research(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to crawl")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        system, prompt = company_research_prompt(company, _crawl_text(crawl.results))
        result = await self.ai.complete_structured(
            result_type=CompanyResearchResult, system=system, prompt=prompt
        )
        evidence = EvidenceRecorder(session)
        write_policy = AIWritePolicy(session)
        updater = CompanyResearchUpdater(session)
        brand_recorder = BrandRecorder(session)
        social_recorder = SocialRecorder(session)
        event_recorder = EventRecorder(session)
        for claim in result.evidence:
            await evidence.record_claim(company_id=company.id, claim=claim)
        confidence = (
            EvidenceConfidence.HIGH
            if result.confidence >= 0.8
            else EvidenceConfidence.MEDIUM
            if result.confidence >= 0.5
            else EvidenceConfidence.LOW
        )
        description_evidence = await evidence.record(
            company_id=company.id,
            field_name="company.description",
            value=result.description,
            source_type=SourceType.OFFICIAL_WEBSITE,
            extraction_method="ai",
            confidence=confidence,
        )
        await write_policy.apply_company_description(company, result.description, description_evidence)
        type_evidence = await evidence.record(
            company_id=company.id,
            field_name="company.company_type",
            value=", ".join(item.value for item in result.company_type) or None,
            source_type=SourceType.OFFICIAL_WEBSITE,
            extraction_method="ai",
            confidence=confidence,
        )
        await write_policy.apply_company_type(company, list(result.company_type), [type_evidence] if type_evidence else [])
        product_evidence = await evidence.record(
            company_id=company.id,
            field_name="company.main_products_summary",
            value=", ".join(item.value for item in result.main_products) or None,
            source_type=SourceType.OFFICIAL_WEBSITE,
            extraction_method="ai",
            confidence=confidence,
        )
        await write_policy.apply_products_summary(
            company,
            ", ".join(item.value for item in result.main_products) or None,
            product_evidence,
        )
        relationship = _default_brand_relationship(company)
        for brand_name in result.brands:
            evidence_row = await evidence.record(
                company_id=company.id,
                field_name="brand.name",
                value=brand_name,
                source_type=SourceType.OFFICIAL_WEBSITE,
                extraction_method="ai",
                confidence=EvidenceConfidence.MEDIUM
                if result.confidence >= 0.6
                else EvidenceConfidence.LOW,
            )
            await brand_recorder.link(
                company_id=company.id,
                brand_name=brand_name,
                relationship=relationship,
                evidence_id=evidence_row.id if evidence_row else None,
            )
        for social in result.social_accounts:
            evidence_row = await evidence.record(
                company_id=company.id,
                field_name=f"social.{social.platform.value}",
                value=social.url,
                source_type=SourceType.OFFICIAL_SOCIAL,
                extraction_method="ai",
                confidence=EvidenceConfidence.MEDIUM
                if social.confidence >= 0.5
                else EvidenceConfidence.LOW,
            )
            await social_recorder.upsert(
                company_id=company.id,
                platform=social.platform,
                profile_url=social.url,
                display_name=social.handle,
                business_or_personal=social.business_or_personal,
                verification=_verified_from_confidence(social.confidence),
                confidence=social.confidence,
                evidence_id=evidence_row.id if evidence_row else None,
            )
        for signal in result.buying_signals:
            evidence_row = await evidence.record(
                company_id=company.id,
                field_name=f"buying_signal.{signal.signal_type.value}",
                value=signal.description or "detected",
                source_type=SourceType.OFFICIAL_WEBSITE,
                extraction_method="ai",
                confidence=EvidenceConfidence.MEDIUM
                if signal.confidence >= 0.5
                else EvidenceConfidence.LOW,
            )
            await event_recorder.record(
                company_id=company.id,
                event_type=signal.signal_type,
                title=signal.description or signal.signal_type.value,
                description=signal.description,
                importance=Importance.MEDIUM,
                evidence_id=evidence_row.id if evidence_row else None,
            )
        if result.contacts:
            await self._record_company_contacts(session, company, result.contacts, evidence)
        await updater.mark_researched(company, "L2", "COMPANY_RESEARCHED")
        return TaskOutcome(
            "completed",
            f"company researched: {len(result.evidence)} evidence, {len(result.brands)} brands, "
            f"{len(result.social_accounts)} socials, {len(result.contacts)} contacts ({_summary(crawl)})",
        )

    async def run_contact_discovery(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to crawl")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        system, prompt = contacts_prompt(company, _crawl_text(crawl.results))
        result = await self.ai.complete_structured(
            result_type=ContactListResult, system=system, prompt=prompt
        )
        if result.contacts:
            evidence = EvidenceRecorder(session)
            created = await self._record_company_contacts(
                session, company, result.contacts, evidence
            )
            await CompanyResearchUpdater(session).mark_researched(
                company, "L4", "CONTACT_RESEARCHED"
            )
            return TaskOutcome("completed", f"contacts recorded: {created}")
        return TaskOutcome("completed", "no contacts found in source text")

    async def run_product_research(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to crawl")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        system, prompt = products_prompt(company, _crawl_text(crawl.results))
        result = await self.ai.complete_structured(
            result_type=ProductListResult, system=system, prompt=prompt
        )
        evidence = EvidenceRecorder(session)
        write_policy = AIWritePolicy(session)
        brands = set()
        categories: set[str] = set()
        summary_evidence = None
        for product in result.products:
            categories.add(product.category.value)
            if product.brand:
                brands.add(product.brand)
            for claim in product.evidence:
                await evidence.record_claim(company_id=company.id, claim=claim)
            product_evidence = await evidence.record(
                company_id=company.id,
                field_name=f"product.{product.category.value}",
                value=product.product_name,
                source_url=product.url,
                source_type=SourceType.OFFICIAL_PRODUCT_PAGE,
                extraction_method="ai",
                confidence=EvidenceConfidence.MEDIUM
                if product.confidence >= 0.5
                else EvidenceConfidence.LOW,
            )
            if summary_evidence is None:
                summary_evidence = product_evidence
            await _upsert_product(session, company.id, product)
        if categories:
            summary_evidence = await evidence.record(
                company_id=company.id,
                field_name="company.main_products_summary",
                value=", ".join(sorted(categories)),
                source_type=SourceType.OFFICIAL_PRODUCT_PAGE,
                extraction_method="ai",
                confidence=EvidenceConfidence.MEDIUM,
            )
            await write_policy.apply_products_summary(
                company, ", ".join(sorted(categories)), summary_evidence
            )
        for brand_name in brands:
            await BrandRecorder(session).link(
                company_id=company.id,
                brand_name=brand_name,
                relationship=_default_brand_relationship(company),
            )
        await CompanyResearchUpdater(session).mark_researched(company, "L3", "PRODUCT_RESEARCHED")
        return TaskOutcome(
            "completed", f"products recorded: {len(result.products)} ({_summary(crawl)})"
        )

    async def run_social_discovery(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to crawl")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        links = [link for r in crawl.results if r.ok for link in r.links]
        found = extract_social_links(links)
        system, prompt = social_prompt(
            company, _crawl_text(crawl.results), [url for url, _ in found]
        )
        result = await self.ai.complete_structured(
            result_type=SocialResearchResult, system=system, prompt=prompt
        )
        social_recorder = SocialRecorder(session)
        evidence = EvidenceRecorder(session)
        seen = 0
        for account in result.accounts:
            profile_url = account.url or _link_for(found, account.platform)
            if not profile_url:
                continue
            evidence_row = await evidence.record(
                company_id=company.id,
                field_name=f"social.{account.platform.value}",
                value=profile_url,
                source_url=profile_url,
                source_type=SourceType.OFFICIAL_SOCIAL,
                extraction_method="ai",
                confidence=EvidenceConfidence.MEDIUM
                if account.confidence >= 0.5
                else EvidenceConfidence.LOW,
            )
            await social_recorder.upsert(
                company_id=company.id,
                platform=account.platform,
                profile_url=profile_url,
                display_name=account.handle,
                business_or_personal=account.business_or_personal,
                activity_level=account.activity_level,
                verification=_verified_from_confidence(account.confidence),
                confidence=account.confidence,
                evidence_id=evidence_row.id if evidence_row else None,
            )
            seen += 1
        if seen:
            await CompanyResearchUpdater(session).mark_researched(
                company, "L6", "SOCIAL_RESEARCHED"
            )
        return TaskOutcome("completed", f"social accounts recorded: {seen} ({_summary(crawl)})")

    async def run_email_discovery(self, session: AsyncSession, task) -> TaskOutcome:
        return await self._run_method_discovery(
            session, task, MethodType.EMAIL, SourceType.OFFICIAL_CONTACT_PAGE
        )

    async def run_phone_discovery(self, session: AsyncSession, task) -> TaskOutcome:
        return await self._run_method_discovery(
            session, task, MethodType.PHONE, SourceType.OFFICIAL_CONTACT_PAGE
        )

    async def run_whatsapp_discovery(self, session: AsyncSession, task) -> TaskOutcome:
        return await self._run_method_discovery(
            session, task, MethodType.WHATSAPP, SourceType.OFFICIAL_CONTACT_PAGE
        )

    async def _run_method_discovery(
        self,
        session: AsyncSession,
        task,
        method: MethodType,
        source_type: SourceType,
    ) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to crawl")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        values: list[tuple[str, float]] = []
        for result_page in crawl.results:
            if not result_page.ok:
                continue
            combined = result_page.text + "\n" + " ".join(result_page.links)
            if method == MethodType.EMAIL:
                for email in extract_emails(result_page.text):
                    values.append((email, _link_confidence(result_page.url)))
            elif method == MethodType.PHONE:
                for original, normalized in extract_phones(result_page.text):
                    values.append((normalized or original, _link_confidence(result_page.url)))
            elif method == MethodType.WHATSAPP:
                for number in extract_whatsapp_numbers(combined, result_page.links):
                    values.append((number, 0.85))
        known = await _known_methods(session, company.id, method)
        fresh = [(v, c) for v, c in values if v.lower() not in {k.lower() for k in known}]
        contact = await _company_contact(session, company)
        evidence = EvidenceRecorder(session)
        methods = ContactMethodRecorder(session)
        recorded = 0
        for value, confidence in fresh:
            if method == MethodType.EMAIL:
                suppressed = (await session.execute(
                    select(EmailSuppression.id).where(EmailSuppression.normalized_email == value.lower())
                )).scalars().first()
                if suppressed is not None:
                    continue
            verification, page_type = (
                (VerificationStatus.VERIFIED, source_type)
                if method == MethodType.WHATSAPP
                else (VerificationStatus.UNVERIFIED, source_type)
            )
            evidence_confidence = (
                EvidenceConfidence.HIGH
                if verification != VerificationStatus.UNVERIFIED
                else EvidenceConfidence.LOW
            )
            if not await self._conflict_guard(
                session,
                company_id=company.id,
                field_name=f"company.{method.value.lower()}",
                value=value,
                source_type=page_type,
                confidence=evidence_confidence,
            ):
                continue
            row = await evidence.record(
                company_id=company.id,
                contact_id=contact.id if contact else None,
                field_name=f"company.{method.value.lower()}",
                value=value,
                source_type=page_type,
                extraction_method="regex",
                confidence=evidence_confidence,
            )
            created = await methods.upsert(
                contact_id=contact.id,
                company_id=company.id,
                method=method,
                value=value,
                verification=verification,
                confidence=confidence,
                is_business=True,
                evidence_id=row.id if row else None,
            )
            recorded += 1 if created else 0
        if recorded:
            await CompanyResearchUpdater(session).mark_researched(
                company,
                "L5",
                "WHATSAPP_RESEARCHED" if method == MethodType.WHATSAPP else "CONTACT_RESEARCHED",
            )
        return TaskOutcome(
            "completed",
            f"{method.value} discovered: {recorded} new, {len(known)} known ({_summary(crawl)})",
        )

    async def run_buying_signal_research(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to crawl")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        evidence = EvidenceRecorder(session)
        events = EventRecorder(session)
        recorded = 0
        for page in crawl.results:
            if not page.ok:
                continue
            for event_type, description, source_url in detect_buying_signals(page.text, page.url):
                evidence_row = await evidence.record(
                    company_id=company.id,
                    field_name=f"buying_signal.{event_type}",
                    value=description,
                    source_url=source_url,
                    source_type=SourceType.OFFICIAL_WEBSITE,
                    extraction_method="rules",
                    confidence=EvidenceConfidence.MEDIUM,
                )
                created = await events.record(
                    company_id=company.id,
                    event_type=EventType(event_type),
                    title=description,
                    description=description,
                    importance=Importance.MEDIUM,
                    evidence_id=evidence_row.id if evidence_row else None,
                )
                if created:
                    recorded += 1
        if recorded:
            await CompanyResearchUpdater(session).mark_researched(company, "L7", "FULLY_ENRICHED")
        return TaskOutcome("completed", f"buying signals: {recorded} ({_summary(crawl)})")

    async def run_verification(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to verify")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        site_text = _crawl_text(crawl.results).lower()
        from app.db.models import ContactMethod

        stmt = select(ContactMethod).where(ContactMethod.company_id == company.id)
        methods = (await session.execute(stmt)).scalars().all()
        evidence = EvidenceRecorder(session)
        verified = 0
        for method in methods:
            probe = (method.value or "").strip().lower()
            if probe and probe in site_text:
                method.verification_status = VerificationStatus.VERIFIED
                method.verified_at = datetime.now(UTC)
                method.confidence = 0.9
                await evidence.record(
                    company_id=company.id,
                    contact_id=method.contact_id,
                    field_name="verification.website_match",
                    value=method.value,
                    source_type=SourceType.OFFICIAL_CONTACT_PAGE,
                    extraction_method="rules",
                    confidence=EvidenceConfidence.HIGH,
                )
                verified += 1
        await CompanyResearchUpdater(session).mark_researched(
            company, "L5", "CONTACT_VERIFIED" if verified else "CONTACT_RESEARCHED"
        )
        return TaskOutcome(
            "completed",
            f"verification: {verified}/{len(methods)} matched on site ({_summary(crawl)})",
        )

    async def run_brand_research(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to crawl")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        system, prompt = products_prompt(company, _crawl_text(crawl.results))
        result = await self.ai.complete_structured(
            result_type=ProductListResult, system=system, prompt=prompt
        )
        brands = {product.brand for product in result.products if product.brand}
        relationship = _default_brand_relationship(company)
        evidence = EvidenceRecorder(session)
        linked = 0
        for brand_name in brands:
            evidence_row = await evidence.record(
                company_id=company.id,
                field_name="brand.name",
                value=brand_name,
                source_type=SourceType.OFFICIAL_PRODUCT_PAGE,
                extraction_method="ai",
                confidence=EvidenceConfidence.MEDIUM,
            )
            created = await BrandRecorder(session).link(
                company_id=company.id,
                brand_name=brand_name,
                relationship=relationship,
                evidence_id=evidence_row.id if evidence_row else None,
            )
            if created is not None:
                linked += 1
        await CompanyResearchUpdater(session).mark_researched(company, "L3", "PRODUCT_RESEARCHED")
        return TaskOutcome("completed", f"brands linked: {linked} ({_summary(crawl)})")

    async def run_full_enrichment(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        website = _resolve_website(company)
        if not website:
            return TaskOutcome("completed", "no website/domain; nothing to do")
        crawl = await self._site_crawl(company)
        if crawl.fetched == 0:
            return TaskOutcome("retry", error=f"crawl returned no pages: {_summary(crawl)}")
        self._crawl_cache[company.id] = crawl
        summaries: list[str] = []
        try:
            for step in (
                self.run_company_research,
                self.run_product_research,
                self.run_brand_research,
                self.run_contact_discovery,
                self.run_email_discovery,
                self.run_phone_discovery,
                self.run_whatsapp_discovery,
                self.run_social_discovery,
            ):
                outcome = await step(session, task)
                if outcome.status == "completed":
                    summaries.append(outcome.summary or "ok")
                else:
                    summaries.append(f"{outcome.status}: {outcome.error or outcome.summary or ''}")
            outcome = await self.run_verification(session, task)
            if outcome.status == "completed":
                summaries.append(outcome.summary or "ok")
            outcome = await self.run_buying_signal_research(session, task)
            if outcome.status == "completed":
                summaries.append(outcome.summary or "ok")
        finally:
            self._crawl_cache.pop(company.id, None)
        await CompanyResearchUpdater(session).mark_researched(company, "L8", "FULLY_ENRICHED")
        return TaskOutcome("completed", "; ".join(summaries))

    async def run_company_discovery(self, session: AsyncSession, task) -> TaskOutcome:
        # Company discovery happens at import time; a queued discovery task is a no-op.
        return TaskOutcome("completed", "company already discovered")

    async def run_lead_scoring(self, session: AsyncSession, task) -> TaskOutcome:
        company = await self._company(session, task.company_id)
        if company is None:
            return TaskOutcome("failed", error="company not found")
        from app.enrichment.scoring import apply_lead_score, describe_company

        components = await describe_company(session, company)
        lead = await apply_lead_score(session, company, components)
        return TaskOutcome("completed", f"lead score: {lead.total_score:.0f} ({lead.grade})")


def _resolve_website(company: Company) -> str | None:
    if company.website:
        return company.website
    if company.normalized_domain:
        return f"https://{company.normalized_domain}"
    return None


def _linkedin_of(item: ContactResearchResult) -> str | None:
    for social in item.social_accounts:
        if social.platform == Platform.LINKEDIN:
            return social.url
    return None


def _verified_from_confidence(confidence: float) -> VerificationStatus:
    return VerificationStatus.VERIFIED if confidence >= 0.8 else VerificationStatus.UNVERIFIED


def _link_confidence(url: str) -> float:
    from app.enrichment.discovery import is_contact_page, is_team_page

    if is_contact_page(url) or is_team_page(url):
        return 0.8
    return 0.5


def _default_brand_relationship(company: Company) -> BrandRelationship:
    if company.manufacturer or company.oem:
        return BrandRelationship.OWNED
    if company.retailer:
        return BrandRelationship.DEALER
    return BrandRelationship.DISTRIBUTOR


async def _upsert_product(session: AsyncSession, company_id: uuid.UUID, product_result) -> None:
    """Upsert into the global product catalog."""
    stmt = select(Product).where(Product.name == product_result.product_name)
    existing = (await session.execute(stmt)).scalars().first()
    if existing is not None:
        if existing.category == product_result.category or existing.category is None:
            existing.category = product_result.category
        if not existing.description and product_result.description:
            existing.description = product_result.description
        product = existing
    else:
        product = Product(
            name=product_result.product_name,
            category=product_result.category,
            description=product_result.description,
        )
        session.add(product)
        await session.flush()
    link = (
        await session.execute(
            select(CompanyProduct).where(
                CompanyProduct.company_id == company_id,
                CompanyProduct.product_id == product.id,
            )
        )
    ).scalars().first()
    if link is None:
        session.add(CompanyProduct(company_id=company_id, product_id=product.id))
        await session.flush()


async def _company_contact(session: AsyncSession, company: Company):
    """The company's general contact row for business-level emails/phones."""
    from app.enrichment.recorders import ContactRecorder

    return await ContactRecorder(session).upsert(
        company_id=company.id,
        full_name=company.company_name,
        role=PurchasingRole.UNKNOWN,
        confidence=0.2,
    )


async def _known_methods(
    session: AsyncSession, company_id: uuid.UUID, method: MethodType
) -> list[str]:
    from app.db.models import ContactMethod

    stmt = select(ContactMethod.normalized_value).where(
        ContactMethod.company_id == company_id,
        ContactMethod.method_type == method,
    )
    rows = (await session.execute(stmt)).scalars().all()
    return [r for r in rows if r]


def _link_for(found: list[tuple[str, Platform]], platform: Platform) -> str | None:
    for url, plat in found:
        if plat == platform:
            return url
    return None
