from __future__ import annotations

import asyncio
import contextlib
import time
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

_DEFAULT_USER_AGENT = "GlobalWatersportsBot/1.0"


class RobotsChecker:
    """Cached robots.txt enforcement per site (urllib.robotparser in a worker thread)."""

    def __init__(self, ttl_seconds: int = 3600, user_agent: str = _DEFAULT_USER_AGENT) -> None:
        self.ttl_seconds = ttl_seconds
        self.user_agent = user_agent
        self._parsers: dict[str, RobotFileParser] = {}
        self._loaded_at: dict[str, float] = {}
        self._failures: dict[str, float] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def _base_url(url: str) -> str:
        return f"{urlsplit(url).scheme}://{urlsplit(url).netloc}"

    async def can_fetch(self, url: str, user_agent: str | None = None) -> bool:
        """True when robots.txt (if present) allows fetching `url`."""
        agent = user_agent or self.user_agent
        try:
            base = self._base_url(url)
        except ValueError:
            return False
        parser = await self._load(base)
        if parser is None:
            return True  # no robots.txt reachable -> assume allowed (offline-friendly)
        return await asyncio.to_thread(parser.can_fetch, agent, url)

    async def _load(self, base_url: str) -> RobotFileParser | None:
        async with self._lock:
            parser = self._parsers.get(base_url)
            if parser is not None:
                age = time.monotonic() - self._loaded_at.get(base_url, 0.0)
                if age < self.ttl_seconds:
                    return parser
            # Negative-cache a failed fetch for a short window.
            failed_at = self._failures.get(base_url)
            if failed_at is not None and time.monotonic() - failed_at < min(
                300.0, self.ttl_seconds
            ):
                return None
            fetched = None
            with contextlib.suppress(Exception):  # offline / network errors mean "no robots"
                fetched = await asyncio.to_thread(self._fetch, base_url + "/robots.txt")
            now = time.monotonic()
            if fetched is not None:
                self._parsers[base_url] = fetched
                self._loaded_at[base_url] = now
                self._failures.pop(base_url, None)
            else:
                self._failures[base_url] = now
            return fetched

    def _fetch(self, robots_url: str) -> RobotFileParser | None:
        parser = RobotFileParser()
        try:
            parser.set_url(robots_url)
            parser.read()
        except Exception:  # noqa: BLE001
            return None
        return parser

    def register(self, base_url: str, robots_text: str) -> None:
        """Inject robots.txt content directly (used by tests / offline seeding)."""
        parser = RobotFileParser()
        parser.parse(robots_text.splitlines())
        key = base_url.rstrip("/")
        self._parsers[key] = parser
        self._loaded_at[key] = time.monotonic()
