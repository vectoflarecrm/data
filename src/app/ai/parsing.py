from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, ValidationError

from app.ai.errors import AISchemaValidationError

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
_JSON_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)


def extract_json(raw: str) -> Any:
    """Best-effort JSON extraction from arbitrary model text (fences, prose wrapper)."""
    text = raw.strip()
    if not text:
        raise AISchemaValidationError("empty AI output", raw_output=raw)
    candidates: list[str] = []
    fence = _FENCE_RE.search(text)
    if fence:
        candidates.append(fence.group(1).strip())
    candidates.append(text)
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
        match = _JSON_OBJECT_RE.search(candidate) or _JSON_ARRAY_RE.search(candidate)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass
        repaired = _try_repair_json(candidate)
        if repaired is not None:
            return repaired
    raise AISchemaValidationError("AI output is not valid JSON", raw_output=raw[:2000])


def _try_repair_json(candidate: str) -> Any:
    """Recover from common LLM JSON slips: trailing commas, unquoted keys."""
    repaired = re.sub(r",\s*([}\]])", r"\1", candidate)
    repaired = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)", r'\1"\2"\3', repaired)
    if repaired == candidate:
        return None
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        return None


def parse_structured(raw: str, schema: type[BaseModel]) -> BaseModel:
    """Parse raw model output into the Pydantic schema; never trust the model."""
    try:
        payload = extract_json(raw)
    except AISchemaValidationError:
        raise
    try:
        return schema.model_validate(payload)
    except ValidationError as exc:
        details = exc.errors()
        message = "; ".join(
            f"{'.'.join(str(p) for p in e.get('loc', []))}: {e.get('msg', 'invalid')}"
            for e in details[:5]
        )
        raise AISchemaValidationError(
            f"AI output failed validation: {message}", raw_output=raw[:2000]
        ) from exc
