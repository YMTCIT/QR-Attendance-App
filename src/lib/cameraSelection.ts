/**
 * Front-camera identification helpers (pure functions, unit-tested).
 *
 * Browsers do not always honour facingMode, and labels are not standardised.
 * Android Chrome usually labels cameras "camera2 1, facing front" /
 * "camera2 0, facing back". We therefore combine, in order of trust:
 *   1. MediaTrackSettings.facingMode / InputDeviceInfo capabilities ("user")
 *   2. the device label
 * and we NEVER pick a device that looks like a rear camera, nor an unknown
 * device when a rear camera might be the only match.
 */

export type CameraFacing = 'front' | 'back' | 'unknown'

const FRONT_LABEL = /\b(front|user|selfie|facetime|facing front)\b|前置|前面/i
const BACK_LABEL = /\b(back|rear|environment|world|facing back)\b|后置|後置|背面/i

export function classifyLabel(label: string | undefined | null): CameraFacing {
  if (!label) return 'unknown'
  const back = BACK_LABEL.test(label)
  const front = FRONT_LABEL.test(label)
  if (back && !front) return 'back'
  if (front && !back) return 'front'
  return 'unknown'
}

export function classifyFacingMode(modes: string | string[] | undefined | null): CameraFacing {
  const list = Array.isArray(modes) ? modes : modes ? [modes] : []
  if (list.includes('user')) return 'front'
  if (list.includes('environment')) return 'back'
  return 'unknown'
}

export interface VideoDeviceCandidate {
  deviceId: string
  label: string
  /** facingMode values from InputDeviceInfo.getCapabilities(), when available. */
  facingModes?: string[]
}

/**
 * Picks the front camera's deviceId, or null if none can be identified.
 * Capability data wins over labels; rear-looking devices are excluded.
 */
export function chooseFrontDevice(devices: VideoDeviceCandidate[]): string | null {
  const byCapability = devices.find((d) => classifyFacingMode(d.facingModes) === 'front')
  if (byCapability) return byCapability.deviceId

  const byLabel = devices.find(
    (d) => classifyFacingMode(d.facingModes) !== 'back' && classifyLabel(d.label) === 'front',
  )
  return byLabel ? byLabel.deviceId : null
}

export type TrackVerification = 'front' | 'back' | 'unverified'

/** Verifies the camera that actually opened. */
export function verifyRunningTrack(settingsFacingMode: string | undefined, label: string | undefined): TrackVerification {
  const fromSettings = classifyFacingMode(settingsFacingMode)
  if (fromSettings === 'front') return 'front'
  if (fromSettings === 'back') return 'back'
  const fromLabel = classifyLabel(label)
  if (fromLabel === 'front') return 'front'
  if (fromLabel === 'back') return 'back'
  return 'unverified'
}

export type CameraErrorKind = 'denied' | 'not_found' | 'overconstrained' | 'in_use' | 'insecure' | 'unknown'

/** html5-qrcode rejects with DOMExceptions or plain strings — normalise both. */
export function classifyCameraError(error: unknown): CameraErrorKind {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : ''
  const text = `${name} ${String(error)}`
  if (/NotAllowedError|PermissionDenied|Permission denied|SecurityError/i.test(text)) return 'denied'
  if (/OverconstrainedError|ConstraintNotSatisfied/i.test(text)) return 'overconstrained'
  if (/NotFoundError|DevicesNotFound|Requested device not found/i.test(text)) return 'not_found'
  if (/NotReadableError|TrackStartError|Could not start video source/i.test(text)) return 'in_use'
  if (/secure context|https/i.test(text)) return 'insecure'
  return 'unknown'
}
