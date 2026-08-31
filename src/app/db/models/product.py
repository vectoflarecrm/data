from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.enums import ProductCategory
from app.db.base import Base
from app.db.models.mixins import TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from app.db.models.company import Company


class Product(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "products"
    __table_args__ = (UniqueConstraint("name", name="uq_product_name"),)

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    category: Mapped[ProductCategory | None] = mapped_column(index=True)
    subcategory: Mapped[str | None] = mapped_column(String(150))
    description: Mapped[str | None] = mapped_column(Text)

    company_links: Mapped[list[CompanyProduct]] = relationship(back_populates="product")  # noqa: F821

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Product id={self.id} name={self.name!r} category={self.category}>"


class CompanyProduct(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "company_products"
    __table_args__ = (
        UniqueConstraint("company_id", "product_id", name="uq_company_product"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True
    )
    relationship_type: Mapped[str] = mapped_column(String(30), default="SOLD")
    source_evidence_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("research_evidence.id", ondelete="SET NULL")
    )

    company: Mapped[Company] = relationship(back_populates="products")  # noqa: F821
    product: Mapped[Product] = relationship(back_populates="company_links")
