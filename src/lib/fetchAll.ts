/**
 * Supabase's API returns at most 1000 rows per request by default. This pages
 * through a query with .range() until everything is loaded.
 */
interface RangeQuery<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

export async function fetchAll<T>(makeQuery: () => RangeQuery<T>, pageSize = 1000, maxRows = 100_000): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < pageSize) break
  }
  return all
}

/** Turn Supabase/PostgREST errors into short, user-facing messages. */
export function friendlyDbError(error: unknown): string {
  const e = error as { code?: string; message?: string } | null
  const code = e?.code
  const msg = e?.message ?? String(error)
  if (code === '23505' || /duplicate key/i.test(msg)) {
    if (/qr_code/i.test(msg)) return 'That QR code is already registered.'
    if (/events_single_active/i.test(msg)) return 'Another event is already active.'
    return 'That record already exists.'
  }
  if (code === '23503' || /foreign key/i.test(msg)) {
    return 'This event still has registrants assigned to it. Move or delete those registrants first.'
  }
  if (code === '42501' || /forbidden|permission denied|row-level security/i.test(msg)) {
    return 'You do not have permission to do that.'
  }
  if (code === '23514' || /check constraint/i.test(msg)) return 'Some values are invalid or too long.'
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Connection problem. Please check the network and try again.'
  return msg || 'Something went wrong.'
}
