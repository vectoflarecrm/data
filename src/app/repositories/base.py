from __future__ import annotations

import uuid
from typing import Any, Generic, TypeVar

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import Base
from app.schemas.common import Page, to_page

ModelT = TypeVar("ModelT", bound=Base)


class BaseRepository(Generic[ModelT]):  # noqa: UP046
    model: type[ModelT]

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, entity_id: uuid.UUID) -> ModelT | None:
        return await self.session.get(self.model, entity_id)

    async def create(self, **values: Any) -> ModelT:
        obj = self.model(**values)
        self.session.add(obj)
        await self.session.flush()
        return obj

    async def update(self, entity: ModelT, **values: Any) -> ModelT:
        for key, value in values.items():
            setattr(entity, key, value)
        await self.session.flush()
        await self.session.refresh(entity)
        return entity

    async def delete(self, entity: ModelT) -> None:
        await self.session.delete(entity)
        await self.session.flush()

    async def list_paginated(
        self,
        *,
        page: int = 1,
        page_size: int = 50,
        order_by: Any = None,
        filters: list[ColumnElement[bool]] | None = None,
        model: type[Any] | None = None,
    ) -> Page[Any]:
        model = model or self.model
        query = select(model)
        if filters:
            query = query.where(*filters)
        count_query = select(func.count()).select_from(model)
        if filters:
            count_query = count_query.where(*filters)

        total = (await self.session.execute(count_query)).scalar_one()
        if order_by is not None:
            query = query.order_by(order_by)
        query = query.offset((page - 1) * page_size).limit(page_size)
        result = await self.session.execute(query)
        items = list(result.scalars().unique().all())
        return to_page(items, total, page, page_size)
