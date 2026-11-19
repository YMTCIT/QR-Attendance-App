import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { computeQrBox, useFrontCamera } from '../hooks/useFrontCamera'
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
  onStatusChange?: (status: ReturnType<typeof useFrontCamera>['state']) => void
  ref?: Ref<QRScannerHandle>
}

/**
 * The reader is laid out at a FIXED width and visually scaled with a CSS
 * transform to fit the screen. html5-qrcode maps its decode region using the
 * element's layout size, which transforms do not change — so rotating the
 * tablet only rescales the picture and never requires restarting the camera.
 */
const RENDER_WIDTH = 960
const ELEMENT_ID = 'front-camera-reader'

export function QRScanner({ onDecode, processing, ready, onStatusChange, ref }: QRScannerProps) {
  const { state, start, stop } = useFrontCamera({ elementId: ELEMENT_ID, onDecode, fps: SCAN_FPS })
  const viewportRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [frame, setFrame] = useState<number | null>(null)

  useImperativeHandle(ref, () => ({ stop, restart: start }), [stop, start])

  useEffect(() => {
    onStatusChange?.(state)
  }, [state, onStatusChange])

  // Fit the fixed-width reader into the available area (portrait or landscape).
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const reader = readerRef.current
    if (!viewport || !reader) return
    const update = () => {
      const readerHeight = reader.offsetHeight || (RENDER_WIDTH * 9) / 16
      const s = Math.min(viewport.clientWidth / RENDER_WIDTH, viewport.clientHeight / readerHeight)
      setScale(Number.isFinite(s) && s > 0 ? s : 1)
      const video = reader.querySelector('video')
      if (video && video.clientWidth > 0 && video.clientHeight > 0) {
        setFrame(computeQrBox(video.clientWidth, video.clientHeight).width)
      }
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(viewport)
    ro.observe(reader)
    return () => ro.disconnect()
  }, [])

  const running = state.status === 'running'

  return (
    <div className="scanner-stage">
      <div className="scanner-viewport" ref={viewportRef}>
        <div className="scanner-scaler" style={{ width: RENDER_WIDTH, transform: `translate(-50%, -50%) scale(${scale})` }}>
          <div id={ELEMENT_ID} className="scanner-reader" ref={readerRef} />
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
        <p className="scanner-prompt__title">Present Your QR Code</p>
        <p className="scanner-prompt__hint">Hold your phone screen facing this tablet&apos;s front camera</p>
        <span className={`ready-indicator ${processing ? 'ready-indicator--busy' : running && ready ? 'ready-indicator--ok' : ''}`}>
          {processing ? 'Processing…' : running ? (ready ? 'Ready to Scan' : 'Please wait…') : 'Camera not ready'}
        </span>
      </div>
    </div>
  )
}

function CameraStatusPanel({
  state,
  onRetry,
}: {
  state: ReturnType<typeof useFrontCamera>['state']
  onRetry: () => void
}) {
  if (state.status === 'starting' || state.status === 'idle') {
    return (
      <div className="camera-panel">
        <span className="spinner spinner--light" aria-hidden="true" />
        <p className="camera-panel__title">{state.message ?? 'Starting front camera…'}</p>
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
        <p className="camera-panel__title">Front Camera Access Denied</p>
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
    no_front_camera: 'Front Camera Not Available',
    in_use: 'Front Camera Busy',
    insecure: 'Secure Connection Required',
    unsupported: 'Camera Not Supported',
    error: 'Camera Error',
  }

  return (
    <div className="camera-panel camera-panel--error" role="alert">
      <p className="camera-panel__title">{titles[state.status] ?? 'Camera Error'}</p>
      {state.message && <p>{state.message}</p>}
      {state.status === 'no_front_camera' && (
        <p className="camera-panel__small">
          This scanner only uses the tablet&apos;s front (selfie) camera. Make sure no other app is using it, then retry.
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
