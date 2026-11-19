/**
 * Small HTTP helpers shared by the Edge Functions. No Deno-specific APIs here,
 * so this file is also importable from Vitest.
 */

export interface CoreResult {
  status: number
  body: Record<string, unknown>
}

/**
 * CORS. Browser calls are authenticated with a bearer token (not cookies), so
 * a permissive origin is acceptable; set ALLOWED_ORIGINS (comma-separated) to
 * restrict it to your Vercel domain(s).
 */
export function corsHeaders(origin: string | null, allowedOrigins: string | undefined): Record<string, string> {
  const list = (allowedOrigins ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const allow = list.length === 0 ? '*' : origin && list.includes(origin) ? origin : list[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-registration-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() || null : null
}

/** Constant-time string comparison (for shared secrets). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  // Always walk the longer input so timing does not reveal the position of
  // the first mismatch; a length mismatch still fails.
  const len = Math.max(x.length, y.length)
  let diff = x.length ^ y.length
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export type StaffRole = 'admin' | 'scanner'

/** Dependencies for authenticating a staff caller. */
export interface StaffAuthDeps {
  /** Validates the access token with Supabase Auth; returns the user id or null. */
  getUserId(token: string): Promise<string | null>
  /** Returns the ENABLED role of the user, or null (no role / disabled). */
  getRole(userId: string): Promise<StaffRole | null>
}

export type StaffAuthResult = { ok: true; userId: string; role: StaffRole } | { ok: false; result: CoreResult }

export async function authenticateStaff(
  authorization: string | null,
  deps: StaffAuthDeps,
  allowed: readonly StaffRole[],
): Promise<StaffAuthResult> {
  const token = parseBearer(authorization)
  if (!token) return { ok: false, result: { status: 401, body: { error: 'unauthorized' } } }

  let userId: string | null
  try {
    userId = await deps.getUserId(token)
  } catch {
    userId = null
  }
  if (!userId) return { ok: false, result: { status: 401, body: { error: 'unauthorized' } } }

  let role: StaffRole | null
  try {
    role = await deps.getRole(userId)
  } catch {
    return { ok: false, result: { status: 500, body: { error: 'server_error' } } }
  }
  if (!role || !allowed.includes(role)) return { ok: false, result: { status: 403, body: { error: 'forbidden' } } }
  return { ok: true, userId, role }
}
