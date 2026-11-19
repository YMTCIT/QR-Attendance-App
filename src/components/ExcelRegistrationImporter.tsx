import { useMemo, useState } from 'react'
import { Modal } from './Modal'
import { EventSelector } from './EventSelector'
import { readSpreadsheet, SpreadsheetError, type Workbook } from '../lib/excel'
import {
  IMPORT_FIELDS,
  autoDetectMapping,
  findHeaderRowIndex,
  missingRequired,
  type ColumnMapping,
  type ImportFieldKey,
} from '../features/imports/columnMapping'
import { validateImportRows, type ValidationResult } from '../features/imports/validateRows'
import {
  importRegistrations,
  lookupExisting,
  writeImportLog,
  type ImportOutcome,
  type ImportProgress,
} from '../features/imports/api'
import { formatNumber } from '../lib/format'
import { IMPORT_MAX_FILE_BYTES } from '../config'
import type { EventRow } from '../types/database'

/**
 * Registration import ONLY. Spreadsheet rows become registrations (attendees).
 * Nothing in this flow reads Present/Absent columns or writes attendance.
 */

type Step = 'choose' | 'map' | 'review' | 'importing' | 'done'

interface Props {
  events: EventRow[]
  defaultEventId: number | null
  userId: string
  onClose: () => void
  onImported: () => void
}

interface EventChange {
  qr: string
  name: string
  from: number | null
  to: number | null
}

export function ExcelRegistrationImporter({ events, defaultEventId, userId, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>('choose')
  const [eventId, setEventId] = useState<number | null>(defaultEventId)
  const [file, setFile] = useState<File | null>(null)
  const [workbook, setWorkbook] = useState<Workbook | null>(null)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [existingCount, setExistingCount] = useState(0)
  const [eventChanges, setEventChanges] = useState<EventChange[]>([])
  const [acknowledgeChanges, setAcknowledgeChanges] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [logError, setLogError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const eventName = (id: number | null) =>
    id === null ? 'Any event' : (events.find((e) => e.id === id)?.name ?? `Event #${id}`)

  const sheet = workbook?.sheets[sheetIndex] ?? null
  const headerIdx = sheet ? findHeaderRowIndex(sheet.rows) : -1
  const headers = useMemo(
    () => (sheet && headerIdx >= 0 ? sheet.rows[headerIdx].map((c, i) => c.text || `Column ${i + 1}`) : []),
    [sheet, headerIdx],
  )
  const dataRows = useMemo(() => (sheet && headerIdx >= 0 ? sheet.rows.slice(headerIdx + 1) : []), [sheet, headerIdx])

  const selectSheet = (wb: Workbook, index: number) => {
    setSheetIndex(index)
    const s = wb.sheets[index]
    const h = findHeaderRowIndex(s.rows)
    setMapping(h >= 0 ? autoDetectMapping(s.rows[h].map((c) => c.text)) : null)
  }

  const onFile = async (f: File | null) => {
    setError(null)
    setFile(f)
    setWorkbook(null)
    setMapping(null)
    if (!f) return
    setBusy(true)
    try {
      const wb = await readSpreadsheet(f)
      setWorkbook(wb)
      const firstWithData = Math.max(
        0,
        wb.sheets.findIndex((s) => s.rows.length > 1),
      )
      selectSheet(wb, firstWithData)
    } catch (e) {
      setError(e instanceof SpreadsheetError ? e.message : 'The file could not be read.')
    } finally {
      setBusy(false)
    }
  }

  const setField = (key: ImportFieldKey, value: string) => {
    if (!mapping) return
    const idx = value === '' ? null : Number(value)
    const next = { ...mapping }
    // A column can feed only one field.
    if (idx !== null) {
      for (const f of IMPORT_FIELDS) if (next[f.key] === idx) next[f.key] = null
    }
    next[key] = idx
    setMapping(next)
  }

  const runValidation = async () => {
    if (!mapping || !sheet) return
    setError(null)
    setBusy(true)
    try {
      const result = validateImportRows({
        dataRows,
        firstRowNumber: headerIdx + 2,
        mapping,
        defaultEventId: eventId,
        events: events.map((e) => ({ id: e.id, name: e.name })),
      })
      setValidation(result)
      const existing = await lookupExisting(result.valid.map((r) => r.qr_code))
      setExistingCount(existing.size)
      const changes: EventChange[] = []
      for (const row of result.valid) {
        const prev = existing.get(row.qr_code)
        if (prev && prev.event_id !== row.event_id) {
          changes.push({ qr: row.qr_code, name: prev.name, from: prev.event_id, to: row.event_id })
        }
      }
      setEventChanges(changes)
      setAcknowledgeChanges(false)
      setStep('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Validation failed.')
    } finally {
      setBusy(false)
    }
  }

  const runImport = async () => {
    if (!validation || !file) return
    setStep('importing')
    setError(null)
    const result = await importRegistrations(validation.valid, setProgress)
    setOutcome(result)
    try {
      await writeImportLog({
        userId,
        eventId,
        filename: file.name,
        total: validation.totalDataRows,
        successful: result.inserted + result.updated,
        skipped: validation.skippedBlank,
        errors: validation.errors.length + result.failed,
      })
    } catch (e) {
      setLogError(e instanceof Error ? e.message : 'Import log could not be saved.')
    }
    setStep('done')
    onImported()
  }

  const missing = mapping ? missingRequired(mapping) : []
  const importing = step === 'importing'

  return (
    <Modal title="Import registrations (Excel / CSV)" onClose={onClose} wide locked={importing}>
      <p className="muted">
        Imports or updates <strong>registrations only</strong>. Importing never marks anyone present and never removes
        existing check-ins. Rows are matched on the QR code value.
      </p>

      {step === 'choose' || step === 'map' ? (
        <>
          <div className="form-grid">
            <EventSelector
              id="import-event"
              events={events}
              value={eventId}
              onChange={setEventId}
              label="Register attendees for"
              emptyOption="Any event (eligible for every event)"
            />
            <label className="field">
              <span>Spreadsheet file (.xlsx or .csv, max {IMPORT_MAX_FILE_BYTES / 1024 / 1024} MB)</span>
              <input
                type="file"
                accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
                disabled={busy}
              />
            </label>
          </div>

          {busy && <p className="muted">Reading file…</p>}

          {workbook && sheet && (
            <>
              <div className="import-summary">
                <span>
                  <strong>{file?.name}</strong>
                </span>
                <span>{formatNumber(Math.max(0, dataRows.length))} data rows detected</span>
                {workbook.sheets.length > 1 && (
                  <label className="field field--inline">
                    <span>Worksheet</span>
                    <select value={sheetIndex} onChange={(e) => selectSheet(workbook, Number(e.target.value))}>
                      {workbook.sheets.map((s, i) => (
                        <option key={i} value={i}>
                          {s.name} ({Math.max(0, s.rows.length - 1)} rows)
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              {headerIdx < 0 ? (
                <p className="form-error">This worksheet is empty.</p>
              ) : (
                <>
                  <h3 className="section-title">Preview (first 5 rows)</h3>
                  <div className="table-wrap">
                    <table className="data-table data-table--compact">
                      <thead>
                        <tr>
                          {headers.map((h, i) => (
                            <th key={i}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {dataRows.slice(0, 5).map((row, r) => (
                          <tr key={r}>
                            {headers.map((_, c) => (
                              <td key={c}>{row[c]?.text ?? ''}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <h3 className="section-title">Column mapping</h3>
                  <p className="muted small">Detected automatically — change any field if it is wrong.</p>
                  <div className="mapping-grid">
                    {IMPORT_FIELDS.map((f) => (
                      <label key={f.key} className="field">
                        <span>
                          {f.label}
                          {f.required && <span className="required"> *</span>}
                        </span>
                        <select
                          value={mapping?.[f.key] ?? ''}
                          onChange={(e) => setField(f.key, e.target.value)}
                          className={f.required && mapping?.[f.key] === null ? 'input--error' : undefined}
                        >
                          <option value="">— not in file —</option>
                          {headers.map((h, i) => (
                            <option key={i} value={i}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  {missing.length > 0 && (
                    <p className="form-error">
                      Map the required column(s):{' '}
                      {missing.map((k) => IMPORT_FIELDS.find((f) => f.key === k)?.label).join(', ')}
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!workbook || !mapping || missing.length > 0 || headerIdx < 0 || busy}
              onClick={() => void runValidation()}
            >
              {busy ? 'Checking…' : 'Validate rows'}
            </button>
          </div>
        </>
      ) : null}

      {step === 'review' && validation && (
        <>
          <div className="stat-row">
            <div className="mini-stat mini-stat--ok">
              <span>{formatNumber(validation.valid.length)}</span>
              <small>valid rows</small>
            </div>
            <div className="mini-stat">
              <span>{formatNumber(validation.valid.length - existingCount)}</span>
              <small>new</small>
            </div>
            <div className="mini-stat">
              <span>{formatNumber(existingCount)}</span>
              <small>will update</small>
            </div>
            <div className="mini-stat mini-stat--bad">
              <span>{formatNumber(validation.errors.length)}</span>
              <small>rows with errors (skipped)</small>
            </div>
            <div className="mini-stat">
              <span>{formatNumber(validation.skippedBlank)}</span>
              <small>blank rows ignored</small>
            </div>
          </div>
          <p className="muted small">
            Target event: <strong>{eventName(eventId)}</strong> (rows with an Event column value use that event instead).
          </p>

          {validation.warnings.map((w, i) => (
            <p key={i} className="notice notice--warn">
              {w}
            </p>
          ))}

          {eventChanges.length > 0 && (
            <div className="notice notice--warn">
              <p>
                <strong>{eventChanges.length}</strong> existing registrant(s) will be moved to a different event. Their
                past check-ins are kept, but they may no longer be eligible for their previous event.
              </p>
              <ul className="compact-list">
                {eventChanges.slice(0, 8).map((c) => (
                  <li key={c.qr}>
                    {c.name}: {eventName(c.from)} → {eventName(c.to)}
                  </li>
                ))}
                {eventChanges.length > 8 && <li>…and {eventChanges.length - 8} more</li>}
              </ul>
              <label className="checkbox">
                <input type="checkbox" checked={acknowledgeChanges} onChange={(e) => setAcknowledgeChanges(e.target.checked)} />
                I understand — change their event.
              </label>
            </div>
          )}

          {validation.errors.length > 0 && (
            <details className="error-details" open={validation.errors.length <= 10}>
              <summary>Rows with errors ({validation.errors.length}) — these will be skipped</summary>
              <ul className="compact-list">
                {validation.errors.slice(0, 200).map((e) => (
                  <li key={e.rowNumber}>
                    Row {e.rowNumber}: {e.messages.join('; ')}
                  </li>
                ))}
                {validation.errors.length > 200 && <li>…and {validation.errors.length - 200} more</li>}
              </ul>
            </details>
          )}

          {error && <p className="form-error">{error}</p>}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setStep('map')}>
              Back
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={validation.valid.length === 0 || (eventChanges.length > 0 && !acknowledgeChanges)}
              onClick={() => void runImport()}
            >
              Import {formatNumber(validation.valid.length)} registration(s)
            </button>
          </div>
        </>
      )}

      {step === 'importing' && progress && (
        <div className="import-progress" role="status" aria-live="polite">
          <p>
            Importing {formatNumber(progress.processed)} / {formatNumber(progress.total)}…
          </p>
          <progress max={progress.total || 1} value={progress.processed} />
          <p className="muted small">Please keep this window open.</p>
        </div>
      )}

      {step === 'done' && outcome && validation && (
        <>
          <div className="stat-row">
            <div className="mini-stat mini-stat--ok">
              <span>{formatNumber(outcome.inserted)}</span>
              <small>imported (new)</small>
            </div>
            <div className="mini-stat mini-stat--ok">
              <span>{formatNumber(outcome.updated)}</span>
              <small>updated</small>
            </div>
            <div className="mini-stat">
              <span>{formatNumber(validation.errors.length + validation.skippedBlank)}</span>
              <small>skipped</small>
            </div>
            <div className="mini-stat mini-stat--bad">
              <span>{formatNumber(outcome.failed)}</span>
              <small>failed</small>
            </div>
          </div>
          {outcome.failures.length > 0 && (
            <div className="notice notice--error">
              <p>Some batches failed (earlier batches were saved):</p>
              <ul className="compact-list">
                {outcome.failures.map((f, i) => (
                  <li key={i}>
                    Rows {f.fromRow}–{f.toRow}: {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {logError && <p className="notice notice--warn">Import finished, but the import log was not saved: {logError}</p>}
          <p className="muted small">No attendance records were created or changed by this import.</p>
          <div className="modal__actions">
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
