/**
 * Scanner tuning. Change the defaults here, or override per deployment with
 * the optional VITE_* variables (see .env.example).
 *
 * SCAN_COOLDOWN_MS is ONLY a QR-scanning debounce. It is not, and must never
 * become, an attendance "time-out" feature.
 */

function readMs(name: string, fallback: number, min: number, max: number): number {
  const raw = (import.meta.env as Record<string, string | undefined>)[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[config] Ignoring ${name}=${raw}; expected ${min}-${max}. Using ${fallback}.`)
    return fallback
  }
  return Math.round(value)
}

/**
 * Minimum gap after a scan is processed before another is accepted. 500 / 800
 * / 1000 are typical. Successful check-ins show no overlay, so this is the only
 * pause before the next attendee can scan.
 */
export const SCAN_COOLDOWN_MS = readMs('VITE_SCAN_COOLDOWN_MS', 500, 300, 5000)

/**
 * How long the success highlight animation runs on the newest attendance-log
 * row. (Successful check-ins no longer show a full-screen overlay; the name
 * goes straight to the log.) The row stays marked until the next check-in.
 */
export const SUCCESS_OVERLAY_MS = readMs('VITE_SUCCESS_OVERLAY_MS', 1200, 500, 10000)

/** How often the scanner's attendance log re-syncs (picks up other tablets and manual check-ins). */
export const CHECK_IN_LOG_REFRESH_MS = readMs('VITE_CHECK_IN_LOG_REFRESH_MS', 10000, 3000, 120000)

/** Number of most recent check-ins shown in the scanner's attendance log. */
export const CHECK_IN_LOG_LIMIT = 50

/** How long duplicate / invalid / error overlays stay up. */
export const ERROR_OVERLAY_MS = readMs('VITE_ERROR_OVERLAY_MS', 2500, 500, 15000)

/**
 * Per-code re-arm: after a code has been processed, the SAME code is ignored
 * until it has been out of view for at least this long. Stops one phone held
 * in front of the camera from firing repeated requests.
 */
export const SAME_CODE_REARM_MS = readMs('VITE_SAME_CODE_REARM_MS', 1000, 200, 10000)

/**
 * Decode attempts per second (the whole frame is decoded each time). 15 picks
 * a code up quickly on the Xiaomi Pad 7, which decodes natively.
 */
export const SCAN_FPS = readMs('VITE_SCAN_FPS', 15, 2, 30)

/** Check-in request timeout before showing CONNECTION ERROR. */
export const CHECK_IN_TIMEOUT_MS = readMs('VITE_CHECK_IN_TIMEOUT_MS', 10000, 2000, 30000)

/** Fallback poll for active-event changes when Realtime is unavailable. */
export const ACTIVE_EVENT_POLL_MS = 30_000

/** Timezone used for every displayed date/time. */
export const DISPLAY_TIMEZONE = 'Asia/Manila'

/** Registration import limits. */
export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
export const IMPORT_MAX_ROWS = 20_000
export const IMPORT_BATCH_SIZE = 500
