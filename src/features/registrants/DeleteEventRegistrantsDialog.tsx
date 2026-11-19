import { useEffect, useState } from 'react'
import { Modal } from '../../components/Modal'
import { formatNumber } from '../../lib/format'
import type { EventRow } from '../../types/database'
import { countEventRegistrants, deleteEventRegistrants } from './api'

/** Seconds the final Delete button stays disabled after the warning appears. */
export const DELETE_ARM_SECONDS = 2

interface Props {
  events: EventRow[]
  /** Event pre-selected when the dialog opens. */
  initialEventId: number | null
  onClose: () => void
  onDeleted: (deleted: number) => void
}

type Counts = { registrants: number; checkIns: number }

/**
 * Deletes every registrant assigned to one event, in two steps:
 *   1. choose the event and review what will be deleted;
 *   2. a final warning whose Delete button only becomes clickable after
 *      DELETE_ARM_SECONDS.
 * Check-ins of those registrants are deleted with them (ON DELETE CASCADE).
 * "Any event" registrants are not affected.
 */
export function DeleteEventRegistrantsDialog({ events, initialEventId, onClose, onDeleted }: Props) {
  const [step, setStep] = useState<'choose' | 'confirm' | 'done'>('choose')
  const [eventId, setEventId] = useState<number | null>(initialEventId ?? events[0]?.id ?? null)
  const [counts, setCounts] = useState<{ eventId: number; value: Counts } | null>(null)
  const [countError, setCountError] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(DELETE_ARM_SECONDS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(0)

  const eventName = events.find((e) => e.id === eventId)?.name ?? ''
  const current = counts && counts.eventId === eventId ? counts.value : null

  // Load what would be deleted for the chosen event.
  useEffect(() => {
    if (eventId === null) return
    let cancelled = false
    countEventRegistrants(eventId)
      .then((value) => {
        if (cancelled) return
        setCounts({ eventId, value })
        setCountError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setCountError(e instanceof Error ? e.message : 'Could not count registrants.')
      })
    return () => {
      cancelled = true
    }
  }, [eventId])

  // Arm the final Delete button after a short delay.
  useEffect(() => {
    if (step !== 'confirm' || secondsLeft <= 0) return
    const t = window.setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => window.clearTimeout(t)
  }, [step, secondsLeft])

  const goToConfirm = () => {
    setError(null)
    setSecondsLeft(DELETE_ARM_SECONDS)
    setStep('confirm')
  }

  const runDelete = async () => {
    if (eventId === null) return
    setBusy(true)
    setError(null)
    try {
      const n = await deleteEventRegistrants(eventId)
      setDeleted(n)
      setStep('done')
      onDeleted(n)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the registrants.')
    } finally {
      setBusy(false)
    }
  }

  const armed = secondsLeft <= 0

  return (
    <Modal
      title="Delete all registrants of an event"
      onClose={onClose}
      locked={busy}
      footer={
        step === 'choose' ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={goToConfirm}
              disabled={!current || current.registrants === 0}
            >
              Continue
            </button>
          </>
        ) : step === 'confirm' ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setStep('choose')} disabled={busy}>
              Back
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void runDelete()}
              disabled={!armed || busy}
              aria-describedby="delete-arm-hint"
            >
              {busy
                ? 'Deleting…'
                : armed
                  ? `Delete ${formatNumber(current?.registrants ?? 0)} registrant(s)`
                  : `Delete (${secondsLeft})`}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        )
      }
    >
      {step === 'choose' && (
        <>
          {events.length === 0 ? (
            <p className="muted">There are no events yet.</p>
          ) : (
            <label className="field">
              <span>Event</span>
              <select
                value={eventId === null ? '' : String(eventId)}
                onChange={(e) => setEventId(e.target.value === '' ? null : Number(e.target.value))}
              >
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {countError ? (
            <p className="form-error">{countError}</p>
          ) : eventId !== null && !current ? (
            <p className="muted">Counting…</p>
          ) : current ? (
            current.registrants === 0 ? (
              <p className="muted">No registrants are assigned to this event.</p>
            ) : (
              <div className="notice notice--warn">
                <p>
                  This will delete <strong>{formatNumber(current.registrants)}</strong> registrant(s) assigned to{' '}
                  <strong>{eventName}</strong>
                  {current.checkIns > 0 && (
                    <>
                      {' '}
                      and their <strong>{formatNumber(current.checkIns)}</strong> check-in record(s)
                    </>
                  )}
                  .
                </p>
                <p className="small">Registrants set to &ldquo;Any event&rdquo; are not affected.</p>
              </div>
            )
          ) : null}
        </>
      )}

      {step === 'confirm' && current && (
        <div className="notice notice--error" role="alert">
          <p>
            <strong>Are you absolutely sure?</strong>
          </p>
          <p>
            You are about to permanently delete <strong>{formatNumber(current.registrants)}</strong> registrant(s) of{' '}
            <strong>{eventName}</strong>
            {current.checkIns > 0 && (
              <>
                {' '}
                together with <strong>{formatNumber(current.checkIns)}</strong> check-in record(s)
              </>
            )}
            . Their QR codes will stop working. <strong>This cannot be undone.</strong>
          </p>
          <p id="delete-arm-hint" className="small">
            {armed ? 'The Delete button is now active.' : `The Delete button unlocks in ${secondsLeft} second(s).`}
          </p>
        </div>
      )}

      {step === 'done' && (
        <p>
          Deleted <strong>{formatNumber(deleted)}</strong> registrant(s) of <strong>{eventName}</strong>.
        </p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
