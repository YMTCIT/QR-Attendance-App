/**
 * Registration field validation, shared by the manual form and the importer.
 * Limits mirror the CHECK constraints in 001_initial_schema.sql.
 */

export const LIMITS = {
  qr_code: 512,
  name: 200,
  id_number: 64,
  email: 254,
  department: 200,
} as const

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/

/** Remove control characters (except none) and trim. */
export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return ''
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
}

export function isValidEmail(value: string): boolean {
  return value.length <= LIMITS.email && EMAIL_RE.test(value)
}

export interface RegistrantInput {
  qr_code: string
  name: string
  id_number: string | null
  email: string | null
  department: string | null
  event_id: number | null
}

export interface FieldErrors {
  qr_code?: string
  name?: string
  id_number?: string
  email?: string
  department?: string
}

export function validateRegistrant(input: {
  qr_code: unknown
  name: unknown
  id_number?: unknown
  email?: unknown
  department?: unknown
}): { value: Omit<RegistrantInput, 'event_id'>; errors: FieldErrors } {
  const errors: FieldErrors = {}
  // QR codes are compared exactly after trimming, so keep inner content as-is.
  const qr = input.qr_code === null || input.qr_code === undefined ? '' : String(input.qr_code).trim()
  const name = cleanText(input.name).replace(/\s+/g, ' ')
  const idNumber = cleanText(input.id_number)
  const email = cleanText(input.email).toLowerCase()
  const department = cleanText(input.department).replace(/\s+/g, ' ')

  if (!qr) errors.qr_code = 'QR code is required'
  else if (qr.length > LIMITS.qr_code) errors.qr_code = `QR code is longer than ${LIMITS.qr_code} characters`

  if (!name) errors.name = 'Name is required'
  else if (name.length > LIMITS.name) errors.name = `Name is longer than ${LIMITS.name} characters`

  if (idNumber.length > LIMITS.id_number) errors.id_number = `ID is longer than ${LIMITS.id_number} characters`
  if (email && !isValidEmail(email)) errors.email = 'Email address is not valid'
  if (department.length > LIMITS.department) errors.department = `Department is longer than ${LIMITS.department} characters`

  return {
    value: {
      qr_code: qr,
      name,
      id_number: idNumber || null,
      email: email || null,
      department: department || null,
    },
    errors,
  }
}

export function hasErrors(errors: FieldErrors): boolean {
  return Object.values(errors).some(Boolean)
}
