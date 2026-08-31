from __future__ import annotations

from app.db.models import Company
from app.enrichment.discovery import (
    extract_emails,
    extract_whatsapp_numbers,
    is_direct_contact_email,
)
from app.research.prompts import contacts_prompt


def test_direct_email_policy_rejects_sales_and_invoice_inboxes() -> None:
    assert is_direct_contact_email("jane.doe@watersports.test")
    assert not is_direct_contact_email("sales@watersports.test")
    assert not is_direct_contact_email("sales.eu@watersports.test")
    assert not is_direct_contact_email("invoice-team@watersports.test")

    assert extract_emails(
        "sales@watersports.test jane.doe@watersports.test invoice-team@watersports.test"
    ) == ["jane.doe@watersports.test"]


def test_whatsapp_requires_explicit_public_signal() -> None:
    ordinary_text = "Call our mobile +1 415 555 0101"
    assert extract_whatsapp_numbers(ordinary_text, []) == []

    links = ["https://wa.me/14155550101"]
    assert extract_whatsapp_numbers(ordinary_text, links) == ["+14155550101"]

    labeled_text = "WhatsApp: +1 415 555 0102"
    assert extract_whatsapp_numbers(labeled_text, []) == ["+14155550102"]


def test_contact_prompt_requires_source_and_no_inference() -> None:
    company = Company(company_name="Example Co", website="https://example.co")
    system, prompt = contacts_prompt(company, "A public team page names Jane Doe.")
    combined = f"{system}\n{prompt}"
    assert "Never guess email addresses" in combined
    assert "source_url" in combined
    assert "WhatsApp" in combined
    assert "sales/invoice" in combined
