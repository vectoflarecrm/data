from __future__ import annotations

from urllib.parse import urlsplit

from app.core.config import get_settings
from app.crawlers.document import extract_document, normalize_link
from app.crawlers.errors import ProviderUnavailable, RobotsBlocked
from app.crawlers.robots import RobotsChecker
from app.crawlers.schema import CrawlOptions, CrawlResult


class PlaywrightProvider:
    """Optional full-browser crawler via Playwright (lazily imported)."""

    name = "playwright-provider"

    def __init__(self, robots: RobotsChecker | None = None, user_agent: str | None = None) -> None:
        try:
            from playwright.async_api import async_playwright  # noqa: F401
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise ProviderUnavailable(
                "playwright is not installed; install with `pip install .[playwright]`"
            ) from exc
        self._async_playwright = async_playwright
        self.user_agent = user_agent or "GlobalWatersportsBot/1.0 (+contact)"
        self.robots = robots or RobotsChecker(user_agent=self.user_agent)

    async def crawl(self, url: str, options: CrawlOptions | None = None) -> CrawlResult:
        opts = options or CrawlOptions(url=url)
        if opts.respect_robots and not await self.robots.can_fetch(url, self.user_agent):
            raise RobotsBlocked(f"robots.txt disallows {url}")
        timeout_ms = (opts.timeout_seconds or get_settings().httpx_timeout_seconds) * 1000
        domain = urlsplit(url).netloc
        try:
            async with self._async_playwright() as pw:
                browser = await pw.chromium.launch(headless=True)
                try:
                    page = await browser.new_page(user_agent=self.user_agent)
                    response = await page.goto(
                        url, wait_until="domcontentloaded", timeout=timeout_ms
                    )
                    raw = await page.content()
                finally:
                    await browser.close()
        except Exception as exc:  # noqa: BLE001
            return CrawlResult(
                url=url, status_code=0, error=f"playwright failure: {exc}", provider=self.name
            )
        status = int(response.status if response is not None else 200)
        final_url = str(page.url) if "page" in locals() else url
        parsed = extract_document(raw, final_url)
        links = [normalize_link(link, final_url) for link in parsed["links"]]
        links = [cl for cl in links if cl]
        result = CrawlResult(
            url=url,
            final_url=final_url,
            status_code=status,
            title=parsed["title"],
            markdown=parsed["markdown"],
            text=parsed["text"],
            links=list(dict.fromkeys(links)),
            metadata={"backend": "playwright", "domain": domain},
            provider=self.name,
        )
        result.compute_content_hash()
        return result
