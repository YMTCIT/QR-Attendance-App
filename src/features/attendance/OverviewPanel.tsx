import { useEffect, useState } from 'react'
import { EventSelector } from '../../components/EventSelector'
import { LoadingState } from '../../components/LoadingState'
import { attendanceRate, formatEventDate, formatNumber, formatPercent, formatTime } from '../../lib/format'
import type { EventRow, EventStats } from '../../types/database'
import type { DataVersions } from '../../hooks/useRealtimeAttendance'
import { fetchEventStats, fetchRecentCheckIns, type RecentCheckIn } from './api'

interface Props {
  events: EventRow[]
  eventId: number | null
  onEventChange: (id: number | null) => void
  versions: DataVersions
}

export function OverviewPanel({ events, eventId, onEventChange, versions }: Props) {
  const [stats, setStats] = useState<EventStats | null>(null)
  const [recent, setRecent] = useState<RecentCheckIn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadedFor, setLoadedFor] = useState<number | null>(null)

  useEffect(() => {
    if (eventId === null) return
    let cancelled = false
    Promise.all([fetchEventStats(eventId), fetchRecentCheckIns(eventId, 12)])
      .then(([s, r]) => {
        if (cancelled) return
        setStats(s)
        setRecent(r)
        setError(null)
        setLoadedFor(eventId)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load statistics.')
      })
    return () => {
      cancelled = true
    }
    // Realtime version counters are intentional refetch triggers.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [eventId, versions.attendance, versions.attendees, versions.events])

  const active = events.find((e) => e.active) ?? null
  const selected = events.find((e) => e.id === eventId) ?? null

  const registered = stats?.registered ?? 0
  const present = stats?.present ?? 0
  const absent = Math.max(0, registered - present)
  const rate = attendanceRate(present, registered)

  return (
    <section className="panel">
      <div className="panel__toolbar">
        <div>
          <h2 className="panel__title">Overview</h2>
          <p className="muted">
            Active event:{' '}
            {active ? (
              <strong>
                {active.name} · {formatEventDate(active.date)}
              </strong>
            ) : (
              <strong className="text-warn">none — scanners cannot record attendance</strong>
            )}
          </p>
        </div>
        <EventSelector id="overview-event" events={events} value={eventId} onChange={onEventChange} label="Showing" />
      </div>

      {eventId === null ? (
        <p className="empty-state">Create an event in the Events tab to see statistics.</p>
      ) : error ? (
        <p className="form-error">{error}</p>
      ) : loadedFor !== eventId ? (
        <LoadingState />
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-card__label">Registered</span>
              <span className="stat-card__value">{formatNumber(registered)}</span>
            </div>
            <div className="stat-card stat-card--ok">
              <span className="stat-card__label">Present</span>
              <span className="stat-card__value">{formatNumber(present)}</span>
            </div>
            <div className="stat-card stat-card--muted">
              <span className="stat-card__label">Absent</span>
              <span className="stat-card__value">{formatNumber(absent)}</span>
            </div>
            <div className="stat-card stat-card--gold">
              <span className="stat-card__label">Attendance rate</span>
              <span className="stat-card__value">{formatPercent(rate)}</span>
              <span className="meter" aria-hidden="true">
                <span className="meter__fill" style={{ width: `${Math.min(100, rate)}%` }} />
              </span>
            </div>
          </div>

          <h3 className="section-title">Recent check-ins{selected ? ` — ${selected.name}` : ''}</h3>
          {recent.length === 0 ? (
            <p className="empty-state">No check-ins yet.</p>
          ) : (
            <ul className="recent-list">
              {recent.map((r) => (
                <li key={r.id} className="recent-list__item">
                  <span className="recent-list__time">{formatTime(r.scanned_at)}</span>
                  <span className="recent-list__name">{r.name}</span>
                  <span className="recent-list__meta">
                    {[r.id_number, r.department].filter(Boolean).join(' · ')}
                  </span>
                  <span className={r.check_in_method === 'qr' ? 'badge badge--ok' : 'badge badge--gold'}>
                    {r.check_in_method === 'qr' ? 'QR' : 'Manual'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
