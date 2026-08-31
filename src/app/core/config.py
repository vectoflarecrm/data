from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_name: str = "Global Watersports B2B Intelligence Database"
    app_env: str = "development"
    log_level: str = "INFO"

    database_url: str = "postgresql+asyncpg://watersports:watersports@localhost:5432/watersports"
    test_database_url: str | None = None

    gemini_cli_command: str = "gemini"
    gemini_model: str | None = None
    gemini_timeout_seconds: int = 120
    gemini_cli_enabled: bool = True

    crawl4ai_enabled: bool = True
    crawl4ai_strategy: str = "css"
    playwright_enabled: bool = False
    httpx_timeout_seconds: int = 30

    max_pages_per_company: int = 15
    max_depth: int = 2
    request_delay_seconds: float = 2.0
    domain_concurrency: int = 2
    ai_max_concurrency: int = 1
    max_requests_per_minute: int = 30

    research_prompt_char_budget: int = 20000
    research_page_text_budget: int = 4000

    research_workers: int = 3
    task_max_attempts: int = 5
    task_staleness_seconds: int = 1800
    retry_backoff_seconds: int = 0  # override exponential backoff (0 = use defaults)

    score_product_fit: int = 20
    score_company_fit: int = 15
    score_market_fit: int = 15
    score_purchasing_potential: int = 20
    score_contact_quality: int = 10
    score_growth_signals: int = 10
    score_data_completeness: int = 5
    score_recent_activity: int = 5

    max_csv_upload_mb: int = 20

    @property
    def scoring_weights(self) -> dict[str, int]:
        return {
            "product_fit": self.score_product_fit,
            "company_fit": self.score_company_fit,
            "market_fit": self.score_market_fit,
            "purchasing_potential": self.score_purchasing_potential,
            "contact_quality": self.score_contact_quality,
            "growth_signals": self.score_growth_signals,
            "data_completeness": self.score_data_completeness,
            "recent_activity": self.score_recent_activity,
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reload_settings() -> None:
    get_settings.cache_clear()
