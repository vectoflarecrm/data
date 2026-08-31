from __future__ import annotations

import argparse
import asyncio
import uuid
from pathlib import Path

from sqlalchemy import select, text

from app.db.session import dispose_engine, get_session_factory, init_engine
from app.import_export.csv_exporter import export_companies
from app.import_export.csv_importer import CsvImporter


async def _research_run(workers: int | None) -> None:
    from app.research.workers import run_workers

    async def executor(session, task):
        from app.research.executor import dispatch
        from app.research.register import register_all

        register_all()
        return await dispatch(session, task)

    await run_workers(executor, count=workers)


async def _import_csv(path: Path, *, suppression_only: bool = False) -> None:
    await init_engine()
    factory = get_session_factory()
    async with factory() as session:
        importer = CsvImporter(session)
        report = await importer.import_text(
            path.read_text(encoding="utf-8-sig"), suppression_only=suppression_only
        )
        await session.commit()
    await dispose_engine()

    print("Import complete")
    for label, value in report.summary.items():
        if isinstance(value, list):
            if value:
                print(f"  {label}: {len(value)}")
                for item in value[:20]:
                    print(f"    - {item}")
            else:
                print(f"  {label}: 0")
        else:
            print(f"  {label}: {value}")


async def _export_csv(path: Path) -> None:
    await init_engine()
    factory = get_session_factory()
    async with factory() as session:
        content = await export_companies(session)
    await dispose_engine()
    path.write_text(content, encoding="utf-8")
    print(f"Exported companies to {path}")


async def _healthcheck() -> None:
    await init_engine()
    factory = get_session_factory()
    async with factory() as session:
        result = await session.execute(text("SELECT 1"))
        print("Database connection: OK", result.scalar_one())
    await dispose_engine()


async def _ai_check(sample: str | None) -> None:
    from app.ai.factory import build_ai_provider

    provider = build_ai_provider()
    print(f"AI provider: {provider.name}")
    if sample:
        text_out = await provider.complete(
            system="You are a compliance checker. Reply with a single short sentence.",
            prompt=sample,
        )
        print(f"Round trip ({len(text_out)} chars): {text_out[:200]}")


async def _context_rebuild(company_id: str | None = None, ai: bool = False) -> None:
    from app.db.models import Company
    from app.enrichment.ai_context import generate_company_contexts

    await init_engine()
    factory = get_session_factory()
    async with factory() as session:
        query = select(Company).order_by(Company.company_name)
        if company_id:
            query = query.where(Company.id == uuid.UUID(company_id))
        companies = list((await session.execute(query)).scalars().all())
        if not companies:
            print("No companies matched.")
            await dispose_engine()
            return
        for company in companies:
            rows = await generate_company_contexts(session, company, use_ai=ai)
            await session.flush()
            kinds = sorted({row.context_type for row in rows})
            print(f"{company.company_name}: {', '.join(kinds)}")
        await session.commit()
        print(
            f"Context regenerated for {len(companies)} company/companies "
            f"(all types, deterministic)."
        )
    await dispose_engine()


def main() -> None:
    parser = argparse.ArgumentParser(prog="app", description="Watersports Intelligence CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    import_parser = sub.add_parser("import-csv", help="Import companies from a CSV file")
    import_parser.add_argument("file", type=Path)
    import_parser.add_argument(
        "--suppressions", action="store_true", help="Import invalid/suppressed email addresses"
    )

    export_parser = sub.add_parser("export-csv", help="Export companies to a CSV file")
    export_parser.add_argument("output", type=Path)

    sub.add_parser("healthcheck", help="Check database connectivity")

    ai_parser = sub.add_parser("ai-check", help="Check AI provider availability")
    ai_parser.add_argument("--sample", default=None, help="Run a small round-trip completion")

    run_parser = sub.add_parser("research-run", help="Run research workers (blocks until Ctrl+C)")
    run_parser.add_argument("--workers", type=int, default=None)

    context_parser = sub.add_parser("context-rebuild", help="Regenerate AI context objects")
    context_parser.add_argument("--company-id", default=None, help="Regenerate a single company")
    context_parser.add_argument(
        "--ai", action="store_true", help="Polish prose with the AI provider"
    )

    args = parser.parse_args()

    if args.command == "import-csv":
        asyncio.run(_import_csv(args.file, suppression_only=args.suppressions))
    elif args.command == "export-csv":
        asyncio.run(_export_csv(args.output))
    elif args.command == "healthcheck":
        asyncio.run(_healthcheck())
    elif args.command == "ai-check":
        asyncio.run(_ai_check(args.sample))
    elif args.command == "research-run":
        asyncio.run(_research_run(args.workers))
    elif args.command == "context-rebuild":
        asyncio.run(_context_rebuild(args.company_id, args.ai))


if __name__ == "__main__":
    main()
