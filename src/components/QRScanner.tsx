import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { computeQrBox, useCamera } from '../hooks/useCamera'
import type { CameraChoice } from '../lib/cameraSelection'
import { SCAN_FPS } from '../config'

export interface QRScannerHandle {
  /** Stop the camera (used before logout). */
  stop: () => Promise<void>
  /** Manually (re)start the camera. */
  restart: () => Promise<void>
}

interface QRScannerProps {
  onDecode: (text: string) => void
  /** True while a check-in request is in flight. */
  processing: boolean
  /** True when the scan gate would accept a code. */
  ready: boolean
  /** Which camera to use. Changing it switches cameras. */
  facing: CameraChoice
  onToggleFacing: () => void
  /** Extra buttons shown beside the camera switch (e.g. the fullscreen toggle). */
  actions?: ReactNode
  /** Optional logo shown directly above the camera box. */
  logo?: { src: string; alt: string }
  onStatusChange?: (status: ReturnType<typeof useCamera>['state']) => void
  ref?: Ref<QRScannerHandle>
}

/**
 * The reader is laid out at a FIXED width and visually scaled with a CSS
 * transform to fit INSIDE the box ("contain": never cropped, never past the
 * border). html5-qrcode maps its decode region using the element's layout
 * size, which transforms do not change — so rotating the tablet only rescales
 * the picture and never requires restarting the camera.
 */
const RENDER_WIDTH = 960
const ELEMENT_ID = 'camera-reader'

export function QRScanner({
  onDecode,
  processing,
  ready,
  facing,
  onToggleFacing,
  actions,
  logo,
  onStatusChange,
  ref,
}: QRScannerProps) {
  const { state, start, stop } = useCamera({ elementId: ELEMENT_ID, onDecode, fps: SCAN_FPS, facing })
  const viewportRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [frame, setFrame] = useState<number | null>(null)
  /** The camera's real width / height, so the box takes the picture's shape. */
  const [ratio, setRatio] = useState<number | null>(null)

  useImperativeHandle(ref, () => ({ stop, restart: start }), [stop, start])

  useEffect(() => {
    onStatusChange?.(state)
  }, [state, onStatusChange])

  /** Fit the fixed-width reader inside the box, using the camera's real aspect ratio. */
  const fit = useCallback(() => {
    const viewport = viewportRef.current
    const reader = readerRef.current
    if (!viewport || !reader) return
    const video = reader.querySelector('video')
    const known = !!video && video.videoWidth > 0 && video.videoHeight > 0
    if (known) setRatio(Math.round((video.videoWidth / video.videoHeight) * 1000) / 1000)
    const readerHeight = known
      ? (RENDER_WIDTH * video.videoHeight) / video.videoWidth
      : reader.offsetHeight || (RENDER_WIDTH * 9) / 16
    // clientWidth/Height exclude the border, so the picture stays inside it.
    const s = Math.min(viewport.clientWidth / RENDER_WIDTH, viewport.clientHeight / readerHeight)
    setScale(Number.isFinite(s) && s > 0 ? s : 1)
    if (video && video.clientWidth > 0 && video.clientHeight > 0) {
      setFrame(computeQrBox(video.clientWidth, video.clientHeight).width)
    }
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const reader = readerRef.current
    if (!viewport || !reader) return
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(viewport)
    ro.observe(reader)
    return () => ro.disconnect()
  }, [fit])

  // Re-fit once the camera reports its real size. Switching cameras passes
  // through "starting", so this re-runs for the new camera's video element.
  const running = state.status === 'running'
  useEffect(() => {
    if (!running) return
    const video = readerRef.current?.querySelector('video')
    fit()
    if (!video) return
    video.addEventListener('loadedmetadata', fit)
    video.addEventListener('resize', fit)
    return () => {
      video.removeEventListener('loadedmetadata', fit)
      video.removeEventListener('resize', fit)
    }
  }, [running, fit])

  const switching = state.status === 'starting' || state.status === 'idle'
  const otherName = facing === 'front' ? 'back' : 'front'

  return (
    <div className={`scanner-stage${logo ? ' scanner-stage--with-logo' : ''}`}>
      {logo && <img className="scanner-logo" src={logo.src} alt={logo.alt} />}
      <div className="scanner-viewport" ref={viewportRef} style={running && ratio ? { aspectRatio: String(ratio) } : undefined}>
        <div className="scanner-scaler" style={{ width: RENDER_WIDTH, transform: `translate(-50%, -50%) scale(${scale})` }}>
          <div
            id={ELEMENT_ID}
            className={`scanner-reader${facing === 'front' ? ' scanner-reader--mirror' : ''}`}
            ref={readerRef}
          />
          {running && frame !== null && (
            <div
              className={`scan-frame${processing ? ' scan-frame--busy' : ''}${ready ? ' scan-frame--ready' : ''}`}
              style={{ width: frame, height: frame }}
              aria-hidden="true"
            >
              <span className="scan-frame__corner scan-frame__corner--tl" />
              <span className="scan-frame__corner scan-frame__corner--tr" />
              <span className="scan-frame__corner scan-frame__corner--bl" />
              <span className="scan-frame__corner scan-frame__corner--br" />
              {ready && !processing && <span className="scan-frame__laser" />}
            </div>
          )}
        </div>

        {!running && <CameraStatusPanel state={state} onRetry={() => void start()} />}
      </div>

      <div className="scanner-prompt" aria-live="polite">
        <span className={`ready-indicator ${processing ? 'ready-indicator--busy' : running && ready ? 'ready-indicator--ok' : ''}`}>
          {processing ? 'Processing…' : running ? (ready ? 'Ready to Scan' : 'Please wait…') : 'Camera not ready'}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--small camera-switch"
          onClick={onToggleFacing}
          disabled={switching}
          title={`Switch to the ${otherName} camera`}
        >
          <span aria-hidden="true">⇄</span> Use {otherName} camera
        </button>
        {actions}
      </div>
    </div>
  )
}

function CameraStatusPanel({
  state,
  onRetry,
}: {
  state: ReturnType<typeof useCamera>['state']
  onRetry: () => void
}) {
  const cameraName = state.facing === 'front' ? 'Front' : 'Back'

  if (state.status === 'starting' || state.status === 'idle') {
    return (
      <div className="camera-panel">
        <span className="spinner spinner--large" aria-hidden="true" />
        <p className="camera-panel__title">{state.message ?? `Starting ${cameraName.toLowerCase()} camera…`}</p>
        {state.status === 'idle' && (
          <button type="button" className="btn btn--gold btn--large" onClick={onRetry}>
            Start Camera
          </button>
        )}
      </div>
    )
  }

  if (state.status === 'denied') {
    return (
      <div className="camera-panel camera-panel--error" role="alert">
        <p className="camera-panel__title">Camera Access Denied</p>
        <p>Please allow camera access and try again.</p>
        <ol className="camera-panel__steps">
          <li>Tap the camera / lock icon next to the address bar in Chrome.</li>
          <li>Set <strong>Camera</strong> to <strong>Allow</strong>.</li>
          <li>If it is not listed: Chrome menu ⋮ → Settings → Site settings → Camera → allow this site.</li>
          <li>For the installed app: Android Settings → Apps → Chrome → Permissions → Camera → Allow.</li>
        </ol>
        <button type="button" className="btn btn--gold btn--large" onClick={onRetry}>
          Retry Camera
        </button>
      </div>
    )
  }

  const titles: Record<string, string> = {
    not_found: `${cameraName} Camera Not Available`,
    in_use: `${cameraName} Camera Busy`,
    insecure: 'Secure Connection Required',
    unsupported: 'Camera Not Supported',
    error: 'Camera Error',
  }

  return (
    <div className="camera-panel camera-panel--error" role="alert">
      <p className="camera-panel__title">{titles[state.status] ?? 'Camera Error'}</p>
      {state.message && <p>{state.message}</p>}
      {state.status === 'not_found' && (
        <p className="camera-panel__small">
          Make sure no other app is using the camera, then retry, or switch cameras with the button below.
        </p>
      )}
      {state.status !== 'insecure' && state.status !== 'unsupported' && (
        <button type="button" className="btn btn--gold btn--large" onClick={onRetry}>
          Retry Camera
        </button>
      )}
    </div>
  )
}
