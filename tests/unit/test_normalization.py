from __future__ import annotations

from app.core.normalization import (
    is_valid_email,
    is_valid_url,
    normalize_domain,
    normalize_email,
    normalize_full_name,
    normalize_name,
    normalize_phone,
)


def test_normalize_domain_variants() -> None:
    assert normalize_domain("https://www.AquaMarina.com/shop") == "aquamarina.com"
    assert normalize_domain("WWW.SUP.com") == "sup.com"
    assert normalize_domain("brand.example.org") == "brand.example.org"
    assert normalize_domain("") == ""


def test_normalize_email() -> None:
    assert normalize_email("  John@Example.COM ") == "john@example.com"


def test_is_valid_email() -> None:
    assert is_valid_email("a@b.com")
    assert not is_valid_email("nope")
    assert not is_valid_email("a@b")


def test_is_valid_url() -> None:
    assert is_valid_url("https://example.com")
    assert is_valid_url("http://x.io/a?b=1")
    assert not is_valid_url("")
    assert not is_valid_url("javascript:alert(1)")
    assert not is_valid_url("ftp://x.io")


def test_normalize_phone_e164() -> None:
    assert normalize_phone("+49 151 2345 6789") == "+4915123456789"
    assert normalize_phone("(212) 555-0123") == "2125550123"
    assert normalize_phone("+1-415-555-2671") == "+14155552671"


def test_normalize_full_name() -> None:
    assert normalize_full_name("  Anna ", "  Müller ") == "Anna Müller"
    assert normalize_full_name(None, "Doe") == "Doe"


def test_normalize_name_collapses_whitespace() -> None:
    assert normalize_name("  A   B  ") == "A B"
