"""add canonical watersports product categories

Revision ID: f1a2b3c4d5e6
Revises: d8f2a4c6e139
"""
import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a2b3c4d5e6"
down_revision: str | Sequence[str] | None = "d8f2a4c6e139"
branch_labels = None
depends_on = None

_PRODUCT_CATEGORY_VALUES = (
    "SUP",
    "INFLATABLE_SUP",
    "HARD_SUP",
    "TOURING_SUP",
    "ALL_ROUND_SUP",
    "RACE_SUP",
    "YOGA_SUP",
    "KAYAK",
    "INFLATABLE_KAYAK",
    "FISHING_KAYAK",
    "TOURING_KAYAK",
    "INFLATABLE_BOAT",
    "RIB",
    "PADDLE",
    "PUMP",
    "LIFE_JACKET",
    "WATER_TOY",
    "ACCESSORY",
    "OTHER",
    "RIB_BOAT",
)

_CANONICAL_PRODUCTS = (
    ("RIB boats", "RIB_BOAT"),
    ("Inflatable boats", "INFLATABLE_BOAT"),
    ("SUPs (standup paddleboards)", "SUP"),
)


def upgrade() -> None:
    # The initial migration omitted RIB_BOAT, although the runtime enum already
    # exposes it. Rebuild the enum so the new value can be used immediately in
    # this transaction on all supported PostgreSQL versions.
    enum_values = ", ".join(f"'{value}'" for value in _PRODUCT_CATEGORY_VALUES)
    op.execute(f"CREATE TYPE productcategory_new AS ENUM ({enum_values})")
    op.execute(
        "ALTER TABLE products ALTER COLUMN category TYPE productcategory_new "
        "USING category::text::productcategory_new"
    )
    op.execute("DROP TYPE productcategory")
    op.execute("ALTER TYPE productcategory_new RENAME TO productcategory")

    # Normalize the legacy generic RIB category while preserving all existing
    # product rows and company-product links.
    op.execute("UPDATE products SET category = 'RIB_BOAT' WHERE category = 'RIB'")

    for name, category in _CANONICAL_PRODUCTS:
        statement = sa.text(
            "INSERT INTO products (id, name, category) "
            "VALUES (CAST(:id AS uuid), :name, CAST(:category AS productcategory)) "
            "ON CONFLICT (name) DO UPDATE SET category = EXCLUDED.category"
        ).bindparams(id=str(uuid.uuid4()), name=name, category=category)
        op.execute(statement)


def downgrade() -> None:
    # Keep enum values and linked catalog rows. Removing an enum value is unsafe
    # when user data may still reference it; a later cleanup can be explicit.
    pass
