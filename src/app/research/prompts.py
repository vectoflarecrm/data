from __future__ import annotations

from app.core.config import get_settings
from app.db.models import Company

_RULES = """Rules:
- Base every claim strictly on the provided source text.
- NEVER invent, derive, or guess email addresses, phone numbers, social handles,
  product names, brands, founded years or people that are not in the text.
- When information is absent, use UNKNOWN, empty lists or null — never fabricate.
- Do not infer personal contact details.
- Output must be a single JSON object matching the requested schema exactly."""

_CHAR_BUDGET_DEFAULT = 20000


def _budget() -> int:
    return get_settings().research_prompt_char_budget


def truncate_to(text: str, limit: int | None = None) -> str:
    limit = limit or _budget()
    if len(text) <= limit:
        return text
    return text[:limit] + "\n... [truncated]"


def company_intro(company: Company) -> str:
    return (
        f"Company: {company.company_name}\n"
        f"Website: {company.website or company.normalized_domain or 'unknown'}\n"
        f"Country: {company.country or company.country_code or 'unknown'}"
    )


def company_research_prompt(company: Company, crawl_text: str) -> tuple[str, str]:
    system = (
        "You are a B2B intelligence analyst. Extract a structured company research "
        "profile for the watersports industry.\n" + _RULES
    )
    user = (
        f"{company_intro(company)}\n\n"
        "Crawled website text:\n\n"
        f"{truncate_to(crawl_text)}\n\n"
        "Produce CompanyResearchResult with description, company_type, main_products "
        "(ProductCategory enum values), brands, social_accounts, buying_signals and "
        "evidence claims (evidence confidence is your best judgement, prefer HIGH only "
        "when the page states it verbatim)."
    )
    return system, user


def contacts_prompt(company: Company, crawl_text: str) -> tuple[str, str]:
    system = (
        "You are a B2B contact researcher for the watersports trade. Extract people "
        "who are business decision makers: purchasing managers, buyers, procurement, "
        "owners, founders, general managers, CEOs, import managers.\n" + _RULES
    )
    user = (
        f"{company_intro(company)}\n\n"
        "Source text:\n\n"
        f"{truncate_to(crawl_text)}\n\n"
        'Produce a JSON array under the key "contacts" of ContactResearchResult objects. '
        "Only include people that appear in the text. Set role to UNKNOWN when the role "
        "is not stated. Never guess email addresses."
    )
    return system, user


def social_prompt(company: Company, crawl_text: str, found_links: list[str]) -> tuple[str, str]:
    system = (
        "You are a social media researcher. Identify the company's official public "
        "social accounts. Do not attribute similarly named accounts without evidence.\n" + _RULES
    )
    user = (
        f"{company_intro(company)}\n\n"
        "Candidate links found on the site:\n" + "\n".join(found_links or ["(none)"]) + "\n\n"
        "Produce SocialResearchResult with official accounts only."
    )
    return system, user


def products_prompt(company: Company, crawl_text: str) -> tuple[str, str]:
    system = (
        "You are a product analyst for the watersports industry. Identify the "
        "company's products and product categories.\n" + _RULES
    )
    user = (
        f"{company_intro(company)}\n\n"
        "Source text:\n\n"
        f"{truncate_to(crawl_text)}\n\n"
        'Produce ProductListResult (key "products") each with product_name, category '
        "(ProductCategory enum), brand if stated, url if found, evidence claims and confidence."
    )
    return system, user


def verification_prompt(
    company: Company, crawl_text: str, discovered: list[str]
) -> tuple[str, str]:
    system = (
        "You are a data verification analyst. Confirm or refute whether each "
        "contact detail appears in the source text.\n" + _RULES
    )
    user = (
        f"{company_intro(company)}\n\n"
        "Details to verify:\n" + "\n".join(discovered or ["(none)"]) + "\n\nSource text:\n\n"
        f"{truncate_to(crawl_text)}\n\n"
        'Output a JSON object with key "results" of objects {value, confirmed: bool, '
        "reason: str}. Only confirm when the value literally appears in the text."
    )
    return system, user
