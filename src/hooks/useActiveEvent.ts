import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchActiveEvent } from '../features/events/api'
import { ACTIVE_EVENT_POLL_MS } from '../config'
import type { ActiveEvent } from '../types/database'

export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected'

/**
 * Tracks the active event for the scanner. Uses Realtime on the tiny
 * active_event_state table (the only table scanner users may subscribe to),
 * plus a 30-second poll and a refetch whenever the page becomes visible or
 * the network returns, in case realtime messages were missed. The server
 * still decides the active event authoritatively on every check-in.
 */
export function useActiveEvent() {
  const [event, setEvent] = useState<ActiveEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [realtime, setRealtime] = useState<RealtimeStatus>('connecting')
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const mounted = useRef(true)

  /** Fetch the active event; concurrent calls share one request. */
  const load = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current
    const request = fetchActiveEvent()
      .then((next) => {
        if (!mounted.current) return
        setEvent(next)
        setError(null)
        setLastChecked(new Date())
      })
      .catch((e: unknown) => {
        if (mounted.current) setError(e instanceof Error ? e.message : 'Could not load the active event.')
      })
      .finally(() => {
        inFlight.current = null
        if (mounted.current) setLoading(false)
      })
    inFlight.current = request
    return request
  }, [])

  useEffect(() => {
    mounted.current = true
    const trigger = () => {
      void load()
    }
    const initial = window.setTimeout(trigger, 0)

    let hasSubscribedBefore = false
    const channel = supabase
      .channel(`scanner-active-event-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'active_event_state' }, trigger)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtime('connected')
          // After a reconnect, catch up on anything we missed.
          if (hasSubscribedBefore) trigger()
          hasSubscribedBefore = true
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtime('disconnected')
        }
      })

    const poll = window.setInterval(trigger, ACTIVE_EVENT_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') trigger()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', trigger)

    return () => {
      mounted.current = false
      window.clearTimeout(initial)
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', trigger)
      void supabase.removeChannel(channel)
    }
  }, [load])

  return { event, loading, error, realtime, lastChecked, refresh: load }
}
