import type { CheckInResponse, ScanOutcome } from '../../types/attendance'
import { formatTime } from '../../lib/format'

/**
 * Validates an Edge Function response. Anything that is not exactly one of the
 * documented shapes returns null, which the caller treats as a connection
 * error — so a malformed response can NEVER be shown as a successful check-in.
 */
export function parseCheckInResponse(body: unknown): CheckInResponse | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v))

  switch (b.status) {
    case 'ok':
      if (isStr(b.name) && isTime(b.scanned_at)) {
        return {
          status: 'ok',
          name: b.name,
          event_name: isStr(b.event_name) ? b.event_name : '',
          scanned_at: b.scanned_at,
        }
      }
      return null
    case 'already':
      if (isStr(b.name) && isTime(b.scanned_at)) {
        return {
          status: 'already',
          name: b.name,
          scanned_at: b.scanned_at,
          ...(isStr(b.event_name) ? { event_name: b.event_name } : {}),
        }
      }
      return null
    case 'invalid':
    case 'wrong_event':
    case 'no_event':
      return { status: b.status }
    default:
      return null
  }
}

export type OverlayTone = 'success' | 'warning' | 'error'

export interface OverlayContent {
  tone: OverlayTone
  kicker?: string
  title: string
  name?: string
  lines: string[]
}

/** Maps a scan outcome to the text shown on the full-screen overlay. */
export function describeOutcome(outcome: ScanOutcome, fallbackEventName?: string): OverlayContent {
  switch (outcome.status) {
    case 'ok':
      return {
        tone: 'success',
        kicker: 'CHECK-IN SUCCESSFUL',
        title: 'WELCOME!',
        name: outcome.name,
        lines: ['Attendance Recorded', outcome.event_name || fallbackEventName || ''].filter(Boolean),
      }
    case 'already':
      return {
        tone: 'warning',
        title: 'ALREADY CHECKED IN',
        name: outcome.name,
        lines: ['This attendee has already attended this event.', `Checked in at: ${formatTime(outcome.scanned_at)}`],
      }
    case 'invalid':
      return { tone: 'error', title: 'INVALID QR CODE', lines: ['This QR code is not registered.'] }
    case 'wrong_event':
      return {
        tone: 'error',
        title: 'NOT REGISTERED FOR THIS EVENT',
        lines: ['This QR code is not registered for the active event.'],
      }
    case 'no_event':
      return { tone: 'error', title: 'NO ACTIVE EVENT', lines: ['Please contact the administrator.'] }
    case 'unauthorized':
      return {
        tone: 'error',
        title: 'SIGN-IN REQUIRED',
        lines: ['Your session has expired or this account is disabled.', 'Please sign in again.'],
      }
    case 'network_error':
      return {
        tone: 'error',
        title: 'CONNECTION ERROR',
        lines: ['Attendance could not be confirmed.', 'Please try again.'],
      }
  }
}

/** Overlay duration for an outcome (success is shorter so the line keeps moving). */
export function overlayDurationFor(outcome: ScanOutcome, successMs: number, errorMs: number): number {
  return outcome.status === 'ok' ? successMs : errorMs
}
