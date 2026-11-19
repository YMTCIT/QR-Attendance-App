import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { guardDecision, type ProtectedArea } from '../features/auth/routing'
import { LoadingState } from './LoadingState'

/**
 * Hides pages from roles that may not use them. This is a UX convenience
 * only: RLS policies and Edge Functions enforce the same rules server-side.
 */
export function RoleGuard({ area, children }: { area: ProtectedArea; children: ReactNode }) {
  const { loading, session, role } = useAuth()
  if (loading) return <LoadingState label="Checking permissions…" fullScreen />
  const decision = guardDecision({ signedIn: !!session, role, area })
  if (decision.kind === 'redirect') return <Navigate to={decision.to} replace />
  return <>{children}</>
}
