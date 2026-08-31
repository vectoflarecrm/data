from __future__ import annotations

import logging

from app.ai.errors import AIProviderUnavailable
from app.ai.gemini_cli_provider import GeminiCLIProvider
from app.core.config import get_settings

logger = logging.getLogger(__name__)


def build_ai_provider():
    """Return the configured AI provider (V1: Gemini CLI, or fail with a clear error)."""
    settings = get_settings()
    if not settings.gemini_cli_enabled:
        raise AIProviderUnavailable("GEMINI_CLI_ENABLED is false")
    return GeminiCLIProvider()


def provider_name() -> str:
    try:
        return build_ai_provider().name
    except AIProviderUnavailable as exc:
        return f"unavailable ({exc})"
