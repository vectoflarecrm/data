from __future__ import annotations

import pytest

from app.core.enums import ProductCategory
from app.core.product_categories import PRODUCT_CATEGORY_LABELS, map_product_category


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("RIB boats", ProductCategory.RIB_BOAT),
        ("RIB boat", ProductCategory.RIB_BOAT),
        ("rigid inflatable boat", ProductCategory.RIB_BOAT),
        ("Inflatable boats", ProductCategory.INFLATABLE_BOAT),
        ("inflatable", ProductCategory.INFLATABLE_BOAT),
        ("SUPs (standup paddleboards)", ProductCategory.SUP),
        ("stand-up paddleboards", ProductCategory.SUP),
        ("INFLATABLE_SUP", ProductCategory.INFLATABLE_SUP),
    ],
)
def test_customer_product_aliases_use_canonical_categories(
    raw: str, expected: ProductCategory
) -> None:
    assert map_product_category(raw) == expected


def test_unknown_product_is_not_guessed() -> None:
    assert map_product_category("marine accessories") is None


def test_core_category_display_labels_are_stable() -> None:
    assert PRODUCT_CATEGORY_LABELS == {
        ProductCategory.RIB_BOAT: "RIB boats",
        ProductCategory.INFLATABLE_BOAT: "Inflatable boats",
        ProductCategory.SUP: "SUPs (standup paddleboards)",
    }
