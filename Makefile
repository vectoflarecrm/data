.PHONY: install db-up db-down migrate seed test lint format run check

install:
	python3 -m venv .venv
	.venv/bin/pip install -e ".[dev]"

db-up:
	docker-compose up -d postgres

db-down:
	docker-compose down

migrate:
	.venv/bin/alembic upgrade head

seed:
	.venv/bin/python -m app.cli seed

test:
	.venv/bin/python -m pytest

lint:
	.venv/bin/ruff check .

format:
	.venv/bin/ruff format .
	.venv/bin/ruff check . --fix

check: lint test

run:
	.venv/bin/uvicorn app.main:app --reload --app-dir src

worker:
	.venv/bin/python -m app.research.workers --workers 3