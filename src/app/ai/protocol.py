from __future__ import annotations

from typing import Protocol, runtime_checkable

from pydantic import BaseModel


@runtime_checkable
class AIProvider(Protocol):
    """Concrete AI backends implement this protocol; research code depends on it only."""

    name: str

    async def complete(
        self,
        *,
        system: str,
        prompt: str,
        model: str | None = None,
    ) -> str:
        """Return the raw text completion."""
        ...

    async def complete_structured(
        self,
        *,
        result_type: type[BaseModel],
        system: str,
        prompt: str,
        model: str | None = None,
    ) -> BaseModel:
        """Return an LLM answer validated against `result_type`.

        Raises AISchemaValidationError/AITimeoutError/AICommandError on failure —
        never silently returns fabricated success.
        """
        ...
