import { createContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { AppRole } from '../../types/database'

export interface AuthState {
  /** True until the session AND role have been resolved. */
  loading: boolean
  session: Session | null
  userId: string | null
  email: string | null
  /** null when signed out, when the account has no role, or when it is disabled. */
  role: AppRole | null
  roleError: string | null
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refreshRole: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
