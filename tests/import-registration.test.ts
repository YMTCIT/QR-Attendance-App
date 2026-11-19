// @vitest-environment node
/**
 * Registration import: real .xlsx (multi-sheet) and .csv parsing, content
 * sniffing, column mapping, validation, batching and the guarantee that the
 * importer only ever calls the registration upsert (never attendance).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import writeXlsxFile from 'write-excel-file/node'
import { detectKind, readSpreadsheet, SpreadsheetError, type SheetCell } from '../src/lib/excel'
import { autoDetectMapping, emptyMapping, missingRequired, normalizeHeader } from '../src/features/imports/columnMapping'
import { toBatches, validateImportRows } from '../src/features/imports/validateRows'

// ---- Supabase mock for the import API -------------------------------------
const calls = vi.hoisted(() => ({ rpc: [] as { fn: string; args: Record<string, unknown> }[], from: [] as string[] }))
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args })
      if (fn === 'admin_upsert_registrants') {
        const rows = args.p_rows as unknown[]
        if (rows.some((r) => (r as { qr_code: string }).qr_code === 'FAIL')) {
          return { data: null, error: { message: 'boom', code: 'XX000' } }
        }
        return { data: { inserted: rows.length, updated: 0 }, error: null }
      }
      return { data: [], error: null }
    }),
    from: vi.fn((table: string) => {
      calls.from.push(table)
      return { insert: vi.fn(async () => ({ error: null })) }
    }),
  },
}))

beforeEach(() => {
  calls.rpc.length = 0
  calls.from.length = 0
})

function cells(...values: string[]): SheetCell[] {
  return values.map((text) => ({ text, numeric: false }))
}

async function xlsxFile(sheets: { sheet: string; data: unknown[][] }[], name = 'reg.xlsx'): Promise<File> {
  const buffer = await writeXlsxFile(sheets as never).toBuffer()
  return new File([new Uint8Array(buffer)], name)
}

describe('reading spreadsheets', () => {
  it('reads every worksheet of an .xlsx and flags numeric cells', async () => {
    const file = await xlsxFile([
      {
        sheet: 'Registrations',
        data: [
          ['QR Code', 'Full Name', 'Student ID', 'Department'],
          ['ABC001', 'Juan Dela Cruz', '00260001', 'BSIT'],
          ['ABC002', 'Maria Santos', 20260002, 'BSCS'],
        ],
      },
      { sheet: 'Notes', data: [['Anything'], ['else']] },
    ])
    const wb = await readSpreadsheet(file)
    expect(wb.kind).toBe('xlsx')
    expect(wb.sheets.map((s) => s.name)).toEqual(['Registrations', 'Notes'])
    const rows = wb.sheets[0].rows
    expect(rows[1][2]).toEqual({ text: '00260001', numeric: false }) // text cell keeps leading zeros
    expect(rows[2][2]).toEqual({ text: '20260002', numeric: true })
  })

  it('reads a .csv without coercing types (leading zeros kept)', async () => {
    const csv = '﻿QR Code,Full Name,Student Number\r\n000123,"Dela Cruz, Juan",00042\r\n\r\n'
    const wb = await readSpreadsheet(new File([csv], 'reg.csv'))
    expect(wb.kind).toBe('csv')
    expect(wb.sheets[0].rows).toEqual([cells('QR Code', 'Full Name', 'Student Number'), cells('000123', 'Dela Cruz, Juan', '00042')])
  })

  it('does not trust file extensions', async () => {
    await expect(readSpreadsheet(new File(['QR,Name\n1,a'], 'fake.xlsx'))).rejects.toThrow(/not an Excel workbook/)
    const realXlsx = await xlsxFile([{ sheet: 'S', data: [['a']] }], 'disguised.csv')
    await expect(readSpreadsheet(realXlsx)).rejects.toThrow(/not plain text/)
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])
    await expect(readSpreadsheet(new File([ole], 'old.xls'))).rejects.toThrow(/\.xls/)
    await expect(readSpreadsheet(new File([new Uint8Array([0, 1, 2, 3])], 'bin.csv'))).rejects.toBeInstanceOf(SpreadsheetError)
  })

  it('rejects empty and malformed files', async () => {
    await expect(readSpreadsheet(new File([], 'empty.csv'))).rejects.toThrow(/empty/)
    const brokenZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5])
    await expect(readSpreadsheet(new File([brokenZip], 'broken.xlsx'))).rejects.toBeInstanceOf(SpreadsheetError)
  })

  it('reads cached values and never executes formulas', async () => {
    const file = await xlsxFile([
      { sheet: 'S', data: [['QR Code', 'Full Name'], ['=1+1', { value: 'SUM(1,2)', type: 'Formula' }]] },
    ])
    const wb = await readSpreadsheet(file)
    // The "=1+1" string is just text; the formula cell has no computed value.
    expect(wb.sheets[0].rows[1][0].text).toBe('=1+1')
    expect(wb.sheets[0].rows[1][1]?.text ?? '').not.toBe('3')
  })

  it('sniffs content types', () => {
    expect(detectKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('xlsx')
    expect(detectKind(new TextEncoder().encode('a,b\n1,2'))).toBe('csv')
    expect(detectKind(new Uint8Array([0xff, 0xfe, 0x00]))).toBe('unknown')
  })
})

describe('column mapping', () => {
  it('detects common header variations', () => {
    expect(normalizeHeader('ID No.')).toBe('idno')
    const m = autoDetectMapping(['QR Token', 'Full Name', 'Student Number', 'Email Address', 'Program', 'Section'])
    expect(m).toEqual({ qr_code: 0, name: 1, id_number: 2, email: 3, department: 4, section: 5, event: null })
    expect(autoDetectMapping(['Unique Code', 'Name', 'ID No.']).id_number).toBe(2)
    expect(autoDetectMapping(['Unique Code', 'Name', 'ID No.']).qr_code).toBe(0)
  })

  it('reports missing required mappings', () => {
    expect(missingRequired(emptyMapping())).toEqual(['qr_code', 'name'])
    expect(missingRequired(autoDetectMapping(['QR Code', 'Full Name']))).toEqual([])
  })
})

describe('row validation', () => {
  const mapping = autoDetectMapping(['QR Code', 'Full Name', 'Student ID', 'Email', 'Department', 'Event'])
  const events = [
    { id: 1, name: 'Foundation Day' },
    { id: 2, name: 'Job Fair' },
  ]

  it('validates required fields, duplicates, emails and events with row numbers', () => {
    const result = validateImportRows({
      dataRows: [
        cells('ABC001', 'Juan Dela Cruz', '00260001', 'juan@cit.example', 'BSIT', ''),
        cells('', 'No Code', '', '', '', ''),
        cells('ABC003', '', '', '', '', ''),
        cells('ABC001', 'Duplicate Juan', '', '', '', ''),
        cells('', '', '', '', '', ''),
        cells('ABC005', 'Bad Email', '', 'not-an-email', '', ''),
        cells('ABC006', 'Job Fair Person', '', '', '', 'job fair'),
        cells('ABC007', 'Ghost Event', '', '', '', 'Nope'),
        cells('ABC008', 'By Id', '', '', '', '1'),
      ],
      firstRowNumber: 2,
      mapping,
      defaultEventId: 1,
      events,
    })
    expect(result.valid.map((r) => [r.rowNumber, r.qr_code, r.event_id, r.email])).toEqual([
      [2, 'ABC001', 1, 'juan@cit.example'],
      [7, 'ABC005', 1, null],
      [8, 'ABC006', 2, null],
      [10, 'ABC008', 1, null],
    ])
    expect(result.valid[0].id_number).toBe('00260001')
    expect(result.errors).toEqual([
      { rowNumber: 3, messages: ['QR code is required'] },
      { rowNumber: 4, messages: ['Name is required'] },
      { rowNumber: 5, messages: ['Duplicate QR code (first used on row 2)'] },
      { rowNumber: 9, messages: ['Unknown event "Nope"'] },
    ])
    expect(result.skippedBlank).toBe(1)
    expect(result.warnings.some((w) => /Invalid email/.test(w) && /7/.test(w))).toBe(true)
  })

  it('combines department and section', () => {
    const m = autoDetectMapping(['QR Code', 'Full Name', 'Program', 'Section'])
    const r = validateImportRows({ dataRows: [cells('Q1', 'A', 'BSIT', '3A')], firstRowNumber: 2, mapping: m, defaultEventId: null, events: [] })
    expect(r.valid[0].department).toBe('BSIT – 3A')
    expect(r.valid[0].event_id).toBeNull()
  })

  it('warns when Excel stored IDs / QR codes as numbers (leading zeros lost)', () => {
    const m = autoDetectMapping(['QR Code', 'Full Name', 'Student ID'])
    const r = validateImportRows({
      dataRows: [
        cells('Q1', 'A', '00260001'),
        [{ text: 'Q2', numeric: false }, { text: 'B', numeric: false }, { text: '260002', numeric: true }],
        [{ text: '12345', numeric: true }, { text: 'C', numeric: false }, { text: '00260003', numeric: false }],
      ],
      firstRowNumber: 2,
      mapping: m,
      defaultEventId: null,
      events: [],
    })
    expect(r.valid).toHaveLength(3)
    expect(r.warnings.find((w) => w.includes('QR code cell(s) were stored as NUMBERS'))).toContain('rows 4')
    expect(r.warnings.find((w) => w.includes('ID cell(s)'))).toContain('rows 3')
  })

  it('splits imports into 500-row batches', () => {
    const batches = toBatches(Array.from({ length: 1250 }, (_, i) => i), 500)
    expect(batches.map((b) => b.length)).toEqual([500, 500, 250])
  })
})

describe('importing registrations', () => {
  const row = (i: number, qr = `Q${i}`) => ({
    rowNumber: i + 2,
    qr_code: qr,
    name: `Person ${i}`,
    id_number: null,
    email: null,
    department: null,
    event_id: 1,
  })

  it('upserts in batches with accurate progress and never touches attendance', async () => {
    const { importRegistrations } = await import('../src/features/imports/api')
    const progress: string[] = []
    const rows = Array.from({ length: 1250 }, (_, i) => row(i))
    const outcome = await importRegistrations(rows, (p) => progress.push(`${p.processed}/${p.total}`))

    expect(progress).toEqual(['0/1250', '500/1250', '1000/1250', '1250/1250'])
    expect(outcome).toMatchObject({ inserted: 1250, updated: 0, failed: 0 })
    expect(calls.rpc.map((c) => c.fn)).toEqual(['admin_upsert_registrants', 'admin_upsert_registrants', 'admin_upsert_registrants'])
    expect(calls.rpc.every((c) => c.args.p_source === 'import')).toBe(true)
    expect(calls.from).not.toContain('attendance')
    // Payload carries registration fields only — no status / present columns.
    const first = (calls.rpc[0].args.p_rows as Record<string, unknown>[])[0]
    expect(Object.keys(first).sort()).toEqual(['department', 'email', 'event_id', 'id_number', 'name', 'qr_code'])
  })

  it('reports partial completion when a batch fails', async () => {
    const { importRegistrations } = await import('../src/features/imports/api')
    const rows = [...Array.from({ length: 4 }, (_, i) => row(i)), row(4, 'FAIL'), row(5)]
    const outcome = await importRegistrations(rows, () => undefined, 2)
    expect(outcome.inserted).toBe(4)
    expect(outcome.failed).toBe(2)
    expect(outcome.failures).toEqual([{ fromRow: 6, toRow: 7, message: 'boom' }])
  })
})
