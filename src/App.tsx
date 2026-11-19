import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './features/auth/AuthProvider'
import { homePathForRole } from './features/auth/routing'
import { ProtectedRoute } from './components/ProtectedRoute'
import { RoleGuard } from './components/RoleGuard'
import { LoadingState } from './components/LoadingState'
import { useAuth } from './hooks/useAuth'
import { supabaseConfigError } from './lib/supabase'
import LoginPage from './pages/LoginPage'
import UnauthorizedPage from './pages/UnauthorizedPage'

// Split the two big screens so the scanner tablet does not download the
// dashboard + spreadsheet code, and vice versa.
const ScannerPage = lazy(() => import('./pages/ScannerPage'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))

function HomeRedirect() {
  const { loading, session, role } = useAuth()
  if (loading) return <LoadingState fullScreen />
  if (!session) return <Navigate to="/login" replace />
  return <Navigate to={homePathForRole(role)} replace />
}

function ConfigError() {
  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-card__title">Setup required</h1>
        <p className="form-error">{supabaseConfigError}</p>
      </div>
    </div>
  )
}

export default function App() {
  if (supabaseConfigError) return <ConfigError />

  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<LoadingState fullScreen />}>
          <Routes>
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/unauthorized" element={<UnauthorizedPage />} />
            <Route
              path="/scan"
              element={
                <ProtectedRoute>
                  <RoleGuard area="scan">
                    <ScannerPage />
                  </RoleGuard>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/dashboard"
              element={
                <ProtectedRoute>
                  <RoleGuard area="admin">
                    <AdminDashboard />
                  </RoleGuard>
                </ProtectedRoute>
              }
            />
            <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  )
}
