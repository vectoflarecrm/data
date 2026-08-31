from __future__ import annotations

from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


T = TypeVar("T", bound=BaseModel)


class Page(BaseModel, Generic[T]):  # noqa: UP046
    items: list[T]
    total: int
    page: int
    page_size: int
    pages: int


def to_page(items: list[Any], total: int, page: int, page_size: int) -> Page[Any]:
    pages = (total // page_size) + (1 if total % page_size else 0)
    return Page[Any](items=items, total=total, page=page, page_size=page_size, pages=pages)
