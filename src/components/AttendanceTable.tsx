import type { RosterRow } from '../types/database'
import { formatDateTime } from '../lib/format'

interface AttendanceTableProps {
  rows: RosterRow[]
  eventName: string
  onMarkPresent: (row: RosterRow) => void
  onUndo: (row: RosterRow) => void
}

/**
 * Check-in status per eligible attendee. Check-in only: there are no
 * time-out, departure, duration or hours columns by design.
 */
export function AttendanceTable({ rows, eventName, onMarkPresent, onUndo }: AttendanceTableProps) {
  if (rows.length === 0) {
    return <p className="empty-state">No attendees match the current filters.</p>
  }
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Student / Employee ID</th>
            <th>Department</th>
            <th>Event</th>
            <th>Status</th>
            <th>Check-in time</th>
            <th>Method</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const present = r.attendance_id !== null
            return (
              <tr key={r.attendee_id}>
                <td data-label="Name" className="cell-strong">
                  {r.name}
                </td>
                <td data-label="ID">{r.id_number ?? '—'}</td>
                <td data-label="Department">{r.department ?? '—'}</td>
                <td data-label="Event">{r.attendee_event === null ? `${eventName} (any-event registrant)` : eventName}</td>
                <td data-label="Status">
                  <span className={present ? 'badge badge--ok' : 'badge badge--muted'}>{present ? 'Present' : 'Absent'}</span>
                </td>
                <td data-label="Check-in time">{present ? formatDateTime(r.scanned_at) : '—'}</td>
                <td data-label="Method">{r.check_in_method === 'qr' ? 'QR scan' : r.check_in_method === 'manual' ? 'Manual' : '—'}</td>
                <td className="cell-actions">
                  {present ? (
                    <button type="button" className="btn btn--small btn--ghost" onClick={() => onUndo(r)}>
                      Undo check-in
                    </button>
                  ) : (
                    <button type="button" className="btn btn--small btn--primary" onClick={() => onMarkPresent(r)}>
                      Mark present
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
