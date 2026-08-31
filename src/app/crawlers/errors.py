from __future__ import annotations


class CrawlerError(Exception):
    """Base error for the crawler abstraction."""


class ProviderUnavailable(CrawlerError):
    """The requested crawler backend is not installed or not enabled."""


class RobotsBlocked(CrawlerError):
    """The target site's robots.txt disallows the URL."""


class PageLimitReached(CrawlerError):
    """The configured page limit was reached before crawl completion."""


class HttpError(CrawlerError):
    def __init__(self, status_code: int, url: str, message: str = "") -> None:
        self.status_code = status_code
        self.url = url
        super().__init__(f"HTTP {status_code} for {url}: {message}".strip())
