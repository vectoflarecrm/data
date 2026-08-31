from __future__ import annotations

import logging
from collections.abc import Sequence

from app.core.config import get_settings
from app.crawlers.crawl4ai_provider import Crawl4AIProvider
from app.crawlers.errors import CrawlerError, ProviderUnavailable, RobotsBlocked
from app.crawlers.httpx_provider import HttpxProvider
from app.crawlers.playwright_provider import PlaywrightProvider
from app.crawlers.schema import CrawlOptions, CrawlResult

logger = logging.getLogger(__name__)


class CompositeCrawler:
    """Tries providers in order; falls back on genuine crawler failures (not robots blocks)."""

    name = "composite-provider"

    def __init__(self, providers: Sequence) -> None:
        self.providers = list(providers)

    async def crawl(self, url: str, options: CrawlOptions | None = None) -> CrawlResult:
        last_error: CrawlResult | None = None
        for provider in self.providers:
            try:
                result = await provider.crawl(url, options)
            except RobotsBlocked:
                raise
            except CrawlerError as exc:
                last_error = CrawlResult(
                    url=url, status_code=0, error=str(exc), provider=getattr(provider, "name", None)
                )
                continue
            if result.ok and not result.error:
                return result
            last_error = result
        return last_error or CrawlResult(url=url, status_code=0, error="no crawler available")

    async def close(self) -> None:
        for provider in self.providers:
            closer = getattr(provider, "close", None)
            if closer is not None:
                await closer()


def build_crawler() -> CompositeCrawler:
    """Select providers by enabled flags; primary crawl4ai, fallback httpx, optional playwright."""
    settings = get_settings()
    providers: list = []
    if settings.crawl4ai_enabled:
        try:
            providers.append(Crawl4AIProvider())
        except ProviderUnavailable as exc:
            logger.warning("Crawl4AI unavailable, falling back to httpx: %s", exc)
    providers.append(HttpxProvider())
    if settings.playwright_enabled:
        try:
            providers.append(PlaywrightProvider())
        except ProviderUnavailable as exc:
            logger.warning("Playwright unavailable: %s", exc)
    return CompositeCrawler(providers)
