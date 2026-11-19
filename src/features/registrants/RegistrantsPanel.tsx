import { useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { ExcelRegistrationImporter } from '../../components/ExcelRegistrationImporter'
import { LoadingState } from '../../components/LoadingState'
import { Modal } from '../../components/Modal'
import { downloadCsv } from '../../lib/csv'
import { abbreviate, formatDateTime, formatNumber } from '../../lib/format'
import { hasErrors, validateRegistrant, type FieldErrors } from '../../lib/validation'
import type { AttendeeRow, EventRow, RegistrationSource } from '../../types/database'
import type { DataVersions } from '../../hooks/useRealtimeAttendance'
import {
  countCheckIns,
  createRegistrant,
  deleteRegistrant,
  listRegistrants,
  updateRegistrant,
  type EventFilter,
} from './api'
import { DeleteEventRegistrantsDialog } from './DeleteEventRegistrantsDialog'

const PAGE = 300
const SOURCE_LABEL: Record<RegistrationSource, string> = {
  power_automate: 'Microsoft Forms',
  import: 'Excel import',
  manual: 'Manual',
}

interface Props {
  events: EventRow[]
  versions: DataVersions
  userId: string
  defaultEventId: number | null
}

export function RegistrantsPanel({ events, versions, userId, defaultEventId }: Props) {
  const [filter, setFilter] = useState<EventFilter>('all')
  const [rows, setRows] = useState<AttendeeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [manualRefresh, setManualRefresh] = useState(0)
  const [editing, setEditing] = useState<AttendeeRow | 'new' | null>(null)
  const [deleting, setDeleting] = useState<{ row: AttendeeRow; checkIns: number } | null>(null)
  const [showQr, setShowQr] = useState<AttendeeRow | null>(null)
  const [importing, setImporting] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    listRegistrants(filter)
      .then((r) => {
        if (cancelled) return
        setRows(r)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load registrants.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Realtime version counters / manualRefresh are intentional refetch triggers.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [filter, versions.attendees, versions.events, manualRefresh])

  const eventName = useCallback(
    (id: number | null) => (id === null ? 'Any event' : (events.find((e) => e.id === id)?.name ?? `#${id}`)),
    [events],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.name, r.id_number, r.email, r.department, r.qr_code].some((v) => v?.toLowerCase().includes(q)),
    )
  }, [rows, search])

  const exportCsv = () => {
    downloadCsv(
      `registrants_${new Date().toISOString().slice(0, 10)}.csv`,
      ['QR Code', 'Full Name', 'Student/Employee ID', 'Email', 'Department', 'Event', 'Source', 'Registered (Asia/Manila)'],
      filtered.map((r) => [
        r.qr_code,
        r.name,
        r.id_number ?? '',
        r.email ?? '',
        r.department ?? '',
        eventName(r.event_id),
        SOURCE_LABEL[r.source],
        formatDateTime(r.created_at),
      ]),
    )
  }

  const askDelete = async (row: AttendeeRow) => {
    let checkIns = 0
    try {
      checkIns = await countCheckIns(row.id)
    } catch {
      checkIns = -1
    }
    setDeleting({ row, checkIns })
  }

  return (
    <section className="panel">
      <div className="panel__toolbar">
        <div>
          <h2 className="panel__title">Registrants</h2>
          <p className="muted">{formatNumber(rows.length)} registration(s) in this view</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn--gold" onClick={() => setImporting(true)}>
            Import Excel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
            + Add registrant
          </button>
          <button
            type="button"
            className="btn btn--danger-ghost"
            onClick={() => setBulkDeleting(true)}
            disabled={events.length === 0}
            title="Delete every registrant assigned to one event"
          >
            Delete event&apos;s registrants…
          </button>
        </div>
      </div>

      <div className="filters">
        <label className="field field--inline">
          <span>Event</span>
          <select
            value={typeof filter === 'number' ? String(filter) : filter}
            onChange={(e) => {
              const v = e.target.value
              setFilter(v === 'all' || v === 'any' ? v : Number(v))
              setLimit(PAGE)
            }}
          >
            <option value="all">All registrants</option>
            <option value="any">Registered for any event</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                Eligible for: {ev.name}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          className="input"
          placeholder="Search name, ID, email, department, QR"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setLimit(PAGE)
          }}
          aria-label="Search registrants"
        />
        <button type="button" className="btn btn--ghost" onClick={exportCsv} disabled={filtered.length === 0}>
          Export CSV
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setManualRefresh((n) => n + 1)}>
          Refresh
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <LoadingState />
      ) : filtered.length === 0 ? (
        <p className="empty-state">No registrants found.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Student / Employee ID</th>
                  <th>Department</th>
                  <th>Email</th>
                  <th>Event</th>
                  <th>QR code</th>
                  <th>Source</th>
                  <th>Registered</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, limit).map((r) => (
                  <tr key={r.id}>
                    <td data-label="Name" className="cell-strong">
                      {r.name}
                    </td>
                    <td data-label="ID">{r.id_number ?? '—'}</td>
                    <td data-label="Department">{r.department ?? '—'}</td>
                    <td data-label="Email">{r.email ?? '—'}</td>
                    <td data-label="Event">{eventName(r.event_id)}</td>
                    <td data-label="QR code">
                      <button type="button" className="link-button" onClick={() => setShowQr(r)} title="Show full QR value">
                        <code>{abbreviate(r.qr_code)}</code>
                      </button>
                    </td>
                    <td data-label="Source">{SOURCE_LABEL[r.source]}</td>
                    <td data-label="Registered">{formatDateTime(r.created_at)}</td>
                    <td className="cell-actions">
                      <button type="button" className="btn btn--small btn--ghost" onClick={() => setEditing(r)}>
                        Edit
                      </button>
                      <button type="button" className="btn btn--small btn--danger-ghost" onClick={() => void askDelete(r)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > limit && (
            <button type="button" className="btn btn--ghost btn--block" onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({formatNumber(filtered.length - limit)} remaining)
            </button>
          )}
        </>
      )}

      {editing && (
        <RegistrantForm
          registrant={editing === 'new' ? null : editing}
          events={events}
          defaultEventId={defaultEventId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setManualRefresh((n) => n + 1)
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete registrant"
          danger
          confirmLabel="Delete"
          message={
            <>
              <p>
                Delete <strong>{deleting.row.name}</strong>? Their QR code will no longer be accepted.
              </p>
              {deleting.checkIns > 0 && (
                <p className="text-warn">
                  This person has {deleting.checkIns} check-in record(s); they will be deleted too.
                </p>
              )}
            </>
          }
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteRegistrant(deleting.row.id)
            setManualRefresh((n) => n + 1)
          }}
        />
      )}

      {showQr && (
        <Modal title="QR code value (admin only)" onClose={() => setShowQr(null)}>
          <p className="muted small">
            This is the exact text encoded in {showQr.name}&apos;s externally generated QR code. Do not share it.
          </p>
          <pre className="qr-value">{showQr.qr_code}</pre>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void navigator.clipboard?.writeText(showQr.qr_code).catch(() => undefined)}
          >
            Copy value
          </button>
        </Modal>
      )}

      {bulkDeleting && (
        <DeleteEventRegistrantsDialog
          events={events}
          initialEventId={typeof filter === 'number' ? filter : defaultEventId}
          onClose={() => setBulkDeleting(false)}
          onDeleted={() => setManualRefresh((n) => n + 1)}
        />
      )}

      {importing && (
        <ExcelRegistrationImporter
          events={events}
          defaultEventId={defaultEventId}
          userId={userId}
          onClose={() => setImporting(false)}
          onImported={() => setManualRefresh((n) => n + 1)}
        />
      )}
    </section>
  )
}

function RegistrantForm({
  registrant,
  events,
  defaultEventId,
  onClose,
  onSaved,
}: {
  registrant: AttendeeRow | null
  events: EventRow[]
  defaultEventId: number | null
  onClose: () => void
  onSaved: () => void
}) {
  const [qr, setQr] = useState(registrant?.qr_code ?? '')
  const [name, setName] = useState(registrant?.name ?? '')
  const [idNumber, setIdNumber] = useState(registrant?.id_number ?? '')
  const [email, setEmail] = useState(registrant?.email ?? '')
  const [department, setDepartment] = useState(registrant?.department ?? '')
  const [eventId, setEventId] = useState<number | null>(registrant ? registrant.event_id : defaultEventId)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const eventChanged = registrant !== null && registrant.event_id !== eventId

  const save = async () => {
    const { value, errors } = validateRegistrant({ qr_code: qr, name, id_number: idNumber, email, department })
    setFieldErrors(errors)
    if (hasErrors(errors)) return
    setBusy(true)
    setError(null)
    try {
      const input = { ...value, event_id: eventId }
      if (registrant) await updateRegistrant(registrant.id, input)
      else await createRegistrant(input)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={registrant ? 'Edit registrant' : 'Add registrant'}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="field">
          <span>
            QR code value <span className="required">*</span>
          </span>
          <input value={qr} onChange={(e) => setQr(e.target.value)} autoComplete="off" spellCheck={false} />
          <small className="muted">Exactly the text inside the attendee&apos;s emailed QR code. This app never generates QR codes.</small>
          {fieldErrors.qr_code && <small className="field-error">{fieldErrors.qr_code}</small>}
        </label>
        <label className="field">
          <span>
            Full name <span className="required">*</span>
          </span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          {fieldErrors.name && <small className="field-error">{fieldErrors.name}</small>}
        </label>
        <label className="field">
          <span>Student / Employee ID</span>
          <input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} inputMode="text" />
          {fieldErrors.id_number && <small className="field-error">{fieldErrors.id_number}</small>}
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          {fieldErrors.email && <small className="field-error">{fieldErrors.email}</small>}
        </label>
        <label className="field">
          <span>Department / Program</span>
          <input value={department} onChange={(e) => setDepartment(e.target.value)} />
          {fieldErrors.department && <small className="field-error">{fieldErrors.department}</small>}
        </label>
        <label className="field">
          <span>Event</span>
          <select
            value={eventId === null ? '' : String(eventId)}
            onChange={(e) => setEventId(e.target.value === '' ? null : Number(e.target.value))}
          >
            <option value="">Any event</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" hidden />
      </form>
      {eventChanged && (
        <p className="notice notice--warn">
          You are changing this attendee&apos;s event. Existing check-ins are kept, but they may no longer be eligible for
          their previous event.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}
