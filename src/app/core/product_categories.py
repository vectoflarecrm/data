from __future__ import annotations

import re

from app.core.enums import ProductCategory

PRODUCT_CATEGORY_LABELS: dict[ProductCategory, str] = {
    ProductCategory.RIB_BOAT: "RIB boats",
    ProductCategory.INFLATABLE_BOAT: "Inflatable boats",
    ProductCategory.SUP: "SUPs (standup paddleboards)",
}


_PRODUCT_CATEGORY_ALIASES: dict[str, ProductCategory] = {
    # RIB boat terminology. RIB is retained as a legacy enum value, but new
    # imports use the more explicit canonical category RIB_BOAT.
    "RIB": ProductCategory.RIB_BOAT,
    "RIB_BOAT": ProductCategory.RIB_BOAT,
    "RIB_BOATS": ProductCategory.RIB_BOAT,
    "RIGID_INFLATABLE_BOAT": ProductCategory.RIB_BOAT,
    "RIGID_INFLATABLE_BOATS": ProductCategory.RIB_BOAT,
    # Inflatable boat terminology.
    "INFLATABLE": ProductCategory.INFLATABLE_BOAT,
    "INFLATABLE_BOAT": ProductCategory.INFLATABLE_BOAT,
    "INFLATABLE_BOATS": ProductCategory.INFLATABLE_BOAT,
    # SUP terminology. Keep explicit inflatable SUP as its own existing
    # subcategory rather than collapsing it into the general SUP category.
    "SUP": ProductCategory.SUP,
    "SUPS": ProductCategory.SUP,
    "STANDUP_PADDLEBOARD": ProductCategory.SUP,
    "STANDUP_PADDLEBOARDS": ProductCategory.SUP,
    "STAND_UP_PADDLEBOARD": ProductCategory.SUP,
    "STAND_UP_PADDLEBOARDS": ProductCategory.SUP,
    "INFLATABLE_SUP": ProductCategory.INFLATABLE_SUP,
    "INFLATABLE_SUPS": ProductCategory.INFLATABLE_SUP,
}


def map_product_category(value: str | None) -> ProductCategory | None:
    """Map a product label to the canonical database category.

    Parenthetical explanations and punctuation are ignored, while explicit
    subcategories such as ``INFLATABLE_SUP`` remain distinguishable.
    Unknown free-text product names return ``None`` so they are not guessed.
    """
    if not value:
        return None
    normalized = re.sub(r"[^A-Z0-9]+", "_", value.upper()).strip("_")
    if not normalized:
        return None

    # Explicit subcategories must be checked before the broader INFLATABLE alias.
    if normalized in {"INFLATABLE_SUP", "INFLATABLE_SUPS"}:
        return ProductCategory.INFLATABLE_SUP

    for alias in sorted(_PRODUCT_CATEGORY_ALIASES, key=len, reverse=True):
        category = _PRODUCT_CATEGORY_ALIASES[alias]
        if normalized == alias or normalized.startswith(f"{alias}_"):
            return category

    try:
        return ProductCategory(normalized)
    except ValueError:
        return None
