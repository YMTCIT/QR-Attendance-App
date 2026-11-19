import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { homePathForRole } from '../features/auth/routing'

export default function UnauthorizedPage() {
  const { session, role, signOut } = useAuth()
  const navigate = useNavigate()
  const home = role ? homePathForRole(role) : null

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-card__title">Access denied</h1>
        <p className="login-card__subtitle">Your account does not have permission to open that page.</p>
        <div className="form-grid">
          {home && home !== '/unauthorized' && (
            <Link className="btn btn--primary btn--large btn--block" to={home}>
              {role === 'scanner' ? 'Go to the scanner' : 'Go to the dashboard'}
            </Link>
          )}
          {session ? (
            <button
              type="button"
              className="btn btn--ghost btn--block"
              onClick={async () => {
                await signOut()
                navigate('/login', { replace: true })
              }}
            >
              Sign in with a different account
            </button>
          ) : (
            <Link className="btn btn--ghost btn--block" to="/login">
              Sign in
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
