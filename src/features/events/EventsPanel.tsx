import { useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Modal } from '../../components/Modal'
import { formatEventDate, formatNumber } from '../../lib/format'
import { createEvent, deleteEvent, setActiveEvent, updateEvent, validateEventInput, type EventWithCount } from './api'

interface Props {
  events: EventWithCount[]
  loading: boolean
  error: string | null
  onChanged: () => void
}

function todayInManila(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date())
}

export function EventsPanel({ events, loading, error, onChanged }: Props) {
  const [editing, setEditing] = useState<EventWithCount | 'new' | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'activate' | 'deactivate' | 'delete'; event: EventWithCount } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  return (
    <section className="panel">
      <div className="panel__toolbar">
        <div>
          <h2 className="panel__title">Events</h2>
          <p className="muted">Only one event can be active. Scanners record attendance for the active event only.</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
          + Create event
        </button>
      </div>

      {(error || actionError) && <p className="form-error">{error ?? actionError}</p>}

      {loading && events.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="empty-state">No events yet. Create the first one.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Event</th>
                <th>Date</th>
                <th>Venue</th>
                <th>Registrants</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id} className={ev.active ? 'row--active' : undefined}>
                  <td data-label="ID">
                    <code>{ev.id}</code>
                  </td>
                  <td data-label="Event" className="cell-strong">
                    {ev.name}
                  </td>
                  <td data-label="Date">{formatEventDate(ev.date)}</td>
                  <td data-label="Venue">{ev.venue ?? '—'}</td>
                  <td data-label="Registrants">{formatNumber(ev.registrants)}</td>
                  <td data-label="Status">
                    {ev.active ? <span className="badge badge--ok">Active</span> : <span className="badge badge--muted">Inactive</span>}
                  </td>
                  <td className="cell-actions">
                    {ev.active ? (
                      <button type="button" className="btn btn--small btn--ghost" onClick={() => setConfirm({ kind: 'deactivate', event: ev })}>
                        Deactivate
                      </button>
                    ) : (
                      <button type="button" className="btn btn--small btn--gold" onClick={() => setConfirm({ kind: 'activate', event: ev })}>
                        Set active
                      </button>
                    )}
                    <button type="button" className="btn btn--small btn--ghost" onClick={() => setEditing(ev)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn--small btn--danger-ghost" onClick={() => setConfirm({ kind: 'delete', event: ev })}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EventForm
          event={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            onChanged()
          }}
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === 'activate' ? 'Set active event' : confirm.kind === 'deactivate' ? 'Deactivate event' : 'Delete event'
          }
          message={
            confirm.kind === 'activate' ? (
              <p>
                Make <strong>{confirm.event.name}</strong> the active event? Any other active event is deactivated at the
                same moment. All scanner tablets switch to this event.
              </p>
            ) : confirm.kind === 'deactivate' ? (
              <p>
                Deactivate <strong>{confirm.event.name}</strong>? Scanners will show &quot;No active event&quot; and stop
                recording attendance.
              </p>
            ) : (
              <>
                <p>
                  Permanently delete <strong>{confirm.event.name}</strong> and <strong>all of its check-in records</strong>?
                  This cannot be undone.
                </p>
                <p className="muted small">
                  Events with registrants assigned specifically to them cannot be deleted until those registrants are moved or
                  deleted.
                </p>
              </>
            )
          }
          confirmLabel={confirm.kind === 'activate' ? 'Set active' : confirm.kind === 'deactivate' ? 'Deactivate' : 'Delete event'}
          danger={confirm.kind !== 'activate'}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            setActionError(null)
            if (confirm.kind === 'activate') await setActiveEvent(confirm.event.id)
            else if (confirm.kind === 'deactivate') await setActiveEvent(null)
            else await deleteEvent(confirm.event.id)
            onChanged()
          }}
        />
      )}
    </section>
  )
}

function EventForm({ event, onClose, onSaved }: { event: EventWithCount | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(event?.name ?? '')
  const [date, setDate] = useState(event?.date ?? todayInManila())
  const [venue, setVenue] = useState(event?.venue ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const input = { name, date, venue: venue.trim() || null }
    const invalid = validateEventInput(input)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (event) await updateEvent(event.id, input)
      else await createEvent(input)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the event.')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={event ? 'Edit event' : 'Create event'}
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
            Event name <span className="required">*</span>
          </span>
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span>
            Date <span className="required">*</span>
          </span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="field">
          <span>Venue</span>
          <input value={venue} maxLength={200} onChange={(e) => setVenue(e.target.value)} />
        </label>
        <button type="submit" hidden />
      </form>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}
