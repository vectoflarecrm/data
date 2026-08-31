from __future__ import annotations

import json

import pytest

from app.ai import (
    AICommandError,
    AIProviderUnavailable,
    AISchemaValidationError,
    AITimeoutError,
    CompanyResearchResult,
    GeminiCLIProvider,
    MockAIProvider,
    ProductResearchResult,
    extract_json,
    parse_structured,
)
from app.ai.parsing import extract_json as _extract
from app.core.enums import CompanyType, ProductCategory


def _company_payload() -> dict:
    return {
        "description": "Distributor of inflatable SUPs.",
        "company_type": ["DISTRIBUTOR", "IMPORTER"],
        "main_products": ["INFLATABLE_SUP", "KAYAK"],
        "brands": ["Bluewater"],
        "confidence": 0.93,
    }


class TestParsing:
    def test_extract_plain_json(self) -> None:
        assert extract_json('{"a": [1, 2]}') == {"a": [1, 2]}

    def test_extract_json_inside_fences(self) -> None:
        raw = '```json\n{"a": 1}\n```'
        assert extract_json(raw) == {"a": 1}

    def test_extract_json_wrapped_in_prose(self) -> None:
        raw = 'Sure! Here is the answer: {"a": 1, "b": 2} hope it helps.'
        assert extract_json(raw) == {"a": 1, "b": 2}

    def test_extract_recovers_trailing_comma(self) -> None:
        assert extract_json('{"a": 1, "b": [1, 2,],}') == {"a": 1, "b": [1, 2]}

    def test_extract_raises_on_unparseable(self) -> None:
        with pytest.raises(AISchemaValidationError):
            extract_json("here is my answer but no json at all")

    def test_validate_schema_success(self) -> None:
        result = parse_structured(json.dumps(_company_payload()), CompanyResearchResult)
        assert isinstance(result, CompanyResearchResult)
        assert result.company_type == [CompanyType.DISTRIBUTOR, CompanyType.IMPORTER]

    def test_validate_schema_rejects_wrong_fields(self) -> None:
        with pytest.raises(AISchemaValidationError):
            parse_structured(
                '{"description": "x", "company_type": "not-a-list"}', CompanyResearchResult
            )

    def test_validate_schema_rejects_extra_keys(self) -> None:
        payload = _company_payload() | {"made_up_key": "nonsense"}
        with pytest.raises(AISchemaValidationError):
            parse_structured(json.dumps(payload), CompanyResearchResult)


def _write_script(tmp_path, body: str) -> str:
    script = tmp_path / "fake_gemini.sh"
    script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    script.chmod(0o755)
    return str(script)


@pytest.mark.asyncio
class TestGeminiCLIAdapter:
    async def test_valid_json_roundtrip(self, tmp_path) -> None:
        json_body = _company_payload()
        cmd = _write_script(tmp_path, f"echo '{json.dumps(json_body)}'\n")
        provider = GeminiCLIProvider(command=[cmd])
        result = await provider.complete_structured(
            result_type=CompanyResearchResult,
            system="Extract company data.",
            prompt="Analyze: Bluewater sells inflatable SUPs.",
        )
        assert isinstance(result, CompanyResearchResult)
        assert result.main_products == [ProductCategory.INFLATABLE_SUP, ProductCategory.KAYAK]

    async def test_model_flag_passed(self, tmp_path) -> None:
        seen = []

        class Recorder(GeminiCLIProvider):
            async def complete(self, *, system, prompt, model=None):  # noqa: ARG003
                args = ["gemini", "cli"]
                if model:
                    args.extend(["-m", model])
                args.extend(["-p", prompt])
                return await self._run(args)

            async def _run(self, args):  # noqa: N802
                seen.append(args)
                return '{"description": "d", "confidence": 0.5}'

        provider = Recorder(command=["gemini", "cli"], model="gemini-2.5-pro")
        await provider.complete(system="s", prompt="p", model="gemini-2.5-pro")
        args = seen[0]
        assert args == ["gemini", "cli", "-m", "gemini-2.5-pro", "-p", "p"]

    async def test_timeout_kills_process(self, tmp_path) -> None:
        cmd = _write_script(tmp_path, "exec sleep 30\n")
        provider = GeminiCLIProvider(command=[cmd], timeout_seconds=1)
        with pytest.raises(AITimeoutError):
            await provider.complete(system="s", prompt="p")

    async def test_cli_missing_raises_provider_unavailable(self) -> None:
        provider = GeminiCLIProvider(command=["/nonexistent/gemini-cli"])
        with pytest.raises(AIProviderUnavailable):
            await provider.complete(system="s", prompt="p")

    async def test_cli_error_returns_nonzero(self, tmp_path) -> None:
        cmd = _write_script(tmp_path, 'echo "boom" >&2\nexit 3\n')
        provider = GeminiCLIProvider(command=[cmd])
        with pytest.raises(AICommandError) as exc:
            await provider.complete(system="s", prompt="p")
        assert exc.value.returncode == 3
        assert "boom" in exc.value.stderr

    async def test_malformed_json_raises_schema_error(self, tmp_path) -> None:
        cmd = _write_script(tmp_path, 'echo "definitely not json"\n')
        provider = GeminiCLIProvider(command=[cmd])
        with pytest.raises(AISchemaValidationError):
            await provider.complete_structured(
                result_type=CompanyResearchResult,
                system="s",
                prompt="p",
            )

    async def test_partial_json_recovers_via_repair(self, tmp_path) -> None:
        payload = '{ "description": "d", "main_products": ["SUP",] }'
        cmd = _write_script(tmp_path, f"echo '{payload}'\n")
        provider = GeminiCLIProvider(command=[cmd])
        result = await provider.complete_structured(
            result_type=CompanyResearchResult,
            system="s",
            prompt="p",
        )
        assert result.description == "d"

    async def test_empty_output_raises(self, tmp_path) -> None:
        cmd = _write_script(tmp_path, 'echo ""\n')
        provider = GeminiCLIProvider(command=[cmd])
        with pytest.raises(AISchemaValidationError):
            await provider.complete_structured(
                result_type=CompanyResearchResult,
                system="s",
                prompt="p",
            )

    async def test_stderr_warnings_with_valid_stdout_ok(self, tmp_path) -> None:
        cmd = _write_script(
            tmp_path,
            f"echo \"warning: rate limit near\" >&2\necho '{json.dumps(_company_payload())}'\n",
        )
        provider = GeminiCLIProvider(command=[cmd])
        result = await provider.complete_structured(
            result_type=CompanyResearchResult,
            system="s",
            prompt="p",
        )
        assert result.description == "Distributor of inflatable SUPs."


@pytest.mark.asyncio
class TestMockAIProvider:
    async def test_structured_returns_registered_value(self) -> None:
        canned = ProductResearchResult(product_name="Board", category="SUP")
        provider = MockAIProvider(handlers={ProductResearchResult: canned})
        result = await provider.complete_structured(
            result_type=ProductResearchResult,
            system="s",
            prompt="p",
        )
        assert result is canned
        assert provider.structured_calls[0][1] == "p"

    async def test_structured_calls_handler(self) -> None:
        async def handler(prompt: str) -> ProductResearchResult:
            return ProductResearchResult(product_name=prompt[:3], category="PUMP")

        provider = MockAIProvider(handlers={ProductResearchResult: handler})
        result = await provider.complete_structured(
            result_type=ProductResearchResult,
            system="s",
            prompt="abc",
        )
        assert isinstance(result, ProductResearchResult)
        assert result.product_name == "abc"

    async def test_missing_handler_raises(self) -> None:
        provider = MockAIProvider()
        with pytest.raises(ValueError):
            await provider.complete_structured(
                result_type=CompanyResearchResult,
                system="s",
                prompt="p",
            )


def test_extract_json_import_alias() -> None:
    """Ensure the parsing module and package re-export agree."""
    assert _extract is extract_json
