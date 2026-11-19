import { useEffect, useMemo, useState } from 'react'
import { AttendanceTable } from '../../components/AttendanceTable'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { EventSelector } from '../../components/EventSelector'
import { LoadingState } from '../../components/LoadingState'
import { downloadCsv, safeFilename } from '../../lib/csv'
import { attendanceRate, formatDateTime, formatNumber, formatPercent } from '../../lib/format'
import type { EventRow, RosterRow } from '../../types/database'
import type { DataVersions } from '../../hooks/useRealtimeAttendance'
import { fetchRoster, markPresent, undoCheckIn } from './api'

type StatusFilter = 'all' | 'present' | 'absent'
const PAGE = 300

interface Props {
  events: EventRow[]
  eventId: number | null
  onEventChange: (id: number | null) => void
  versions: DataVersions
}

export function AttendancePanel({ events, eventId, onEventChange, versions }: Props) {
  const [rows, setRows] = useState<RosterRow[]>([])
  const [loadedFor, setLoadedFor] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [limit, setLimit] = useState(PAGE)
  const [confirm, setConfirm] = useState<{ kind: 'mark' | 'undo'; row: RosterRow } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (eventId === null) return
    let cancelled = false
    fetchRoster(eventId)
      .then((r) => {
        if (cancelled) return
        setRows(r)
        setLoadedFor(eventId)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load attendance.')
      })
    return () => {
      cancelled = true
    }
    // Realtime version counters are intentional refetch triggers.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [eventId, versions.attendance, versions.attendees, versions.events])

  const event = events.find((e) => e.id === eventId) ?? null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (status === 'present' && r.attendance_id === null) return false
      if (status === 'absent' && r.attendance_id !== null) return false
      if (!q) return true
      return [r.name, r.id_number, r.department, r.email].some((v) => v?.toLowerCase().includes(q))
    })
  }, [rows, search, status])

  const present = rows.filter((r) => r.attendance_id !== null).length

  const exportCsv = () => {
    if (!event) return
    downloadCsv(
      `${safeFilename(event.name)}_attendance_${event.date}.csv`,
      ['Name', 'Student/Employee ID', 'Department', 'Email', 'Event', 'Status', 'Check-in time (Asia/Manila)', 'Check-in method'],
      filtered.map((r) => [
        r.name,
        r.id_number ?? '',
        r.department ?? '',
        r.email ?? '',
        event.name,
        r.attendance_id !== null ? 'Present' : 'Absent',
        r.attendance_id !== null ? formatDateTime(r.scanned_at) : '',
        r.check_in_method === 'qr' ? 'QR scan' : r.check_in_method === 'manual' ? 'Manual' : '',
      ]),
    )
  }

  return (
    <section className="panel">
      <div className="panel__toolbar">
        <div>
          <h2 className="panel__title">Attendance</h2>
          {loadedFor === eventId && eventId !== null && (
            <p className="muted">
              {formatNumber(present)} present · {formatNumber(rows.length - present)} absent ·{' '}
              {formatPercent(attendanceRate(present, rows.length))}
            </p>
          )}
        </div>
        <EventSelector id="attendance-event" events={events} value={eventId} onChange={onEventChange} />
      </div>

      <div className="filters">
        <input
          type="search"
          className="input"
          placeholder="Search name, ID, department or email"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setLimit(PAGE)
          }}
          aria-label="Search attendees"
        />
        <div className="segmented" role="group" aria-label="Status filter">
          {(['all', 'present', 'absent'] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={status === s ? 'segmented__btn segmented__btn--on' : 'segmented__btn'}
              onClick={() => {
                setStatus(s)
                setLimit(PAGE)
              }}
              aria-pressed={status === s}
            >
              {s === 'all' ? 'All' : s === 'present' ? 'Present' : 'Absent'}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--ghost" onClick={exportCsv} disabled={!event || filtered.length === 0}>
          Export CSV
        </button>
      </div>

      {notice && (
        <p className="notice notice--ok" role="status">
          {notice}
        </p>
      )}

      {eventId === null ? (
        <p className="empty-state">Select an event.</p>
      ) : error ? (
        <p className="form-error">{error}</p>
      ) : loadedFor !== eventId ? (
        <LoadingState />
      ) : (
        <>
          <AttendanceTable
            rows={filtered.slice(0, limit)}
            eventName={event?.name ?? ''}
            onMarkPresent={(row) => setConfirm({ kind: 'mark', row })}
            onUndo={(row) => setConfirm({ kind: 'undo', row })}
          />
          {filtered.length > limit && (
            <button type="button" className="btn btn--ghost btn--block" onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({formatNumber(filtered.length - limit)} remaining)
            </button>
          )}
        </>
      )}

      {confirm && eventId !== null && (
        <ConfirmDialog
          title={confirm.kind === 'mark' ? 'Mark present manually' : 'Undo check-in'}
          message={
            confirm.kind === 'mark' ? (
              <p>
                Record <strong>{confirm.row.name}</strong> as present for <strong>{event?.name}</strong>? Use this only when
                the attendee&apos;s QR code cannot be scanned.
              </p>
            ) : (
              <p>
                Remove the check-in for <strong>{confirm.row.name}</strong> recorded at{' '}
                {formatDateTime(confirm.row.scanned_at)}? They will show as absent and can check in again.
              </p>
            )
          }
          confirmLabel={confirm.kind === 'mark' ? 'Mark present' : 'Undo check-in'}
          danger={confirm.kind === 'undo'}
          askReason
          onClose={() => setConfirm(null)}
          onConfirm={async (reason) => {
            if (confirm.kind === 'mark') {
              const r = await markPresent(eventId, confirm.row.attendee_id, reason)
              if (r.status === 'wrong_event') throw new Error('This attendee is registered for a different event.')
              setNotice(
                r.status === 'already'
                  ? `${confirm.row.name} was already checked in.`
                  : `${confirm.row.name} marked present.`,
              )
            } else if (confirm.row.attendance_id !== null) {
              const r = await undoCheckIn(confirm.row.attendance_id, reason)
              setNotice(r === 'ok' ? `Check-in removed for ${confirm.row.name}.` : 'That check-in was already removed.')
            }
          }}
        />
      )}
    </section>
  )
}
