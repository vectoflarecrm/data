from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.time import utcnow
from app.crawlers.document import content_hash


class CrawlOptions(BaseModel):
    """Politeness + extraction controls for a single crawl request."""

    model_config = ConfigDict(extra="forbid")

    url: str
    max_depth: int = Field(default=2, ge=0)
    page_limit: int = Field(default=15, ge=1)
    max_retries: int = Field(default=2, ge=0)
    delay_seconds: float | None = None
    timeout_seconds: int | None = None
    respect_robots: bool = True
    allowed_domains: list[str] | None = None
    user_agent: str = "GlobalWatersportsBot/1.0 (+contact)"
    extract_title: bool = True
    follow_redirects: bool = True


class CrawlResult(BaseModel):
    """Structured crawl output consumed by the research engine."""

    model_config = ConfigDict(extra="forbid")

    url: str
    final_url: str | None = None
    status_code: int = 200
    title: str = ""
    markdown: str = ""
    text: str = ""
    links: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    content_hash: str | None = None
    retrieved_at: datetime = Field(default_factory=utcnow)
    provider: str | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return 200 <= (self.status_code or 0) < 400

    def compute_content_hash(self) -> None:
        self.content_hash = content_hash(self.text) if self.text else None


class CrawlSessionResult(BaseModel):
    """Summary of a multi-page site crawl."""

    model_config = ConfigDict(extra="forbid")

    root_url: str
    results: list[CrawlResult] = Field(default_factory=list)
    requested: int = 0
    fetched: int = 0
    failed: int = 0
    truncated: bool = False
