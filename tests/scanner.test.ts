/**
 * Scanner logic: scan gate (cooldown, in-flight lock, per-code re-arm, overlay
 * hold), front-camera selection, and decode-region sizing.
 */
import { describe, expect, it } from 'vitest'
import { ScanGate } from '../src/features/attendance/scanGate'
import {
  chooseFrontDevice,
  classifyCameraError,
  classifyLabel,
  verifyRunningTrack,
} from '../src/lib/cameraSelection'
import { computeQrBox } from '../src/hooks/useFrontCamera'
import { SCAN_COOLDOWN_MS, SUCCESS_OVERLAY_MS } from '../src/config'

const opts = { cooldownMs: 800, rearmMs: 1000 }

describe('config defaults', () => {
  it('uses an 800 ms scan cooldown and a separate 1200 ms success overlay', () => {
    expect(SCAN_COOLDOWN_MS).toBe(800)
    expect(SUCCESS_OVERLAY_MS).toBe(1200)
  })
})

describe('ScanGate', () => {
  it('accepts the first code and blocks overlapping callbacks synchronously', () => {
    const g = new ScanGate(opts)
    expect(g.tryAccept('A', 0)).toBe(true)
    // 10 more decode callbacks in the same instant (same or different code)
    for (let i = 0; i < 10; i++) {
      expect(g.tryAccept('A', i)).toBe(false)
      expect(g.tryAccept('B', i)).toBe(false)
    }
    expect(g.isBusy).toBe(true)
  })

  it('stays locked while the server is slow (longer than the cooldown)', () => {
    const g = new ScanGate(opts)
    g.tryAccept('A', 0)
    expect(g.tryAccept('B', 5_000)).toBe(false) // request still pending after 5 s
    g.finish(5_000)
    expect(g.tryAccept('B', 5_100)).toBe(false) // inside cooldown
    expect(g.tryAccept('B', 5_800)).toBe(true) // cooldown elapsed
  })

  it.each([500, 800, 1000])('honours a configurable cooldown of %i ms', (cooldownMs) => {
    const g = new ScanGate({ cooldownMs, rearmMs: 0 })
    g.tryAccept('A', 0)
    g.finish(100)
    expect(g.tryAccept('B', 100 + cooldownMs - 1)).toBe(false)
    expect(g.tryAccept('B', 100 + cooldownMs)).toBe(true)
  })

  it('blocks everything while an overlay is held, then a different code is accepted', () => {
    const g = new ScanGate(opts)
    g.tryAccept('A', 0)
    g.finish(200)
    g.hold()
    expect(g.tryAccept('B', 5_000)).toBe(false)
    g.release()
    expect(g.tryAccept('B', 5_001)).toBe(true)
  })

  it('ignores the same QR while it stays in the frame (per-code re-arm)', () => {
    const g = new ScanGate(opts)
    g.tryAccept('A', 0)
    g.finish(300)
    g.hold()
    // Phone still held up: decodes keep arriving every 100 ms during the overlay.
    for (let t = 300; t <= 1500; t += 100) g.tryAccept('A', t)
    g.release()
    // Still in view right after the overlay closes → ignored, no new request.
    for (let t = 1600; t <= 4000; t += 100) expect(g.tryAccept('A', t)).toBe(false)
    // Taken away for > rearmMs, then shown again deliberately → accepted (server says "already").
    expect(g.tryAccept('A', 5_100)).toBe(true)
  })

  it('lets the same code retry right away after a connection error', () => {
    const g = new ScanGate(opts)
    g.tryAccept('A', 0)
    g.finish(100, { rearmSameCode: false })
    expect(g.tryAccept('A', 900)).toBe(true)
  })

  it('ignores empty strings', () => {
    expect(new ScanGate(opts).tryAccept('', 0)).toBe(false)
  })
})

describe('front camera selection', () => {
  it('classifies typical Android Chrome labels', () => {
    expect(classifyLabel('camera2 1, facing front')).toBe('front')
    expect(classifyLabel('camera2 0, facing back')).toBe('back')
    expect(classifyLabel('Front Camera')).toBe('front')
    expect(classifyLabel('Rear Camera')).toBe('back')
    expect(classifyLabel('USB Camera')).toBe('unknown')
    expect(classifyLabel('')).toBe('unknown')
  })

  it('prefers capability data, then labels, and never returns a rear camera', () => {
    expect(
      chooseFrontDevice([
        { deviceId: 'rear', label: 'camera2 0, facing back', facingModes: ['environment'] },
        { deviceId: 'front', label: 'camera2 1, facing front', facingModes: ['user'] },
      ]),
    ).toBe('front')

    expect(
      chooseFrontDevice([
        { deviceId: 'rear', label: 'camera2 0, facing back' },
        { deviceId: 'front', label: 'camera2 1, facing front' },
      ]),
    ).toBe('front')

    // Mislabelled device whose capabilities say "environment" must be rejected.
    expect(chooseFrontDevice([{ deviceId: 'x', label: 'front?', facingModes: ['environment'] }])).toBeNull()
  })

  it('returns null rather than guessing when no front camera is identifiable', () => {
    expect(chooseFrontDevice([{ deviceId: 'rear', label: 'camera2 0, facing back' }])).toBeNull()
    expect(chooseFrontDevice([{ deviceId: 'u', label: 'Integrated Camera' }])).toBeNull()
    expect(chooseFrontDevice([])).toBeNull()
  })

  it('verifies the opened track and detects a rear camera', () => {
    expect(verifyRunningTrack('user', '')).toBe('front')
    expect(verifyRunningTrack('environment', 'facing front')).toBe('back')
    expect(verifyRunningTrack(undefined, 'camera2 1, facing front')).toBe('front')
    expect(verifyRunningTrack(undefined, 'camera2 0, facing back')).toBe('back')
    expect(verifyRunningTrack(undefined, 'Webcam')).toBe('unverified')
  })

  it('classifies camera errors without an infinite retry path', () => {
    expect(classifyCameraError(new DOMException('Permission denied', 'NotAllowedError'))).toBe('denied')
    expect(classifyCameraError('Error getting userMedia, error = NotAllowedError: Permission denied')).toBe('denied')
    expect(classifyCameraError(new DOMException('x', 'OverconstrainedError'))).toBe('overconstrained')
    expect(classifyCameraError(new DOMException('x', 'NotFoundError'))).toBe('not_found')
    expect(classifyCameraError(new DOMException('Could not start video source', 'NotReadableError'))).toBe('in_use')
    expect(classifyCameraError(new Error('weird'))).toBe('unknown')
  })
})

describe('decode region', () => {
  it('is a centred square sized to the shorter side, in both orientations', () => {
    expect(computeQrBox(960, 540)).toEqual({ width: 388, height: 388 })
    expect(computeQrBox(540, 960)).toEqual({ width: 388, height: 388 })
    const tiny = computeQrBox(100, 80)
    expect(tiny.width).toBeLessThanOrEqual(80)
  })
})
