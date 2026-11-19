// @vitest-environment node
/**
 * Executes the real migrations in PGlite and verifies constraints, RLS and the
 * check-in / registration functions.
 */
import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_ID, DISABLED_SCANNER_ID, NO_ROLE_ID, SCANNER_ID, as, createTestDb } from './helpers/pglite'

type Json = Record<string, unknown>

let db: PGlite
let eventA: number
let eventB: number

async function checkIn(code: string, userId = SCANNER_ID): Promise<Json> {
  return as(db, 'service_role', async (tx) => {
    const r = await tx.query<{ r: Json }>('select public.record_qr_check_in($1, $2) as r', [code, userId])
    return r.rows[0].r
  })
}

async function attendanceCount(): Promise<number> {
  const r = await db.query<{ n: number }>('select count(*)::int as n from public.attendance')
  return r.rows[0].n
}

beforeAll(async () => {
  db = await createTestDb()
  await as(db, { userId: ADMIN_ID }, async (tx) => {
    const a = await tx.query<{ id: number }>(
      `insert into public.events (name, date, venue) values ('Event A', '2026-12-01', 'Gym') returning id`,
    )
    const b = await tx.query<{ id: number }>(
      `insert into public.events (name, date) values ('Event B', '2026-12-02') returning id`,
    )
    eventA = Number(a.rows[0].id)
    eventB = Number(b.rows[0].id)
    await tx.query(
      `insert into public.attendees (qr_code, name, id_number, email, department, event_id, source) values
        ('ANY-001', 'Any Event Person', '000123', 'Any@Example.test', 'BSIT', null, 'manual'),
        ('A-001', '  Juan Dela Cruz ', '20260001', null, 'BSIT', $1, 'import'),
        ('B-001', 'Maria Santos', '20260002', null, 'BSCS', $2, 'import')`,
      [eventA, eventB],
    )
  })
})

describe('schema & constraints', () => {
  it('normalises registration text and keeps leading zeros', async () => {
    const r = await db.query<{ name: string; id_number: string; email: string }>(
      `select name, id_number, email from public.attendees where qr_code in ('A-001', 'ANY-001') order by qr_code`,
    )
    expect(r.rows[0]).toMatchObject({ name: 'Juan Dela Cruz', id_number: '20260001' })
    expect(r.rows[1]).toMatchObject({ id_number: '000123', email: 'any@example.test' })
  })

  it('rejects empty QR codes and duplicate QR codes', async () => {
    await expect(
      db.query(`insert into public.attendees (qr_code, name, source) values ('   ', 'X', 'manual')`),
    ).rejects.toThrow(/check constraint/)
    await expect(
      db.query(`insert into public.attendees (qr_code, name, source) values ('A-001', 'Dup', 'manual')`),
    ).rejects.toThrow(/duplicate key/)
  })

  it('has no time-out / check-out style columns', async () => {
    const r = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'attendance'`,
    )
    const cols = r.rows.map((c) => c.column_name)
    expect(cols.sort()).toEqual(
      ['attendee_id', 'check_in_method', 'created_at', 'event_id', 'id', 'recorded_by', 'scanned_at'].sort(),
    )
    for (const forbidden of ['time_out', 'check_out', 'clock_out', 'departure_at', 'checkout_at', 'duration', 'work_hours']) {
      expect(cols).not.toContain(forbidden)
    }
  })
})

describe('active event', () => {
  it('returns no_event when nothing is active', async () => {
    expect(await checkIn('A-001')).toEqual({ status: 'no_event' })
    expect(await attendanceCount()).toBe(0)
  })

  it('allows at most one active event (partial unique index)', async () => {
    await db.query(`update public.events set active = true where id = $1`, [eventA])
    await expect(db.query(`update public.events set active = true where id = $1`, [eventB])).rejects.toThrow(
      /duplicate key/,
    )
    await db.query(`update public.events set active = false`)
  })

  it('switches the active event atomically via set_active_event and signals scanners', async () => {
    await as(db, { userId: ADMIN_ID }, (tx) => tx.query('select public.set_active_event($1)', [eventB]))
    await as(db, { userId: ADMIN_ID }, (tx) => tx.query('select public.set_active_event($1)', [eventA]))
    const active = await db.query<{ id: number }>('select id from public.events where active')
    expect(active.rows.map((r) => Number(r.id))).toEqual([eventA])
    const state = await db.query<{ event_id: number }>('select event_id from public.active_event_state')
    expect(Number(state.rows[0].event_id)).toBe(eventA)
  })

  it('does not let scanner users change the active event', async () => {
    await expect(
      as(db, { userId: SCANNER_ID }, (tx) => tx.query('select public.set_active_event(null)')),
    ).rejects.toThrow(/forbidden/)
  })

  it('exposes only minimal active-event details to scanner users', async () => {
    const r = await as(db, { userId: SCANNER_ID }, (tx) => tx.query<Json>('select * from public.get_active_event()'))
    expect(r.rows).toHaveLength(1)
    expect(Object.keys(r.rows[0]).sort()).toEqual(['date', 'id', 'name', 'venue'])
    expect(r.rows[0].name).toBe('Event A')
  })
})

describe('record_qr_check_in', () => {
  it('records the first valid scan exactly once', async () => {
    const first = await checkIn('A-001')
    expect(first).toMatchObject({ status: 'ok', name: 'Juan Dela Cruz', event_name: 'Event A' })
    expect(typeof first.scanned_at).toBe('string')
    expect(await attendanceCount()).toBe(1)
  })

  it('returns "already" with the ORIGINAL timestamp and creates no new row', async () => {
    const before = await db.query<{ scanned_at: Date }>('select scanned_at from public.attendance')
    const again = await checkIn('A-001')
    const padded = await checkIn('   A-001  ')
    expect(again.status).toBe('already')
    expect(padded.status).toBe('already')
    expect(again.scanned_at).toBe(padded.scanned_at)
    const after = await db.query<{ scanned_at: Date }>('select scanned_at from public.attendance')
    expect(after.rows[0].scanned_at.getTime()).toBe(before.rows[0].scanned_at.getTime())
    expect(await attendanceCount()).toBe(1)
  })

  it('treats concurrent duplicate inserts as a single check-in (ON CONFLICT on the unique key)', async () => {
    // Two "tablets" racing inside one transaction: the second insert hits the
    // unique constraint path and must not create a row.
    const results = await as(db, 'service_role', async (tx) => {
      const r1 = await tx.query<{ r: Json }>('select public.record_qr_check_in($1, $2) as r', ['ANY-001', SCANNER_ID])
      const r2 = await tx.query<{ r: Json }>('select public.record_qr_check_in($1, $2) as r', ['ANY-001', ADMIN_ID])
      return [r1.rows[0].r, r2.rows[0].r]
    })
    expect(results.map((r) => r.status)).toEqual(['ok', 'already'])
    expect(results[1].scanned_at).toBe(results[0].scanned_at)
    const n = await db.query<{ n: number }>(
      `select count(*)::int as n from public.attendance at join public.attendees a on a.id = at.attendee_id where a.qr_code = 'ANY-001'`,
    )
    expect(n.rows[0].n).toBe(1)
  })

  it('enforces UNIQUE(event_id, attendee_id) even for direct inserts', async () => {
    await expect(
      db.query(
        `insert into public.attendance (event_id, attendee_id, check_in_method)
         select $1, id, 'qr' from public.attendees where qr_code = 'A-001'`,
        [eventA],
      ),
    ).rejects.toThrow(/attendance_event_attendee_unique/)
  })

  it('rejects wrong-event, unknown and empty codes', async () => {
    expect(await checkIn('B-001')).toEqual({ status: 'wrong_event' })
    expect(await checkIn('NOPE')).toEqual({ status: 'invalid' })
    expect(await checkIn('   ')).toEqual({ status: 'invalid' })
    expect(await checkIn('x'.repeat(600))).toEqual({ status: 'invalid' })
  })

  it('refuses callers without an enabled staff role', async () => {
    await expect(checkIn('A-001', DISABLED_SCANNER_ID)).rejects.toThrow(/forbidden/)
    await expect(checkIn('A-001', NO_ROLE_ID)).rejects.toThrow(/forbidden/)
  })

  it('cannot be executed directly by browser roles', async () => {
    await expect(
      as(db, { userId: SCANNER_ID }, (tx) => tx.query(`select public.record_qr_check_in('A-001', $1)`, [SCANNER_ID])),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(db, 'anon', (tx) => tx.query(`select public.record_qr_check_in('A-001', $1)`, [SCANNER_ID])),
    ).rejects.toThrow(/permission denied/)
  })

  it('never lets anyone overwrite scanned_at', async () => {
    await expect(db.query(`update public.attendance set scanned_at = now() - interval '1 day'`)).rejects.toThrow(
      /immutable/,
    )
  })
})

describe('row level security', () => {
  it('hides registrants and attendance from scanner users', async () => {
    const r = await as(db, { userId: SCANNER_ID }, async (tx) => ({
      attendees: (await tx.query('select * from public.attendees')).rows.length,
      attendance: (await tx.query('select * from public.attendance')).rows.length,
      events: (await tx.query('select * from public.events')).rows.length,
      state: (await tx.query('select * from public.active_event_state')).rows.length,
    }))
    expect(r).toEqual({ attendees: 0, attendance: 0, events: 0, state: 1 })
  })

  it('prevents scanner users from writing registrations or attendance', async () => {
    await expect(
      as(db, { userId: SCANNER_ID }, (tx) =>
        tx.query(`insert into public.attendees (qr_code, name, source) values ('S-1', 'S', 'manual')`),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(
      as(db, { userId: SCANNER_ID }, (tx) =>
        tx.query(`insert into public.attendance (event_id, attendee_id, check_in_method) values (1, 1, 'qr')`),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(db, { userId: SCANNER_ID }, (tx) => tx.query('select public.admin_mark_present($1, 1)', [eventA])),
    ).rejects.toThrow(/forbidden/)
  })

  it('prevents role self-assignment / privilege escalation', async () => {
    await expect(
      as(db, { userId: SCANNER_ID }, (tx) =>
        tx.query(`update public.app_user_roles set role = 'admin' where user_id = $1`, [SCANNER_ID]),
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      as(db, { userId: NO_ROLE_ID }, (tx) =>
        tx.query(`insert into public.app_user_roles (user_id, role) values ($1, 'admin')`, [NO_ROLE_ID]),
      ),
    ).rejects.toThrow(/permission denied/)
  })

  it('lets a user read only their own role row', async () => {
    const r = await as(db, { userId: SCANNER_ID }, (tx) => tx.query<{ role: string }>('select role from public.app_user_roles'))
    expect(r.rows).toEqual([{ role: 'scanner' }])
  })

  it('treats disabled scanner accounts as having no role', async () => {
    const r = await as(db, { userId: DISABLED_SCANNER_ID }, (tx) =>
      tx.query<{ role: string | null }>('select public.app_role() as role'),
    )
    expect(r.rows[0].role).toBeNull()
    await expect(
      as(db, { userId: DISABLED_SCANNER_ID }, (tx) => tx.query('select * from public.get_active_event()')),
    ).rejects.toThrow(/forbidden/)
  })

  it('gives every newly created auth user the admin role, without overwriting an existing role', async () => {
    const NEW_ID = '00000000-0000-0000-0000-0000000000ee'
    await db.query(`insert into auth.users (id, email) values ($1, 'new@example.test')`, [NEW_ID])
    const r = await as(db, { userId: NEW_ID }, (tx) => tx.query<{ role: string | null }>('select public.app_role() as role'))
    expect(r.rows[0].role).toBe('admin')

    // App-created scanners are switched to 'scanner' right after creation and stay that way.
    await db.query(`update public.app_user_roles set role = 'scanner' where user_id = $1`, [NEW_ID])
    const s = await as(db, { userId: NEW_ID }, (tx) => tx.query<{ role: string | null }>('select public.app_role() as role'))
    expect(s.rows[0].role).toBe('scanner')
    await db.query(`delete from auth.users where id = $1`, [NEW_ID])
  })

  it('gives anonymous visitors no table access at all', async () => {
    for (const table of ['attendees', 'attendance', 'events', 'app_user_roles', 'active_event_state']) {
      await expect(as(db, 'anon', (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(
        /permission denied/,
      )
    }
  })
})

describe('registration upsert (Excel import)', () => {
  it('inserts and updates by qr_code without touching attendance', async () => {
    const before = await attendanceCount()
    const rows = [
      { qr_code: 'A-001', name: 'Juan D. Cruz', id_number: null, email: null, department: null, event_id: eventA },
      { qr_code: 'NEW-001', name: 'Pedro Reyes', id_number: '0042', email: null, department: 'BSIT', event_id: eventA },
    ]
    const r = await as(db, { userId: ADMIN_ID }, (tx) =>
      tx.query<{ r: Json }>('select public.admin_upsert_registrants($1::jsonb) as r', [JSON.stringify(rows)]),
    )
    expect(r.rows[0].r).toEqual({ inserted: 1, updated: 1 })
    expect(await attendanceCount()).toBe(before)

    const juan = await db.query<{ name: string; id_number: string; department: string; source: string }>(
      `select name, id_number, department, source from public.attendees where qr_code = 'A-001'`,
    )
    // Name updated; blank optional cells did not erase existing values; source kept.
    expect(juan.rows[0]).toEqual({ name: 'Juan D. Cruz', id_number: '20260001', department: 'BSIT', source: 'import' })

    // The existing check-in is still there and still reported as "already".
    expect((await checkIn('A-001')).status).toBe('already')
  })

  it('is admin-only', async () => {
    await expect(
      as(db, { userId: SCANNER_ID }, (tx) => tx.query(`select public.admin_upsert_registrants('[]'::jsonb)`)),
    ).rejects.toThrow(/forbidden/)
  })
})

describe('integration (Power Automate) upsert', () => {
  it('is idempotent for retries with the same QR code', async () => {
    const call = () =>
      as(db, 'service_role', (tx) =>
        tx.query<{ r: Json }>(
          `select public.integration_upsert_registrant('PA-777', 'Ana Lim', '00077', 'ana@example.test', 'BSCE', $1) as r`,
          [eventA],
        ),
      )
    const first = (await call()).rows[0].r
    const second = (await call()).rows[0].r
    expect(first).toMatchObject({ status: 'ok', created: true })
    expect(second).toMatchObject({ status: 'ok', created: false, id: first.id })
    const n = await db.query<{ n: number }>(`select count(*)::int as n from public.attendees where qr_code = 'PA-777'`)
    expect(n.rows[0].n).toBe(1)
  })

  it('reports unknown events and cannot be called from the browser', async () => {
    const r = await as(db, 'service_role', (tx) =>
      tx.query<{ r: Json }>(`select public.integration_upsert_registrant('PA-1', 'X', null, null, null, 999999) as r`),
    )
    expect(r.rows[0].r).toEqual({ status: 'unknown_event' })
    await expect(
      as(db, { userId: ADMIN_ID }, (tx) =>
        tx.query(`select public.integration_upsert_registrant('PA-2', 'X', null, null, null, null)`),
      ),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('admin statistics and corrections', () => {
  it('computes registered / present per the dashboard definitions', async () => {
    const r = await as(db, { userId: ADMIN_ID }, (tx) =>
      tx.query<{ r: { registered: number; present: number } }>('select public.event_stats($1) as r', [eventA]),
    )
    // Eligible for A: ANY-001 (any event), A-001, NEW-001, PA-777 => 4. Present: ANY-001, A-001.
    expect(r.rows[0].r).toEqual({ registered: 4, present: 2 })

    const roster = await as(db, { userId: ADMIN_ID }, (tx) =>
      tx.query<{ name: string; attendance_id: number | null }>('select * from public.event_roster($1)', [eventA]),
    )
    expect(roster.rows).toHaveLength(4)
    expect(roster.rows.filter((x) => x.attendance_id !== null)).toHaveLength(2)

    const counts = await as(db, { userId: ADMIN_ID }, (tx) =>
      tx.query<{ event_id: number; registrants: number }>('select * from public.event_registrant_counts() order by event_id'),
    )
    expect(counts.rows.map((c) => Number(c.registrants))).toEqual([4, 2])
  })

  it('supports audited manual check-in and undo', async () => {
    const pedro = await db.query<{ id: number }>(`select id from public.attendees where qr_code = 'NEW-001'`)
    const id = Number(pedro.rows[0].id)
    const mark = await as(db, { userId: ADMIN_ID }, (tx) =>
      tx.query<{ r: Json }>(`select public.admin_mark_present($1, $2, 'forgot phone') as r`, [eventA, id]),
    )
    expect(mark.rows[0].r.status).toBe('ok')
    const again = await as(db, { userId: ADMIN_ID }, (tx) =>
      tx.query<{ r: Json }>(`select public.admin_mark_present($1, $2) as r`, [eventA, id]),
    )
    expect(again.rows[0].r.status).toBe('already')

    const att = await db.query<{ id: number; check_in_method: string; recorded_by: string }>(
      `select id, check_in_method, recorded_by from public.attendance where attendee_id = $1`,
      [id],
    )
    expect(att.rows[0]).toMatchObject({ check_in_method: 'manual', recorded_by: ADMIN_ID })

    const undo = await as(db, { userId: ADMIN_ID }, (tx) =>
      tx.query<{ r: Json }>(`select public.admin_undo_check_in($1, 'scanned wrong person') as r`, [att.rows[0].id]),
    )
    expect(undo.rows[0].r).toEqual({ status: 'ok' })

    const audit = await db.query<{ action: string }>(
      `select action from public.attendance_corrections where attendee_id = $1 order by id`,
      [id],
    )
    expect(audit.rows.map((a) => a.action)).toEqual(['manual_check_in', 'undo_check_in'])
  })

  it('refuses to delete an event that still has registrants', async () => {
    await expect(
      as(db, { userId: ADMIN_ID }, (tx) => tx.query('delete from public.events where id = $1', [eventB])),
    ).rejects.toThrow(/foreign key/)
  })
})

describe('scanner attendance log (get_recent_check_ins)', () => {
  type LogRow = { attendance_id: number; name: string; scanned_at: string; total: number }
  const logAs = (userId: string, limit = 50) =>
    as(db, { userId }, (tx) => tx.query<LogRow>('select * from public.get_recent_check_ins($1)', [limit]))

  it('returns only name + time for the ACTIVE event, newest first, to scanner users', async () => {
    await as(db, { userId: ADMIN_ID }, (tx) => tx.query('select public.set_active_event($1)', [eventA]))
    // A second check-in for event A, a little later than any existing one.
    const later = await as(db, { userId: ADMIN_ID }, async (tx) => {
      const a = await tx.query<{ id: number }>(
        `insert into public.attendees (qr_code, name, event_id, source) values ('LOG-001', 'Log Person', $1, 'manual') returning id`,
        [eventA],
      )
      return a.rows[0].id
    })
    await db.query(
      `insert into public.attendance (event_id, attendee_id, check_in_method, scanned_at)
       values ($1, $2, 'manual', now() + interval '1 hour')`,
      [eventA, later],
    )

    const r = await logAs(SCANNER_ID)
    const expected = await db.query<{ n: number }>('select count(*)::int as n from public.attendance where event_id = $1', [eventA])
    expect(r.rows.length).toBe(expected.rows[0].n)
    expect(r.rows.length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(r.rows[0]).sort()).toEqual(['attendance_id', 'name', 'scanned_at', 'total'])
    expect(r.rows[0].name).toBe('Log Person')
    expect(Number(r.rows[0].total)).toBe(expected.rows[0].n)
    const times = r.rows.map((x) => new Date(x.scanned_at).getTime())
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    // Nothing from the inactive event.
    expect(r.rows.map((x) => x.name)).not.toContain('Maria Santos')
  })

  it('clamps the limit and still reports the full total', async () => {
    const r = await logAs(SCANNER_ID, 1)
    expect(r.rows).toHaveLength(1)
    expect(Number(r.rows[0].total)).toBeGreaterThanOrEqual(2)
    await expect(logAs(SCANNER_ID, 100000)).resolves.toBeTruthy()
  })

  it('refuses disabled, role-less and anonymous callers', async () => {
    await expect(logAs(DISABLED_SCANNER_ID)).rejects.toThrow(/forbidden/)
    await expect(logAs(NO_ROLE_ID)).rejects.toThrow(/forbidden/)
    await expect(as(db, 'anon', (tx) => tx.query('select * from public.get_recent_check_ins(10)'))).rejects.toThrow(
      /permission denied/,
    )
  })

  it('returns nothing when no event is active', async () => {
    await as(db, { userId: ADMIN_ID }, (tx) => tx.query('select public.set_active_event(null)'))
    const r = await logAs(SCANNER_ID)
    expect(r.rows).toHaveLength(0)
    await as(db, { userId: ADMIN_ID }, (tx) => tx.query('select public.set_active_event($1)', [eventA]))
  })
})
