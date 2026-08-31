from __future__ import annotations

import asyncio
import logging
from urllib.parse import urlsplit

import httpx

from app.core.config import get_settings
from app.crawlers.document import extract_document, normalize_link
from app.crawlers.errors import HttpError, RobotsBlocked
from app.crawlers.politeness import PolitenessGate
from app.crawlers.robots import RobotsChecker
from app.crawlers.schema import CrawlOptions, CrawlResult

logger = logging.getLogger(__name__)

_RETRYABLE_CODES = {408, 429, 500, 502, 503, 504}


class HttpxProvider:
    """Fast, dependency-light fallback crawler built on httpx."""

    name = "httpx-provider"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        robots: RobotsChecker | None = None,
        politeness: PolitenessGate | None = None,
        user_agent: str | None = None,
    ) -> None:
        settings = get_settings()
        self.user_agent = user_agent or "GlobalWatersportsBot/1.0 (+contact)"
        self.timeout_seconds = settings.httpx_timeout_seconds
        self.politeness = politeness or PolitenessGate(
            domain_concurrency=settings.domain_concurrency,
            request_delay_seconds=settings.request_delay_seconds,
            max_requests_per_minute=settings.max_requests_per_minute,
        )
        self.robots = robots or RobotsChecker(user_agent=self.user_agent)
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout_seconds),
            follow_redirects=True,
            headers={"User-Agent": self.user_agent},
        )
        self._owns_client = client is None

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def crawl(self, url: str, options: CrawlOptions | None = None) -> CrawlResult:
        opts = options or CrawlOptions(url=url)
        if opts.respect_robots and not await self.robots.can_fetch(url, self.user_agent):
            raise RobotsBlocked(f"robots.txt disallows {url}")
        domain = urlsplit(url).netloc
        delay = (
            opts.delay_seconds
            if opts.delay_seconds is not None
            else self.politeness.request_delay_seconds
        )
        async with self.politeness.guard(domain, delay_seconds=delay):
            return await self._fetch_with_retries(url, opts)

    async def _fetch_with_retries(self, url: str, opts: CrawlOptions) -> CrawlResult:
        last_error: Exception | None = None
        for attempt in range(opts.max_retries + 1):
            try:
                return await self._single_fetch(url, opts)
            except (HttpError, httpx.HTTPError, TimeoutError) as exc:
                last_error = exc
                status = int(getattr(exc, "status_code", 0) or 0)
                if status and status not in _RETRYABLE_CODES:
                    break
                if attempt < opts.max_retries:
                    await asyncio.sleep((attempt + 1) * 0.25)
        return _error_result(url, f"crawl failed after retries: {last_error}")

    async def _single_fetch(self, url: str, opts: CrawlOptions) -> CrawlResult:
        req = self._client.build_request("GET", url, headers={"User-Agent": self.user_agent})
        response = await self._client.send(req)
        if response.status_code >= 400:
            raise HttpError(response.status_code, url)
        final_url = str(response.url)
        raw = response.content
        charset = response.encoding or "utf-8"
        try:
            raw_str = raw.decode(charset, errors="replace")
        except (LookupError, TypeError):
            raw_str = raw.decode("utf-8", errors="replace")
        parsed = extract_document(raw_str, final_url)
        links = [normalize_link(link, final_url) for link in parsed["links"]]
        links = [cl for cl in links if cl]
        result = CrawlResult(
            url=url,
            final_url=final_url,
            status_code=response.status_code,
            title=parsed["title"],
            markdown=parsed["markdown"],
            text=parsed["text"],
            links=list(dict.fromkeys(links)),
            metadata={
                "content_type": response.headers.get("content-type", ""),
                "content_length": len(raw),
                "encoding": charset,
            },
            provider=self.name,
        )
        result.compute_content_hash()
        return result


def _error_result(url: str, message: str) -> CrawlResult:
    result = CrawlResult(url=url, status_code=0, error=message, provider="httpx-provider")
    result.compute_content_hash()
    return result
