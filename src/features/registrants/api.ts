import { supabase } from '../../lib/supabase'
import { fetchAll, friendlyDbError } from '../../lib/fetchAll'
import type { AttendeeRow } from '../../types/database'
import type { RegistrantInput } from '../../lib/validation'

export type EventFilter = 'all' | 'any' | number

export async function listRegistrants(filter: EventFilter): Promise<AttendeeRow[]> {
  return fetchAll<AttendeeRow>(() => {
    let q = supabase.from('attendees').select('*').order('name').order('id')
    if (filter === 'any') q = q.is('event_id', null)
    else if (typeof filter === 'number') q = q.or(`event_id.eq.${filter},event_id.is.null`)
    return q
  })
}

export async function createRegistrant(input: RegistrantInput): Promise<void> {
  const { error } = await supabase.from('attendees').insert({ ...input, source: 'manual' })
  if (error) throw new Error(friendlyDbError(error))
}

export async function updateRegistrant(id: number, input: RegistrantInput): Promise<void> {
  const { error } = await supabase.from('attendees').update(input).eq('id', id)
  if (error) throw new Error(friendlyDbError(error))
}

/** Deleting a registrant also removes their check-ins (ON DELETE CASCADE). */
export async function deleteRegistrant(id: number): Promise<void> {
  const { error } = await supabase.from('attendees').delete().eq('id', id)
  if (error) throw new Error(friendlyDbError(error))
}

export async function countCheckIns(attendeeId: number): Promise<number> {
  const { count, error } = await supabase
    .from('attendance')
    .select('id', { count: 'exact', head: true })
    .eq('attendee_id', attendeeId)
  if (error) throw new Error(friendlyDbError(error))
  return count ?? 0
}
