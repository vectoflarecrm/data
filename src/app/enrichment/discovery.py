from __future__ import annotations

import re
from urllib.parse import urlsplit

from app.core.enums import Platform

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+")
_PHONE_RE = re.compile(r"(?:\+?\d[\d\s\-().]{6,25}\d)")
_WHATSAPP_RE = re.compile(r"(?:wa\.me|api\.whatsapp\.com)/(?:send/)?\s*(\+?\d[\d\s\-()]{6,20})")

_PLACEHOLDER_DOMAINS = {
    "example.com",
    "example.org",
    "example.net",
    "email.com",
    "your-domain.com",
    "domain.com",
    "yourcompany.com",
    "your-email.com",
    "name@company.com",
}

_SOCIAL_HOSTS: dict[str, Platform] = {
    "linkedin.com": Platform.LINKEDIN,
    "www.linkedin.com": Platform.LINKEDIN,
    "instagram.com": Platform.INSTAGRAM,
    "www.instagram.com": Platform.INSTAGRAM,
    "facebook.com": Platform.FACEBOOK,
    "www.facebook.com": Platform.FACEBOOK,
    "fb.com": Platform.FACEBOOK,
    "youtube.com": Platform.YOUTUBE,
    "www.youtube.com": Platform.YOUTUBE,
    "tiktok.com": Platform.TIKTOK,
    "www.tiktok.com": Platform.TIKTOK,
    "pinterest.com": Platform.PINTEREST,
    "www.pinterest.com": Platform.PINTEREST,
    "twitter.com": Platform.X,
    "www.twitter.com": Platform.X,
    "x.com": Platform.X,
    "www.x.com": Platform.X,
}


def normalize_email(email: str) -> str | None:
    email = (email or "").strip().strip(".,;").lower()
    if "@" not in email:
        return None
    local, _, domain = email.rpartition("@")
    domain = domain.strip()
    if local and "." in domain:
        return f"{local}@{domain}"
    return None


def extract_emails(text: str) -> list[str]:
    """Deterministic email extraction; never infers or fabricates addresses."""
    found: list[str] = []
    seen: set[str] = set()
    for raw in _EMAIL_RE.findall(text or ""):
        email = normalize_email(raw)
        if not email:
            continue
        domain = email.rsplit("@", 1)[1].lower()
        if domain in _PLACEHOLDER_DOMAINS or domain.endswith((".png", ".jpg", ".jpeg")):
            continue
        if email not in seen:
            seen.add(email)
            found.append(email)
    return found


def normalize_phone(raw: str) -> str | None:
    """Best-effort E.164-ish normalization; keeps country-coded numbers only."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) < 8 or len(digits) > 15:
        return None
    if not raw.strip().startswith("+"):
        # Without a leading + we cannot know the country code reliably.
        return None
    return "+" + digits


def extract_phones(text: str) -> list[tuple[str, str | None]]:
    """Return [(original, normalized_e164_or_None)] found verbatim in text."""
    found: list[tuple[str, str | None]] = []
    seen: set[str] = set()
    for raw in _PHONE_RE.findall(text or ""):
        candidate = raw.strip()
        if len(candidate) < 7:
            continue
        key = re.sub(r"\D", "", candidate)
        if key in seen:
            continue
        seen.add(key)
        found.append((candidate, normalize_phone(candidate)))
    return found


def detect_social(url: str) -> Platform | None:
    host = (urlsplit(url).netloc or "").lower()
    for mapped, platform in _SOCIAL_HOSTS.items():
        if host == mapped or host.endswith("." + mapped):
            return platform
    return None


def extract_social_links(links: list[str]) -> list[tuple[str, Platform]]:
    found: list[tuple[str, Platform]] = []
    seen: set[str] = set()
    for link in links:
        platform = detect_social(link)
        if platform is None:
            continue
        key = f"{platform.value}|{link.rstrip('/')}"
        if key in seen:
            continue
        seen.add(key)
        found.append((link, platform))
    return found


def extract_whatsapp_numbers(text: str, links: list[str] | None = None) -> list[str]:
    """Return publicly stated business WhatsApp numbers only (explicit wa.me links)."""
    found: list[str] = []
    seen: set[str] = set()
    sources = list(links or [])
    for number in _WHATSAPP_RE.findall(" ".join(sources)):
        digits = re.sub(r"\D", "", number)
        if digits and digits not in seen and len(digits) >= 8:
            seen.add(digits)
            found.append("+" + digits)
    return found


_BUYING_PHRASES: dict[str, tuple[str, str]] = {
    "download catalog": ("CATALOG_RELEASE", "catalog available for download"),
    "download catalogue": ("CATALOG_RELEASE", "catalog available for download"),
    "new catalog": ("CATALOG_RELEASE", "new catalog published"),
    "new collection": ("NEW_PRODUCT", "new collection announced"),
    "new arrival": ("NEW_PRODUCT", "new arrivals listed"),
    "now available": ("NEW_PRODUCT", "product marked available"),
    "new product": ("NEW_PRODUCT", "new product mentioned"),
    "new brand": ("NEW_BRAND", "new brand mentioned"),
    "new store": ("NEW_STORE", "new store mentioned"),
    "opening soon": ("NEW_STORE", "store opening mentioned"),
    "groundbreaking": ("NEW_STORE", "new location mentioned"),
    "grand opening": ("NEW_STORE", "grand opening mentioned"),
    "trade show": ("TRADE_SHOW", "trade show participation"),
    "booth": ("TRADE_SHOW", "exhibition booth mentioned"),
    "expanding": ("EXPANSION", "expansion mentioned"),
    "expansion": ("EXPANSION", "expansion mentioned"),
    "new warehouse": ("NEW_WAREHOUSE", "new warehouse mention"),
    "hiring": ("NEW_HIRING", "hiring announced"),
    "we are looking for": ("NEW_HIRING", "open recruitment mention"),
    "career": ("NEW_HIRING", "career page mention"),
    "partnership": ("PARTNERSHIP", "partnership mention"),
    "distribution partner": ("NEW_DISTRIBUTOR", "distributor partnership mention"),
}


def detect_buying_signals(text: str, source_url: str) -> list[tuple[str, str, str]]:
    """Deterministic buying-signal detection in page text: [(event_type, description, source_url)]."""
    lowered = (text or "").lower()
    signals: list[tuple[str, str, str]] = []
    for phrase, (event_type, template) in _BUYING_PHRASES.items():
        if phrase in lowered:
            signals.append((event_type, template, source_url))
    return signals


def derive_domain(website: str | None) -> str | None:
    if not website:
        return None
    host = (urlsplit(website).netloc or website).lower()
    if host.startswith("www."):
        host = host[4:]
    if not host.replace(".", "").isalnum():
        return None
    return host


def guess_website(company_name: str) -> tuple[str, float]:
    """Inference helper: builds a probable website from the name (LOW confidence, never verified)."""
    slug = re.sub(r"[^a-z0-9]+", "", company_name.lower()).strip()
    return f"https://{slug}.com", 0.2


def is_contact_page(url: str | None) -> bool:
    if not url:
        return False
    path = (urlsplit(url).path or "").lower()
    return "contact" in path


def is_team_page(url: str | None) -> bool:
    if not url:
        return False
    path = (urlsplit(url).path or "").lower()
    return "team" in path or "people" in path


def is_catalog_page(url: str | None) -> bool:
    if not url:
        return False
    path = (urlsplit(url).path or "").lower()
    return any(part in path for part in ("catalog", "catalogue", "product", "brand"))
