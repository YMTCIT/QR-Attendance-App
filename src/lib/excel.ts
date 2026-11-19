import readXlsxFile from 'read-excel-file/browser'
import { IMPORT_MAX_FILE_BYTES } from '../config'
import { parseCsvText } from './csv'

/**
 * Reads .xlsx and .csv registration spreadsheets in the browser.
 *
 * Safety notes:
 *  - The file type is decided from its CONTENT (magic bytes), not just the
 *    extension; mismatches are rejected.
 *  - Formulas are never executed: read-excel-file only reads the cached cell
 *    values that Excel stored in the file.
 *  - Numbers are kept as their raw text and flagged, so the importer can warn
 *    about IDs/QR codes that Excel already stored as numbers (which loses
 *    leading zeros — that information is not in the file any more).
 */

export interface SheetCell {
  text: string
  /** True when Excel stored this cell as a number (leading zeros may be lost). */
  numeric: boolean
}

export interface SheetGrid {
  name: string
  rows: SheetCell[][]
}

export interface Workbook {
  kind: 'xlsx' | 'csv'
  sheets: SheetGrid[]
}

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpreadsheetError'
  }
}

class NumericCell {
  readonly raw: string
  constructor(raw: string) {
    this.raw = raw
  }
}

type DetectedKind = 'xlsx' | 'xls' | 'csv' | 'unknown'

/** Sniff the first bytes. XLSX is a ZIP ("PK\x03\x04"); legacy XLS is OLE2. */
export function detectKind(bytes: Uint8Array): DetectedKind {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'xlsx'
  }
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return 'xls'
  }
  // Text heuristic: no NUL bytes in the sample and valid UTF-8.
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024))
  if (sample.includes(0)) return 'unknown'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < bytes.length ? trimPartialUtf8(sample) : sample)
    return 'csv'
  } catch {
    return 'unknown'
  }
}

/** Drop a possibly cut multi-byte sequence at the end of a sample. */
function trimPartialUtf8(sample: Uint8Array): Uint8Array {
  let end = sample.length
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = sample[end - i]
    if ((b & 0xc0) === 0xc0) return sample.subarray(0, end - i) // lead byte of a cut sequence
    if ((b & 0x80) === 0) break
  }
  return sample
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

function numericToText(raw: string): string {
  // Excel stores very large/small numbers in exponent form; expand when safe.
  if (/e/i.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n) && Math.abs(n) < 1e21) return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
  }
  return raw
}

function cellFromXlsx(value: unknown): SheetCell {
  if (value === null || value === undefined) return { text: '', numeric: false }
  if (value instanceof NumericCell) return { text: numericToText(value.raw).trim(), numeric: true }
  if (value instanceof Date) return { text: value.toISOString().slice(0, 10), numeric: false }
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', numeric: false }
  return { text: String(value).trim(), numeric: false }
}

function isBlankRow(row: SheetCell[]): boolean {
  return row.every((c) => c.text === '')
}

/** Remove fully blank trailing rows/columns that spreadsheets often carry. */
function tidy(rows: SheetCell[][]): SheetCell[][] {
  const out = rows.slice()
  while (out.length > 0 && isBlankRow(out[out.length - 1])) out.pop()
  return out
}

export async function readSpreadsheet(file: File): Promise<Workbook> {
  if (file.size === 0) throw new SpreadsheetError('The file is empty.')
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    throw new SpreadsheetError(
      `The file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB.`,
    )
  }

  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const kind = detectKind(bytes)
  const ext = extensionOf(file.name)

  if (kind === 'xls') {
    throw new SpreadsheetError('Old .xls (Excel 97-2003) files are not supported. Open it in Excel and "Save As" .xlsx.')
  }
  if (kind === 'unknown') throw new SpreadsheetError('This file is not a readable .xlsx or .csv spreadsheet.')
  if (ext === 'xlsx' && kind !== 'xlsx') throw new SpreadsheetError('The file is named .xlsx but its content is not an Excel workbook.')
  if ((ext === 'csv' || ext === 'txt') && kind !== 'csv') {
    throw new SpreadsheetError('The file is named .csv but its content is not plain text.')
  }
  if (ext !== 'xlsx' && ext !== 'csv' && ext !== 'txt') {
    throw new SpreadsheetError('Please choose an .xlsx or .csv file.')
  }

  if (kind === 'csv') {
    const text = new TextDecoder('utf-8').decode(bytes)
    let grid: string[][]
    try {
      grid = parseCsvText(text)
    } catch (e) {
      throw new SpreadsheetError((e as Error).message)
    }
    const rows = tidy(grid.map((r) => r.map((t) => ({ text: (t ?? '').trim(), numeric: false }))))
    if (rows.length === 0) throw new SpreadsheetError('The CSV file has no rows.')
    return { kind: 'csv', sheets: [{ name: 'CSV', rows }] }
  }

  let sheets: { sheet: string; data: unknown[][] }[]
  try {
    sheets = (await readXlsxFile<NumericCell>(new Blob([buffer]), {
      parseNumber: (raw: string) => new NumericCell(raw),
    })) as unknown as { sheet: string; data: unknown[][] }[]
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new SpreadsheetError(`The workbook could not be read: ${msg}`)
  }

  const grids: SheetGrid[] = sheets.map((s) => ({
    name: s.sheet,
    rows: tidy(s.data.map((row) => row.map(cellFromXlsx))),
  }))
  if (grids.length === 0 || grids.every((g) => g.rows.length === 0)) {
    throw new SpreadsheetError('The workbook is empty.')
  }
  return { kind: 'xlsx', sheets: grids }
}
