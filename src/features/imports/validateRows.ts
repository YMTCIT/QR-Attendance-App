import type { SheetCell } from '../../lib/excel'
import { validateRegistrant, type RegistrantInput } from '../../lib/validation'
import type { ColumnMapping } from './columnMapping'
import { IMPORT_MAX_ROWS } from '../../config'

export interface ImportEventRef {
  id: number
  name: string
}

export interface ValidRow extends RegistrantInput {
  /** 1-based spreadsheet row number, for messages. */
  rowNumber: number
}

export interface RowError {
  rowNumber: number
  messages: string[]
}

export interface ValidationResult {
  valid: ValidRow[]
  errors: RowError[]
  /** Fully blank rows that were ignored. */
  skippedBlank: number
  warnings: string[]
  totalDataRows: number
}

function cellAt(row: SheetCell[], idx: number | null): SheetCell {
  if (idx === null || idx < 0) return { text: '', numeric: false }
  return row[idx] ?? { text: '', numeric: false }
}

function mostCommon(values: number[]): number | null {
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: number | null = null
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

function listRows(rows: number[], max = 10): string {
  const shown = rows.slice(0, max).join(', ')
  return rows.length > max ? `${shown} and ${rows.length - max} more` : shown
}

/**
 * Validates spreadsheet data rows (everything after the header row).
 * Registration only — nothing here ever produces attendance.
 */
export function validateImportRows(params: {
  dataRows: SheetCell[][]
  /** 1-based sheet row number of dataRows[0]. */
  firstRowNumber: number
  mapping: ColumnMapping
  defaultEventId: number | null
  events: ImportEventRef[]
}): ValidationResult {
  const { dataRows, firstRowNumber, mapping, defaultEventId, events } = params
  const valid: ValidRow[] = []
  const errors: RowError[] = []
  const warnings: string[] = []
  let skippedBlank = 0

  if (dataRows.length > IMPORT_MAX_ROWS) {
    return {
      valid: [],
      errors: [{ rowNumber: firstRowNumber, messages: [`The sheet has ${dataRows.length} rows; the limit is ${IMPORT_MAX_ROWS}.`] }],
      skippedBlank: 0,
      warnings: [],
      totalDataRows: dataRows.length,
    }
  }

  const eventsById = new Map(events.map((e) => [e.id, e]))
  const eventsByName = new Map(events.map((e) => [e.name.trim().toLowerCase(), e]))
  const firstSeenQr = new Map<string, number>()
  const numericIdRows: { row: number; length: number }[] = []
  const textIdLengths: number[] = []
  const numericQrRows: number[] = []
  const invalidEmailRows: number[] = []

  const mappedIdx = Object.values(mapping).filter((v): v is number => v !== null)

  dataRows.forEach((row, i) => {
    const rowNumber = firstRowNumber + i
    if (mappedIdx.every((idx) => cellAt(row, idx).text === '')) {
      skippedBlank++
      return
    }

    const qrCell = cellAt(row, mapping.qr_code)
    const idCell = cellAt(row, mapping.id_number)
    const dept = cellAt(row, mapping.department).text
    const section = cellAt(row, mapping.section).text
    const department = [dept, section].filter(Boolean).join(' – ')

    let emailText = cellAt(row, mapping.email).text
    const { value, errors: fieldErrors } = validateRegistrant({
      qr_code: qrCell.text,
      name: cellAt(row, mapping.name).text,
      id_number: idCell.text,
      email: emailText,
      department,
    })

    const messages: string[] = []
    if (fieldErrors.qr_code) messages.push(fieldErrors.qr_code)
    if (fieldErrors.name) messages.push(fieldErrors.name)
    if (fieldErrors.id_number) messages.push(fieldErrors.id_number)
    if (fieldErrors.department) messages.push(fieldErrors.department)
    if (fieldErrors.email) {
      // A bad email should not block registration; drop it and warn.
      invalidEmailRows.push(rowNumber)
      emailText = ''
    }

    // Resolve per-row event (Event column), falling back to the chosen default.
    let eventId = defaultEventId
    const eventText = cellAt(row, mapping.event).text
    if (eventText) {
      const byId = /^\d+$/.test(eventText) ? eventsById.get(Number(eventText)) : undefined
      const match = byId ?? eventsByName.get(eventText.toLowerCase())
      if (match) eventId = match.id
      else messages.push(`Unknown event "${eventText}"`)
    }

    if (value.qr_code) {
      const first = firstSeenQr.get(value.qr_code)
      if (first !== undefined) messages.push(`Duplicate QR code (first used on row ${first})`)
      else firstSeenQr.set(value.qr_code, rowNumber)
    }

    if (messages.length > 0) {
      errors.push({ rowNumber, messages })
      return
    }

    if (qrCell.numeric) numericQrRows.push(rowNumber)
    if (value.id_number) {
      if (idCell.numeric) numericIdRows.push({ row: rowNumber, length: value.id_number.length })
      else textIdLengths.push(value.id_number.length)
    }

    valid.push({
      ...value,
      email: emailText ? value.email : null,
      event_id: eventId,
      rowNumber,
    })
  })

  if (numericQrRows.length > 0) {
    warnings.push(
      `${numericQrRows.length} QR code cell(s) were stored as NUMBERS in Excel (rows ${listRows(numericQrRows)}). ` +
        'If the real QR value had leading zeros they are already lost and those attendees will not scan. ' +
        'Format the column as Text in Excel and re-enter the values, or import a CSV.',
    )
  }
  if (numericIdRows.length > 0) {
    const typical = mostCommon([...textIdLengths, ...numericIdRows.map((r) => r.length)])
    const short = typical === null ? [] : numericIdRows.filter((r) => r.length < typical).map((r) => r.row)
    warnings.push(
      `${numericIdRows.length} ID cell(s) were stored as numbers in Excel, so leading zeros cannot be recovered.` +
        (short.length > 0 ? ` These look shorter than usual and may have lost zeros: rows ${listRows(short)}.` : '') +
        ' Format the ID column as Text in Excel to keep leading zeros.',
    )
  }
  if (invalidEmailRows.length > 0) {
    warnings.push(`Invalid email addresses were ignored on rows ${listRows(invalidEmailRows)}.`)
  }

  return { valid, errors, skippedBlank, warnings, totalDataRows: dataRows.length }
}

/** Split an array into fixed-size batches. */
export function toBatches<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
