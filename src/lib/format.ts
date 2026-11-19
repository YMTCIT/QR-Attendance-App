import { DISPLAY_TIMEZONE } from '../config'

const timeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: DISPLAY_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const dateTimeFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: DISPLAY_TIMEZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const dateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'UTC', // event dates are calendar dates (YYYY-MM-DD) — don't shift them
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
})

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "8:35 AM" in Asia/Manila. */
export function formatTime(value: string | Date | null | undefined): string {
  const d = toDate(value)
  return d ? timeFmt.format(d).toUpperCase() : '—'
}

/** "Dec 1, 2026, 8:35 AM" in Asia/Manila. */
export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value)
  return d ? dateTimeFmt.format(d) : '—'
}

/** Formats a DATE column ("2026-12-01"). */
export function formatEventDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? value : dateFmt.format(d)
}

export function attendanceRate(present: number, registered: number): number {
  if (!registered || registered <= 0) return 0
  return Math.round((present / registered) * 1000) / 10
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-PH').format(value)
}

/** Abbreviate a QR value for tables: "ABCDEF…7890". */
export function abbreviate(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}
