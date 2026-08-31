from __future__ import annotations

import logging
import re
import time

from app.core.config import get_settings
from app.crawlers.errors import ProviderUnavailable
from app.crawlers.schema import CrawlOptions, CrawlResult

logger = logging.getLogger(__name__)


class Crawl4AIProvider:
    """Primary crawler backed by Crawl4AI (lazily imported so it is optional at runtime)."""

    name = "crawl4ai-provider"

    def __init__(self) -> None:
        try:
            from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig  # noqa: F401
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise ProviderUnavailable(
                "crawl4ai is not installed; install with `pip install .[crawl4ai]`"
            ) from exc
        self._AsyncWebCrawler = AsyncWebCrawler
        self._BrowserConfig = BrowserConfig
        self._CrawlerRunConfig = CrawlerRunConfig

    async def crawl(self, url: str, options: CrawlOptions | None = None) -> CrawlResult:
        opts = options or CrawlOptions(url=url)
        settings = get_settings()
        strategy = settings.crawl4ai_strategy
        config_kwargs: dict = {
            "markdown": True,
            "respect_robots_txt": opts.respect_robots,
        }
        if strategy in {"css", "llm", "none"}:
            config_kwargs["extraction_strategy"] = "none"
            config_kwargs["markdown_strategy"] = "css" if strategy == "css" else "none"
        browser_kwargs: dict = {"headless": True}
        started = time.monotonic()
        try:
            async with self._AsyncWebCrawler(
                browser_config=self._BrowserConfig(**browser_kwargs)
            ) as crawler:
                run_config = self._CrawlerRunConfig(**config_kwargs)
                result = await crawler.arun(url=url, config=run_config)
        except TypeError:
            # Older crawl4ai signatures take keyword args directly on arun().
            return await self._crawl_legacy(url, opts)
        except Exception as exc:  # noqa: BLE001
            return CrawlResult(
                url=url, status_code=0, error=f"crawl4ai failure: {exc}", provider=self.name
            )

        markdown = getattr(result, "markdown", "") or ""
        html = getattr(result, "html", "") or ""
        status = int(getattr(result, "status_code", 200) or 200)
        success = bool(getattr(result, "success", status < 400))
        final_url = str(getattr(result, "url", url) or url)
        links_box = getattr(result, "links", None) or {}
        links: list[str] = []
        if isinstance(links_box, dict):
            links = [
                str(link)
                for group in (links_box.get("internal", []), links_box.get("external", []))
                if isinstance(group, list)
                for link in group
            ]
        elif isinstance(links_box, list):
            links = [str(link) for link in links_box]
        title = str(getattr(result, "title", "") or "")
        if not title and isinstance(getattr(result, "metadata", None), dict):
            title = str(result.metadata.get("title", "") or "")
        crawl_result = CrawlResult(
            url=url,
            final_url=final_url,
            status_code=status,
            title=title,
            markdown=markdown,
            text=_markdown_to_text(markdown) or _strip_html(html),
            links=list(dict.fromkeys(links)),
            metadata={
                "strategy": strategy,
                "crawl4ai_success": success,
                "elapsed_seconds": round(time.monotonic() - started, 3),
            },
            provider=self.name,
        )
        if not success and status >= 400:
            crawl_result.error = f"crawl4ai returned HTTP {status}"
        crawl_result.compute_content_hash()
        return crawl_result

    async def _crawl_legacy(self, url: str, opts: CrawlOptions) -> CrawlResult:
        try:
            async with self._AsyncWebCrawler() as crawler:
                result = await crawler.arun(url=url)
        except Exception as exc:  # noqa: BLE001
            return CrawlResult(
                url=url, status_code=0, error=f"crawl4ai failure: {exc}", provider=self.name
            )
        markdown = getattr(result, "markdown", "") or ""
        status = int(getattr(result, "status_code", 200) or 200)
        links_box = getattr(result, "links", None) or {}
        links: list[str] = []
        if isinstance(links_box, dict):
            for group in (links_box.get("internal", []), links_box.get("external", [])):
                if isinstance(group, list):
                    links.extend(str(link) for link in group)
        crawl_result = CrawlResult(
            url=url,
            status_code=status,
            title=str(getattr(result, "title", "") or ""),
            markdown=markdown,
            text=_markdown_to_text(markdown),
            links=list(dict.fromkeys(links)),
            provider=self.name,
        )
        crawl_result.compute_content_hash()
        return crawl_result


def _markdown_to_text(markdown: str) -> str:
    text = re.sub(r"[#>*_`\[\]\(\)!\-\|{}=]", " ", markdown)
    return re.sub(r"[ \t]+", " ", text).strip()


def _strip_html(html: str) -> str:
    from app.crawlers.document import extract_document

    return extract_document(html, "")["text"]
