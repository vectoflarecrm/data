from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager


class PolitenessGate:
    """Rate limiting / politeness: per-domain concurrency, per-domain delay, global budget."""

    def __init__(
        self,
        domain_concurrency: int = 2,
        request_delay_seconds: float = 2.0,
        max_requests_per_minute: int = 30,
        window_seconds: float = 60.0,
    ) -> None:
        self.domain_concurrency = max(1, int(domain_concurrency))
        self.request_delay_seconds = max(0.0, float(request_delay_seconds))
        self.max_requests_per_minute = max(1, int(max_requests_per_minute))
        self.window_seconds = max(0.01, float(window_seconds))
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self._last_request: dict[str, float] = {}
        self._recent_requests: deque[float] = deque()
        self._lock = asyncio.Lock()

    def _domain_for(self, domain: str) -> str:
        return (domain or "unknown").lower().rstrip(".")

    async def _acquire_concurrency(self, domain: str) -> None:
        sem = self._semaphores.get(domain)
        if sem is None:
            async with self._lock:
                sem = self._semaphores.get(domain)
                if sem is None:
                    sem = asyncio.Semaphore(self.domain_concurrency)
                    self._semaphores[domain] = sem
        await sem.acquire()

    async def _wait_domain_delay(self, domain: str, delay: float | None = None) -> None:
        delay = delay if delay is not None else self.request_delay_seconds
        if delay <= 0:
            return
        async with self._lock:
            last = self._last_request.get(domain, 0.0)
            wait = delay - (time.monotonic() - last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request[domain] = time.monotonic()

    async def _wait_minute_budget(self) -> None:
        while True:
            now = time.monotonic()
            async with self._lock:
                while (
                    self._recent_requests and now - self._recent_requests[0] > self.window_seconds
                ):
                    self._recent_requests.popleft()
                if len(self._recent_requests) < self.max_requests_per_minute:
                    self._recent_requests.append(now)
                    return
                expires = self._recent_requests[0] + self.window_seconds - now
            await asyncio.sleep(min(max(expires, 0.01), 0.5))

    async def acquire(self, domain: str, delay_seconds: float | None = None) -> None:
        normalized = self._domain_for(domain)
        await self._acquire_concurrency(normalized)
        try:
            await self._wait_domain_delay(normalized, delay_seconds)
            await self._wait_minute_budget()
        except BaseException:
            self.release(normalized)
            raise

    def release(self, domain: str) -> None:
        sem = self._semaphores.get(self._domain_for(domain))
        if sem is not None:
            sem.release()

    @asynccontextmanager
    async def guard(self, domain: str, delay_seconds: float | None = None) -> AsyncIterator[None]:
        await self.acquire(domain, delay_seconds)
        try:
            yield
        finally:
            self.release(domain)
