import type { CheckInLogEntry } from '../features/attendance/api'
import { formatNumber, formatTime } from '../lib/format'

interface Props {
  entries: CheckInLogEntry[]
  total: number
  loading: boolean
  stale: boolean
  hasEvent: boolean
  /** Row to highlight: the most recent successful check-in on this tablet. */
  highlightKey: string | null
  /** Duration of the arrival animation on the highlighted row. */
  highlightMs: number
}

/**
 * Attendance log shown beside the camera on the scanner screen. Newest first.
 * A successful check-in appears at the top, highlighted, instead of a
 * full-screen overlay. Shows only names and times.
 */
export function CheckInLog({ entries, total, loading, stale, hasEvent, highlightKey, highlightMs }: Props) {
  return (
    <section className="checkin-log" aria-label="Attendance log">
      <header className="checkin-log__header">
        <h2 className="checkin-log__title">Attendance Log</h2>
        {hasEvent && (
          <span className="checkin-log__count">
            <strong>{formatNumber(total)}</strong> checked in
          </span>
        )}
      </header>

      {stale && (
        <p className="checkin-log__stale" role="status">
          Can&apos;t refresh the log right now. Showing the last known list.
        </p>
      )}

      {!hasEvent ? (
        <p className="checkin-log__empty">No active event.</p>
      ) : loading && entries.length === 0 ? (
        <p className="checkin-log__empty">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="checkin-log__empty">
          No check-ins yet.
          <br />
          Hold your QR code up to the camera to check in.
        </p>
      ) : (
        <ol className="checkin-log__list" aria-live="polite">
          {entries.map((entry) => {
            const highlighted = entry.key === highlightKey
            return (
              <li
                key={entry.key}
                className={`checkin-log__row${highlighted ? ' checkin-log__row--new' : ''}`}
                style={highlighted ? { animationDuration: `${highlightMs}ms` } : undefined}
              >
                <span className="checkin-log__name">
                  {highlighted && (
                    <span className="checkin-log__badge" aria-hidden="true">
                      ✓
                    </span>
                  )}
                  {entry.name}
                  {highlighted && <span className="sr-only"> (just checked in)</span>}
                </span>
                <time className="checkin-log__time" dateTime={entry.scanned_at}>
                  {formatTime(entry.scanned_at)}
                </time>
              </li>
            )
          })}
        </ol>
      )}

      {hasEvent && total > entries.length && (
        <p className="checkin-log__more">Showing the latest {formatNumber(entries.length)}.</p>
      )}
    </section>
  )
}
