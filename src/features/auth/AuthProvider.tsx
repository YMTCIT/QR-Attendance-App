import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { readStoredSession, supabase } from '../../lib/supabase'
import type { AppRole } from '../../types/database'
import { AuthContext, type AuthState } from './context'

/**
 * Staying signed in
 * -----------------
 * A login is kept on this device until the user taps Log out, or until
 * Supabase rejects it for good (e.g. the account was disabled), which Supabase
 * reports as a SIGNED_OUT event. Network problems (Wi-Fi still reconnecting
 * after the tablet wakes up, a short outage) never sign anyone out: the saved
 * login and the last known role are used until the server can be reached
 * again. Roles only decide which pages are shown; the database and Edge
 * Functions still check every request.
 */

const ROLE_CACHE_PREFIX = 'cit-qr:role:'
const ROLE_RETRY_MS = 5_000

function readCachedRole(uid: string): AppRole | null {
  try {
    const value = localStorage.getItem(ROLE_CACHE_PREFIX + uid)
    return value === 'admin' || value === 'scanner' ? value : null
  } catch {
    return null
  }
}

function writeCachedRole(uid: string, role: AppRole | null): void {
  try {
    if (role) localStorage.setItem(ROLE_CACHE_PREFIX + uid, role)
    else localStorage.removeItem(ROLE_CACHE_PREFIX + uid)
  } catch {
    // storage unavailable
  }
}

function clearCachedRoles(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith(ROLE_CACHE_PREFIX)) localStorage.removeItem(key)
    }
  } catch {
    // storage unavailable
  }
}

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
      // No session but the login is still saved: Supabase could not refresh
      // the token while offline. Stay signed in with the saved login.
      setSession(data.session ?? readStoredSession())
      setSessionLoaded(true)
    })
    // Do not call other Supabase APIs synchronously inside this callback.
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'SIGNED_OUT') {
        // Log out, or Supabase rejected the login for good.
        clearCachedRoles()
        setSession(null)
      } else {
        setSession(next ?? readStoredSession())
      }
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

  /**
   * Load the role. If the server can't be reached, use the role remembered on
   * this device (if any) and keep retrying until it can.
   */
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    let retry: number | undefined
    const attempt = async () => {
      const result = await fetchRole(userId)
      if (cancelled) return
      if (result.error) {
        const cached = readCachedRole(userId)
        applyRole(userId, cached ? { role: cached, error: null } : result)
        retry = window.setTimeout(() => void attempt(), ROLE_RETRY_MS)
        return
      }
      writeCachedRole(userId, result.role)
      applyRole(userId, result)
    }
    void attempt()
    return () => {
      cancelled = true
      window.clearTimeout(retry)
    }
  }, [userId, applyRole])

  const loadRole = useCallback(
    async (uid: string) => {
      const result = await fetchRole(uid)
      if (result.error) {
        const cached = readCachedRole(uid)
        applyRole(uid, cached ? { role: cached, error: null } : result)
        return
      }
      writeCachedRole(uid, result.role)
      applyRole(uid, result)
    },
    [applyRole],
  )

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw new Error(friendlyAuthError(error.message))
  }, [])

  /** The ONLY way the app itself signs a user out (the Log out button). */
  const signOut = useCallback(async () => {
    // scope 'local': forget the login on this device even if the server can't
    // be reached right now.
    await supabase.auth.signOut({ scope: 'local' })
    clearCachedRoles()
    setSession(null)
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
