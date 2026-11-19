/**
 * check-in Edge Function handler (the real code from
 * supabase/functions/_shared/checkInCore.ts) and the client-side response
 * parsing / overlay mapping.
 */
import { describe, expect, it, vi } from 'vitest'
import { handleCheckIn, normalizeCheckInResult, type CheckInDeps } from '../supabase/functions/_shared/checkInCore'
import { describeOutcome, overlayDurationFor, parseCheckInResponse } from '../src/features/attendance/checkInResult'

const USER = '11111111-1111-1111-1111-111111111111'

function deps(overrides: Partial<CheckInDeps> = {}): CheckInDeps {
  return {
    getUserId: vi.fn(async (token: string) => (token === 'good-token' ? USER : null)),
    getRole: vi.fn(async () => 'scanner' as const),
    recordCheckIn: vi.fn(async () => ({
      status: 'ok',
      name: 'Juan Dela Cruz',
      event_name: 'CIT University Event',
      scanned_at: '2026-12-01T00:35:00+00:00',
      internal_id: 42, // must be stripped
    })),
    ...overrides,
  }
}

const post = (body: unknown, authorization: string | null = 'Bearer good-token') => ({ method: 'POST', authorization, body })

describe('check-in handler', () => {
  it('records a check-in for an authenticated scanner and returns minimal fields', async () => {
    const d = deps()
    const res = await handleCheckIn(post({ qr_code: '  ABC001  ' }), d)
    expect(res).toEqual({
      status: 200,
      body: { status: 'ok', name: 'Juan Dela Cruz', event_name: 'CIT University Event', scanned_at: '2026-12-01T00:35:00+00:00' },
    })
    expect(d.recordCheckIn).toHaveBeenCalledWith('ABC001', USER)
  })

  it('rejects unauthenticated callers before touching the database', async () => {
    for (const auth of [null, '', 'Basic abc', 'Bearer ', 'Bearer bad-token']) {
      const d = deps()
      const res = await handleCheckIn(post({ qr_code: 'ABC001' }, auth), d)
      expect(res.status).toBe(401)
      expect(d.recordCheckIn).not.toHaveBeenCalled()
    }
  })

  it('rejects signed-in users without an enabled staff role', async () => {
    const d = deps({ getRole: vi.fn(async () => null) })
    const res = await handleCheckIn(post({ qr_code: 'ABC001' }), d)
    expect(res.status).toBe(403)
    expect(d.recordCheckIn).not.toHaveBeenCalled()
  })

  it('allows administrators too', async () => {
    const res = await handleCheckIn(post({ qr_code: 'ABC001' }), deps({ getRole: vi.fn(async () => 'admin' as const) }))
    expect(res.status).toBe(200)
  })

  it('validates the QR payload', async () => {
    expect((await handleCheckIn(post({}), deps())).status).toBe(400)
    expect((await handleCheckIn(post({ qr_code: 123 }), deps())).status).toBe(400)
    expect((await handleCheckIn(post(null), deps())).status).toBe(400)
    expect((await handleCheckIn(post({ qr_code: '   ' }), deps())).body).toEqual({ status: 'invalid' })
    expect((await handleCheckIn(post({ qr_code: 'x'.repeat(513) }), deps())).body).toEqual({ status: 'invalid' })
    expect((await handleCheckIn({ method: 'GET', authorization: 'Bearer good-token', body: null }, deps())).status).toBe(405)
  })

  it('passes through duplicate / invalid / wrong-event / no-event results', async () => {
    const cases: [unknown, unknown][] = [
      [
        { status: 'already', name: 'Juan Dela Cruz', event_name: 'E', scanned_at: '2026-12-01T00:35:00Z' },
        { status: 'already', name: 'Juan Dela Cruz', event_name: 'E', scanned_at: '2026-12-01T00:35:00Z' },
      ],
      [{ status: 'invalid' }, { status: 'invalid' }],
      [{ status: 'wrong_event', name: 'leak?' }, { status: 'wrong_event' }],
      [{ status: 'no_event' }, { status: 'no_event' }],
    ]
    for (const [db, expected] of cases) {
      const res = await handleCheckIn(post({ qr_code: 'Q' }), deps({ recordCheckIn: vi.fn(async () => db) }))
      expect(res).toEqual({ status: 200, body: expected })
    }
  })

  it('returns a generic 500 (no internals) when the database fails or returns junk', async () => {
    const failing = deps({ recordCheckIn: vi.fn(async () => Promise.reject(new Error('connection to db at 10.0.0.5 failed'))) })
    const res = await handleCheckIn(post({ qr_code: 'Q' }), failing)
    expect(res).toEqual({ status: 500, body: { error: 'server_error' } })

    const junk = await handleCheckIn(post({ qr_code: 'Q' }), deps({ recordCheckIn: vi.fn(async () => ({ status: 'ok' })) }))
    expect(junk.status).toBe(500)
  })

  it('normalizeCheckInResult rejects unknown statuses', () => {
    expect(normalizeCheckInResult({ status: 'checked_out' })).toBeNull()
    expect(normalizeCheckInResult(null)).toBeNull()
  })
})

describe('client response parsing (never a false success)', () => {
  it('accepts well-formed responses', () => {
    expect(parseCheckInResponse({ status: 'ok', name: 'A', event_name: 'E', scanned_at: '2026-12-01T00:35:00Z' })).toEqual({
      status: 'ok',
      name: 'A',
      event_name: 'E',
      scanned_at: '2026-12-01T00:35:00Z',
    })
    expect(parseCheckInResponse({ status: 'no_event' })).toEqual({ status: 'no_event' })
  })

  it('rejects malformed or unexpected responses', () => {
    expect(parseCheckInResponse({ status: 'ok' })).toBeNull()
    expect(parseCheckInResponse({ status: 'ok', name: 'A', scanned_at: 'not a date' })).toBeNull()
    expect(parseCheckInResponse({ error: 'server_error' })).toBeNull()
    expect(parseCheckInResponse('ok')).toBeNull()
    expect(parseCheckInResponse(undefined)).toBeNull()
  })

  it('maps outcomes to the required overlay text', () => {
    const ok = describeOutcome({ status: 'ok', name: 'Juan Dela Cruz', event_name: 'CIT University Event', scanned_at: '2026-12-01T00:35:00Z' })
    expect(ok).toMatchObject({ tone: 'success', kicker: 'CHECK-IN SUCCESSFUL', title: 'WELCOME!', name: 'Juan Dela Cruz' })
    expect(ok.lines).toEqual(['Attendance Recorded', 'CIT University Event'])

    const dup = describeOutcome({ status: 'already', name: 'Juan Dela Cruz', scanned_at: '2026-12-01T00:35:00Z' })
    expect(dup.tone).toBe('warning')
    expect(dup.title).toBe('ALREADY CHECKED IN')
    expect(dup.lines).toContain('Checked in at: 8:35 AM') // Asia/Manila

    expect(describeOutcome({ status: 'invalid' }).title).toBe('INVALID QR CODE')
    expect(describeOutcome({ status: 'wrong_event' }).title).toBe('NOT REGISTERED FOR THIS EVENT')
    expect(describeOutcome({ status: 'no_event' }).title).toBe('NO ACTIVE EVENT')
    const net = describeOutcome({ status: 'network_error' })
    expect(net).toMatchObject({ tone: 'error', title: 'CONNECTION ERROR' })
    expect(net.lines).toEqual(['Attendance could not be confirmed.', 'Please try again.'])
  })

  it('uses separate success and error overlay durations', () => {
    expect(overlayDurationFor({ status: 'ok', name: 'a', event_name: '', scanned_at: 'x' }, 1200, 2500)).toBe(1200)
    expect(overlayDurationFor({ status: 'invalid' }, 1200, 2500)).toBe(2500)
  })
})
