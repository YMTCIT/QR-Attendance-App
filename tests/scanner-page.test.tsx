/**
 * Integration test for the scanner page with a fake html5-qrcode camera.
 * Proves the camera session is started ONCE and is never stopped/restarted,
 * that rapid duplicate decodes send ONE request, that a successful check-in
 * goes straight to the top of the attendance log (highlighted, no full-screen
 * overlay), that other outcomes still show their overlay, and that a
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
type LogResult = { entries: { key: string; name: string; scanned_at: string }[]; total: number }
const submitCheckIn = vi.hoisted(() => vi.fn<(code: string) => Promise<ScanOutcome>>())
const fetchCheckInLog = vi.hoisted(() => vi.fn<(limit: number) => Promise<LogResult>>())
vi.mock('../src/features/attendance/api', () => ({
  submitCheckIn,
  fetchCheckInLog,
  checkInLogKey: (name: string, scannedAt: string) => `${name}|${Date.parse(scannedAt)}`,
}))
const logEntry = (name: string, scannedAt: string) => ({ key: `${name}|${Date.parse(scannedAt)}`, name, scanned_at: scannedAt })

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
  fetchCheckInLog.mockReset()
  fetchCheckInLog.mockResolvedValue({ entries: [logEntry('Pedro Reyes', '2026-12-01T00:30:00Z')], total: 1 })
})

function logRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.checkin-log__row'))
}

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
    expect(screen.getByText('Attendance Log')).toBeTruthy()
    expect(screen.queryByText('Present Your QR Code')).toBeNull()
    expect(screen.getByText('CIT University Event')).toBeTruthy()
    // The log loads the active event's check-ins from the server.
    expect(await screen.findByText('Pedro Reyes')).toBeTruthy()
    expect(screen.getByText('8:30 AM')).toBeTruthy()
  })

  it('sends one request for a burst of decodes and puts the name at the top of the log, highlighted, with no overlay', async () => {
    submitCheckIn.mockResolvedValue({
      status: 'ok',
      name: 'Juan Dela Cruz',
      event_name: 'CIT University Event',
      scanned_at: '2026-12-01T00:35:00Z',
    })
    await renderScanner()
    await screen.findByText('Pedro Reyes')
    const startsBefore = camera.starts

    for (let i = 0; i < 8; i++) decode('ABC001')
    expect(submitCheckIn).toHaveBeenCalledTimes(1)
    expect(submitCheckIn).toHaveBeenCalledWith('ABC001')

    // Newest first, highlighted; older entry below it.
    await waitFor(() => expect(logRows()[0]?.textContent).toContain('Juan Dela Cruz'))
    expect(logRows()[0].className).toContain('checkin-log__row--new')
    expect(logRows()[0].textContent).toContain('8:35 AM')
    expect(logRows()[1].textContent).toContain('Pedro Reyes')
    expect(logRows()[1].className).not.toContain('checkin-log__row--new')
    expect(screen.getByText('2')).toBeTruthy() // "2 checked in"

    // No full-screen success overlay.
    expect(screen.queryByText('WELCOME!')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()

    // The log re-syncs with the server right after a local success.
    await waitFor(() => expect(fetchCheckInLog.mock.calls.length).toBeGreaterThanOrEqual(2))

    // Holding the same code in view never triggers a second request.
    decode('ABC001')
    expect(submitCheckIn).toHaveBeenCalledTimes(1)

    // After the scan cooldown (800 ms) the next attendee is accepted on the SAME camera session.
    submitCheckIn.mockResolvedValueOnce({ status: 'already', name: 'Maria Santos', scanned_at: '2026-12-01T00:20:00Z' })
    await waitFor(
      () => {
        decode('ABC002')
        expect(submitCheckIn).toHaveBeenCalledTimes(2)
      },
      { timeout: 3000, interval: 100 },
    )
    // Non-success outcomes still use the full-screen overlay.
    expect(await screen.findByText('ALREADY CHECKED IN')).toBeTruthy()
    expect(screen.getByText(/Checked in at: 8:20 AM/)).toBeTruthy()

    expect(camera.starts).toBe(startsBefore)
    expect(camera.stops).toBe(0)
    expect(document.querySelector('#front-camera-reader video')).not.toBeNull()
  }, 15_000)

  it('keeps a just-confirmed check-in visible even if a slower, older log sync finishes afterwards', async () => {
    submitCheckIn.mockResolvedValue({ status: 'ok', name: 'Ana Lim', event_name: 'E', scanned_at: '2026-12-01T00:40:00Z' })
    // The initial log load is slow: it starts BEFORE the scan and resolves after it.
    let resolveStale: (v: LogResult) => void = () => undefined
    fetchCheckInLog.mockImplementationOnce(() => new Promise((r) => (resolveStale = r)))
    await renderScanner()

    // Later syncs (after the scan) include the new row, as the server would.
    fetchCheckInLog.mockResolvedValue({
      entries: [logEntry('Ana Lim', '2026-12-01T00:40:00Z'), logEntry('Pedro Reyes', '2026-12-01T00:30:00Z')],
      total: 2,
    })
    decode('ABC009')
    await waitFor(() => expect(logRows()[0]?.textContent).toContain('Ana Lim'))

    await act(async () => resolveStale({ entries: [logEntry('Pedro Reyes', '2026-12-01T00:30:00Z')], total: 1 }))
    expect(logRows()[0].textContent).toContain('Ana Lim')
    expect(logRows()[0].className).toContain('checkin-log__row--new')
  })

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
