import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { LoadingState } from '../../components/LoadingState'
import { Modal } from '../../components/Modal'
import { formatDateTime } from '../../lib/format'
import { isValidEmail } from '../../lib/validation'
import type { ScannerUser } from '../../types/database'
import { createScannerUser, listScannerUsers, setScannerDisabled } from './api'

export function ScannerUsersPanel() {
  const [users, setUsers] = useState<ScannerUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [toggling, setToggling] = useState<ScannerUser | null>(null)

  const load = useCallback(async () => {
    try {
      setUsers(await listScannerUsers())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load scanner users.')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    listScannerUsers()
      .then((u) => {
        if (!cancelled) setUsers(u)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load scanner users.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="panel">
      <div className="panel__toolbar">
        <div>
          <h2 className="panel__title">Scanner users</h2>
          <p className="muted">Event staff accounts that can only use the scanner page. Attendees never need accounts.</p>
        </div>
        <div className="toolbar-actions">
          <button type="button" className="btn btn--ghost" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            + New scanner user
          </button>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      {users === null && !error ? (
        <LoadingState />
      ) : users && users.length === 0 ? (
        <p className="empty-state">No scanner users yet.</p>
      ) : users ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last sign-in</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.user_id}>
                  <td data-label="Email" className="cell-strong">
                    {u.email ?? '(no email)'}
                  </td>
                  <td data-label="Status">
                    {u.disabled ? <span className="badge badge--bad">Disabled</span> : <span className="badge badge--ok">Enabled</span>}
                  </td>
                  <td data-label="Created">{formatDateTime(u.created_at)}</td>
                  <td data-label="Last sign-in">{formatDateTime(u.last_sign_in_at)}</td>
                  <td className="cell-actions">
                    <button
                      type="button"
                      className={u.disabled ? 'btn btn--small btn--ghost' : 'btn btn--small btn--danger-ghost'}
                      onClick={() => setToggling(u)}
                    >
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {creating && (
        <CreateScannerUser
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void load()
          }}
        />
      )}

      {toggling && (
        <ConfirmDialog
          title={toggling.disabled ? 'Enable scanner user' : 'Disable scanner user'}
          danger={!toggling.disabled}
          confirmLabel={toggling.disabled ? 'Enable' : 'Disable'}
          message={
            toggling.disabled ? (
              <p>
                Allow <strong>{toggling.email}</strong> to sign in and scan again?
              </p>
            ) : (
              <p>
                Disable <strong>{toggling.email}</strong>? They are signed out of new sessions and their check-in requests
                are refused immediately.
              </p>
            )
          }
          onClose={() => setToggling(null)}
          onConfirm={async () => {
            await setScannerDisabled(toggling.user_id, !toggling.disabled)
            await load()
          }}
        />
      )}
    </section>
  )
}

function CreateScannerUser({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('')
  const [mode, setMode] = useState<'password' | 'invite'>('password')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const trimmed = email.trim().toLowerCase()
    if (!isValidEmail(trimmed)) {
      setError('Enter a valid email address.')
      return
    }
    if (mode === 'password' && password.length < 10) {
      setError('Use a password of at least 10 characters.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createScannerUser({ email: trimmed, invite: mode === 'invite', password: mode === 'password' ? password : undefined })
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the account.')
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New scanner user"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Creating…' : mode === 'invite' ? 'Send invite' : 'Create account'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" autoFocus />
        </label>
        <div className="segmented" role="group" aria-label="Account setup">
          <button
            type="button"
            className={mode === 'password' ? 'segmented__btn segmented__btn--on' : 'segmented__btn'}
            onClick={() => setMode('password')}
          >
            Set a password
          </button>
          <button
            type="button"
            className={mode === 'invite' ? 'segmented__btn segmented__btn--on' : 'segmented__btn'}
            onClick={() => setMode('invite')}
          >
            Email an invite
          </button>
        </div>
        {mode === 'password' ? (
          <label className="field">
            <span>Temporary password (min. 10 characters)</span>
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <small className="muted">Give it to the staff member in person.</small>
          </label>
        ) : (
          <p className="muted small">
            Supabase emails an invitation link. This requires email (SMTP) to be configured in your Supabase project.
          </p>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}
