/**
 * Staying signed in: a login is kept until Log out (or until Supabase ends it
 * for good). Network trouble — typically Wi-Fi reconnecting after the tablet
 * screen was off — must never sign anyone out.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { FunctionsHttpError, type Session } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- mocked Supabase client ---------------------------------------------------
type AuthCallback = (event: string, session: Session | null) => void
const sb = vi.hoisted(() => ({
  authCallback: null as null | ((event: string, session: unknown) => void),
  storedSession: null as unknown,
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  roleQuery: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: sb.getSession,
      refreshSession: sb.refreshSession,
      signOut: sb.signOut,
      signInWithPassword: vi.fn(),
      onAuthStateChange: (cb: AuthCallback) => {
        sb.authCallback = cb as typeof sb.authCallback
        return { data: { subscription: { unsubscribe: () => undefined } } }
      },
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: sb.roleQuery }) }) }),
    functions: { invoke: sb.invoke },
  },
  readStoredSession: () => sb.storedSession,
}))

const session = (id: string) =>
  ({ access_token: 'a', refresh_token: 'r', expires_at: 0, user: { id, email: `${id}@cit.example` } }) as unknown as Session

beforeEach(() => {
  localStorage.clear()
  sb.authCallback = null
  sb.storedSession = null
  sb.getSession.mockReset()
  sb.refreshSession.mockReset()
  sb.signOut.mockClear()
  sb.roleQuery.mockReset()
  sb.invoke.mockReset()
})
afterEach(() => cleanup())

// ---- AuthProvider ---------------------------------------------------------------
async function renderAuth() {
  const { AuthProvider } = await import('../src/features/auth/AuthProvider')
  const { useAuth } = await import('../src/hooks/useAuth')
  const api: { current: ReturnType<typeof useAuth> | null } = { current: null }
  function Probe() {
    const auth = useAuth()
    api.current = auth
    return createElement(
      'p',
      { 'data-testid': 'probe' },
      auth.loading ? 'loading' : `${auth.session ? auth.session.user.id : 'signed-out'}/${auth.role ?? 'no-role'}`,
    )
  }
  render(createElement(AuthProvider, null, createElement(Probe)))
  return api
}
const probe = () => screen.getByTestId('probe').textContent

describe('AuthProvider keeps the login through network trouble', () => {
  it('stays signed in with the saved login when the refresh fails offline (e.g. page reloaded after waking)', async () => {
    sb.getSession.mockResolvedValue({ data: { session: null }, error: new Error('Failed to fetch') })
    sb.storedSession = session('u1')
    sb.roleQuery.mockResolvedValue({ data: { role: 'scanner', disabled_at: null }, error: null })
    await renderAuth()
    await waitFor(() => expect(probe()).toBe('u1/scanner'))
  })

  it('ignores a "no session" notification while the login is still saved, but honours SIGNED_OUT', async () => {
    sb.getSession.mockResolvedValue({ data: { session: session('u1') }, error: null })
    sb.roleQuery.mockResolvedValue({ data: { role: 'admin', disabled_at: null }, error: null })
    await renderAuth()
    await waitFor(() => expect(probe()).toBe('u1/admin'))

    sb.storedSession = session('u1')
    act(() => sb.authCallback!('INITIAL_SESSION', null))
    expect(probe()).toBe('u1/admin')

    // Supabase ended the session for good (e.g. account disabled).
    sb.storedSession = null
    act(() => sb.authCallback!('SIGNED_OUT', null))
    expect(probe()).toBe('signed-out/no-role')
  })

  it('uses the role remembered on this device when the role lookup fails, and keeps retrying', async () => {
    localStorage.setItem('cit-qr:role:u1', 'scanner')
    sb.getSession.mockResolvedValue({ data: { session: session('u1') }, error: null })
    sb.roleQuery.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
    sb.roleQuery.mockResolvedValue({ data: { role: 'scanner', disabled_at: null }, error: null })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await renderAuth()
      await waitFor(() => expect(probe()).toBe('u1/scanner'))
      expect(sb.roleQuery).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      await waitFor(() => expect(sb.roleQuery).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it('remembers the role after a successful lookup, and forgets it when disabled', async () => {
    sb.getSession.mockResolvedValue({ data: { session: session('u1') }, error: null })
    sb.roleQuery.mockResolvedValue({ data: { role: 'admin', disabled_at: null }, error: null })
    const api = await renderAuth()
    await waitFor(() => expect(probe()).toBe('u1/admin'))
    expect(localStorage.getItem('cit-qr:role:u1')).toBe('admin')

    sb.roleQuery.mockResolvedValue({ data: { role: 'admin', disabled_at: '2026-01-01T00:00:00Z' }, error: null })
    await act(async () => api.current!.refreshRole())
    expect(probe()).toBe('u1/no-role')
    expect(localStorage.getItem('cit-qr:role:u1')).toBeNull()
  })

  it('Log out signs out only THIS device and forgets the remembered role', async () => {
    sb.getSession.mockResolvedValue({ data: { session: session('u1') }, error: null })
    sb.roleQuery.mockResolvedValue({ data: { role: 'scanner', disabled_at: null }, error: null })
    const api = await renderAuth()
    await waitFor(() => expect(probe()).toBe('u1/scanner'))

    await act(async () => api.current!.signOut())
    expect(sb.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(probe()).toBe('signed-out/no-role')
    expect(localStorage.getItem('cit-qr:role:u1')).toBeNull()
  })
})

// ---- check-in after waking up -----------------------------------------------------
const httpError = (status: number) => new FunctionsHttpError(new Response(null, { status }))
const ok = { status: 'ok', name: 'Juan', event_name: 'E', scanned_at: '2026-12-01T00:35:00Z' }

describe('submitCheckIn when the login token is stale', () => {
  it('refreshes the login and retries once on 401', async () => {
    const { submitCheckIn } = await import('../src/features/attendance/api')
    sb.invoke.mockResolvedValueOnce({ data: null, error: httpError(401) }).mockResolvedValueOnce({ data: ok, error: null })
    sb.refreshSession.mockResolvedValue({ data: { session: session('u1') }, error: null })
    await expect(submitCheckIn('ABC001')).resolves.toMatchObject({ status: 'ok', name: 'Juan' })
    expect(sb.invoke).toHaveBeenCalledTimes(2)
  })

  it('reports a CONNECTION ERROR (not sign-in required) while the saved login cannot be refreshed yet', async () => {
    const { submitCheckIn } = await import('../src/features/attendance/api')
    sb.invoke.mockResolvedValue({ data: null, error: httpError(401) })
    sb.refreshSession.mockResolvedValue({ data: { session: null }, error: new Error('Failed to fetch') })
    sb.storedSession = session('u1')
    await expect(submitCheckIn('ABC001')).resolves.toMatchObject({ status: 'network_error' })
    expect(sb.invoke).toHaveBeenCalledTimes(1)
  })

  it('reports sign-in required only when the login is really gone, or the account has no enabled role', async () => {
    const { submitCheckIn } = await import('../src/features/attendance/api')
    sb.invoke.mockResolvedValue({ data: null, error: httpError(401) })
    sb.refreshSession.mockResolvedValue({ data: { session: null }, error: new Error('Invalid Refresh Token') })
    sb.storedSession = null
    await expect(submitCheckIn('ABC001')).resolves.toEqual({ status: 'unauthorized' })

    sb.invoke.mockResolvedValue({ data: null, error: httpError(403) })
    await expect(submitCheckIn('ABC001')).resolves.toEqual({ status: 'unauthorized' })
  })
})

// ---- reading the saved login from the REAL client's storage ------------------------------
describe('readStoredSession (real Supabase client)', () => {
  it('finds the login under the key the Supabase client saves it to', async () => {
    const real = await vi.importActual<typeof import('../src/lib/supabase')>('../src/lib/supabase')
    const key = (real.supabase.auth as unknown as { storageKey?: string }).storageKey
    expect(key).toMatch(/^sb-.+-auth-token$/)
    expect(real.readStoredSession()).toBeNull()

    localStorage.setItem(key!, JSON.stringify(session('u9')))
    expect(real.readStoredSession()?.user.id).toBe('u9')

    localStorage.setItem(key!, '{"not":"a session"}')
    expect(real.readStoredSession()).toBeNull()
  })
})

// ---- resilient fetch for login refreshes ----------------------------------------------
describe('createResilientFetch', () => {
  const load = async () =>
    (await vi.importActual<typeof import('../src/lib/supabase')>('../src/lib/supabase')).createResilientFetch

  it('retries login-token requests after network failures', async () => {
    const createResilientFetch = await load()
    const base = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(new Response('{}', { status: 200 }))
    const f = createResilientFetch(base, { retryDelaysMs: [0, 0, 0] })
    const res = await f('https://x.supabase.co/auth/v1/token?grant_type=refresh_token', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(base).toHaveBeenCalledTimes(3)
  })

  it('gives up after the last retry, and never retries other requests', async () => {
    const createResilientFetch = await load()
    const base = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    const f = createResilientFetch(base, { retryDelaysMs: [0, 0] })
    await expect(f('https://x.supabase.co/auth/v1/token?grant_type=refresh_token')).rejects.toThrow('Failed to fetch')
    expect(base).toHaveBeenCalledTimes(3)

    base.mockClear()
    await expect(f('https://x.supabase.co/functions/v1/check-in', { method: 'POST' })).rejects.toThrow('Failed to fetch')
    expect(base).toHaveBeenCalledTimes(1)
  })

  it('waits for the device to come back online before refreshing the login', async () => {
    const createResilientFetch = await load()
    const base = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }))
    const f = createResilientFetch(base, { retryDelaysMs: [], waitForOnlineMs: 60_000 })
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      const pending = f('https://x.supabase.co/auth/v1/token?grant_type=refresh_token')
      await new Promise((r) => setTimeout(r, 20))
      expect(base).not.toHaveBeenCalled()
      onLine.mockReturnValue(true)
      window.dispatchEvent(new Event('online'))
      await expect(pending).resolves.toBeInstanceOf(Response)
      expect(base).toHaveBeenCalledTimes(1)
    } finally {
      onLine.mockRestore()
    }
  })
})
