/**
 * Spreadsheet header → registration field mapping.
 */

export const IMPORT_FIELDS = [
  { key: 'qr_code', label: 'QR Code', required: true },
  { key: 'name', label: 'Full Name', required: true },
  { key: 'id_number', label: 'Student / Employee ID', required: false },
  { key: 'email', label: 'Email', required: false },
  { key: 'department', label: 'Department / Program', required: false },
  { key: 'section', label: 'Course / Section', required: false },
  { key: 'event', label: 'Event (ID or name)', required: false },
] as const

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key']

/** Column index per field, or null when not mapped. */
export type ColumnMapping = Record<ImportFieldKey, number | null>

export function emptyMapping(): ColumnMapping {
  return { qr_code: null, name: null, id_number: null, email: null, department: null, section: null, event: null }
}

/** Lower-case, strip punctuation/spaces: "ID No." → "idno". */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '')
}

const SYNONYMS: Record<ImportFieldKey, string[]> = {
  qr_code: [
    'qrcode', 'qr', 'qrtoken', 'qrvalue', 'qrcodevalue', 'qrdata', 'qrtext', 'qrstring',
    'uniquecode', 'code', 'token', 'registrationcode', 'ticketcode', 'ticket', 'uniqueid', 'uniquetoken',
  ],
  name: ['fullname', 'name', 'attendeename', 'studentname', 'participantname', 'completename', 'nameofattendee', 'participant'],
  id_number: [
    'studentid', 'studentnumber', 'studentno', 'idnumber', 'idno', 'id', 'employeeid', 'employeenumber',
    'employeeno', 'schoolid', 'studentidnumber', 'idnum',
  ],
  email: ['email', 'emailaddress', 'mail', 'emailadd', 'institutionalemail', 'schoolemail'],
  department: ['department', 'dept', 'program', 'college', 'course', 'courseprogram', 'office', 'programcourse'],
  section: ['section', 'coursesection', 'yearandsection', 'yearsection', 'block', 'class', 'yearlevel'],
  event: ['event', 'eventid', 'eventname', 'eventtitle'],
}

/** Auto-detect a mapping. Each column is used at most once. */
export function autoDetectMapping(headers: string[]): ColumnMapping {
  const mapping = emptyMapping()
  const normalized = headers.map((h) => normalizeHeader(h ?? ''))
  const used = new Set<number>()

  // Pass 1: exact synonym matches, in field priority order.
  for (const field of IMPORT_FIELDS) {
    for (const synonym of SYNONYMS[field.key]) {
      const idx = normalized.findIndex((h, i) => !used.has(i) && h === synonym)
      if (idx >= 0) {
        mapping[field.key] = idx
        used.add(idx)
        break
      }
    }
  }

  // Pass 2: looser "contains" matches for still-unmapped fields.
  const contains: Partial<Record<ImportFieldKey, RegExp>> = {
    qr_code: /qr|uniquecode|token/,
    name: /fullname|^name|name$/,
    id_number: /studentno|studentnum|studentid|idno|idnum|employeeid/,
    email: /email/,
    section: /section/,
  }
  for (const field of IMPORT_FIELDS) {
    if (mapping[field.key] !== null) continue
    const re = contains[field.key]
    if (!re) continue
    const idx = normalized.findIndex((h, i) => !used.has(i) && h !== '' && re.test(h))
    if (idx >= 0) {
      mapping[field.key] = idx
      used.add(idx)
    }
  }
  return mapping
}

export function missingRequired(mapping: ColumnMapping): ImportFieldKey[] {
  return IMPORT_FIELDS.filter((f) => f.required && mapping[f.key] === null).map((f) => f.key)
}

/** Index of the first non-blank row, used as the header row. */
export function findHeaderRowIndex(rows: { text: string }[][]): number {
  return rows.findIndex((r) => r.some((c) => c.text !== ''))
}
