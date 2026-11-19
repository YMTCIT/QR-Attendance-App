import { supabase } from '../../lib/supabase'
import { friendlyDbError } from '../../lib/fetchAll'
import { IMPORT_BATCH_SIZE } from '../../config'
import type { ValidRow } from './validateRows'
import { toBatches } from './validateRows'

export interface ExistingRegistration {
  qr_code: string
  name: string
  event_id: number | null
}

/** Look up which QR codes are already registered (for the event-change warning). */
export async function lookupExisting(codes: string[]): Promise<Map<string, ExistingRegistration>> {
  const out = new Map<string, ExistingRegistration>()
  for (const batch of toBatches(codes, 2000)) {
    const { data, error } = await supabase.rpc('admin_lookup_registrants', { p_codes: batch })
    if (error) throw new Error(friendlyDbError(error))
    for (const r of (data ?? []) as ExistingRegistration[]) {
      out.set(r.qr_code, { ...r, event_id: r.event_id === null ? null : Number(r.event_id) })
    }
  }
  return out
}

export interface ImportProgress {
  processed: number
  total: number
}

export interface ImportOutcome {
  inserted: number
  updated: number
  failed: number
  failures: { fromRow: number; toRow: number; message: string }[]
}

/**
 * Upserts registrations in batches. Each batch is its own transaction, so a
 * failing batch is reported precisely while earlier batches stay committed.
 * This NEVER writes attendance.
 */
export async function importRegistrations(
  rows: ValidRow[],
  onProgress: (p: ImportProgress) => void,
  batchSize = IMPORT_BATCH_SIZE,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { inserted: 0, updated: 0, failed: 0, failures: [] }
  let processed = 0
  onProgress({ processed, total: rows.length })

  for (const batch of toBatches(rows, batchSize)) {
    const payload = batch.map((r) => ({
      qr_code: r.qr_code,
      name: r.name,
      id_number: r.id_number,
      email: r.email,
      department: r.department,
      event_id: r.event_id,
    }))
    const { data, error } = await supabase.rpc('admin_upsert_registrants', { p_rows: payload, p_source: 'import' })
    if (error) {
      outcome.failed += batch.length
      outcome.failures.push({
        fromRow: batch[0].rowNumber,
        toRow: batch[batch.length - 1].rowNumber,
        message: friendlyDbError(error),
      })
    } else {
      const d = data as { inserted: number; updated: number }
      outcome.inserted += Number(d.inserted)
      outcome.updated += Number(d.updated)
    }
    processed += batch.length
    onProgress({ processed, total: rows.length })
  }
  return outcome
}

export async function writeImportLog(log: {
  userId: string
  eventId: number | null
  filename: string
  total: number
  successful: number
  skipped: number
  errors: number
}): Promise<void> {
  const { error } = await supabase.from('import_logs').insert({
    imported_by: log.userId,
    event_id: log.eventId,
    filename: log.filename.slice(0, 255),
    total_rows: log.total,
    successful_rows: log.successful,
    skipped_rows: log.skipped,
    error_rows: log.errors,
  })
  if (error) throw new Error(friendlyDbError(error))
}
