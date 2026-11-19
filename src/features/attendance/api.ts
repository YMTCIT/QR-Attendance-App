import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { fetchAll, friendlyDbError } from '../../lib/fetchAll'
import { CHECK_IN_TIMEOUT_MS } from '../../config'
import type { ScanOutcome } from '../../types/attendance'
import type { CheckInMethod, EventStats, RosterRow } from '../../types/database'
import { parseCheckInResponse } from './checkInResult'

/**
 * Sends ONLY the decoded QR text to the check-in Edge Function. No camera
 * frames ever leave the device. Success is reported only when the server
 * confirms it with a well-formed response.
 */
export async function submitCheckIn(qrCode: string): Promise<ScanOutcome> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'network_error', detail: 'offline' }
  }
  try {
    const { data, error } = await supabase.functions.invoke('check-in', {
      body: { qr_code: qrCode },
      timeout: CHECK_IN_TIMEOUT_MS,
    })
    if (error) {
      if (error instanceof FunctionsHttpError) {
        const status = (error.context as Response | undefined)?.status
        if (status === 401 || status === 403) return { status: 'unauthorized' }
      }
      return { status: 'network_error', detail: error.message }
    }
    const parsed = parseCheckInResponse(data)
    return parsed ?? { status: 'network_error', detail: 'unexpected response' }
  } catch (e) {
    return { status: 'network_error', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** One row of the scanner screen's attendance log (name + time only). */
export interface CheckInLogEntry {
  /** Stable identity used to merge local and server rows: name + timestamp. */
  key: string
  name: string
  scanned_at: string
}

export function checkInLogKey(name: string, scannedAt: string): string {
  const ms = Date.parse(scannedAt)
  return `${name}|${Number.isNaN(ms) ? scannedAt : ms}`
}

/** Newest-first check-ins for the ACTIVE event (staff only; see migration 006). */
export async function fetchCheckInLog(limit: number): Promise<{ entries: CheckInLogEntry[]; total: number }> {
  const { data, error } = await supabase.rpc('get_recent_check_ins', { p_limit: limit })
  if (error) throw new Error(friendlyDbError(error))
  const rows = (data ?? []) as { name: string; scanned_at: string; total: number | string }[]
  return {
    entries: rows.map((r) => ({ key: checkInLogKey(r.name, r.scanned_at), name: r.name, scanned_at: r.scanned_at })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  }
}

export async function fetchEventStats(eventId: number): Promise<EventStats> {
  const { data, error } = await supabase.rpc('event_stats', { p_event_id: eventId })
  if (error) throw new Error(friendlyDbError(error))
  const d = (data ?? {}) as { registered?: number; present?: number }
  return { registered: Number(d.registered ?? 0), present: Number(d.present ?? 0) }
}

export async function fetchRoster(eventId: number): Promise<RosterRow[]> {
  return fetchAll<RosterRow>(() => supabase.rpc('event_roster', { p_event_id: eventId }))
}

export interface RecentCheckIn {
  id: number
  scanned_at: string
  check_in_method: CheckInMethod
  name: string
  id_number: string | null
  department: string | null
}

export async function fetchRecentCheckIns(eventId: number, limit = 10): Promise<RecentCheckIn[]> {
  const { data, error } = await supabase
    .from('attendance')
    .select('id, scanned_at, check_in_method, attendees(name, id_number, department)')
    .eq('event_id', eventId)
    .order('scanned_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(friendlyDbError(error))
  type Row = {
    id: number
    scanned_at: string
    check_in_method: CheckInMethod
    attendees: { name: string; id_number: string | null; department: string | null } | null
  }
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    scanned_at: r.scanned_at,
    check_in_method: r.check_in_method,
    name: r.attendees?.name ?? '(deleted registrant)',
    id_number: r.attendees?.id_number ?? null,
    department: r.attendees?.department ?? null,
  }))
}

export type ManualResult = { status: 'ok' | 'already' | 'wrong_event'; name?: string; scanned_at?: string }

export async function markPresent(eventId: number, attendeeId: number, reason: string | null): Promise<ManualResult> {
  const { data, error } = await supabase.rpc('admin_mark_present', {
    p_event_id: eventId,
    p_attendee_id: attendeeId,
    p_reason: reason,
  })
  if (error) throw new Error(friendlyDbError(error))
  return data as ManualResult
}

export async function undoCheckIn(attendanceId: number, reason: string | null): Promise<'ok' | 'not_found'> {
  const { data, error } = await supabase.rpc('admin_undo_check_in', {
    p_attendance_id: attendanceId,
    p_reason: reason,
  })
  if (error) throw new Error(friendlyDbError(error))
  return (data as { status: 'ok' | 'not_found' }).status
}
