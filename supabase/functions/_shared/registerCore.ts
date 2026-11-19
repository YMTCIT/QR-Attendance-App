import { timingSafeEqual, type CoreResult } from './http.ts'

export const SECRET_HEADER = 'x-registration-secret'
export const MIN_SECRET_LENGTH = 32
export const MAX_BODY_BYTES = 16 * 1024

export interface RegistrationPayload {
  qr_code: string
  name: string
  id_number: string | null
  email: string | null
  department: string | null
  event_id: number | null
}

const LIMITS = { qr_code: 512, name: 200, id_number: 64, email: 254, department: 200 }
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/

function optionalText(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return undefined // wrong type
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
  return t === '' ? null : t
}

export function validateRegistrationPayload(
  body: unknown,
): { ok: true; value: RegistrationPayload } | { ok: false; errors: string[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errors: ['Body must be a JSON object'] }
  const b = body as Record<string, unknown>
  const errors: string[] = []

  const qr = typeof b.qr_code === 'string' ? b.qr_code.trim() : typeof b.qr_code === 'number' ? String(b.qr_code) : ''
  if (!qr) errors.push('qr_code is required')
  else if (qr.length > LIMITS.qr_code) errors.push(`qr_code must be at most ${LIMITS.qr_code} characters`)

  const name = optionalText(b.name)
  if (!name) errors.push('name is required')
  else if (name.length > LIMITS.name) errors.push(`name must be at most ${LIMITS.name} characters`)

  const idNumber = optionalText(b.id_number)
  if (idNumber === undefined) errors.push('id_number must be a string')
  else if (idNumber && idNumber.length > LIMITS.id_number) errors.push('id_number is too long')

  const email = optionalText(b.email)
  if (email === undefined) errors.push('email must be a string')
  else if (email && (email.length > LIMITS.email || !EMAIL_RE.test(email))) errors.push('email is not a valid address')

  const department = optionalText(b.department)
  if (department === undefined) errors.push('department must be a string')
  else if (department && department.length > LIMITS.department) errors.push('department is too long')

  let eventId: number | null = null
  if (!('event_id' in b)) {
    errors.push('event_id is required (use null to register for any event)')
  } else if (b.event_id !== null && b.event_id !== '') {
    const n = typeof b.event_id === 'number' ? b.event_id : typeof b.event_id === 'string' ? Number(b.event_id.trim()) : NaN
    if (!Number.isSafeInteger(n) || n <= 0) errors.push('event_id must be a positive integer or null')
    else eventId = n
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      qr_code: qr,
      name: (name as string).replace(/\s+/g, ' '),
      id_number: idNumber ?? null,
      email: email ? email.toLowerCase() : null,
      department: department ?? null,
      event_id: eventId,
    },
  }
}

export interface RegisterDeps {
  /** REGISTRATION_WEBHOOK_SECRET from Edge Function secrets. */
  secret: string | undefined
  /** Calls public.integration_upsert_registrant via the service role. */
  upsert(payload: RegistrationPayload): Promise<{ status: string; id?: number; created?: boolean }>
  logError?(message: string, error: unknown): void
}

export interface RegisterRequest {
  method: string
  providedSecret: string | null
  body: unknown
}

/**
 * register-attendee handler for Microsoft Forms / Power Automate.
 * Retries with the same qr_code update the same row (idempotent).
 */
export async function handleRegister(req: RegisterRequest, deps: RegisterDeps): Promise<CoreResult> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }

  if (!deps.secret || deps.secret.length < MIN_SECRET_LENGTH) {
    deps.logError?.('REGISTRATION_WEBHOOK_SECRET missing or too short', null)
    return { status: 500, body: { error: 'server_not_configured' } }
  }
  if (!req.providedSecret || !timingSafeEqual(req.providedSecret, deps.secret)) {
    return { status: 401, body: { error: 'unauthorized' } }
  }

  const parsed = validateRegistrationPayload(req.body)
  if (!parsed.ok) return { status: 400, body: { error: 'validation_failed', details: parsed.errors } }

  let result: { status: string; id?: number; created?: boolean }
  try {
    result = await deps.upsert(parsed.value)
  } catch (error) {
    deps.logError?.('integration_upsert_registrant failed', error)
    return { status: 500, body: { error: 'server_error' } }
  }

  if (result.status === 'unknown_event') {
    return { status: 422, body: { error: 'unknown_event', details: [`No event with id ${parsed.value.event_id}`] } }
  }
  if (result.status !== 'ok') return { status: 500, body: { error: 'server_error' } }
  return { status: 200, body: { status: 'ok', id: result.id, created: result.created } }
}
