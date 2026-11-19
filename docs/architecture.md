# Architecture

## How a check-in works

```
 Attendee phone (QR)                Xiaomi Pad 7 — /scan (Chrome, HTTPS)
        │  shows code            ┌──────────────────────────────────────────────┐
        └──────────────────────► │ FRONT camera ─► html5-qrcode (≈10 fps decode)│
                                 │       │ decoded text only (no frames)        │
                                 │   ScanGate (sync lock, 800 ms cooldown,      │
                                 │   per-code re-arm, blocked while overlay up) │
                                 └───────┼──────────────────────────────────────┘
                                         │ POST {qr_code}  + user JWT
                                         ▼
                        Edge Function  check-in  (verifies user + role)
                                         │ service role
                                         ▼
                 PostgreSQL  record_qr_check_in()  — advisory lock vs. event switch,
                 INSERT … ON CONFLICT (event_id, attendee_id) DO NOTHING
                                         │
             ┌───────────────────────────┴──────────────┐
             ▼                                          ▼
   {"status":"ok","name":…}                    Realtime ─► Admin dashboard
   full-screen overlay (camera keeps running)          (counts, tables, recent)
```

- **The database is the source of truth.** `UNIQUE(event_id, attendee_id)` plus `ON CONFLICT DO NOTHING` means two tablets scanning the same code at the same instant still produce one row. The original `scanned_at` is never overwritten; a trigger makes attendance rows immutable.
- **At most one event is active** (partial unique index). `set_active_event()` switches atomically under an advisory lock that check-ins also take (shared), so a check-in is always recorded against an event that stayed active for its whole transaction.
- **Tablets learn about active-event changes** via Realtime on the small `active_event_state` table, plus a 30-second poll and a refresh whenever the page becomes visible.

### Edge Function `check-in` responses

| Situation | Response |
|---|---|
| First valid scan | `{"status":"ok","name","event_name","scanned_at"}` |
| Already checked in | `{"status":"already","name","scanned_at"}` (original time) |
| Unknown code | `{"status":"invalid"}` |
| Registered for another event | `{"status":"wrong_event"}` |
| No active event | `{"status":"no_event"}` |
| Network failure / timeout / malformed reply | handled client-side as CONNECTION ERROR, never success |

Times are displayed in Asia/Manila; the database stores `timestamptz`.

### Scan gate

`src/features/attendance/scanGate.ts` controls when a decoded QR is accepted:

- A **synchronous lock** (a ref, not React state) blocks every decode callback while a request is in flight, however long the server takes.
- After the response, the cooldown starts and the overlay **holds** the gate until it is dismissed. With the defaults the overlay (1.2 s) outlasts the cooldown (0.8 s), so the next attendee can scan as soon as the overlay closes.
- The camera keeps capturing the whole time; callbacks are simply ignored. The camera is never restarted after a scan.

---

## Project structure

```
cit-qr-attendance/
├─ index.html, vite.config.ts, vercel.json, .env.example, .oxlintrc.json
├─ tsconfig.json (+ tsconfig.app / node / test)
├─ docs/              this documentation
├─ public/            favicon.svg, manifest.webmanifest, icons/*.png
├─ samples/           sample-registrations.csv, sample-registrations.xlsx (2 sheets)
├─ scripts/           generate-icons.mjs, generate-sample-xlsx.mjs
├─ src/
│  ├─ main.tsx, App.tsx, index.css, config.ts      ← scanner settings live in config.ts
│  ├─ components/     QRScanner, FullScreenScanResult, ExcelRegistrationImporter,
│  │                  AttendanceTable, EventSelector, ProtectedRoute, RoleGuard,
│  │                  LoadingState, Modal, ConfirmDialog, StatusPill
│  ├─ pages/          LoginPage, ScannerPage, AdminDashboard, UnauthorizedPage
│  ├─ features/
│  │  ├─ auth/        AuthProvider, context, routing rules
│  │  ├─ attendance/  scanGate, checkInResult, api, OverviewPanel, AttendancePanel
│  │  ├─ events/      api, EventsPanel
│  │  ├─ registrants/ api, RegistrantsPanel (+ manual add/edit form)
│  │  ├─ imports/     columnMapping, validateRows, api
│  │  └─ users/       api, ScannerUsersPanel
│  ├─ hooks/          useAuth, useFrontCamera, useWakeLock, useRealtimeAttendance,
│  │                  useActiveEvent, useOnlineStatus
│  ├─ lib/            supabase, excel, csv, format, validation, cameraSelection,
│  │                  fetchAll, beep
│  └─ types/          database.ts, attendance.ts
├─ supabase/
│  ├─ config.toml     signups disabled; functions verify callers themselves
│  ├─ migrations/     001_initial_schema · 002_security_policies ·
│  │                  003_database_functions · 004_realtime
│  ├─ functions/
│  │  ├─ _shared/     http, checkInCore, registerCore, scannerUsersCore (pure, unit-tested),
│  │  │               supabaseAdmin (Deno only)
│  │  ├─ check-in/index.ts
│  │  ├─ register-attendee/index.ts
│  │  └─ manage-scanner-users/index.ts
│  ├─ seed.sql        optional local demo data
│  └─ tests/manual_concurrency_check.sql
└─ tests/             database, check-in, scanner, scanner-page, import-registration,
                      authorization (+ helpers/pglite.ts)
```

Design notes:

- **Linting uses [oxlint](https://oxc.rs)** (`.oxlintrc.json`) rather than ESLint. It's what the current Vite React-TS template ships, supports TypeScript 7, and enforces the same React Hooks rules.
- **`supabase/functions/_shared/`** holds the Edge Functions' decision logic as plain TypeScript so Vitest can test the real handler code.

---

## Security model

| Layer | Protection |
|---|---|
| **Accounts** | Supabase Auth with public sign-up disabled and exactly two roles. Roles live in `app_user_roles` with **no** client INSERT/UPDATE policy, so users can't promote themselves. Disabled accounts lose their role and are banned in Auth. |
| **RLS** | Enabled on every table (`app_user_roles`, `events`, `attendees`, `attendance`, `import_logs`, `attendance_corrections`, `active_event_state`). Anonymous users have no table privileges. Scanner users **can't read** attendees or attendance; they see the active event only through `get_active_event()` (id, name, date, venue). |
| **Attendance writes** | Only through functions. `record_qr_check_in` runs only as `service_role` (called by the Edge Function after verifying the user). `admin_mark_present` / `admin_undo_check_in` check `is_admin()` and write an audit row to `attendance_corrections`. Direct `INSERT/UPDATE/DELETE` on `attendance` is revoked from browser roles, and rows are immutable. |
| **Database functions** | Every privileged function is `SECURITY DEFINER` with `SET search_path = ''`, schema-qualified names, its own role check, and `EXECUTE` revoked from `PUBLIC`/`anon`. |
| **Edge Functions** | `verify_jwt = false` in `config.toml` is deliberate: each function authenticates the caller itself, which works with both new `sb_…` keys and legacy JWT keys. `check-in` validates the user token and requires an enabled admin/scanner role, returning only the attendee's name, event name and time. `manage-scanner-users` is admin-only and can only change scanner accounts. `register-attendee` requires the 32+ character shared secret (constant-time compare), validates every field, and caps body size. |
| **Secrets** | The service-role key and webhook secret exist only as Edge Function secrets. The frontend uses only the publishable key. |
| **Realtime** | Respects RLS: admins receive `attendance`, `attendees`, `events` and `active_event_state`; scanners receive only `active_event_state`. |
| **Scanner privacy** | Camera frames never leave the tablet and are never stored. Only the decoded QR text is sent. |
| **Exports** | CSV cells starting with `= + - @ TAB CR` are prefixed with `'` to block spreadsheet formula injection. |
| **Spreadsheet import** | File type is checked from content, not extension. Formulas are never executed (only cached values are read). |
| **Headers** | `vercel.json` sets `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy: camera=(self)`, and SPA rewrites so deep links like `/scan` work. |

### Front-camera selection

The app requests `facingMode: {exact: "user"}`, then falls back to device capabilities and labels (Android Chrome reports "facing front"). If the browser ever reports a rear camera, scanning stops with an error. When the browser reports nothing, the header shows "Front camera (unverified)".
