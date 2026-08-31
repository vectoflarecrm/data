from __future__ import annotations

from app.ai.errors import (
    AICommandError,
    AIProviderError,
    AIProviderUnavailable,
    AISchemaValidationError,
    AITimeoutError,
)
from app.ai.factory import build_ai_provider, provider_name
from app.ai.gemini_cli_provider import GeminiCLIProvider
from app.ai.mock_provider import MockAIProvider, register
from app.ai.parsing import extract_json, parse_structured
from app.ai.protocol import AIProvider
from app.ai.schema import (
    BuyingSignalResult,
    CompanyResearchResult,
    ContactListResult,
    ContactPointResult,
    ContactResearchResult,
    EvidenceClaimResult,
    LeadScoreResult,
    ProductListResult,
    ProductResearchResult,
    SocialProfileResult,
    SocialResearchResult,
)

__all__ = [
    "AICommandError",
    "AIProvider",
    "AIProviderError",
    "AIProviderUnavailable",
    "AISchemaValidationError",
    "AITimeoutError",
    "BuyingSignalResult",
    "CompanyResearchResult",
    "ContactListResult",
    "ContactPointResult",
    "ContactResearchResult",
    "EvidenceClaimResult",
    "GeminiCLIProvider",
    "LeadScoreResult",
    "MockAIProvider",
    "ProductListResult",
    "ProductResearchResult",
    "SocialProfileResult",
    "SocialResearchResult",
    "build_ai_provider",
    "extract_json",
    "parse_structured",
    "provider_name",
    "register",
]
