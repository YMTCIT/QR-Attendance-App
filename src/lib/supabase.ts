import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
// The publishable key (sb_publishable_...) or the legacy anon key. NEVER put a
// service-role / secret key in a VITE_ variable: it would ship to browsers.
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const supabaseConfigError: string | null =
  !url || !publishableKey
    ? 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (see README).'
    : null

interface ResilientFetchOptions {
  /** Longest wait for the device to come back online before trying anyway. */
  waitForOnlineMs?: number
  /** Delays between attempts after a network failure. */
  retryDelaysMs?: number[]
}

/**
 * fetch() for the Supabase client that makes LOGIN-TOKEN requests survive the
 * tablet waking up. When the screen turns back on, Supabase immediately
 * refreshes the login, often before Wi-Fi has reconnected. A failed refresh is
 * cached by the auth library for 60 s, during which the app looks signed out.
 * So for /auth/v1/token requests only, this waits for the device to be online
 * and retries network failures a few times. Every other request is passed
 * through unchanged.
 *
 * Retrying a token refresh is safe: a request that never reached the server
 * changed nothing, and Supabase accepts the same refresh token again within
 * its reuse interval (10 s by default).
 */
export function createResilientFetch(
  baseFetch: typeof fetch,
  { waitForOnlineMs = 15_000, retryDelaysMs = [1_000, 2_000, 3_000] }: ResilientFetchOptions = {},
): typeof fetch {
  const isTokenRequest = (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return href.includes('/auth/v1/token')
  }

  const waitForOnline = () =>
    new Promise<void>((resolve) => {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) return resolve()
      const done = () => {
        window.removeEventListener('online', done)
        window.clearTimeout(timer)
        resolve()
      }
      const timer = window.setTimeout(done, waitForOnlineMs)
      window.addEventListener('online', done)
    })

  return async (input, init) => {
    if (!isTokenRequest(input)) return baseFetch(input, init)
    for (let attempt = 0; ; attempt++) {
      await waitForOnline()
      try {
        return await baseFetch(input, init)
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === 'AbortError'
        if (aborted || attempt >= retryDelaysMs.length) throw error
        await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]))
      }
    }
  }
}

export const supabase: SupabaseClient = createClient(
  url ?? 'http://localhost:54321',
  publishableKey ?? 'missing-key',
  {
    auth: {
      // The login is kept in this browser's localStorage until Log out (or
      // until Supabase rejects it for good, e.g. a disabled account).
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    global: {
      fetch: createResilientFetch((...args) => fetch(...args)),
    },
    realtime: {
      params: { eventsPerSecond: 10 },
    },
  },
)

/**
 * The login saved in this browser, read directly from storage. Used when
 * Supabase cannot refresh it right now (offline after waking up): the saved
 * login is still valid to keep the user signed in, and it is refreshed as
 * soon as the network is back.
 */
export function readStoredSession(): Session | null {
  try {
    const key = (supabase.auth as unknown as { storageKey?: string }).storageKey
    if (!key) return null
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Session> | null
    if (!parsed?.access_token || !parsed.refresh_token || !parsed.user?.id) return null
    return parsed as Session
  } catch {
    return null
  }
}
