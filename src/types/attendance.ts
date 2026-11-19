/** Typed responses of the check-in Edge Function. */

export type CheckInResponse =
  | { status: 'ok'; name: string; event_name: string; scanned_at: string }
  | { status: 'already'; name: string; scanned_at: string; event_name?: string }
  | { status: 'invalid' }
  | { status: 'wrong_event' }
  | { status: 'no_event' }

/** Everything the scanner overlay can show. `network_error` never comes from the server. */
export type ScanOutcome =
  | CheckInResponse
  | { status: 'network_error'; detail?: string }
  | { status: 'unauthorized' }
