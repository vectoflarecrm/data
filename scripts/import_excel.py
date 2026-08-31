from __future__ import annotations

import argparse
import csv
from pathlib import Path

import pandas as pd


def clean(value: object) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    value = str(value).strip()
    return "" if value in {"nan", "NaT", "/", "-"} else value


def convert(path: Path, output: Path, sheet: str) -> None:
    frame = pd.read_excel(path, sheet_name=sheet, dtype=object)
    rows: list[dict[str, str]] = []
    for record in frame.to_dict(orient="records"):
        rows.append(
            {
                "Company": clean(record.get("company name")),
                "Website": clean(record.get("Website")),
                "Country": clean(record.get("Country")),
                "Address": clean(record.get("Street address")),
                "Postal Code": clean(record.get("ZIP & city address")),
                "First Name": clean(record.get("First Name")),
                "Last Name": clean(record.get("Last Name")),
                "Title": clean(record.get("TITLE")),
                "Email": clean(record.get("EMAIL")),
                "Phone": clean(record.get("TEL")),
                "WhatsApp": clean(record.get("WhatsApp")),
                "Products": clean(record.get("Products & Services in English")),
                "Notes": clean(record.get("中文备注")),
            }
        )
    with output.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    print(f"converted {len(rows)} rows from {sheet!r} to {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--sheet", default="处理完")
    args = parser.parse_args()
    convert(args.input, args.output, args.sheet)
