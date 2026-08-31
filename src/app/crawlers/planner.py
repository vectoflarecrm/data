from __future__ import annotations

from urllib.parse import urljoin, urlsplit

from app.crawlers.document import normalize_link

# Priority seeds: pages most likely to hold B2B intelligence about a company.
PRIORITY_PATHS = {
    "/": 100,
    "/about": 90,
    "/contact": 85,
    "/contacts": 85,
    "/team": 80,
    "/our-team": 80,
    "/about-us": 90,
    "/who-we-are": 90,
    "/products": 75,
    "/product": 75,
    "/catalog": 70,
    "/catalogue": 70,
    "/brands": 70,
    "/brand": 70,
    "/contact-us": 85,
    "/services": 60,
    "/service": 60,
    "/news": 50,
    "/blog": 50,
    "/about/team": 80,
    "/about-us/team": 80,
    "/company": 70,
    "/distributors": 70,
    "/dealer-locator": 70,
    "/where-to-buy": 70,
}

_HIGHEST_RELEVANCE = 100
_LOWEST_RELEVANCE = 1

# File types we would rather not spend crawl budget on.
_ASSET_EXTENSIONS = {
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "ico",
    "bmp",
    "css",
    "js",
    "mjs",
    "woff",
    "woff2",
    "ttf",
    "eot",
    "mp4",
    "mov",
    "avi",
    "webm",
    "mp3",
    "wav",
    "zip",
    "tar",
    "gz",
    "exe",
    "dmg",
    "apk",
    "iso",
    "bin",
    "xml",
    "json",
}


def domain_of(url: str) -> str:
    return (urlsplit(url).netloc or "").lower()


def _path_key(path: str) -> str:
    key = path or "/"
    if len(key) > 1 and key.endswith("/"):
        key = key[:-1]
    return key.lower()


def seed_relevance(url: str) -> int:
    """Relevance score for a discovered URL (used for crawl ordering)."""
    parts = urlsplit(url)
    key = _path_key(parts.path)
    if key in PRIORITY_PATHS:
        return PRIORITY_PATHS[key]
    # Deep paths are less likely to be core pages.
    depth = key.count("/")
    return max(_LOWEST_RELEVANCE, 60 - depth * 10)


class CrawlPlanner:
    """Prioritization + scope rules for a site crawl."""

    def __init__(self, allowed_domains: list[str] | None = None) -> None:
        self.allowed_domains = {d.lower().lstrip(".") for d in allowed_domains or []}

    def start_urls(self, start_url: str) -> list[str]:
        """The crawl entry point(s) in order."""
        return [normalize_link(start_url) or start_url]

    def should_follow(self, url: str, root_domain: str | None = None) -> bool:
        if not url:
            return False
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https"):
            return False
        if _path_key(parts.path).rsplit("/", 1)[-1].split(".")[-1] in _ASSET_EXTENSIONS:
            return False
        domain = (parts.netloc or "").lower()
        if self.allowed_domains and domain not in self.allowed_domains:
            return False
        root = root_domain or domain
        # Only stay on the same site (or its subdomains).
        return domain == root or domain.endswith("." + root)

    def prioritize(self, urls: list[str]) -> list[str]:
        """Order discovered links by relevance then path depth (priority crawl)."""
        return sorted(urls, key=lambda u: -seed_relevance(u))


def resolve(base_url: str, href: str) -> str:
    return urljoin(base_url, href)
