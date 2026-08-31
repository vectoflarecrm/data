# AI Providers

All AI calls route through the `AIProvider` protocol; the research domain never imports a concrete provider.

## Interface (conceptual)

```
research_company(...)
extract_contacts(...)
classify_company(...)
analyze_products(...)
identify_buying_roles(...)
score_lead(...)
```

## V1 providers

- `GeminiCLIProvider`: invokes the user's local Gemini CLI as an external subprocess, extracts JSON from stdout, validates with Pydantic schemas before persistence. Configuration only via env vars (`GEMINI_CLI_COMMAND`, `GEMINI_MODEL`).
- `MockAIProvider`: deterministic responses for tests.

## Future providers

OpenRouter, New API, OneAPI, OpenAI, Anthropic, Gemini API — same protocol, not implemented in V1.

## Rules

- Never trust raw model output.
- All AI output validated through Pydantic before database persistence.
- Never invent emails or fabricate missing facts; return UNKNOWN/INFERRED markers.
- If the Gemini CLI is unavailable, return a clear provider error — never silently pretend success.