import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { RealtimeStatus } from './useActiveEvent'

export interface DataVersions {
  attendance: number
  attendees: number
  events: number
}

type Table = keyof DataVersions

/**
 * Admin dashboard realtime. Subscribes to attendance, attendees and events
 * (RLS ensures only admins receive rows) and bumps a version counter per
 * table. Panels refetch when their counter changes.
 *
 *  - Changes are debounced, so a 1,000-row import triggers a few refreshes,
 *    not a thousand.
 *  - INSERT / UPDATE / DELETE are all handled by refetching, which is also
 *    correct for changes that cannot be filtered reliably (e.g. deletes).
 *  - After a reconnect, everything is refetched to recover missed messages.
 *  - The status is reported honestly: "connected" only after SUBSCRIBED.
 */
export function useRealtimeAttendance(enabled = true, debounceMs = 600) {
  const [status, setStatus] = useState<RealtimeStatus>('connecting')
  const [versions, setVersions] = useState<DataVersions>({ attendance: 0, attendees: 0, events: 0 })

  useEffect(() => {
    if (!enabled) return
    const pending = new Set<Table>()
    let timer: number | null = null

    const flush = () => {
      timer = null
      const tables = [...pending]
      pending.clear()
      if (tables.length === 0) return
      setVersions((v) => {
        const next = { ...v }
        for (const t of tables) next[t] = v[t] + 1
        return next
      })
    }

    const bump = (...tables: Table[]) => {
      tables.forEach((t) => pending.add(t))
      if (timer === null) timer = window.setTimeout(flush, debounceMs)
    }

    let hasSubscribedBefore = false
    const unique = Math.random().toString(36).slice(2)
    const channel = supabase
      .channel(`admin-dashboard-${unique}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, () => bump('attendance'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendees' }, () => bump('attendees'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => bump('events'))
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          setStatus('connected')
          if (hasSubscribedBefore) bump('attendance', 'attendees', 'events')
          hasSubscribedBefore = true
        } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') {
          setStatus('disconnected')
        }
      })

    const onVisible = () => {
      if (document.visibilityState === 'visible') bump('attendance', 'attendees', 'events')
    }
    const onOnline = () => bump('attendance', 'attendees', 'events')
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      pending.clear()
      void supabase.removeChannel(channel)
    }
  }, [enabled, debounceMs])

  return { status, versions }
}
