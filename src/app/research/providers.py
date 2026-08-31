from __future__ import annotations

from app.crawlers.factory import CompositeCrawler, build_crawler

_injected_crawler: CompositeCrawler | None = None
_injected_ai = None
_default_crawler: CompositeCrawler | None = None
_default_ai = None


def configure_research_providers(*, crawler=None, ai=None) -> None:
    """Override the research providers (used by tests; idempotent)."""
    global _injected_crawler, _injected_ai
    _injected_crawler = crawler if crawler is not None else _injected_crawler
    _injected_ai = ai if ai is not None else _injected_ai


def reset_research_providers() -> None:
    global _injected_crawler, _injected_ai
    _injected_crawler = None
    _injected_ai = None


def get_research_crawler() -> CompositeCrawler:
    global _default_crawler
    if _injected_crawler is not None:
        return _injected_crawler
    if _default_crawler is None:
        _default_crawler = build_crawler()
    return _default_crawler


def get_research_ai():
    global _default_ai
    if _injected_ai is not None:
        return _injected_ai
    if _default_ai is None:
        from app.ai.factory import build_ai_provider

        _default_ai = build_ai_provider()
    return _default_ai
