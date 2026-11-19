import { useState, type ReactNode } from 'react'
import { Modal } from './Modal'

interface ConfirmDialogProps {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  /** Ask for an optional reason (stored in the audit log for attendance corrections). */
  askReason?: boolean
  onConfirm: (reason: string | null) => Promise<void>
  onClose: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  askReason = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm(reason.trim() || null)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={danger ? 'btn btn--danger' : 'btn btn--primary'} onClick={confirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-message">{message}</div>
      {askReason && (
        <label className="field">
          <span>Reason (optional, saved in the audit log)</span>
          <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}
