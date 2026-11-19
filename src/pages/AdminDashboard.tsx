import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { StatusPill } from '../components/StatusPill'
import { useAuth } from '../hooks/useAuth'
import { useRealtimeAttendance } from '../hooks/useRealtimeAttendance'
import { listEvents, type EventWithCount } from '../features/events/api'
import { EventsPanel } from '../features/events/EventsPanel'
import { OverviewPanel } from '../features/attendance/OverviewPanel'
import { AttendancePanel } from '../features/attendance/AttendancePanel'
import { RegistrantsPanel } from '../features/registrants/RegistrantsPanel'
import { ScannerUsersPanel } from '../features/users/ScannerUsersPanel'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'events', label: 'Events' },
  { key: 'registrants', label: 'Registrants' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'users', label: 'Scanner Users' },
] as const

type TabKey = (typeof TABS)[number]['key']

export default function AdminDashboard() {
  const { email, userId, signOut } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'overview'

  const { status: realtime, versions } = useRealtimeAttendance(true)
  const [events, setEvents] = useState<EventWithCount[]>([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null)
  const [eventsRefresh, setEventsRefresh] = useState(0)

  useEffect(() => {
    let cancelled = false
    listEvents()
      .then((list) => {
        if (cancelled) return
        setEvents(list)
        setEventsError(null)
        setSelectedEventId((current) => {
          if (current !== null && list.some((e) => e.id === current)) return current
          return list.find((e) => e.active)?.id ?? list[0]?.id ?? null
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) setEventsError(e instanceof Error ? e.message : 'Could not load events.')
      })
      .finally(() => {
        if (!cancelled) setEventsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Realtime version counters / eventsRefresh are intentional refetch triggers.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [versions.events, versions.attendees, eventsRefresh])

  const refreshEvents = useCallback(() => setEventsRefresh((n) => n + 1), [])

  const logout = async () => {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header__brand">
          <img src="/favicon.svg" alt="" width={40} height={40} />
          <div>
            <p className="admin-header__title">CIT QR Attendance</p>
            <p className="admin-header__subtitle">Administrator dashboard</p>
          </div>
        </div>
        <div className="admin-header__actions">
          {realtime === 'connected' ? (
            <StatusPill tone="ok" label="Live" title="Realtime updates connected" />
          ) : realtime === 'connecting' ? (
            <StatusPill tone="neutral" label="Connecting…" />
          ) : (
            <StatusPill tone="bad" label="Not live" title="Realtime disconnected — data refreshes when you change tabs or reload" />
          )}
          <Link className="btn btn--gold btn--small" to="/scan">
            Open scanner
          </Link>
          <span className="admin-header__user" title={email ?? undefined}>
            {email}
          </span>
          <button type="button" className="btn btn--ghost-light btn--small" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Dashboard sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={tab === t.key ? 'tabs__tab tabs__tab--on' : 'tabs__tab'}
            aria-current={tab === t.key ? 'page' : undefined}
            onClick={() => setParams(t.key === 'overview' ? {} : { tab: t.key })}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="admin-main">
        {eventsError && tab !== 'events' && <p className="form-error">{eventsError}</p>}
        {tab === 'overview' && (
          <OverviewPanel events={events} eventId={selectedEventId} onEventChange={setSelectedEventId} versions={versions} />
        )}
        {tab === 'events' && <EventsPanel events={events} loading={eventsLoading} error={eventsError} onChanged={refreshEvents} />}
        {tab === 'registrants' && userId && (
          <RegistrantsPanel
            events={events}
            versions={versions}
            userId={userId}
            defaultEventId={events.find((e) => e.active)?.id ?? null}
          />
        )}
        {tab === 'attendance' && (
          <AttendancePanel events={events} eventId={selectedEventId} onEventChange={setSelectedEventId} versions={versions} />
        )}
        {tab === 'users' && <ScannerUsersPanel />}
      </main>
    </div>
  )
}
