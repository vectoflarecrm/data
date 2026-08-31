from __future__ import annotations

from app.crawlers.crawl4ai_provider import Crawl4AIProvider
from app.crawlers.document import content_hash, extract_document, normalize_link, normalize_text
from app.crawlers.errors import (
    CrawlerError,
    HttpError,
    PageLimitReached,
    ProviderUnavailable,
    RobotsBlocked,
)
from app.crawlers.factory import CompositeCrawler, build_crawler
from app.crawlers.httpx_provider import HttpxProvider
from app.crawlers.mock_provider import MockCrawlerProvider, html_result
from app.crawlers.orchestrator import CrawlOrchestrator
from app.crawlers.planner import CrawlPlanner, domain_of, seed_relevance
from app.crawlers.playwright_provider import PlaywrightProvider
from app.crawlers.politeness import PolitenessGate
from app.crawlers.robots import RobotsChecker
from app.crawlers.schema import CrawlOptions, CrawlResult, CrawlSessionResult

__all__ = [
    "CompositeCrawler",
    "Crawl4AIProvider",
    "CrawlOptions",
    "CrawlOrchestrator",
    "CrawlPlanner",
    "CrawlResult",
    "CrawlSessionResult",
    "CrawlerError",
    "HttpxProvider",
    "HttpError",
    "MockCrawlerProvider",
    "PageLimitReached",
    "PlaywrightProvider",
    "PolitenessGate",
    "ProviderUnavailable",
    "RobotsBlocked",
    "RobotsChecker",
    "build_crawler",
    "content_hash",
    "domain_of",
    "extract_document",
    "html_result",
    "normalize_link",
    "normalize_text",
    "seed_relevance",
]
