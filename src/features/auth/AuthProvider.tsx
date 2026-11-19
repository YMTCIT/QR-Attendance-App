import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { AppRole } from '../../types/database'
import { AuthContext, type AuthState } from './context'

function friendlyAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) return 'Incorrect email or password.'
  if (/email not confirmed/i.test(message)) return 'This account has not been confirmed yet. Ask the administrator.'
  if (/banned|disabled/i.test(message)) return 'This account has been disabled. Ask the administrator.'
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Please wait a minute and try again.'
  if (/fetch|network/i.test(message)) return 'Cannot reach the server. Check the internet connection.'
  return 'Sign-in failed. Please try again.'
}

interface RoleResult {
  role: AppRole | null
  error: string | null
}

/** Reads the signed-in user's own role row (RLS allows reading only your own). */
async function fetchRole(uid: string): Promise<RoleResult> {
  const { data, error } = await supabase
    .from('app_user_roles')
    .select('role, disabled_at')
    .eq('user_id', uid)
    .maybeSingle()
  if (error) return { role: null, error: 'Could not load your account role. Check the connection and reload.' }
  const row = data as { role: AppRole; disabled_at: string | null } | null
  return { role: row && !row.disabled_at ? row.role : null, error: null }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoaded, setSessionLoaded] = useState(false)
  const [role, setRole] = useState<AppRole | null>(null)
  const [roleForUser, setRoleForUser] = useState<string | null>(null)
  const [roleError, setRoleError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setSession(data.session)
      setSessionLoaded(true)
    })
    // Do not call other Supabase APIs synchronously inside this callback.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setSessionLoaded(true)
    })
    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  const userId = session?.user.id ?? null

  const applyRole = useCallback((uid: string, result: RoleResult) => {
    setRole(result.role)
    setRoleError(result.error)
    setRoleForUser(uid)
  }, [])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void fetchRole(userId).then((result) => {
      if (!cancelled) applyRole(userId, result)
    })
    return () => {
      cancelled = true
    }
  }, [userId, applyRole])

  const loadRole = useCallback(
    async (uid: string) => {
      applyRole(uid, await fetchRole(uid))
    },
    [applyRole],
  )

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw new Error(friendlyAuthError(error.message))
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setRole(null)
    setRoleForUser(null)
  }, [])

  const refreshRole = useCallback(async () => {
    if (userId) await loadRole(userId)
  }, [userId, loadRole])

  const value = useMemo<AuthState>(() => {
    const roleResolved = !userId || roleForUser === userId
    return {
      loading: !sessionLoaded || !roleResolved,
      session,
      userId,
      email: session?.user.email ?? null,
      role: userId && roleForUser === userId ? role : null,
      roleError: userId ? roleError : null,
      signIn,
      signOut,
      refreshRole,
    }
  }, [sessionLoaded, session, userId, roleForUser, role, roleError, signIn, signOut, refreshRole])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
