import { useCallback, useEffect, useRef, useState } from 'react'
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode'
import {
  chooseDevice,
  classifyCameraError,
  facingModeFor,
  verifyRunningTrack,
  type CameraChoice,
  type CameraErrorKind,
  type VideoDeviceCandidate,
} from '../lib/cameraSelection'

/**
 * useCamera — continuous QR scanning with the tablet's FRONT (default) or
 * BACK camera.
 *
 *  - Requests facingMode {exact: "user" | "environment"} first. If the browser
 *    cannot satisfy that, it looks for the wanted camera by device
 *    capabilities / label and opens it by deviceId. It NEVER falls back to the
 *    other camera: if the camera that opened reports the opposite direction,
 *    scanning is stopped and an error is shown.
 *  - The WHOLE frame is decoded (no centre-only region), so a code is picked
 *    up as soon as it is anywhere in view. Android Chrome's native
 *    BarcodeDetector is used when available.
 *  - The camera session stays open while the page is visible. Result overlays
 *    are drawn on top; decode callbacks are simply ignored by the caller's
 *    ScanGate. Nothing here restarts the camera after a scan. Changing
 *    `facing` closes the current camera and opens the other one.
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
  | 'not_found'
  | 'in_use'
  | 'insecure'
  | 'unsupported'
  | 'error'

export interface CameraState {
  status: CameraStatus
  message: string | null
  /** 'verified' = browser reported the expected direction; 'unverified' = could not be determined. */
  verification: 'verified' | 'unverified' | null
  label: string | null
  /** The camera this state refers to. */
  facing: CameraChoice
}

interface Options {
  elementId: string
  onDecode: (text: string) => void
  fps: number
  facing: CameraChoice
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

const CAMERA_NAME: Record<CameraChoice, string> = { front: 'front', back: 'back' }

/**
 * Size of the gold guide frame drawn over the preview: a square ~72% of the
 * shorter side. It is only a visual guide; the whole frame is decoded.
 */
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

/** Find the wanted camera's deviceId using capabilities, then labels. */
async function findDeviceId(want: CameraChoice): Promise<string | null> {
  let devices = await listVideoInputs()
  if (devices.length === 0) return null

  if (devices.every((d) => !d.label)) {
    // Labels are hidden until camera permission is granted. Briefly open a
    // stream (non-exact) only to unlock labels, then close it. It is never
    // used for scanning.
    const probe = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facingModeFor(want) }, audio: false })
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
  return chooseDevice(candidates, want)
}

function messageFor(kind: CameraErrorKind, facing: CameraChoice): { status: CameraStatus; message: string } {
  const name = CAMERA_NAME[facing]
  const other = CAMERA_NAME[facing === 'front' ? 'back' : 'front']
  switch (kind) {
    case 'denied':
      return { status: 'denied', message: 'Please allow camera access and try again.' }
    case 'in_use':
      return {
        status: 'in_use',
        message: `The ${name} camera is busy. Close other apps or tabs that use the camera, then retry.`,
      }
    case 'insecure':
      return { status: 'insecure', message: 'Camera access requires HTTPS. Open the secure (https://) address.' }
    case 'not_found':
    case 'overconstrained':
      return {
        status: 'not_found',
        message: `No ${name}-facing camera could be found. Scanning will not use the ${other} camera unless you switch to it.`,
      }
    default:
      return { status: 'error', message: `The ${name} camera could not be started.` }
  }
}

export function useCamera({ elementId, onDecode, fps, facing, autoStart = true }: Options) {
  const [state, setState] = useState<CameraState>({
    status: 'idle',
    message: null,
    verification: null,
    label: null,
    facing,
  })

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

    const fail = (status: CameraStatus, message: string, label: string | null = null) =>
      setState({ status, message, verification: null, label, facing })

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      fail('insecure', messageFor('insecure', facing).message)
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      fail('unsupported', 'This browser cannot access the camera. Use Google Chrome on the tablet.')
      return
    }

    setState({ status: 'starting', message: null, verification: null, label: null, facing })

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
            // No qrbox: decode the WHOLE frame, so a code is read as soon as
            // it appears anywhere in view (the gold frame is only a guide).
            // Try both orientations of each frame, so codes decode whether
            // or not anything in the pipeline mirrors the image.
            disableFlip: false,
            videoConstraints: { ...selector, ...RESOLUTION },
          },
          (decodedText) => onDecodeRef.current(decodedText),
          () => undefined, // "no QR in this frame" — expected many times per second
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
        await open({ facingMode: { exact: facingModeFor(facing) } })
      } catch (error) {
        const kind = classifyCameraError(error)
        if (kind === 'denied' || kind === 'in_use' || kind === 'insecure') throw error
        // The browser could not satisfy the exact facingMode. Identify the
        // wanted camera explicitly instead — never fall back to "any camera".
        const deviceId = await findDeviceId(facing)
        if (!deviceId) {
          fail('not_found', messageFor('not_found', facing).message)
          return
        }
        if (!wantRunningRef.current) return
        await open({ deviceId: { exact: deviceId } })
      }
    } catch (error) {
      const { status, message } = messageFor(classifyCameraError(error), facing)
      fail(status, message)
      return
    }

    // Verify the camera that actually opened.
    const track = getVideoTrack(elementId)
    const verification = verifyRunningTrack(track?.getSettings?.().facingMode, track?.label)
    if (verification !== 'unverified' && verification !== facing) {
      await stopInternal()
      fail(
        'not_found',
        `The browser opened the ${CAMERA_NAME[verification]} camera instead of the ${CAMERA_NAME[facing]} camera, so scanning was stopped.`,
        track?.label ?? null,
      )
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
      verification: verification === facing ? 'verified' : 'unverified',
      label: track?.label ?? null,
      facing,
    })
  }, [elementId, facing, fps, stopInternal, trackEndedListener])

  /** Re-open the stream after Android suspended or ended it (rate-limited). */
  const autoRestart = useCallback(() => {
    if (!wantRunningRef.current || document.visibilityState !== 'visible') return
    const now = Date.now()
    restartTimesRef.current = restartTimesRef.current.filter((t) => now - t < AUTO_RESTART_WINDOW_MS)
    if (restartTimesRef.current.length >= MAX_AUTO_RESTARTS) {
      setState((s) => ({
        status: 'error',
        message: 'The camera keeps stopping. Tap Retry Camera.',
        verification: null,
        label: null,
        facing: s.facing,
      }))
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
      setState((s) => ({ status: 'idle', message: null, verification: null, label: null, facing: s.facing })),
    )
  }, [enqueue, stopInternal])

  // Mount / unmount — and switching cameras: a new `facing` gives a new
  // startInternal, so this closes the current camera and opens the other.
  useEffect(() => {
    if (autoStart) {
      wantRunningRef.current = true
      restartTimesRef.current = []
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
        if (video?.paused) void video.play()?.catch(() => autoRestart())
        return
      }
      autoRestart()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [elementId, autoRestart])

  return { state, start, stop }
}
