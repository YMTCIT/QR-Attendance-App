// Generates samples/sample-registrations.xlsx (two worksheets) for trying the
// Excel registration importer. Run: npm run samples
// Student IDs are written as TEXT cells so leading zeros are preserved.
import writeXlsxFile from 'write-excel-file/node'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'sample-registrations.xlsx')

const header = ['QR Token', 'Full Name', 'Student Number', 'Email Address', 'Program', 'Section'].map((value) => ({
  value,
  fontWeight: 'bold',
}))
const text = (value) => ({ value, type: String })

const morning = [
  ['ABC101', 'Rafael Tan', '20260101', 'rafael.tan@example.edu', 'BSIT', '1A'],
  ['ABC102', 'Bea Navarro', '00260102', 'bea.navarro@example.edu', 'BSCS', '2A'],
  ['ABC103', 'Miguel Ramos', '20260103', '', 'BSIT', '1B'],
  ['ABC104', 'Clarisse Uy', '20260104', 'clarisse.uy@example.edu', 'BSA', '3A'],
]
const afternoon = [
  ['ABC201', 'Paolo Aquino', '20260201', 'paolo.aquino@example.edu', 'BSEE', '2B'],
  ['ABC202', 'Nicole Torres', '00260202', 'nicole.torres@example.edu', 'BSN', '1A'],
  ['ABC203', 'Enzo Castillo', '20260203', 'enzo.castillo@example.edu', 'BSCE', '4A'],
]

await writeXlsxFile(
  [
    { sheet: 'Morning Session', data: [header, ...morning.map((r) => r.map(text))], columns: [{ width: 12 }, { width: 24 }, { width: 16 }, { width: 30 }, { width: 10 }, { width: 10 }] },
    { sheet: 'Afternoon Session', data: [header, ...afternoon.map((r) => r.map(text))], columns: [{ width: 12 }, { width: 24 }, { width: 16 }, { width: 30 }, { width: 10 }, { width: 10 }] },
  ],
).toFile(out)

console.log('Wrote', out)
