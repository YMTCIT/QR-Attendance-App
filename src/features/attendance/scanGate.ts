/**
 * ScanGate — the synchronous lock that decides whether a decoded QR string may
 * start a check-in request. It deliberately lives in a plain object held by a
 * React ref (not React state), because html5-qrcode can fire several decode
 * callbacks within one render frame.
 *
 * A code is accepted only when ALL of these hold:
 *   1. no request is in flight (`busy`),
 *   2. no result overlay is on screen (`held`),
 *   3. the cooldown since the last processed scan has elapsed,
 *   4. it is not the code we just processed while that code is still in view
 *      (per-code re-arm: the same code must leave the frame for `rearmMs`).
 *
 * The camera keeps capturing the whole time; only callbacks are ignored.
 * This is purely a scanning debounce — it has nothing to do with attendance
 * time-out, which this system does not have.
 */
export interface ScanGateOptions {
  cooldownMs: number
  rearmMs: number
}

export class ScanGate {
  private busy = false
  private held = false
  private unlockAt = 0
  private lastCode: string | null = null
  private lastCodeSeenAt = Number.NEGATIVE_INFINITY
  private readonly options: ScanGateOptions

  constructor(options: ScanGateOptions) {
    this.options = options
  }

  /** Returns true if this decode should start a request (and locks the gate). */
  tryAccept(code: string, now: number): boolean {
    if (!code) return false

    const sameAsLast = code === this.lastCode
    const lastSeenAt = this.lastCodeSeenAt
    if (sameAsLast) this.lastCodeSeenAt = now // still in view: keep pushing the re-arm window

    if (this.busy || this.held || now < this.unlockAt) return false
    if (sameAsLast && now - lastSeenAt < this.options.rearmMs) return false

    this.busy = true
    this.lastCode = code
    this.lastCodeSeenAt = now
    return true
  }

  /**
   * Request finished (any outcome). Starts the cooldown.
   * `rearmSameCode: false` forgets the last code so it can be retried as soon
   * as the gate opens (used after connection errors).
   */
  finish(now: number, { rearmSameCode = true }: { rearmSameCode?: boolean } = {}): void {
    this.busy = false
    this.unlockAt = now + this.options.cooldownMs
    if (!rearmSameCode) {
      this.lastCode = null
      this.lastCodeSeenAt = Number.NEGATIVE_INFINITY
    }
  }

  /** Block scanning while a result overlay is visible. */
  hold(): void {
    this.held = true
  }

  /** Overlay dismissed. */
  release(): void {
    this.held = false
  }

  get isBusy(): boolean {
    return this.busy
  }

  get isHeld(): boolean {
    return this.held
  }

  /** True when a new code would be accepted at `now`. */
  isReady(now: number): boolean {
    return !this.busy && !this.held && now >= this.unlockAt
  }

  reset(): void {
    this.busy = false
    this.held = false
    this.unlockAt = 0
    this.lastCode = null
    this.lastCodeSeenAt = Number.NEGATIVE_INFINITY
  }
}
