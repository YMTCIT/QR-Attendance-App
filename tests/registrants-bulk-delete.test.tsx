/**
 * "Delete all registrants of an event": two confirmations, and the final
 * Delete button only becomes clickable after 2 seconds.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventRow } from '../src/types/database'

const api = vi.hoisted(() => ({
  countEventRegistrants: vi.fn(),
  deleteEventRegistrants: vi.fn(),
}))
vi.mock('../src/features/registrants/api', () => api)

const events = [
  { id: 1, name: 'Foundation Day', date: '2026-12-01', venue: null, active: true },
  { id: 2, name: 'Job Fair', date: '2026-12-05', venue: null, active: false },
] as unknown as EventRow[]

beforeEach(() => {
  api.countEventRegistrants.mockReset()
  api.deleteEventRegistrants.mockReset()
  api.countEventRegistrants.mockImplementation(async (id: number) =>
    id === 1 ? { registrants: 120, checkIns: 37 } : { registrants: 0, checkIns: 0 },
  )
  api.deleteEventRegistrants.mockResolvedValue(120)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function open(initialEventId: number | null = 1) {
  const { DeleteEventRegistrantsDialog } = await import('../src/features/registrants/DeleteEventRegistrantsDialog')
  const onDeleted = vi.fn()
  const onClose = vi.fn()
  render(createElement(DeleteEventRegistrantsDialog, { events, initialEventId, onClose, onDeleted }))
  return { onDeleted, onClose }
}

describe('DeleteEventRegistrantsDialog', () => {
  it('shows what will be deleted, then needs a second confirmation that unlocks after 2 seconds', async () => {
    const { onDeleted } = await open(1)
    await screen.findByText('120')
    expect(screen.getByText('37')).toBeTruthy()
    expect(screen.getByText(/Any event/)).toBeTruthy()

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Are you absolutely sure?')).toBeTruthy()

    const del = () => screen.getByRole('button', { name: /^Delete/ }) as HTMLButtonElement
    expect(del().disabled).toBe(true)
    expect(del().textContent).toBe('Delete (2)')
    fireEvent.click(del())
    expect(api.deleteEventRegistrants).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(del().textContent).toBe('Delete (1)')
    expect(del().disabled).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(del().disabled).toBe(false)
    expect(del().textContent).toBe('Delete 120 registrant(s)')
    vi.useRealTimers()

    fireEvent.click(del())
    await waitFor(() => expect(api.deleteEventRegistrants).toHaveBeenCalledWith(1))
    expect(await screen.findByText(/Deleted/)).toBeTruthy()
    expect(onDeleted).toHaveBeenCalledWith(120)
  })

  it('restarts the 2-second lock after going Back', async () => {
    await open(1)
    await screen.findByText('120')
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    for (let i = 0; i < 2; i++) {
      act(() => {
        vi.advanceTimersByTime(1000)
      })
    }
    expect((screen.getByRole('button', { name: /^Delete/ }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect((screen.getByRole('button', { name: /^Delete/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('cannot continue when the event has no registrants', async () => {
    await open(2)
    await screen.findByText('No registrants are assigned to this event.')
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
