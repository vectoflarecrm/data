from __future__ import annotations

import asyncio
import time

import httpx
import pytest

from app.crawlers import (
    CompositeCrawler,
    CrawlOptions,
    CrawlPlanner,
    CrawlResult,
    HttpError,
    MockCrawlerProvider,
    PlaywrightProvider,
    PolitenessGate,
    ProviderUnavailable,
    RobotsChecker,
    content_hash,
    html_result,
    normalize_link,
    normalize_text,
    seed_relevance,
)
from app.crawlers.document import extract_document as _extract
from app.crawlers.orchestrator import CrawlOrchestrator


class TestDocumentAndHashing:
    def test_normalize_text_collapses_whitespace(self) -> None:
        assert normalize_text("  A\n\n  B  ") == "A B"

    def test_content_hash_deterministic_and_distinct(self) -> None:
        h1 = content_hash("Water ski tow rope 50 ft")
        h2 = content_hash(" Water  ski tow rope 50 ft ")
        h3 = content_hash("wakeboard 50 ft")
        assert h1 == h2
        assert h1 != h3
        assert len(h1) == 64

    def test_extract_document_title_links_and_ignored_tags(self) -> None:
        html = """
        <html><head><title>Bluewater Gear</title></head>
        <body>
        <h1>Welcome</h1>
        <p>We sell <a href="/products">watersports gear</a>.</p>
        <script>alert('no');</script>
        <a href="https://example.com/about/../contact">Contact</a>
        <a href="mailto:sales@bluewater.io">Email</a>
        <a href="#top">Section</a>
        </body></html>
        """
        doc = _extract(html, "https://example.com")
        assert doc["title"] == "Bluewater Gear"
        assert "Welcome" not in doc["markdown"] or "# Welcome" in doc["markdown"]
        assert "watersports gear" in doc["text"]
        assert "alert('no')" not in doc["text"]
        resolved = {normalize_link(link) for link in doc["links"]}
        assert "https://example.com/products" in resolved

    def test_normalize_link_rejects_non_http(self) -> None:
        assert normalize_link("mailto:x@y.io") is None
        assert normalize_link("tel:+123") is None
        assert normalize_link("javascript:void(0)") is None
        assert normalize_link("https://example.com//path/") == "https://example.com/path"


class TestPlanner:
    def test_seed_relevance_orders_core_pages_first(self) -> None:
        assert seed_relevance("https://x.io/") > seed_relevance("https://x.io/deep/a/b")

    def test_should_follow_scopes_to_same_site(self) -> None:
        planner = CrawlPlanner()
        assert planner.should_follow("https://x.io/about", "x.io")
        assert planner.should_follow("https://blog.x.io/post", "x.io")
        assert not planner.should_follow("https://y.io/evil", "x.io")
        assert not planner.should_follow("https://x.io/payload.exe", "x.io")

    def test_start_urls_normalize(self) -> None:
        planner = CrawlPlanner(allowed_domains=["x.io"])
        assert planner.start_urls("https://X.IO//") == ["https://x.io/"]

    def test_allowed_domains_restrict(self) -> None:
        planner = CrawlPlanner(allowed_domains=["x.io"])
        assert not planner.should_follow("https://other.io/x", "other.io")


@pytest.mark.asyncio
class TestPoliteness:
    async def test_delay_between_requests_to_same_domain(self) -> None:
        gate = PolitenessGate(
            domain_concurrency=1, request_delay_seconds=0.08, max_requests_per_minute=1000
        )
        start = time.monotonic()
        for _ in range(3):
            async with gate.guard("example.com"):
                await asyncio.sleep(0)
        elapsed = time.monotonic() - start
        assert elapsed >= 0.14  # at least 2 inter-request gaps

    async def test_different_domains_not_serialized(self) -> None:
        gate = PolitenessGate(
            domain_concurrency=2, request_delay_seconds=0.15, max_requests_per_minute=1000
        )
        start = time.monotonic()

        async def one(domain: str) -> None:
            async with gate.guard(domain):
                await asyncio.sleep(0.05)

        await asyncio.gather(one("a.io"), one("b.io"), one("c.io"))
        elapsed = time.monotonic() - start
        assert elapsed < 0.30

    async def test_minute_budget_throttles_with_short_window(self) -> None:
        gate = PolitenessGate(
            domain_concurrency=1,
            request_delay_seconds=0,
            max_requests_per_minute=1,
            window_seconds=0.2,
        )
        start = time.monotonic()
        async with gate.guard("example.com"):
            pass
        await asyncio.sleep(0.02)
        async with gate.guard("example.com"):
            pass
        elapsed = time.monotonic() - start
        assert elapsed >= 0.18  # second request waited for the window to slide


@pytest.mark.asyncio
class TestRobots:
    async def test_disallow_enforced_and_allow_passed(self) -> None:
        checker = RobotsChecker()
        checker.register("https://example.com", "User-agent: *\nDisallow: /private")
        assert not await checker.can_fetch("https://example.com/private/secret")
        assert await checker.can_fetch("https://example.com/about")


@pytest.mark.asyncio
class TestHttpxProvider:
    async def test_crawl_parses_page_and_hashes_content(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            html = (
                "<html><head><title>SailCo</title></head><body>"
                "<h1>Watersports supplier</h1><a href='/contact'>Contact</a></body></html>"
            )
            return httpx.Response(200, content=html.encode(), headers={"content-type": "text/html"})

        from app.crawlers.httpx_provider import HttpxProvider

        transport = httpx.MockTransport(handler)
        client = httpx.AsyncClient(transport=transport, follow_redirects=True)
        robots = RobotsChecker()
        robots.register("https://sailco.example", "User-agent: *\nAllow: /")
        provider = HttpxProvider(client=client, robots=robots)
        try:
            result = await provider.crawl(
                "https://sailco.example/",
                CrawlOptions(url="https://sailco.example/", delay_seconds=0, max_retries=0),
            )
        finally:
            await client.aclose()
        assert result.status_code == 200
        assert result.title == "SailCo"
        assert "Watersports supplier" in result.text
        assert "https://sailco.example/contact" in result.links
        assert result.content_hash is not None
        assert result.content_hash == content_hash(result.text)

    async def test_robots_block_raises(self) -> None:
        from app.crawlers.errors import RobotsBlocked
        from app.crawlers.httpx_provider import HttpxProvider

        transport = httpx.MockTransport(handler=lambda req: httpx.Response(200))
        client = httpx.AsyncClient(transport=transport)
        robots = RobotsChecker()
        robots.register("https://blocked.io", "User-agent: *\nDisallow: /")
        provider = HttpxProvider(
            client=client,
            robots=robots,
            politeness=PolitenessGate(request_delay_seconds=0),
        )
        with pytest.raises(RobotsBlocked):
            await provider.crawl(
                "https://blocked.io/x", CrawlOptions(url="https://blocked.io/x", delay_seconds=0)
            )
        await client.aclose()

    async def test_retry_then_error_result(self) -> None:
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(503)

        from app.crawlers.httpx_provider import HttpxProvider

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        robots = RobotsChecker()
        robots.register("https://x.io", "User-agent: *\nAllow: /")
        provider = HttpxProvider(client=client, robots=robots)
        try:
            result = await provider.crawl(
                "https://x.io/", CrawlOptions(url="https://x.io/", delay_seconds=0, max_retries=1)
            )
        finally:
            await client.aclose()
        assert calls["n"] == 2
        assert result.error is not None


@pytest.mark.asyncio
class TestMockProvider:
    async def test_default_handles_any_url(self) -> None:
        provider = MockCrawlerProvider()
        result = await provider.crawl("https://x.io/about")
        assert result.status_code == 200
        assert result.provider == "mock-provider"

    async def test_html_result_builds_links(self) -> None:
        result = html_result(
            "https://x.io/",
            """<html><body><h1>Hi</h1><a href="/p">Products</a></body></html>""",
        )
        assert "https://x.io/p" in result.links
        assert "[#]Hi" not in result.text  # markdown headers are separate field


@pytest.mark.asyncio
class TestCompositeAndOrchestrator:
    async def test_composite_falls_back_on_http_error(self) -> None:
        broken = MockCrawlerProvider(
            handler=lambda url, opts: _raise(HttpError(500, url)),
        )
        healthy = MockCrawlerProvider()
        composite = CompositeCrawler([broken, healthy])
        result = await composite.crawl("https://x.io/")
        assert result.status_code == 200
        assert result.provider == "mock-provider"

    async def test_composite_does_not_swallow_robots_block(self) -> None:
        from app.crawlers.errors import RobotsBlocked

        blocked = MockCrawlerProvider(handler=lambda url, opts: _raise(RobotsBlocked("nope")))
        healthy = MockCrawlerProvider()
        composite = CompositeCrawler([blocked, healthy])
        with pytest.raises(RobotsBlocked):
            await composite.crawl("https://x.io/")

    async def test_orchestrator_respects_depth_and_page_limit(self) -> None:
        pages = {
            "https://mock.io/": html_result(
                "https://mock.io/",
                "<h1>Home</h1><a href='/about'>About</a><a href='https://external.io/x'>Ext</a>",
            ),
            "https://mock.io/about": html_result(
                "https://mock.io/about",
                "<h1>About</h1><a href='/team'>Team</a>",
            ),
            "https://mock.io/team": html_result("https://mock.io/team", "<h1>Team</h1>"),
        }

        async def handler(url: str, opts: CrawlOptions) -> CrawlResult:
            return pages.get(url, html_result(url, "<h1>missing</h1>", status=404))

        provider = MockCrawlerProvider(handler=handler)
        orchestrator = CrawlOrchestrator()
        session = await orchestrator.crawl_site(
            provider,
            "https://mock.io/",
            CrawlOptions(url="https://mock.io/", max_depth=1, page_limit=5, delay_seconds=0),
        )
        fetched = [r.url for r in session.results if r.ok]
        assert "https://mock.io/" in fetched
        assert "https://mock.io/about" in fetched
        assert "https://mock.io/team" not in fetched  # depth 2, out of max_depth 1
        assert not any("external.io" in u for u in fetched)

    async def test_orchestrator_page_limit_truncates(self) -> None:
        pages = {
            "https://mock.io/": html_result(
                "https://mock.io/", "<h1>Home</h1><a href='/a'>a</a><a href='/b'>b</a>"
            ),
            "https://mock.io/a": html_result("https://mock.io/a", "<h1>A</h1>"),
            "https://mock.io/b": html_result("https://mock.io/b", "<h1>B</h1>"),
        }

        async def handler(url: str, opts: CrawlOptions) -> CrawlResult:
            return pages.get(url, html_result(url, "<h1>missing</h1>", status=404))

        orchestrator = CrawlOrchestrator()
        session = await orchestrator.crawl_site(
            MockCrawlerProvider(handler=handler),
            "https://mock.io/",
            CrawlOptions(url="https://mock.io/", page_limit=2, delay_seconds=0),
        )
        assert len([r for r in session.results if r.ok]) == 2
        assert session.truncated is True


@pytest.mark.asyncio
async def test_playwright_provider_unavailable_when_missing() -> None:
    with pytest.raises(ProviderUnavailable):
        PlaywrightProvider()


async def _raise(exc: Exception) -> CrawlResult:
    raise exc
