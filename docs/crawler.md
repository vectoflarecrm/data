# Crawler

All crawling routes through the `CrawlerProvider` protocol; business logic does not import Crawl4AI.

## Interface

```
async def crawl(url: str, options: CrawlOptions) -> CrawlResult
```

CrawlResult: url, final_url, status_code, title, markdown, text, links, metadata, content_hash, retrieved_at.

## Providers

- `Crawl4AIProvider` (primary)
- `HttpxProvider` (fast fallback)
- `PlaywrightProvider` (optional, browser)
- `MockCrawlerProvider` (tests)

## Rate limiting / politeness

Per-provider and per-domain limits: REQUEST_DELAY, DOMAIN_CONCURRENCY, AI_CONCURRENCY, MAX_REQUESTS_PER_MINUTE. Reliability over speed.

## Content hashing

`content_hash` (sha256 over normalized text) drives idempotency and duplicate-evidence detection.