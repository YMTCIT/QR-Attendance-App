import { authenticateStaff, type CoreResult, type StaffAuthDeps, type StaffRole } from './http.ts'

export const MIN_PASSWORD_LENGTH = 10
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ScannerAction =
  | { action: 'list' }
  | { action: 'create'; email: string; password: string | null; invite: boolean }
  | { action: 'disable' | 'enable'; user_id: string }

export function parseScannerAction(body: unknown): ScannerAction | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid request.' }
  const b = body as Record<string, unknown>
  switch (b.action) {
    case 'list':
      return { action: 'list' }
    case 'create': {
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
      if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'Enter a valid email address.' }
      const invite = b.invite === true
      const password = typeof b.password === 'string' ? b.password : null
      if (!invite && (!password || password.length < MIN_PASSWORD_LENGTH)) {
        return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }
      }
      if (password && password.length > 128) return { error: 'Password is too long.' }
      return { action: 'create', email, password: invite ? null : password, invite }
    }
    case 'disable':
    case 'enable': {
      const id = typeof b.user_id === 'string' ? b.user_id : ''
      if (!UUID_RE.test(id)) return { error: 'Invalid user id.' }
      return { action: b.action, user_id: id }
    }
    default:
      return { error: 'Unknown action.' }
  }
}

export interface ScannerUserView {
  user_id: string
  email: string | null
  role: 'scanner'
  disabled: boolean
  created_at: string
  last_sign_in_at: string | null
}

export interface ScannerUsersDeps extends StaffAuthDeps {
  listScanners(): Promise<ScannerUserView[]>
  /** Role stored for a user regardless of disabled state (null = none). */
  getStoredRole(userId: string): Promise<StaffRole | null>
  /** Creates the auth user + scanner role. Throws Error('exists') if the email is taken. */
  createScanner(input: { email: string; password: string | null; invite: boolean }): Promise<void>
  setDisabled(userId: string, disabled: boolean): Promise<void>
  logError?(message: string, error: unknown): void
}

/** Admin-only scanner-account management. Never touches admin accounts. */
export async function handleScannerUsers(
  req: { method: string; authorization: string | null; body: unknown },
  deps: ScannerUsersDeps,
): Promise<CoreResult> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }

  const auth = await authenticateStaff(req.authorization, deps, ['admin'])
  if (!auth.ok) return auth.result

  const action = parseScannerAction(req.body)
  if ('error' in action) return { status: 400, body: { error: action.error } }

  try {
    switch (action.action) {
      case 'list':
        return { status: 200, body: { users: await deps.listScanners() } }
      case 'create':
        try {
          await deps.createScanner(action)
        } catch (e) {
          if (e instanceof Error && e.message === 'exists') {
            return { status: 409, body: { error: 'An account with this email already exists.' } }
          }
          throw e
        }
        return { status: 200, body: { status: 'ok' } }
      case 'disable':
      case 'enable': {
        if (action.user_id === auth.userId) return { status: 400, body: { error: 'You cannot change your own account here.' } }
        const target = await deps.getStoredRole(action.user_id)
        if (target !== 'scanner') return { status: 400, body: { error: 'Only scanner accounts can be changed here.' } }
        await deps.setDisabled(action.user_id, action.action === 'disable')
        return { status: 200, body: { status: 'ok' } }
      }
    }
  } catch (error) {
    deps.logError?.('manage-scanner-users failed', error)
    return { status: 500, body: { error: 'The account service failed. Please try again.' } }
  }
}
