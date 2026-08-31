from __future__ import annotations

import asyncio
import shlex
import shutil
from collections.abc import Sequence

from pydantic import BaseModel

from app.ai.errors import (
    AICommandError,
    AIProviderUnavailable,
    AISchemaValidationError,
    AITimeoutError,
)
from app.ai.parsing import parse_structured
from app.core.config import get_settings

_GEMINI_JSON_SCHEMA_INSTRUCTION = (
    "Respond with the requested answer as a single JSON object. Do not wrap it in "
    "markdown code fences. Do not add any prose before or after the JSON. "
    "Use exactly the field names requested. Never invent email addresses, phone "
    "numbers or other contact data that is not present in the provided source text; "
    "leave such fields null or UNKNOWN unless clearly stated in the text."
)


class GeminiCLIProvider:
    """External-process AI adapter: invokes the user's `gemini` CLI as a subprocess.

    Configuration comes only from environment variables / settings
    (GEMINI_CLI_COMMAND, GEMINI_MODEL, GEMINI_TIMEOUT_SECONDS, GEMINI_CLI_ENABLED).
    """

    name = "gemini-cli-provider"

    def __init__(
        self,
        command: str | Sequence[str] | None = None,
        model: str | None = None,
        timeout_seconds: int | None = None,
    ) -> None:
        settings = get_settings()
        self.model = model if model is not None else settings.gemini_model
        self.timeout_seconds = (
            timeout_seconds if timeout_seconds is not None else settings.gemini_timeout_seconds
        )
        if command is None:
            command = shlex.split(settings.gemini_cli_command)
        elif isinstance(command, str):
            command = shlex.split(command)
        self.command = list(command)
        self._semaphore = asyncio.Semaphore(get_settings().ai_max_concurrency)

    async def complete(
        self,
        *,
        system: str,
        prompt: str,
        model: str | None = None,
    ) -> str:
        effective_model = model or self.model
        args = list(self.command)
        if effective_model:
            args.extend(["-m", effective_model])
        args.extend(["-p", prompt])
        if not shutil.which(args[0]):
            raise AIProviderUnavailable(f"gemini CLI not found: {args[0]} (set GEMINI_CLI_COMMAND)")
        async with self._semaphore:
            return await self._run(args)

    async def complete_structured(
        self,
        *,
        result_type: type[BaseModel],
        system: str,
        prompt: str,
        model: str | None = None,
    ) -> BaseModel:
        full_system = f"{system}\n\n{_GEMINI_JSON_SCHEMA_INSTRUCTION}\n\nExpected JSON schema (Pydantic):\n{result_type.model_json_schema()}"
        raw = await self.complete(system=full_system, prompt=prompt, model=model)
        try:
            return parse_structured(raw, result_type)
        except AISchemaValidationError:
            raw = await self.complete(
                system=f"{full_system}\n\nYour previous response was not valid {result_type.__name__}. Return ONLY one valid JSON object now.",
                prompt=prompt,
                model=model,
            )
            return parse_structured(raw, result_type)

    async def _run(self, args: list[str]) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise AIProviderUnavailable(f"gemini CLI not found: {args[0]}") from exc
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=self.timeout_seconds
            )
        except TimeoutError as exc:
            proc.kill()
            await proc.communicate()
            raise AITimeoutError(f"gemini CLI timed out after {self.timeout_seconds}s") from exc
        if proc.returncode not in (0, None):
            raise AICommandError(
                f"gemini CLI exited with {proc.returncode}",
                returncode=proc.returncode,
                stderr=stderr.decode("utf-8", errors="replace")[:2000],
            )
        return stdout.decode("utf-8", errors="replace")
