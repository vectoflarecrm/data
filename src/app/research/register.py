from __future__ import annotations

from app.core.enums import TaskType
from app.research.executor import register_handler

_registered = False


def register_all() -> None:
    global _registered
    if _registered:
        return
    _registered = True

    def step(name: str):
        async def handler(session, task):
            from app.enrichment.pipeline import ResearchPipeline
            from app.research.providers import get_research_ai, get_research_crawler

            pipeline = ResearchPipeline(get_research_crawler(), get_research_ai())
            return await getattr(pipeline, name)(session, task)

        return handler

    register_handler(TaskType.COMPANY_DISCOVERY, step("run_company_discovery"))
    register_handler(TaskType.COMPANY_RESEARCH, step("run_company_research"))
    register_handler(TaskType.PRODUCT_RESEARCH, step("run_product_research"))
    register_handler(TaskType.BRAND_RESEARCH, step("run_brand_research"))
    register_handler(TaskType.CONTACT_DISCOVERY, step("run_contact_discovery"))
    register_handler(TaskType.EMAIL_DISCOVERY, step("run_email_discovery"))
    register_handler(TaskType.PHONE_DISCOVERY, step("run_phone_discovery"))
    register_handler(TaskType.WHATSAPP_DISCOVERY, step("run_whatsapp_discovery"))
    register_handler(TaskType.SOCIAL_DISCOVERY, step("run_social_discovery"))
    register_handler(TaskType.VERIFICATION, step("run_verification"))
    register_handler(TaskType.BUYING_SIGNAL_RESEARCH, step("run_buying_signal_research"))
    register_handler(TaskType.FULL_ENRICHMENT, step("run_full_enrichment"))
    register_handler(TaskType.LEAD_SCORING, step("run_lead_scoring"))


def register_research_handlers() -> None:
    register_all()
