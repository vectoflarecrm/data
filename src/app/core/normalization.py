from __future__ import annotations

import re
from urllib.parse import urlparse


def normalize_domain(value: str) -> str:
    """Normalize a website/domain to a canonical lowercase domain without scheme/path/www."""
    value = value.strip().lower()
    if not value:
        return ""
    if "://" not in value:
        value = f"//{value}"
    parsed = urlparse(value)
    host = parsed.netloc or parsed.path.split("/")[0]
    host = host.split(":")[0]
    host = host.removeprefix("www.")
    return host.strip(".")


def is_valid_url(value: str) -> bool:
    if not value:
        return False
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_email(value: str) -> str:
    return value.strip().lower().replace(" ", "")


VALID_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_valid_email(value: str) -> bool:
    return bool(VALID_EMAIL_RE.match(value.strip()))


def normalize_phone(value: str) -> str:
    """Best-effort E.164 normalization: keep leading +, drop everything else."""
    value = value.strip()
    if not value:
        return ""
    digits = re.sub(r"[^\d]", "", value)
    if not digits:
        return ""
    if value.startswith("+"):
        return f"+{digits}"
    return digits


def normalize_name(value: str) -> str:
    return " ".join(value.split())


def normalize_full_name(first: str | None, last: str | None) -> str:
    parts = [normalize_name(first or "").strip(), normalize_name(last or "").strip()]
    return " ".join(p for p in parts if p)
