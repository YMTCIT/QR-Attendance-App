/** Row shapes for the tables in supabase/migrations. */

export type AppRole = 'admin' | 'scanner'

export type RegistrationSource = 'power_automate' | 'import' | 'manual'

export type CheckInMethod = 'qr' | 'manual'

export interface AppUserRoleRow {
  user_id: string
  role: AppRole
  disabled_at: string | null
  created_at: string
}

export interface EventRow {
  id: number
  name: string
  date: string // YYYY-MM-DD
  venue: string | null
  active: boolean
  created_at: string
  updated_at: string
}

/** What scanner users can see (from get_active_event()). */
export interface ActiveEvent {
  id: number
  name: string
  date: string
  venue: string | null
}

export interface AttendeeRow {
  id: number
  qr_code: string
  name: string
  id_number: string | null
  email: string | null
  department: string | null
  event_id: number | null
  source: RegistrationSource
  created_at: string
  updated_at: string
}

export interface AttendanceRow {
  id: number
  event_id: number
  attendee_id: number
  scanned_at: string
  check_in_method: CheckInMethod
  recorded_by: string | null
  created_at: string
}

export interface RosterRow {
  attendee_id: number
  name: string
  id_number: string | null
  email: string | null
  department: string | null
  attendee_event: number | null
  attendance_id: number | null
  scanned_at: string | null
  check_in_method: CheckInMethod | null
}

export interface EventStats {
  registered: number
  present: number
}

export interface ImportLogRow {
  id: number
  imported_by: string | null
  event_id: number | null
  filename: string
  total_rows: number
  successful_rows: number
  skipped_rows: number
  error_rows: number
  created_at: string
}

export interface ScannerUser {
  user_id: string
  email: string | null
  role: AppRole
  disabled: boolean
  created_at: string
  last_sign_in_at: string | null
}
