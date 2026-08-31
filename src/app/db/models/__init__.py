from __future__ import annotations

from app.db.models.ai import AIContext
from app.db.models.company import Brand, Company, CompanyBrand, CompanyEvent
from app.db.models.contact import Contact, ContactMethod, SocialAccount
from app.db.models.email_suppression import EmailSuppression
from app.db.models.evidence import ResearchEvidence
from app.db.models.outreach import Campaign, Outreach, OutreachEvent
from app.db.models.product import CompanyProduct, Product
from app.db.models.research import ResearchTask, ResearchTaskAttempt
from app.db.models.score import LeadScore

__all__ = [
    "AIContext",
    "Campaign",
    "Brand",
    "Company",
    "CompanyBrand",
    "CompanyEvent",
    "CompanyProduct",
    "EmailSuppression",
    "Contact",
    "ContactMethod",
    "LeadScore",
    "Product",
    "ResearchEvidence",
    "ResearchTask",
    "ResearchTaskAttempt",
    "Outreach",
    "OutreachEvent",
    "SocialAccount",
]

# Import ensures relationships resolve across modules.
_ = (Company, Brand, CompanyBrand, CompanyEvent, CompanyProduct, Contact, ContactMethod, SocialAccount, OutreachEvent)
