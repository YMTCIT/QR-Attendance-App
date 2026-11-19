import { useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { safeReturnPath } from '../features/auth/routing'
import { LoadingState } from '../components/LoadingState'

export default function LoginPage() {
  const { loading, session, role, roleError, signIn, signOut } = useAuth()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return <LoadingState label="Checking your session…" fullScreen />

  // Already signed in with a role → go to the right place.
  if (session && role) {
    const from = (location.state as { from?: unknown } | null)?.from
    return <Navigate to={safeReturnPath(from, role)} replace />
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy(true)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img className="login-card__logo" src="/favicon.svg" alt="" width={72} height={72} />
        <h1 className="login-card__title">CIT QR Attendance</h1>
        <p className="login-card__subtitle">Staff sign-in</p>

        {session && !role ? (
          <div className="notice notice--error" role="alert">
            <p>
              {roleError ??
                'This account is not authorised to use the attendance system, or it has been disabled. Ask the administrator.'}
            </p>
            <button type="button" className="btn btn--ghost" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        ) : (
          <form className="form-grid" onSubmit={submit} noValidate>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                autoComplete="username"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                autoFocus
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn btn--primary btn--large btn--block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        <p className="login-card__footnote">
          Accounts are created by the administrator. Attendees do not need an account — just their registered QR code.
        </p>
      </div>
    </div>
  )
}
