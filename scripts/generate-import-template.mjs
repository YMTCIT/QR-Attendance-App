// Generates public/templates/attendee-import-template.xlsx — a blank template
// for Dashboard → Registrants → Import Excel, downloadable from that dialog.
// Run: npm run template
//
// Keep the headers in sync with TEMPLATE_HEADERS in
// src/features/imports/columnMapping.ts (a test checks this).
//
// Sheet 1 "Attendees": the headers the importer auto-detects, with every data
// cell pre-formatted as TEXT so IDs and QR codes keep their leading zeros.
// Sheet 2 "How to fill in": column guide and example rows (never imported
// unless that sheet is chosen).
import writeXlsxFile from 'write-excel-file/node'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'templates', 'attendee-import-template.xlsx')

const MAROON = '#7A0C0C'
const GOLD = '#F3E3A6'
const PREFORMATTED_ROWS = 1000

const COLUMNS = [
  { header: 'QR Code', width: 22 },
  { header: 'Full Name', width: 30 },
  { header: 'Student ID', width: 16 },
  { header: 'Email', width: 32 },
  { header: 'Department', width: 16 },
  { header: 'Section', width: 12 },
  { header: 'Event', width: 22 },
]

const headerCell = (value) => ({
  value,
  type: String,
  fontWeight: 'bold',
  color: '#FFFFFF',
  backgroundColor: MAROON,
  align: 'center',
  height: 22,
})
const blankText = () => ({ value: '', type: String, format: '@' })

const attendees = [
  COLUMNS.map((c) => headerCell(c.header)),
  ...Array.from({ length: PREFORMATTED_ROWS }, () => COLUMNS.map(blankText)),
]

// ---- Guide sheet -----------------------------------------------------------
const bold = (value, extra = {}) => ({ value, type: String, fontWeight: 'bold', ...extra })
const txt = (value, extra = {}) => ({ value, type: String, format: '@', wrap: true, ...extra })
const blankRow = () => [null, null, null, null]

const guide = [
  [bold('Attendee import template — CIT QR Attendance', { fontSize: 14, color: MAROON, columnSpan: 4 }), null, null, null],
  [txt('Fill in the "Attendees" sheet (one attendee per row), save as .xlsx, then upload it in Dashboard → Registrants → Import Excel.', { columnSpan: 4 }), null, null, null],
  blankRow(),
  ['Column', 'Required?', 'What to enter', 'Example'].map((h) => headerCell(h)),
  [bold('QR Code'), txt('REQUIRED'), txt('The exact text inside the attendee\'s QR code. Must be unique — no two rows may share a code.'), txt('CIT-3F2A9C0E7B1D')],
  [bold('Full Name'), txt('REQUIRED'), txt('Shown on the tablet when the attendee checks in.'), txt('Juan Dela Cruz')],
  [bold('Student ID'), txt('optional'), txt('Student or employee number. Keep leading zeros (the column is formatted as Text).'), txt('00260004')],
  [bold('Email'), txt('optional'), txt('Invalid emails are dropped with a warning; the row is still imported.'), txt('juan.delacruz@cit.edu')],
  [bold('Department'), txt('optional'), txt('Department, college or program.'), txt('BSIT')],
  [bold('Section'), txt('optional'), txt('Course / year and section.'), txt('3A')],
  [bold('Event'), txt('optional'), txt('Leave blank to use the event you pick when importing. Or enter an event ID (Dashboard → Events, ID column) or its exact name to put this row in a different event.'), txt('3')],
  blankRow(),
  [bold('Tips', { color: MAROON, columnSpan: 4 }), null, null, null],
  [txt('• Do not rename or reorder the header row. Extra columns are fine — the importer ignores them.', { columnSpan: 4 }), null, null, null],
  [txt('• Paste with "Paste Special → Values" (Ctrl+Shift+V) so the Text formatting is kept and leading zeros are not lost.', { columnSpan: 4 }), null, null, null],
  [txt('• Re-importing the same file is safe: rows are matched by QR Code and updated. Attendance is never changed by an import.', { columnSpan: 4 }), null, null, null],
  [txt('• Blank optional cells never erase information already saved for that attendee.', { columnSpan: 4 }), null, null, null],
  [txt('• Limits: 20,000 rows / 10 MB per file. CSV (UTF-8) with the same headers also works.', { columnSpan: 4 }), null, null, null],
  blankRow(),
  [bold('Example rows (copy the format, not these values)', { color: MAROON, columnSpan: 4 }), null, null, null],
]
const exampleHeader = COLUMNS.map((c) => headerCell(c.header))
const examples = [
  ['CIT-3F2A9C0E7B1D', 'Juan Dela Cruz', '20260001', 'juan.delacruz@cit.edu', 'BSIT', '3A', ''],
  ['CIT-91B0D4C2A6E8', 'Ana Lim', '00260004', 'ana.lim@cit.edu', 'BSCE', '1C', ''],
  ['CIT-5C7E2F1A0D93', 'Maria Santos', '20260002', '', 'BSCS', '2B', '3'],
].map((r) => r.map((v) => ({ value: v, type: String, format: '@', backgroundColor: GOLD })))

await writeXlsxFile(
  [
    {
      sheet: 'Attendees',
      data: attendees,
      columns: COLUMNS.map((c) => ({ width: c.width })),
      stickyRowsCount: 1,
    },
    {
      sheet: 'How to fill in',
      data: [...guide, exampleHeader, ...examples],
      columns: [{ width: 22 }, { width: 30 }, { width: 60 }, { width: 32 }, { width: 16 }, { width: 12 }, { width: 22 }],
    },
  ],
).toFile(out)

console.log('Wrote', out)
