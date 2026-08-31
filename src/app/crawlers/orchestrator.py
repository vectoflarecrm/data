from __future__ import annotations

import heapq
from dataclasses import dataclass, field

from app.crawlers.errors import CrawlerError, RobotsBlocked
from app.crawlers.planner import CrawlPlanner, domain_of, seed_relevance
from app.crawlers.schema import CrawlOptions, CrawlResult, CrawlSessionResult


@dataclass(order=True)
class _Pending:
    relevance: int
    depth: int
    counter: int
    url: str = field(compare=False)


class CrawlOrchestrator:
    """Breadth-first site crawl bounded by max_depth and page_limit, priority-ordered."""

    def __init__(self, planner: CrawlPlanner | None = None) -> None:
        self.planner = planner or CrawlPlanner()

    async def crawl_site(
        self,
        provider,
        root_url: str,
        options: CrawlOptions | None = None,
    ) -> CrawlSessionResult:
        opts = options or CrawlOptions(url=root_url)
        root_domain = domain_of(root_url)
        session = CrawlSessionResult(root_url=root_url, requested=0)
        counter = 0
        seen: set[str] = set()
        pending: list[_Pending] = []

        for seed in self.planner.start_urls(root_url):
            heapq.heappush(
                pending,
                _Pending(-seed_relevance(seed), 0, counter, seed),
            )
            counter += 1
            seen.add(seed)
        session.requested += 1

        while pending and session.fetched < opts.page_limit:
            entry = heapq.heappop(pending)
            url = entry.url
            page_opts = opts.model_copy(update={"url": url})
            try:
                result = await provider.crawl(url, page_opts)
            except RobotsBlocked as exc:
                session.failed += 1
                session.results.append(
                    CrawlResult(
                        url=url,
                        status_code=0,
                        error=str(exc),
                        provider=getattr(provider, "name", None),
                    )
                )
                continue
            except CrawlerError as exc:
                session.failed += 1
                session.results.append(CrawlResult(url=url, status_code=0, error=str(exc)))
                continue
            session.results.append(result)
            if result.ok:
                session.fetched += 1
            else:
                session.failed += 1
                continue
            if entry.depth >= opts.max_depth:
                continue
            for child in result.links:
                if not self.planner.should_follow(child, root_domain):
                    continue
                if child in seen:
                    continue
                seen.add(child)
                session.requested += 1
                heapq.heappush(
                    pending,
                    _Pending(-seed_relevance(child), entry.depth + 1, counter, child),
                )
                counter += 1

        session.truncated = session.requested > session.fetched
        return session
