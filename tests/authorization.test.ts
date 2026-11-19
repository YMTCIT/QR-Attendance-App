/**
 * Authorization: client route rules, staff authentication used by every
 * protected Edge Function, admin-only scanner-account management, the
 * Power Automate webhook secret, and CSV formula-injection protection.
 * (Database RLS is covered in database.test.ts.)
 */
import { describe, expect, it, vi } from 'vitest'
import { canAccess, guardDecision, homePathForRole, safeReturnPath } from '../src/features/auth/routing'
import { authenticateStaff, corsHeaders, parseBearer, timingSafeEqual } from '../supabase/functions/_shared/http'
import { handleScannerUsers, parseScannerAction, type ScannerUsersDeps } from '../supabase/functions/_shared/scannerUsersCore'
import { handleRegister, validateRegistrationPayload, type RegisterDeps } from '../supabase/functions/_shared/registerCore'
import { sanitizeCsvCell, toCsv } from '../src/lib/csv'

const ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SCANNER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

describe('client routing rules', () => {
  it('sends each role to its home page', () => {
    expect(homePathForRole('admin')).toBe('/admin/dashboard')
    expect(homePathForRole('scanner')).toBe('/scan')
    expect(homePathForRole(null)).toBe('/unauthorized')
  })

  it('keeps scanner users out of the admin dashboard', () => {
    expect(canAccess('admin', 'scanner')).toBe(false)
    expect(canAccess('scan', 'scanner')).toBe(true)
    expect(canAccess('scan', 'admin')).toBe(true)
    expect(guardDecision({ signedIn: true, role: 'scanner', area: 'admin' })).toEqual({ kind: 'redirect', to: '/unauthorized' })
    expect(guardDecision({ signedIn: false, role: null, area: 'scan' })).toEqual({ kind: 'redirect', to: '/login' })
    expect(guardDecision({ signedIn: true, role: null, area: 'scan' })).toEqual({ kind: 'redirect', to: '/unauthorized' })
    expect(guardDecision({ signedIn: true, role: 'admin', area: 'admin' })).toEqual({ kind: 'allow' })
  })

  it('only returns to safe in-app paths after login', () => {
    expect(safeReturnPath('/admin/dashboard', 'scanner')).toBe('/scan')
    expect(safeReturnPath('https://evil.example', 'admin')).toBe('/admin/dashboard')
    expect(safeReturnPath('/scan', 'admin')).toBe('/scan')
  })
})

const staffDeps = (role: 'admin' | 'scanner' | null) => ({
  getUserId: vi.fn(async (t: string) => (t === 'tok' ? (role === 'admin' ? ADMIN : SCANNER) : null)),
  getRole: vi.fn(async () => role),
})

describe('staff authentication (Edge Functions)', () => {
  it('parses bearer tokens strictly', () => {
    expect(parseBearer('Bearer abc')).toBe('abc')
    expect(parseBearer('bearer abc')).toBe('abc')
    expect(parseBearer('abc')).toBeNull()
    expect(parseBearer(null)).toBeNull()
  })

  it('distinguishes 401 (no/invalid token) from 403 (wrong role)', async () => {
    expect(await authenticateStaff(null, staffDeps('admin'), ['admin'])).toMatchObject({ ok: false, result: { status: 401 } })
    expect(await authenticateStaff('Bearer nope', staffDeps('admin'), ['admin'])).toMatchObject({ ok: false, result: { status: 401 } })
    expect(await authenticateStaff('Bearer tok', staffDeps('scanner'), ['admin'])).toMatchObject({ ok: false, result: { status: 403 } })
    expect(await authenticateStaff('Bearer tok', staffDeps(null), ['admin', 'scanner'])).toMatchObject({ ok: false, result: { status: 403 } })
    expect(await authenticateStaff('Bearer tok', staffDeps('admin'), ['admin'])).toEqual({ ok: true, userId: ADMIN, role: 'admin' })
  })

  it('treats auth-service failures as unauthenticated, not as success', async () => {
    const deps = { getUserId: vi.fn(async () => Promise.reject(new Error('down'))), getRole: vi.fn() }
    expect(await authenticateStaff('Bearer tok', deps, ['admin'])).toMatchObject({ ok: false, result: { status: 401 } })
    expect(deps.getRole).not.toHaveBeenCalled()
  })

  it('restricts CORS when ALLOWED_ORIGINS is set', () => {
    expect(corsHeaders('https://a.vercel.app', undefined)['Access-Control-Allow-Origin']).toBe('*')
    expect(corsHeaders('https://a.vercel.app', 'https://a.vercel.app')['Access-Control-Allow-Origin']).toBe('https://a.vercel.app')
    expect(corsHeaders('https://evil.example', 'https://a.vercel.app')['Access-Control-Allow-Origin']).toBe('https://a.vercel.app')
  })
})

describe('manage-scanner-users (admin only)', () => {
  function deps(role: 'admin' | 'scanner', overrides: Partial<ScannerUsersDeps> = {}): ScannerUsersDeps {
    return {
      ...staffDeps(role),
      listScanners: vi.fn(async () => []),
      getStoredRole: vi.fn(async () => 'scanner' as const),
      createScanner: vi.fn(async () => undefined),
      setDisabled: vi.fn(async () => undefined),
      ...overrides,
    }
  }
  const req = (body: unknown) => ({ method: 'POST', authorization: 'Bearer tok', body })

  it('refuses scanner users', async () => {
    const d = deps('scanner')
    const res = await handleScannerUsers(req({ action: 'create', email: 'x@y.zz', password: 'longpassword1' }), d)
    expect(res.status).toBe(403)
    expect(d.createScanner).not.toHaveBeenCalled()
  })

  it('lets admins create, disable and enable scanner accounts', async () => {
    const d = deps('admin')
    expect((await handleScannerUsers(req({ action: 'create', email: 'Staff@CIT.edu', password: 'longpassword1' }), d)).status).toBe(200)
    expect(d.createScanner).toHaveBeenCalledWith({ action: 'create', email: 'staff@cit.edu', password: 'longpassword1', invite: false })
    expect((await handleScannerUsers(req({ action: 'disable', user_id: SCANNER }), d)).status).toBe(200)
    expect(d.setDisabled).toHaveBeenCalledWith(SCANNER, true)
  })

  it('never lets this endpoint change admin accounts or the caller itself', async () => {
    const d = deps('admin', { getStoredRole: vi.fn(async () => 'admin' as const) })
    expect((await handleScannerUsers(req({ action: 'disable', user_id: SCANNER }), d)).status).toBe(400)
    expect((await handleScannerUsers(req({ action: 'disable', user_id: ADMIN }), deps('admin'))).status).toBe(400)
    expect(d.setDisabled).not.toHaveBeenCalled()
  })

  it('validates input', () => {
    expect(parseScannerAction({ action: 'create', email: 'bad', password: 'longpassword1' })).toHaveProperty('error')
    expect(parseScannerAction({ action: 'create', email: 'a@b.cd', password: 'short' })).toHaveProperty('error')
    expect(parseScannerAction({ action: 'create', email: 'a@b.cd', invite: true })).toEqual({
      action: 'create',
      email: 'a@b.cd',
      password: null,
      invite: true,
    })
    expect(parseScannerAction({ action: 'promote', user_id: SCANNER })).toHaveProperty('error')
    expect(parseScannerAction({ action: 'disable', user_id: 'not-a-uuid' })).toHaveProperty('error')
  })

  it('reports duplicate emails clearly', async () => {
    const d = deps('admin', { createScanner: vi.fn(async () => Promise.reject(new Error('exists'))) })
    const res = await handleScannerUsers(req({ action: 'create', email: 'a@b.cd', password: 'longpassword1' }), d)
    expect(res.status).toBe(409)
  })
})

describe('register-attendee (Power Automate webhook)', () => {
  const SECRET = 'x'.repeat(40)
  const valid = {
    qr_code: 'PA-0001',
    name: 'Juan Dela Cruz',
    id_number: '00260001',
    email: 'Juan@CIT.edu',
    department: 'BSIT',
    event_id: 3,
  }
  function deps(overrides: Partial<RegisterDeps> = {}): RegisterDeps {
    return { secret: SECRET, upsert: vi.fn(async () => ({ status: 'ok', id: 7, created: true })), ...overrides }
  }

  it('requires the shared secret', async () => {
    for (const provided of [null, '', 'wrong', SECRET + 'x']) {
      const d = deps()
      const res = await handleRegister({ method: 'POST', providedSecret: provided, body: valid }, d)
      expect(res.status).toBe(401)
      expect(d.upsert).not.toHaveBeenCalled()
    }
  })

  it('refuses to run without a strong configured secret', async () => {
    const res = await handleRegister({ method: 'POST', providedSecret: 'short', body: valid }, deps({ secret: 'short' }))
    expect(res.status).toBe(500)
  })

  it('validates and normalises the payload, keeping leading zeros', async () => {
    const d = deps()
    const res = await handleRegister({ method: 'POST', providedSecret: SECRET, body: valid }, d)
    expect(res).toEqual({ status: 200, body: { status: 'ok', id: 7, created: true } })
    expect(d.upsert).toHaveBeenCalledWith({ ...valid, email: 'juan@cit.edu' })
  })

  it('reports validation errors and unknown events', async () => {
    const bad = await handleRegister({ method: 'POST', providedSecret: SECRET, body: { ...valid, name: '' } }, deps())
    expect(bad.status).toBe(400)
    const unknown = await handleRegister(
      { method: 'POST', providedSecret: SECRET, body: valid },
      deps({ upsert: vi.fn(async () => ({ status: 'unknown_event' })) }),
    )
    expect(unknown.status).toBe(422)
  })

  it('accepts event_id null (any event) and numeric strings, rejects junk', () => {
    expect(validateRegistrationPayload({ ...valid, event_id: null })).toMatchObject({ ok: true, value: { event_id: null } })
    expect(validateRegistrationPayload({ ...valid, event_id: '12' })).toMatchObject({ ok: true, value: { event_id: 12 } })
    expect(validateRegistrationPayload({ ...valid, event_id: 'abc' })).toMatchObject({ ok: false })
    const { event_id: _omit, ...noEvent } = valid
    void _omit
    expect(validateRegistrationPayload(noEvent)).toMatchObject({ ok: false })
  })

  it('compares secrets in constant time semantics', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('CSV export formula-injection protection', () => {
  it('neutralises dangerous leading characters', () => {
    expect(sanitizeCsvCell('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`)
    expect(sanitizeCsvCell('+1')).toBe("'+1")
    expect(sanitizeCsvCell('-2')).toBe("'-2")
    expect(sanitizeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(sanitizeCsvCell('Juan')).toBe('Juan')
    expect(sanitizeCsvCell('00260001')).toBe('00260001')
    expect(sanitizeCsvCell(null)).toBe('')
  })

  it('quotes every field', () => {
    expect(toCsv(['Name'], [['=1+1'], ['Dela Cruz, Juan']])).toBe(`"Name"\r\n"'=1+1"\r\n"Dela Cruz, Juan"`)
  })
})
