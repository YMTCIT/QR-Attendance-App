import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { checkInLogKey, fetchCheckInLog, type CheckInLogEntry } from '../features/attendance/api'
import { CHECK_IN_LOG_LIMIT, CHECK_IN_LOG_REFRESH_MS } from '../config'

export interface CheckInLog {
  entries: CheckInLogEntry[]
  /** Total check-ins for the active event (may exceed entries.length). */
  total: number
  loading: boolean
  /** Set when the last sync failed; the list shown may be out of date. */
  stale: boolean
  /** Put a just-confirmed check-in at the top immediately. Returns its key. */
  addLocal: (name: string, scannedAt: string) => string
}

interface ServerLog {
  eventId: number
  entries: CheckInLogEntry[]
  total: number
  stale: boolean
}

interface LocalEntry {
  eventId: number | null
  entry: CheckInLogEntry
  addedAt: number
}

/** A local check-in is shown until the server list includes it, at most this long. */
const PENDING_MS = 30_000

const newestFirst = (a: CheckInLogEntry, b: CheckInLogEntry) => Date.parse(b.scanned_at) - Date.parse(a.scanned_at)

/**
 * The scanner screen's attendance log for the active event, newest first.
 *
 * - Loads on mount and whenever the active event changes.
 * - Re-syncs every CHECK_IN_LOG_REFRESH_MS (and when the page becomes visible)
 *   to pick up other tablets and manual check-ins by an administrator.
 * - A check-in confirmed on THIS tablet is added instantly (addLocal), then a
 *   sync runs. It can never flicker away: syncs that started before the add
 *   are discarded, and until the server's list includes it (max PENDING_MS)
 *   it is merged into what is shown.
 */
export function useCheckInLog(eventId: number | null): CheckInLog {
  const [server, setServer] = useState<ServerLog | null>(null)
  const [local, setLocal] = useState<LocalEntry[]>([])

  const mountedRef = useRef(true)
  const currentEventRef = useRef(eventId)
  /** When the last local check-in was added; older in-flight syncs are discarded. */
  const lastLocalAtRef = useRef(Number.NEGATIVE_INFINITY)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    currentEventRef.current = eventId
  }, [eventId])

  const sync = useCallback(async (forEvent: number | null) => {
    if (forEvent === null) return
    const startedAt = performance.now()
    try {
      const result = await fetchCheckInLog(CHECK_IN_LOG_LIMIT)
      if (!mountedRef.current || currentEventRef.current !== forEvent) return
      // Started before the latest local check-in: a newer sync is already queued.
      if (startedAt < lastLocalAtRef.current) return

      setServer({ eventId: forEvent, entries: result.entries, total: result.total, stale: false })
      const confirmed = new Set(result.entries.map((e) => e.key))
      const now = performance.now()
      setLocal((prev) =>
        prev.filter((l) => l.eventId === forEvent && !confirmed.has(l.entry.key) && now - l.addedAt <= PENDING_MS),
      )
    } catch {
      if (!mountedRef.current || currentEventRef.current !== forEvent) return
      setServer((prev) =>
        prev && prev.eventId === forEvent
          ? { ...prev, stale: true }
          : { eventId: forEvent, entries: [], total: 0, stale: true },
      )
    }
  }, [])

  // Load for the current event, then keep polling.
  useEffect(() => {
    const first = window.setTimeout(() => void sync(eventId), 0)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void sync(eventId)
    }, CHECK_IN_LOG_REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void sync(eventId)
    }
    const onOnline = () => void sync(eventId)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
    }
  }, [eventId, sync])

  const addLocal = useCallback(
    (name: string, scannedAt: string) => {
      const key = checkInLogKey(name, scannedAt)
      const forEvent = currentEventRef.current
      const now = performance.now()
      lastLocalAtRef.current = now
      setLocal((prev) =>
        prev.some((l) => l.entry.key === key)
          ? prev
          : [{ eventId: forEvent, entry: { key, name, scanned_at: scannedAt }, addedAt: now }, ...prev],
      )
      // Confirm against the server (also picks up anything from other tablets).
      window.setTimeout(() => void sync(forEvent), 0)
      return key
    },
    [sync],
  )

  const view = useMemo(() => {
    const current = server && server.eventId === eventId ? server : null
    const serverKeys = new Set(current?.entries.map((e) => e.key) ?? [])
    const extra = local.filter((l) => l.eventId === eventId && !serverKeys.has(l.entry.key)).map((l) => l.entry)
    return {
      entries: [...extra, ...(current?.entries ?? [])].sort(newestFirst).slice(0, CHECK_IN_LOG_LIMIT),
      total: (current?.total ?? 0) + extra.length,
      loading: eventId !== null && current === null,
      stale: current?.stale ?? false,
    }
  }, [server, local, eventId])

  return { ...view, addLocal }
}
