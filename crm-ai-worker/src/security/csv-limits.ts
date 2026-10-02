/*
 * Security V2 Stage 8 — CSV import resource limits (spec §9).
 *
 * CSV import is the panel's resource-consumption entry point: the previous
 * implementation read the whole JSON body unbounded, then parsed the CSV
 * with a loop that had no row/column/field caps. Everything here fails
 * closed — an import that exceeds any limit is refused with a specific
 * message, and the body is never read past the byte cap (so chunked uploads
 * without Content-Length cannot bypass the size check).
 *
 * §9.3 CSV formula injection: this system has NO CSV export endpoint today,
 * so imported formula-looking text is inert (stored as plain text, returned
 * as JSON, escaped in the panel since Stage 5). sanitizeCsvFieldForExport()
 * is provided so any future export applies the standard =/+/-/@ neutralization
 * instead of discovering the issue later.
 */

export const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB of CSV text
export const MAX_CSV_ROWS = 2000;             // data rows (header excluded)
export const MAX_FIELD_BYTES = 10_000;        // one field, in characters
export const MAX_COLUMNS = 200;               // columns per row

/** Byte allowance above the CSV cap for the JSON envelope (file_name etc.). */
const JSON_ENVELOPE_ALLOWANCE = 64 * 1024;

/** Typed refusal: `status` is 413 for size, 400 for shape. */
export class CsvLimitError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "CsvLimitError";
  }
}

/**
 * Reads the CSV-import JSON body ({csv, file_name}) without ever buffering
 * more than MAX_CSV_BYTES + envelope, regardless of what Content-Length
 * claims (checked first as a fast path; the stream cap is the real guard).
 */
export async function readCsvImportBody(
  request: Request,
): Promise<{ csv: string; file_name: string | null }> {
  const declared = Number(request.headers.get("Content-Length") || "0");
  if (declared > MAX_CSV_BYTES + JSON_ENVELOPE_ALLOWANCE) {
    throw new CsvLimitError(`导入内容超过 ${MAX_CSV_BYTES} 字节上限（Content-Length ${declared}）`, 413);
  }

  const maxTotal = MAX_CSV_BYTES + JSON_ENVELOPE_ALLOWANCE;
  const reader = request.body?.getReader();
  if (!reader) throw new CsvLimitError("请求缺少请求体", 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxTotal) {
      await reader.cancel();
      throw new CsvLimitError(`导入内容超过 ${MAX_CSV_BYTES} 字节上限`, 413);
    }
    chunks.push(value);
  }

  let text: string;
  try {
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(merged);
    const body = JSON.parse(text) as { csv?: unknown; file_name?: unknown };
    if (typeof body !== "object" || body === null || typeof body.csv !== "string") {
      throw new Error("shape");
    }
    // Exact spec limit on the CSV text itself (the read cap above carries a
    // small envelope allowance for file_name etc.).
    if (body.csv.length > MAX_CSV_BYTES) {
      throw new CsvLimitError(`CSV 内容超过 ${MAX_CSV_BYTES} 字节上限`, 413);
    }
    return { csv: body.csv, file_name: typeof body.file_name === "string" ? body.file_name : null };
  } catch (e) {
    if (e instanceof CsvLimitError) throw e;
    throw new CsvLimitError("Invalid JSON body", 400);
  }
}

/**
 * RFC4180-ish CSV parser with the Stage 8 limits enforced during parsing:
 * BOM stripped, quoted fields (embedded commas, quotes, newlines) supported,
 * empty rows skipped. The first non-empty row is the header (the import flow
 * requires one) and is excluded from the MAX_CSV_ROWS count. Throws
 * CsvLimitError on:
 *   - a field larger than MAX_FIELD_BYTES
 *   - a row with more than MAX_COLUMNS columns
 *   - more than MAX_CSV_ROWS data rows
 *   - an unterminated quote (malformed CSV)
 */
export function parseCsvBounded(text: string): string[][] {
  // Excel-style BOM would otherwise corrupt the first header cell.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let dataRows = 0;

  const endField = (): void => {
    if (field.length > MAX_FIELD_BYTES) {
      throw new CsvLimitError(`单个字段超过 ${MAX_FIELD_BYTES} 字符上限`, 400);
    }
    row.push(field);
    field = "";
  };
  const endRow = (): void => {
    endField();
    if (row.length > MAX_COLUMNS) {
      throw new CsvLimitError(`单行列数超过 ${MAX_COLUMNS} 列上限（本行 ${row.length} 列）`, 400);
    }
    if (row.some((c) => c.trim())) {
      if (rows.length > 0) {
        dataRows++;
        if (dataRows > MAX_CSV_ROWS) {
          throw new CsvLimitError(`数据行数超过 ${MAX_CSV_ROWS} 行上限`, 400);
        }
      }
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    throw new CsvLimitError("CSV 格式错误：存在未闭合的引号", 400);
  }
  if (field || row.length) endRow();
  return rows;
}

/**
 * §9.3: neutralize spreadsheet formulas in CSV EXPORT cells. A field that
 * starts with =, +, - or @ gets a leading apostrophe so Excel/Sheets treat
 * it as text instead of executing it (=HYPERLINK, =cmd|' /C …, @SUM …).
 */
export function sanitizeCsvFieldForExport(value: string): string {
  const first = value.charAt(0);
  if (first === "=" || first === "+" || first === "-" || first === "@") {
    return `'${value}`;
  }
  return value;
}
