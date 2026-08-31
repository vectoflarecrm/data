from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from app.crawlers.schema import CrawlOptions, CrawlResult

Handler = Callable[[str, CrawlOptions], Awaitable[CrawlResult]]


class MockCrawlerProvider:
    """Deterministic crawler used in tests — no network access."""

    name = "mock-provider"

    def __init__(
        self,
        handler: Handler | None = None,
        default_status: int = 200,
        delay: float = 0.0,
    ) -> None:
        self._handler = handler
        self.default_status = default_status
        self.delay = delay
        self.urls_seen: list[str] = []

    async def crawl(self, url: str, options: CrawlOptions | None = None) -> CrawlResult:
        opts = options or CrawlOptions(url=url)
        self.urls_seen.append(url)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self._handler is not None:
            return await self._handler(url, opts)
        # Default behaviour: an empty page for the URL.
        return _static_result(url, f"{url}", 200, title=url.rsplit("/", 1)[-1] or url, opts=opts)


def _static_result(
    url: str,
    text: str,
    status: int,
    *,
    title: str = "",
    links: list[str] | None = None,
    opts: CrawlOptions | None = None,  # noqa: ARG001
) -> CrawlResult:
    result = CrawlResult(
        url=url,
        status_code=status,
        title=title,
        text=text,
        markdown=text,
        links=links or [],
        provider="mock-provider",
    )
    result.compute_content_hash()
    return result


def html_result(
    url: str,
    html: str,
    *,
    status: int = 200,
    base_url: str | None = None,
) -> CrawlResult:
    """Build a CrawlResult from raw HTML markup (for mock sites)."""
    from app.crawlers.document import extract_document

    parsed = extract_document(html, base_url or url)
    result = CrawlResult(
        url=url,
        final_url=url,
        status_code=status,
        title=parsed["title"],
        markdown=parsed["markdown"],
        text=parsed["text"],
        links=parsed["links"],
        provider="mock-provider",
    )
    result.compute_content_hash()
    return result
