import Papa from 'papaparse'

/**
 * Neutralise spreadsheet formula injection (CWE-1236). Any cell starting with
 * = + - @ TAB or CR is prefixed with an apostrophe so Excel / Sheets treat it
 * as text instead of executing it.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return Papa.unparse(
    {
      fields: headers.map(sanitizeCsvCell),
      data: rows.map((row) => row.map(sanitizeCsvCell)),
    },
    { quotes: true, newline: '\r\n' },
  )
}

/** Trigger a browser download of a CSV (with BOM so Excel reads UTF-8 names correctly). */
export function downloadCsv(filename: string, headers: string[], rows: unknown[][]): void {
  const blob = new Blob(['﻿', toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Parse CSV text into a 2-D string grid (no type coercion, so leading zeros are kept). */
export function parseCsvText(text: string): string[][] {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ''), {
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
  })
  if (result.errors.length > 0) {
    const fatal = result.errors.find((e) => e.type === 'Quotes' || e.type === 'Delimiter')
    if (fatal) throw new Error(`CSV could not be read (row ${(fatal.row ?? 0) + 1}): ${fatal.message}`)
  }
  return result.data
}

export function safeFilename(base: string): string {
  return base.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(0, 80)
}
