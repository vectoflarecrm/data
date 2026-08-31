from __future__ import annotations

from collections.abc import Awaitable, Callable

from pydantic import BaseModel

Handler = Callable[[str], Awaitable[BaseModel]]


class MockAIProvider:
    """Deterministic AI provider for tests — records calls, returns canned results."""

    name = "mock-ai-provider"

    def __init__(
        self,
        handlers: dict[type[BaseModel] | str, BaseModel | Handler] | None = None,
    ) -> None:
        self.handlers: dict[str, BaseModel | Handler] = {}
        for key, value in (handlers or {}).items():
            self.handlers[_key_of(key)] = value
        self.complete_calls: list[tuple[str, str]] = []
        self.structured_calls: list[tuple[str, str]] = []

    async def complete(
        self,
        *,
        system: str,
        prompt: str,
        model: str | None = None,
    ) -> str:
        self.complete_calls.append((system, prompt))
        result = self.handlers.get("complete")
        if callable(result) and not isinstance(result, BaseModel):
            return str(await result(prompt))
        if result is not None:
            return str(result)
        return '{"__mock__": true}'

    async def complete_structured(
        self,
        *,
        result_type: type[BaseModel],
        system: str,
        prompt: str,
        model: str | None = None,
    ) -> BaseModel:
        self.structured_calls.append((system, prompt))
        result = self.handlers.get(_key_of(result_type))
        if callable(result):
            return await result(prompt)
        if result is not None:
            return result
        raise ValueError(f"No mock registered for {result_type.__name__}")


def _key_of(obj: type[BaseModel] | str) -> str:
    return obj.__name__ if isinstance(obj, type) else obj


def register(provider: MockAIProvider, schema: type[BaseModel], value: BaseModel | Handler) -> None:
    provider.handlers[_key_of(schema)] = value
