import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { QRScanner, type QRScannerHandle } from '../components/QRScanner'
import { FullScreenScanResult } from '../components/FullScreenScanResult'
import { StatusPill } from '../components/StatusPill'
import { useAuth } from '../hooks/useAuth'
import { useActiveEvent } from '../hooks/useActiveEvent'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { useWakeLock } from '../hooks/useWakeLock'
import type { CameraState } from '../hooks/useFrontCamera'
import { ScanGate } from '../features/attendance/scanGate'
import { submitCheckIn } from '../features/attendance/api'
import { overlayDurationFor } from '../features/attendance/checkInResult'
import { ERROR_OVERLAY_MS, SAME_CODE_REARM_MS, SCAN_COOLDOWN_MS, SUCCESS_OVERLAY_MS } from '../config'
import { formatEventDate } from '../lib/format'
import { playErrorBeep, playSuccessBeep, playWarningBeep, unlockAudio } from '../lib/beep'
import type { ScanOutcome } from '../types/attendance'

const SOUND_KEY = 'cit-qr:sound'

function readSoundPref(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'
  } catch {
    return true
  }
}

export default function ScannerPage() {
  const { role, email, signOut } = useAuth()
  const navigate = useNavigate()
  const { event, loading: eventLoading, error: eventError, realtime, refresh: refreshEvent } = useActiveEvent()
  const online = useOnlineStatus()
  const wakeLock = useWakeLock(true)

  const gateRef = useRef<ScanGate>(new ScanGate({ cooldownMs: SCAN_COOLDOWN_MS, rearmMs: SAME_CODE_REARM_MS }))
  const scannerRef = useRef<QRScannerHandle>(null)
  const overlayTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  const [outcome, setOutcome] = useState<ScanOutcome | null>(null)
  const [overlayMs, setOverlayMs] = useState(SUCCESS_OVERLAY_MS)
  const [processing, setProcessing] = useState(false)
  const [soundOn, setSoundOn] = useState(readSoundPref)
  const [camera, setCamera] = useState<CameraState | null>(null)
  // Mirror of soundOn for the async decode handler (avoids stale closures).
  const soundRef = useRef(soundOn)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current)
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await scannerRef.current?.stop()
    } finally {
      await signOut()
      navigate('/login', { replace: true })
    }
  }, [navigate, signOut])

  /**
   * Called by the camera for EVERY decoded frame (~10/s while a code is in
   * view). The synchronous ScanGate decides whether to start a request.
   */
  const handleDecode = useCallback(
    (raw: string) => {
      const code = raw.trim()
      const gate = gateRef.current
      if (!gate.tryAccept(code, performance.now())) return

      setProcessing(true)
      void (async () => {
        const result = await submitCheckIn(code)
        if (!mountedRef.current) return

        gate.finish(performance.now(), { rearmSameCode: result.status !== 'network_error' })
        gate.hold() // no scans while the overlay is visible

        const duration = overlayDurationFor(result, SUCCESS_OVERLAY_MS, ERROR_OVERLAY_MS)
        setProcessing(false)
        setOverlayMs(duration)
        setOutcome(result)

        if (soundRef.current) {
          if (result.status === 'ok') playSuccessBeep()
          else if (result.status === 'already') playWarningBeep()
          else playErrorBeep()
        }
        if (result.status === 'no_event' || result.status === 'wrong_event') void refreshEvent()

        if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current)
        overlayTimerRef.current = window.setTimeout(() => {
          overlayTimerRef.current = null
          if (!mountedRef.current) return
          setOutcome(null)
          gate.release() // resume processing on the SAME camera session
          if (result.status === 'unauthorized') void logout()
        }, duration)
      })()
    },
    [logout, refreshEvent],
  )

  const toggleSound = () => {
    unlockAudio()
    const next = !soundRef.current
    soundRef.current = next
    setSoundOn(next)
    try {
      localStorage.setItem(SOUND_KEY, next ? 'on' : 'off')
    } catch {
      // storage unavailable — preference just won't persist
    }
  }

  const connectionPill = !online ? (
    <StatusPill tone="bad" label="Offline" title="No network connection. Check-ins cannot be confirmed." />
  ) : realtime === 'connected' ? (
    <StatusPill tone="ok" label="Online" title="Connected. Live event updates active." />
  ) : realtime === 'connecting' ? (
    <StatusPill tone="neutral" label="Connecting…" />
  ) : (
    <StatusPill tone="warn" label="Online (no live updates)" title="Realtime unavailable. Checking the active event every 30 seconds." />
  )

  const cameraPill =
    camera?.status === 'running' ? (
      camera.verification === 'verified' ? (
        <StatusPill tone="ok" label="Front camera" title={camera.label ?? undefined} />
      ) : (
        <StatusPill
          tone="warn"
          label="Front camera (unverified)"
          title={`The browser did not report which way this camera faces. Confirm the preview shows the people in front of the tablet. ${camera.label ?? ''}`}
        />
      )
    ) : camera?.status === 'starting' ? (
      <StatusPill tone="neutral" label="Camera starting…" />
    ) : (
      <StatusPill tone="bad" label="Camera off" />
    )

  return (
    <div className="scanner-page">
      <header className="scanner-header">
        <div className="scanner-header__brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <div>
            <p className="scanner-header__app">CIT QR Attendance</p>
            <p className="scanner-header__event">
              {eventLoading ? (
                'Loading event…'
              ) : event ? (
                <>
                  <strong>{event.name}</strong>
                  <span className="scanner-header__date"> · {formatEventDate(event.date)}</span>
                  {event.venue && <span className="scanner-header__date"> · {event.venue}</span>}
                </>
              ) : (
                <strong className="text-warn">No active event</strong>
              )}
            </p>
          </div>
        </div>
        <div className="scanner-header__status">
          {connectionPill}
          {cameraPill}
          {wakeLock === 'active' && <StatusPill tone="neutral" label="Screen awake" />}
          <button type="button" className="btn btn--ghost-light btn--small" onClick={toggleSound} aria-pressed={soundOn}>
            {soundOn ? 'Sound on' : 'Sound off'}
          </button>
          {role === 'admin' && (
            <Link className="btn btn--ghost-light btn--small" to="/admin/dashboard">
              Dashboard
            </Link>
          )}
          <button type="button" className="btn btn--ghost-light btn--small" onClick={() => void logout()} title={email ?? undefined}>
            Log out
          </button>
        </div>
      </header>

      {!eventLoading && !event && (
        <div className="scanner-banner scanner-banner--warn" role="status">
          <strong>NO ACTIVE EVENT</strong> — Please contact the administrator. Scans will not be recorded until an event is
          activated.
        </div>
      )}
      {eventError && (
        <div className="scanner-banner scanner-banner--error" role="status">
          {eventError}
        </div>
      )}

      <main className="scanner-main">
        {/* The scanner stays mounted for the life of this page. */}
        <QRScanner
          ref={scannerRef}
          onDecode={handleDecode}
          processing={processing}
          ready={!processing && outcome === null}
          onStatusChange={setCamera}
        />
      </main>

      {outcome && <FullScreenScanResult outcome={outcome} durationMs={overlayMs} fallbackEventName={event?.name} />}
    </div>
  )
}
