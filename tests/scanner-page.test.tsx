/**
 * Integration test for the scanner page with a fake html5-qrcode camera.
 * Proves the camera session is started ONCE and is never stopped/restarted by
 * result overlays, that rapid duplicate decodes send ONE request, that a
 * full-screen overlay shows the attendee name and auto-dismisses, and that a
 * connection error is never displayed as success.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScanOutcome } from '../src/types/attendance'

// ---- fake camera ----------------------------------------------------------
const camera = vi.hoisted(() => ({
  starts: 0,
  stops: 0,
  constructed: 0,
  lastSelector: null as unknown,
  onSuccess: null as null | ((text: string) => void),
}))

vi.mock('html5-qrcode', () => {
  class FakeHtml5Qrcode {
    isScanning = false
    private readonly id: string
    constructor(id: string) {
      this.id = id
      camera.constructed++
    }
    async start(selector: unknown, _config: unknown, onSuccess: (t: string) => void) {
      camera.starts++
      camera.lastSelector = selector
      camera.onSuccess = onSuccess
      const video = document.createElement('video')
      const track = {
        label: 'camera2 1, facing front',
        readyState: 'live',
        getSettings: () => ({ facingMode: 'user' }),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }
      Object.defineProperty(video, 'srcObject', { value: { getVideoTracks: () => [track] } })
      document.getElementById(this.id)?.appendChild(video)
      this.isScanning = true
      return null
    }
    async stop() {
      camera.stops++
      this.isScanning = false
    }
    clear() {
      const el = document.getElementById(this.id)
      if (el) el.innerHTML = ''
    }
  }
  return { Html5Qrcode: FakeHtml5Qrcode, Html5QrcodeSupportedFormats: { QR_CODE: 0 } }
})

// ---- fake app services ------------------------------------------------------
const submitCheckIn = vi.hoisted(() => vi.fn<(code: string) => Promise<ScanOutcome>>())
vi.mock('../src/features/attendance/api', () => ({ submitCheckIn }))

vi.mock('../src/hooks/useAuth', () => ({
  useAuth: () => ({ role: 'scanner', email: 'staff@example.test', signOut: vi.fn(async () => undefined) }),
}))

vi.mock('../src/hooks/useActiveEvent', () => ({
  useActiveEvent: () => ({
    event: { id: 1, name: 'CIT University Event', date: '2026-12-01', venue: 'Gym' },
    loading: false,
    error: null,
    realtime: 'connected',
    lastChecked: new Date(),
    refresh: vi.fn(async () => undefined),
  }),
}))

beforeAll(() => {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(), enumerateDevices: vi.fn(async () => []) },
    configurable: true,
  })
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  camera.starts = 0
  camera.stops = 0
  camera.constructed = 0
  camera.onSuccess = null
  submitCheckIn.mockReset()
})

afterEach(() => cleanup())

async function renderScanner() {
  const { default: ScannerPage } = await import('../src/pages/ScannerPage')
  render(createElement(MemoryRouter, null, createElement(ScannerPage)))
  await waitFor(() => expect(camera.onSuccess).not.toBeNull())
  await screen.findByText('Ready to Scan')
}

function decode(text: string) {
  act(() => camera.onSuccess!(text))
}

describe('ScannerPage (front camera, continuous session)', () => {
  it('requests the FRONT camera with an exact facingMode constraint', async () => {
    await renderScanner()
    expect(camera.lastSelector).toEqual({ facingMode: { exact: 'user' } })
    // The header pill updates one render after the camera reports "running".
    expect(await screen.findByText('Front camera')).toBeTruthy()
    expect(screen.getByText('Present Your QR Code')).toBeTruthy()
    expect(screen.getByText('CIT University Event')).toBeTruthy()
  })

  it('sends one request for a burst of decodes, shows the name full-screen, auto-dismisses, and keeps the same camera', async () => {
    submitCheckIn.mockResolvedValue({
      status: 'ok',
      name: 'Juan Dela Cruz',
      event_name: 'CIT University Event',
      scanned_at: '2026-12-01T00:35:00Z',
    })
    await renderScanner()
    const startsBefore = camera.starts

    for (let i = 0; i < 8; i++) decode('ABC001')
    expect(submitCheckIn).toHaveBeenCalledTimes(1)
    expect(submitCheckIn).toHaveBeenCalledWith('ABC001')

    expect(await screen.findByText('Juan Dela Cruz')).toBeTruthy()
    expect(screen.getByText('WELCOME!')).toBeTruthy()
    expect(screen.getByText('CHECK-IN SUCCESSFUL')).toBeTruthy()
    expect(screen.getByText('Attendance Recorded')).toBeTruthy()

    // While the overlay is up, other codes are ignored.
    decode('ABC002')
    expect(submitCheckIn).toHaveBeenCalledTimes(1)

    // The overlay disappears on its own (SUCCESS_OVERLAY_MS = 1200).
    await waitFor(() => expect(screen.queryByText('Juan Dela Cruz')).toBeNull(), { timeout: 3000 })

    // Same camera session the whole time: no restart, no stop.
    expect(camera.starts).toBe(startsBefore)
    expect(camera.stops).toBe(0)
    expect(document.querySelector('#front-camera-reader video')).not.toBeNull()

    // A different attendee is accepted on the same session.
    submitCheckIn.mockResolvedValueOnce({ status: 'already', name: 'Maria Santos', scanned_at: '2026-12-01T00:35:00Z' })
    decode('ABC002')
    expect(submitCheckIn).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('ALREADY CHECKED IN')).toBeTruthy()
    expect(screen.getByText('Maria Santos')).toBeTruthy()
    expect(screen.getByText(/Checked in at: 8:35 AM/)).toBeTruthy()
    expect(camera.starts).toBe(startsBefore)
  }, 15_000)

  it('never shows success for a connection error', async () => {
    submitCheckIn.mockResolvedValue({ status: 'network_error', detail: 'timeout' })
    await renderScanner()
    decode('ABC003')
    expect(await screen.findByText('CONNECTION ERROR')).toBeTruthy()
    expect(screen.getByText('Attendance could not be confirmed.')).toBeTruthy()
    expect(screen.queryByText('WELCOME!')).toBeNull()
    expect(screen.queryByText('Attendance Recorded')).toBeNull()
  })

  it.each([
    [{ status: 'invalid' } as ScanOutcome, 'INVALID QR CODE', 'This QR code is not registered.'],
    [{ status: 'wrong_event' } as ScanOutcome, 'NOT REGISTERED FOR THIS EVENT', 'This QR code is not registered for the active event.'],
    [{ status: 'no_event' } as ScanOutcome, 'NO ACTIVE EVENT', 'Please contact the administrator.'],
  ])('shows the %s overlay', async (outcome, title, line) => {
    submitCheckIn.mockResolvedValue(outcome)
    await renderScanner()
    decode('ZZZ')
    expect(await screen.findByText(title)).toBeTruthy()
    expect(screen.getAllByText(line).length).toBeGreaterThan(0)
  })
})
