import { authenticateStaff, type CoreResult, type StaffAuthDeps } from './http.ts'

export const MAX_QR_LENGTH = 512

export interface CheckInDeps extends StaffAuthDeps {
  /** Calls public.record_qr_check_in(p_qr_code, p_recorded_by) with the service role. */
  recordCheckIn(qrCode: string, userId: string): Promise<unknown>
  logError?(message: string, error: unknown): void
}

export interface CheckInRequest {
  method: string
  authorization: string | null
  body: unknown
}

/**
 * Pick ONLY the fields scanner devices need from the database result. Anything
 * unexpected becomes null → a 500, never a fake success.
 */
export function normalizeCheckInResult(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null)
  switch (r.status) {
    case 'ok': {
      const name = str(r.name)
      const scannedAt = str(r.scanned_at)
      if (!name || !scannedAt) return null
      return { status: 'ok', name, event_name: str(r.event_name) ?? '', scanned_at: scannedAt }
    }
    case 'already': {
      const name = str(r.name)
      const scannedAt = str(r.scanned_at)
      if (!name || !scannedAt) return null
      const out: Record<string, unknown> = { status: 'already', name, scanned_at: scannedAt }
      if (str(r.event_name)) out.event_name = r.event_name
      return out
    }
    case 'invalid':
    case 'wrong_event':
    case 'no_event':
      return { status: r.status }
    default:
      return null
  }
}

/**
 * check-in handler:
 *  1. verify the caller's identity (Supabase Auth access token),
 *  2. require an enabled admin or scanner role,
 *  3. validate the QR string,
 *  4. delegate the atomic, constraint-backed insert to the database.
 */
export async function handleCheckIn(req: CheckInRequest, deps: CheckInDeps): Promise<CoreResult> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }

  const auth = await authenticateStaff(req.authorization, deps, ['admin', 'scanner'])
  if (!auth.ok) return auth.result

  const body = req.body as { qr_code?: unknown } | null | undefined
  if (!body || typeof body !== 'object' || typeof body.qr_code !== 'string') {
    return { status: 400, body: { error: 'bad_request' } }
  }

  const code = body.qr_code.trim()
  if (!code || code.length > MAX_QR_LENGTH) return { status: 200, body: { status: 'invalid' } }

  let raw: unknown
  try {
    raw = await deps.recordCheckIn(code, auth.userId)
  } catch (error) {
    deps.logError?.('record_qr_check_in failed', error)
    return { status: 500, body: { error: 'server_error' } }
  }

  const result = normalizeCheckInResult(raw)
  if (!result) {
    deps.logError?.('unexpected record_qr_check_in result', raw)
    return { status: 500, body: { error: 'server_error' } }
  }
  return { status: 200, body: result }
}
