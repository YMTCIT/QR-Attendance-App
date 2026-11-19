import type { AppRole } from '../../types/database'

/**
 * Client-side routing rules. These only decide what to SHOW; every protected
 * operation is enforced again by RLS / Edge Functions on the server.
 */

export type ProtectedArea = 'scan' | 'admin'

const ACCESS: Record<ProtectedArea, readonly AppRole[]> = {
  scan: ['admin', 'scanner'],
  admin: ['admin'],
}

export function canAccess(area: ProtectedArea, role: AppRole | null | undefined): boolean {
  return !!role && ACCESS[area].includes(role)
}

/** Where "/" and a successful login should land. */
export function homePathForRole(role: AppRole | null | undefined): string {
  if (role === 'admin') return '/admin/dashboard'
  if (role === 'scanner') return '/scan'
  return '/unauthorized'
}

export type GuardDecision = { kind: 'allow' } | { kind: 'redirect'; to: string }

export function guardDecision(params: {
  signedIn: boolean
  role: AppRole | null | undefined
  area: ProtectedArea
}): GuardDecision {
  if (!params.signedIn) return { kind: 'redirect', to: '/login' }
  if (!canAccess(params.area, params.role)) return { kind: 'redirect', to: '/unauthorized' }
  return { kind: 'allow' }
}

/** Only allow redirecting back to known in-app paths after login. */
export function safeReturnPath(path: unknown, role: AppRole | null | undefined): string {
  if (typeof path !== 'string') return homePathForRole(role)
  if (path === '/scan' && canAccess('scan', role)) return path
  if (path.startsWith('/admin/') && canAccess('admin', role)) return '/admin/dashboard'
  return homePathForRole(role)
}
