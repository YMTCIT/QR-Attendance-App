import { supabase } from '../../lib/supabase'
import { friendlyDbError } from '../../lib/fetchAll'
import type { ActiveEvent, EventRow } from '../../types/database'

export interface EventWithCount extends EventRow {
  registrants: number
}

export interface EventInput {
  name: string
  date: string
  venue: string | null
}

export async function listEvents(): Promise<EventWithCount[]> {
  const [eventsRes, countsRes] = await Promise.all([
    supabase.from('events').select('*').order('date', { ascending: false }).order('id', { ascending: false }),
    supabase.rpc('event_registrant_counts'),
  ])
  if (eventsRes.error) throw new Error(friendlyDbError(eventsRes.error))
  if (countsRes.error) throw new Error(friendlyDbError(countsRes.error))
  const counts = new Map<number, number>(
    ((countsRes.data ?? []) as { event_id: number; registrants: number }[]).map((c) => [
      Number(c.event_id),
      Number(c.registrants),
    ]),
  )
  return ((eventsRes.data ?? []) as EventRow[]).map((e) => ({ ...e, registrants: counts.get(e.id) ?? 0 }))
}

export function validateEventInput(input: EventInput): string | null {
  if (!input.name.trim()) return 'Event name is required.'
  if (input.name.trim().length > 200) return 'Event name is too long.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return 'Event date is required.'
  if (input.venue && input.venue.length > 200) return 'Venue is too long.'
  return null
}

export async function createEvent(input: EventInput): Promise<void> {
  const { error } = await supabase
    .from('events')
    .insert({ name: input.name.trim(), date: input.date, venue: input.venue?.trim() || null })
  if (error) throw new Error(friendlyDbError(error))
}

export async function updateEvent(id: number, input: EventInput): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update({ name: input.name.trim(), date: input.date, venue: input.venue?.trim() || null })
    .eq('id', id)
  if (error) throw new Error(friendlyDbError(error))
}

/** Atomically activate one event (or pass null to deactivate all). */
export async function setActiveEvent(id: number | null): Promise<void> {
  const { error } = await supabase.rpc('set_active_event', { p_event_id: id })
  if (error) throw new Error(friendlyDbError(error))
}

export async function deleteEvent(id: number): Promise<void> {
  const { error } = await supabase.from('events').delete().eq('id', id)
  if (error) throw new Error(friendlyDbError(error))
}

/** Minimal active-event info, available to scanner users and admins. */
export async function fetchActiveEvent(): Promise<ActiveEvent | null> {
  const { data, error } = await supabase.rpc('get_active_event')
  if (error) throw new Error(friendlyDbError(error))
  const rows = (data ?? []) as ActiveEvent[]
  return rows.length > 0 ? { ...rows[0], id: Number(rows[0].id) } : null
}
