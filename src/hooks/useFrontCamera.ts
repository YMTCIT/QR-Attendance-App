import { useCallback, useEffect, useRef, useState } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import {
  chooseFrontDevice,
  classifyCameraError,
  verifyRunningTrack,
  type CameraErrorKind,
  type VideoDeviceCandidate,
} from '../lib/cameraSelection'

/**
 * useFrontCamera — continuous QR scanning with the tablet's FRONT camera.
 *
 *  - Requests facingMode {exact: "user"} first. If the browser cannot satisfy
 *    that, it looks for the front camera by device capabilities / label and
 *    opens it by deviceId. It NEVER falls back to a rear camera: if the camera
 *    that opened reports itself as rear-facing, scanning is stopped and an
 *    error is shown.
 *  - The camera session stays open while the page is visible. Result overlays
 *    are drawn on top; decode callbacks are simply ignored by the caller's
 *    ScanGate. Nothing here restarts the camera after a scan.
 *  - Start/stop operations are serialised through a promise chain so React
 *    Strict Mode's mount → unmount → mount cannot leave two cameras open.
 *  - When Android suspends the camera (page hidden, screen off), the stream
 *    is re-opened when the page becomes visible again.
 *  - Only the decoded text leaves this hook. Frames are never stored or sent.
 */

export type CameraStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'denied'
  | 'no_front_camera'
  | 'in_use'
  | 'insecure'
  | 'unsupported'
  | 'error'

export interface CameraState {
  status: CameraStatus
  message: string | null
  /** 'verified' = browser reported a front-facing camera; 'unverified' = could not be determined. */
  verification: 'verified' | 'unverified' | null
  label: string | null
}

interface Options {
  elementId: string
  onDecode: (text: string) => void
  fps: number
  autoStart?: boolean
}

const RESOLUTION: MediaTrackConstraints = {
  // 720p is plenty for phone-screen QR codes at arm's length and keeps decode
  // cost low on the tablet. The browser picks the closest supported mode.
  width: { ideal: 1280 },
  height: { ideal: 720 },
}

const MAX_AUTO_RESTARTS = 3
const AUTO_RESTART_WINDOW_MS = 60_000

/** Square decode region, ~72% of the shorter side; adapts to orientation. */
export function computeQrBox(viewW: number, viewH: number): { width: number; height: number } {
  const shorter = Math.min(viewW, viewH)
  const size = Math.max(Math.min(shorter, 120), Math.floor(shorter * 0.72))
  return { width: size, height: size }
}

function getVideoElement(elementId: string): HTMLVideoElement | null {
  return document.getElementById(elementId)?.querySelector('video') ?? null
}

function getVideoTrack(elementId: string): MediaStreamTrack | null {
  const stream = getVideoElement(elementId)?.srcObject
  if (stream && typeof stream === 'object' && 'getVideoTracks' in stream) {
    return (stream as MediaStream).getVideoTracks()[0] ?? null
  }
  return null
}

async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
}

/** Find the front camera's deviceId using capabilities, then labels. */
async function findFrontDeviceId(): Promise<string | null> {
  let devices = await listVideoInputs()
  if (devices.length === 0) return null

  if (devices.every((d) => !d.label)) {
    // Labels are hidden until camera permission is granted. Briefly open a
    // user-facing stream (non-exact) only to unlock labels, then close it.
    // It is never used for scanning.
    const probe = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
    probe.getTracks().forEach((t) => t.stop())
    devices = await listVideoInputs()
  }

  const candidates: VideoDeviceCandidate[] = devices.map((d) => {
    let facingModes: string[] | undefined
    const withCaps = d as MediaDeviceInfo & { getCapabilities?: () => MediaTrackCapabilities }
    if (typeof withCaps.getCapabilities === 'function') {
      try {
        facingModes = withCaps.getCapabilities().facingMode
      } catch {
        facingModes = undefined
      }
    }
    return { deviceId: d.deviceId, label: d.label, facingModes }
  })
  return chooseFrontDevice(candidates)
}

function messageFor(kind: CameraErrorKind): { status: CameraStatus; message: string } {
  switch (kind) {
    case 'denied':
      return { status: 'denied', message: 'Please allow camera access and try again.' }
    case 'in_use':
      return {
        status: 'in_use',
        message: 'The front camera is busy. Close other apps or tabs that use the camera, then retry.',
      }
    case 'insecure':
      return { status: 'insecure', message: 'Camera access requires HTTPS. Open the secure (https://) address.' }
    case 'not_found':
    case 'overconstrained':
      return {
        status: 'no_front_camera',
        message: 'No front-facing camera could be found. Scanning will not use the rear camera.',
      }
    default:
      return { status: 'error', message: 'The front camera could not be started.' }
  }
}

export function useFrontCamera({ elementId, onDecode, fps, autoStart = true }: Options) {
  const [state, setState] = useState<CameraState>({ status: 'idle', message: null, verification: null, label: null })

  const scannerRef = useRef<Html5Qrcode | null>(null)
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const wantRunningRef = useRef(false)
  const wasRunningRef = useRef(false)
  const restartTimesRef = useRef<number[]>([])
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const onDecodeRef = useRef(onDecode)

  useEffect(() => {
    onDecodeRef.current = onDecode
  }, [onDecode])

  /** Serialise camera operations. */
  const enqueue = useCallback((op: () => Promise<void>): Promise<void> => {
    const next = chainRef.current.then(op, op)
    chainRef.current = next.catch(() => undefined)
    return next
  }, [])

  const handleTrackEndedRef = useRef<() => void>(() => undefined)
  // One stable listener object, so add/removeEventListener always match.
  const [trackEndedListener] = useState(() => () => handleTrackEndedRef.current())

  const stopInternal = useCallback(async () => {
    const track = trackRef.current
    if (track) track.removeEventListener('ended', trackEndedListener)
    trackRef.current = null

    const scanner = scannerRef.current
    scannerRef.current = null
    if (!scanner) return
    try {
      if (scanner.isScanning) await scanner.stop()
    } catch {
      // already stopped
    }
    try {
      scanner.clear()
    } catch {
      // element may already be gone on unmount
    }
  }, [trackEndedListener])

  const startInternal = useCallback(async () => {
    if (!wantRunningRef.current || scannerRef.current) return

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setState({ status: 'insecure', message: messageFor('insecure').message, verification: null, label: null })
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({
        status: 'unsupported',
        message: 'This browser cannot access the camera. Use Google Chrome on the tablet.',
        verification: null,
        label: null,
      })
      return
    }

    setState({ status: 'starting', message: null, verification: null, label: null })

    const open = async (selector: MediaTrackConstraints) => {
      const scanner = new Html5Qrcode(elementId, {
        verbose: false,
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        useBarCodeDetectorIfSupported: true,
      })
      scannerRef.current = scanner
      try {
        await scanner.start(
          selector,
          {
            fps,
            qrbox: computeQrBox,
            // Try both orientations of each frame, so codes decode whether
            // or not anything in the pipeline mirrors the image.
            disableFlip: false,
            videoConstraints: { ...selector, ...RESOLUTION },
          },
          (decodedText) => onDecodeRef.current(decodedText),
          () => undefined, // "no QR in this frame" — expected ~10x per second
        )
      } catch (error) {
        scannerRef.current = null
        try {
          scanner.clear()
        } catch {
          // ignore
        }
        throw error
      }
    }

    try {
      try {
        await open({ facingMode: { exact: 'user' } })
      } catch (error) {
        const kind = classifyCameraError(error)
        if (kind === 'denied' || kind === 'in_use' || kind === 'insecure') throw error
        // The browser could not satisfy facingMode: exact "user". Identify the
        // front camera explicitly instead — never fall back to "any camera".
        const deviceId = await findFrontDeviceId()
        if (!deviceId) {
          setState({ status: 'no_front_camera', message: messageFor('not_found').message, verification: null, label: null })
          return
        }
        if (!wantRunningRef.current) return
        await open({ deviceId: { exact: deviceId } })
      }
    } catch (error) {
      const { status, message } = messageFor(classifyCameraError(error))
      setState({ status, message, verification: null, label: null })
      return
    }

    // Verify the camera that actually opened.
    const track = getVideoTrack(elementId)
    const verification = verifyRunningTrack(track?.getSettings?.().facingMode, track?.label)
    if (verification === 'back') {
      await stopInternal()
      setState({
        status: 'no_front_camera',
        message: 'The browser opened a rear-facing camera, so scanning was stopped. Only the front camera may be used.',
        verification: null,
        label: track?.label ?? null,
      })
      return
    }

    if (!wantRunningRef.current) {
      await stopInternal()
      return
    }

    if (track) {
      trackRef.current = track
      track.addEventListener('ended', trackEndedListener)
    }
    wasRunningRef.current = true
    setState({
      status: 'running',
      message: null,
      verification: verification === 'front' ? 'verified' : 'unverified',
      label: track?.label ?? null,
    })
  }, [elementId, fps, stopInternal, trackEndedListener])

  /** Re-open the stream after Android suspended or ended it (rate-limited). */
  const autoRestart = useCallback(() => {
    if (!wantRunningRef.current || document.visibilityState !== 'visible') return
    const now = Date.now()
    restartTimesRef.current = restartTimesRef.current.filter((t) => now - t < AUTO_RESTART_WINDOW_MS)
    if (restartTimesRef.current.length >= MAX_AUTO_RESTARTS) {
      setState({
        status: 'error',
        message: 'The camera keeps stopping. Tap Retry Camera.',
        verification: null,
        label: null,
      })
      return
    }
    restartTimesRef.current.push(now)
    void enqueue(stopInternal).then(() => enqueue(startInternal))
  }, [enqueue, startInternal, stopInternal])

  useEffect(() => {
    handleTrackEndedRef.current = () => {
      setState((s) => ({ ...s, status: 'starting', message: 'Reconnecting camera…' }))
      autoRestart()
    }
  }, [autoRestart])

  const start = useCallback(() => {
    wantRunningRef.current = true
    restartTimesRef.current = []
    return enqueue(async () => {
      // A manual retry after an error: make sure nothing half-open is left.
      if (scannerRef.current && !scannerRef.current.isScanning) await stopInternal()
      await startInternal()
    })
  }, [enqueue, startInternal, stopInternal])

  const stop = useCallback(() => {
    wantRunningRef.current = false
    wasRunningRef.current = false
    return enqueue(stopInternal).then(() =>
      setState({ status: 'idle', message: null, verification: null, label: null }),
    )
  }, [enqueue, stopInternal])

  // Mount / unmount.
  useEffect(() => {
    if (autoStart) {
      wantRunningRef.current = true
      void enqueue(startInternal)
    }
    return () => {
      wantRunningRef.current = false
      void enqueue(stopInternal)
    }
  }, [autoStart, enqueue, startInternal, stopInternal])

  // Recover when the page becomes visible again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' || !wantRunningRef.current || !wasRunningRef.current) return
      const track = trackRef.current
      const video = getVideoElement(elementId)
      const healthy = !!scannerRef.current && !!track && track.readyState === 'live'
      if (healthy) {
        if (video?.paused) void video.play().catch(() => autoRestart())
        return
      }
      autoRestart()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [elementId, autoRestart])

  return { state, start, stop }
}
