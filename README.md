# CIT QR Attendance System


| | |
|---|---|
| **Frontend** | React 19 + TypeScript + Vite, React Router, plain CSS, PWA (vite-plugin-pwa) |
| **QR scanning** | html5-qrcode, front camera only (`facingMode: "user"`) |
| **Backend** | Supabase: PostgreSQL + RLS, Auth, Realtime, Edge Functions (Deno/TypeScript) |
| **Spreadsheets** | read-excel-file (.xlsx), PapaParse (.csv) |
| **Hosting** | Vercel (frontend), Supabase (backend) |
| **Tests** | Vitest, React Testing Library, PGlite (real PostgreSQL in WebAssembly) |

### What this app deliberately does NOT do

- **No check-out / time-out / departure / duration / work hours.** Attendance is check-in only, one per attendee per event.
- **No QR generation.** QR codes come from Microsoft Forms + Power Automate (or another external process). The app only scans them.
- **No attendee accounts.** Only two staff roles exist: **Administrator** and **Scanner User**.
- **No Excel attendance import.** Spreadsheets import *registrations* only; they never mark anyone present.
- **No offline attendance queue.** A check-in is shown as successful only after Supabase confirms it.

---

## Contents

1. [How it works](#how-it-works)
2. [Project structure](#project-structure)
3. [Setup (steps 1–24)](#setup)
4. [Scanner tuning](#scanner-tuning)
5. [Microsoft Forms / Power Automate integration](#microsoft-forms--power-automate-integration)
6. [Excel / CSV registration import](#excel--csv-registration-import)
7. [Security model](#security-model)
8. [Testing](#testing)
9. [Troubleshooting the camera](#troubleshooting-the-camera)
10. [Known limitations](#known-limitations)

---

## How it works

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

- The **database** is the source of truth. `UNIQUE(event_id, attendee_id)` plus `ON CONFLICT DO NOTHING` means two tablets scanning the same code at the same instant still produce one row, and the original `scanned_at` is never overwritten (attendance rows are immutable via a trigger).
- **At most one event is active** (partial unique index). `set_active_event()` switches atomically and takes an advisory lock that check-ins also take (shared), so a check-in is always recorded against an event that was active for its whole transaction.
- **Scanner tablets** learn about active-event changes via Realtime on a tiny `active_event_state` table, plus a 30-second poll and a refresh whenever the page becomes visible again.

### Check-in responses (Edge Function `check-in`)

| Situation | Response | Overlay |
|---|---|---|
| First valid scan | `{"status":"ok","name","event_name","scanned_at"}` | green ✓ **CHECK-IN SUCCESSFUL / WELCOME! / NAME / Attendance Recorded** |
| Already checked in | `{"status":"already","name","scanned_at"}` (original time) | amber **ALREADY CHECKED IN** + "Checked in at: 8:35 AM" |
| Unknown code | `{"status":"invalid"}` | red **INVALID QR CODE** |
| Registered for another event | `{"status":"wrong_event"}` | red **NOT REGISTERED FOR THIS EVENT** |
| No active event | `{"status":"no_event"}` | red **NO ACTIVE EVENT** |
| Network failure / timeout / malformed reply | (client-side) | red **CONNECTION ERROR** (never shows success) |

Times are displayed in **Asia/Manila**; the database stores `timestamptz`.

---

## Project structure

```
cit-qr-attendance/
├─ index.html, vite.config.ts, vercel.json, .env.example, .oxlintrc.json
├─ tsconfig.json (+ tsconfig.app / node / test)
├─ public/            favicon.svg, manifest.webmanifest, icons/*.png
├─ samples/           sample-registrations.csv, sample-registrations.xlsx (2 sheets)
├─ scripts/           generate-icons.mjs, generate-sample-xlsx.mjs
├─ src/
│  ├─ main.tsx, App.tsx, index.css, config.ts      ← scanner tuning lives in config.ts
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

Deviations from the suggested structure, and why:

- **Linting uses [oxlint](https://oxc.rs) (`.oxlintrc.json`) instead of `eslint.config.js`.** It is what the current Vite React-TS template ships, it supports TypeScript 7, and it enforces the same React Hooks rules (`rules-of-hooks`, `exhaustive-deps`).
- **Extra test files.** `database.test.ts` runs the real migrations in PGlite. `scanner-page.test.tsx` renders the real scanner page with a fake camera.
- **`supabase/functions/_shared/`** holds the Edge Functions' decision logic as plain TypeScript, so Vitest can test the actual handler code.

---

## Setup

### 1. Install prerequisites
- **Node.js 20.19+** (22 or 24 LTS recommended) and npm — <https://nodejs.org>
- **Git**
- **Supabase CLI** — `npm i -g supabase`, or use `npx supabase …` in every command below
- A **Supabase** account and a **Vercel** account

### 2. Create a Supabase project
Supabase Dashboard → **New project**. Pick a region near the Philippines (e.g. Singapore) and save the database password.

### 3. Apply the PostgreSQL migrations
```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push            # applies supabase/migrations/001…004 in order
```
No CLI? Open **SQL Editor** and run the four files in `supabase/migrations/` **in order**.
> Do not run `seed.sql` on production. It is demo data for local development.

### 4. RLS policies
Migration `002_security_policies.sql` enables Row Level Security on every table and creates every policy. To check: Dashboard → **Authentication → Policies** should show RLS **enabled** on `app_user_roles`, `events`, `attendees`, `attendance`, `import_logs`, `attendance_corrections` and `active_event_state`.

### 5. Configure authentication
Dashboard → **Authentication → Sign In / Providers → Email**: keep Email enabled. Dashboard → **Authentication → URL Configuration**: set **Site URL** to your Vercel URL once you have it (step 17), e.g. `https://cit-qr-attendance.vercel.app`. Invitation emails link to this URL.

### 6. Disable public self-registration
Dashboard → **Authentication → Sign In / Providers** → turn **off "Allow new users to sign up"**. (`supabase/config.toml` sets `enable_signup = false` for local development too.) Only administrators create accounts.

### 7. Provision the first administrator
1. Dashboard → **Authentication → Users → Add user → Create new user**. Enter the admin's email and a strong password, and tick **Auto Confirm User**.
2. **SQL Editor** → run (replace the email):
   ```sql
   insert into public.app_user_roles (user_id, role)
   select id, 'admin' from auth.users where email = 'admin@your-school.edu';
   ```
Roles cannot be assigned through the public API. RLS has no INSERT/UPDATE policy on `app_user_roles`.

### 8. Create scanner-user accounts
Sign in as the admin → **Dashboard → Scanner Users → + New scanner user**. Either set a temporary password and hand it over in person, or send an email invite (requires SMTP to be configured under **Authentication → Emails**). **Disable** blocks a scanner immediately: its role is disabled, so the check-in function refuses it, and the auth user is banned, so it cannot sign in again.

### 9. Configure Supabase Realtime
Migration `004_realtime.sql` adds `attendance`, `attendees`, `events` and `active_event_state` to the `supabase_realtime` publication. To check: Dashboard → **Database → Publications → supabase_realtime**. Realtime respects RLS: admins receive all four tables, and scanners receive only `active_event_state`.

### 10. Deploy the Edge Functions
```bash
npx supabase functions deploy check-in
npx supabase functions deploy register-attendee
npx supabase functions deploy manage-scanner-users
```
`supabase/config.toml` sets `verify_jwt = false` for all three. This is deliberate: **each function authenticates the caller itself.**
- `check-in` and `manage-scanner-users` validate the user's access token with Supabase Auth, then require an enabled `admin` / `scanner` role (`admin` only for user management).
- `register-attendee` requires the shared webhook secret (step 11).

This setup works with both the new `sb_publishable_…`/`sb_secret_…` keys and legacy JWT keys. It also lets Power Automate call the webhook without a Supabase user.

> If your project has **disabled legacy API keys**, create a secret key (Dashboard → Project Settings → API Keys) and run `npx supabase secrets set SERVICE_ROLE_KEY=sb_secret_…`. Otherwise the functions use the automatically provided `SUPABASE_SERVICE_ROLE_KEY`.

### 11. Configure the Power Automate secret (and optional settings)
```bash
# 32+ random characters. Keep it out of the frontend and out of git.
npx supabase secrets set REGISTRATION_WEBHOOK_SECRET=$(openssl rand -hex 32)
# Optional: restrict browser CORS to your site(s) (comma-separated)
npx supabase secrets set ALLOWED_ORIGINS=https://cit-qr-attendance.vercel.app
# Optional: where scanner invitation emails should land
npx supabase secrets set SITE_URL=https://cit-qr-attendance.vercel.app
```
No `openssl`? Any password generator that produces 40+ random characters is fine.

### 12. Create the local `.env`
```bash
cp .env.example .env.local
```
Fill in from Dashboard → **Project Settings → API**:
```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…     # or the legacy "anon" key
```
**Never** put the service-role/secret key or the webhook secret in a `VITE_` variable. Those values are bundled into the browser.

### 13. Install dependencies
```bash
npm install
```

### 14. Start the local development server
```bash
npm run dev            # http://localhost:5173 (also on your LAN IP)
```
Browsers allow the camera only on **HTTPS or `localhost`**. To try the scanner on the tablet before deploying, use the Vercel preview URL (step 17) or an HTTPS tunnel. A plain `http://192.168.x.x:5173` address will **not** get camera access.

### 15. Run checks and tests
```bash
npm run check            # TypeScript + lint + all automated tests
npm run build            # production build
npm run check:functions  # Deno type-check of the Edge Functions (downloads Deno via npx)
```

### 16. Connect the project to Git
```bash
git init
git add .
git commit -m "CIT QR Attendance System"
git branch -M main
git remote add origin https://github.com/<you>/cit-qr-attendance.git
git push -u origin main
```
`.gitignore` already excludes `.env*` (except `.env.example`), `node_modules`, `dist`, and local Supabase state.

### 17. Deploy to Vercel
Vercel → **Add New → Project** → import the repository. Vercel detects **Vite**. Leave the build command as `npm run build` and the output directory as `dist`. `vercel.json` adds SPA rewrites, so deep links like `/scan` and `/admin/dashboard` work. It also adds security headers, including `Permissions-Policy: camera=(self)`.

### 18. Configure Vercel environment variables
Project → **Settings → Environment Variables** (Production + Preview):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- *(optional)* `VITE_SCAN_COOLDOWN_MS`, `VITE_SUCCESS_OVERLAY_MS`, … (see [Scanner tuning](#scanner-tuning))

Redeploy after changing them, because Vite inlines them at build time. Then go back to step 5 and set the Supabase **Site URL** to the Vercel URL.

### 19. Open the deployed site on the Xiaomi Pad 7
In **Google Chrome** on the tablet, open `https://<your-app>.vercel.app` and sign in with a **scanner** account. You land on `/scan`.

### 20. Allow FRONT-camera access
When Chrome asks, tap **Allow**. If you tapped Block: tap the icon left of the address bar → **Permissions → Camera → Allow**, then tap **Retry Camera**.

### 21. Verify that the selected camera is the front camera
- The preview should show the **people standing in front of the screen**, mirrored like a selfie.
- The header should show **"Front camera"** (green). This means the browser *reported* a user-facing camera.
- **"Front camera (unverified)"** (amber) means the browser did not say which way the camera faces. Confirm visually that the preview shows the person facing the screen. If the browser ever reports a rear camera, the app stops scanning and shows an error instead of using it.

### 22. Test with a real phone
Put an event in place first: **Dashboard → Events** → create one → **Set active**. Then import `samples/sample-registrations.csv`, or add a registrant manually with QR value `ABC001`. Show a QR code containing the text `ABC001` on a phone (any QR generator works for testing) and hold it 25–50 cm from the tablet's front camera, inside the gold frame:
- First scan → green **WELCOME! JUAN DELA CRUZ**
- Same code again (move it away for ~1 s, then back) → amber **ALREADY CHECKED IN** with the original time
- An unregistered code → red **INVALID QR CODE**

### 23. Install the PWA on the tablet's home screen
Chrome menu **⋮ → Add to Home screen / Install app**. Launching from the icon opens full-screen. While the scanner page is open, the app keeps the screen awake (Screen Wake Lock) where supported. Also set Android **Settings → Display → Sleep** to a long timeout as a backup.

### 24. Verify realtime on another device
Sign in as an **admin** on a laptop or phone (Dashboard shows **Live** in green). Scan a code on the tablet. **Present**, **Absent**, **Attendance rate**, **Recent check-ins** and the **Attendance** table should update within about a second, without reloading. Importing registrations should update **Registered** the same way.

---

## Scanner tuning

All values are in `src/config.ts` and can be overridden per deployment with Vercel env vars:

| Setting | Default | Meaning |
|---|---|---|
| `VITE_SCAN_COOLDOWN_MS` | **800** | Minimum gap after a scan is processed before another is accepted. Use 500 / 800 / 1000. This is a scanning debounce, **not** a time-out feature. |
| `VITE_SUCCESS_OVERLAY_MS` | 1200 | How long the green success overlay stays up. Separate from the cooldown. |
| `VITE_ERROR_OVERLAY_MS` | 2500 | Duplicate / invalid / error overlay duration. |
| `VITE_SAME_CODE_REARM_MS` | 1000 | The same QR must be out of view this long before it is accepted again, so a phone held still never triggers repeat requests. |
| `VITE_SCAN_FPS` | 10 | Decode attempts per second. |
| `VITE_CHECK_IN_TIMEOUT_MS` | 10000 | After this, the scanner shows CONNECTION ERROR. |

How the gate behaves (`src/features/attendance/scanGate.ts`):
- A **synchronous lock** (a ref, not React state) blocks every decode callback while a request is in flight, however long the server takes.
- After the response, the cooldown starts and the overlay **holds** the gate until it is dismissed. With the defaults, the overlay (1.2 s) is longer than the cooldown (0.8 s), so the next attendee can scan as soon as the overlay closes.
- The camera keeps capturing the whole time; callbacks are just ignored. The camera is never restarted after a scan.

---

## Microsoft Forms / Power Automate integration

QR codes are created **outside** this application. A typical flow:

1. Attendee completes a **Microsoft Form**.
2. **Power Automate** receives the response.
3. Power Automate **generates a unique code**.
4. The code is turned into a **QR image**.
5. The attendee **receives the QR by email**.
6. The registration is **saved in Supabase** via the `register-attendee` Edge Function.
7. On event day, the tablet scans the emailed QR.

### Flow, step by step

**① Trigger — Microsoft Forms › "When a new response is submitted"**: select your form.

**② Microsoft Forms › "Get response details"**: Form Id = your form; Response Id = *Response Id* from the trigger.

**③ Generate the unique code — "Initialize variable"**
- Name `QrCode`, Type String, Value (expression):
  ```
  concat('CIT-', toUpper(replace(guid(), '-', '')))
  ```
  This gives an unguessable code such as `CIT-3F2A9C0E…`. Codes are compared as exact text after trimming, and need not be UUIDs.

**④ Register in Supabase — "HTTP" action** (premium connector)
- **Method:** `POST`
- **URI:** `https://<project-ref>.supabase.co/functions/v1/register-attendee`
- **Headers:**
  | Key | Value |
  |---|---|
  | `Content-Type` | `application/json` |
  | `x-registration-secret` | *your REGISTRATION_WEBHOOK_SECRET* |
  | `apikey` | *your publishable (or anon) key*. Lets the Supabase gateway route the call. It grants no data access. |
- **Body:**
  ```json
  {
    "qr_code": "@{variables('QrCode')}",
    "name": "@{outputs('Get_response_details')?['body/<full-name-question-id>']}",
    "id_number": "@{outputs('Get_response_details')?['body/<student-id-question-id>']}",
    "email": "@{outputs('Get_response_details')?['body/responder']}",
    "department": "@{outputs('Get_response_details')?['body/<department-question-id>']}",
    "event_id": 3
  }
  ```
  Use the dynamic-content picker to insert the form answers. Power Automate fills in the `<…-question-id>` parts for you.
- **Settings → Retry policy:** *Exponential interval*, count 4.

**Configuring the event ID:** in the admin dashboard, open **Events**. The number in the **ID** column is the `event_id`. Use `null` (no quotes) to make the registrant eligible for **any** event.

**Retries reuse the same QR value:** the code is generated **once** in step ③ and stored in a variable. The HTTP action's automatic retries resend the exact same body. The function upserts on `qr_code`, so a retry updates the same registration and never creates a duplicate. Response codes: `200 {"status":"ok","id":…,"created":true|false}`, `400` validation errors (details listed), `401` wrong/missing secret, `422` unknown `event_id`.
> Do **not** use *Resubmit* on a run that already succeeded. Resubmitting re-runs step ③, which generates a *new* code and therefore creates a second registration. If it happens, delete the extra registrant in the dashboard.

**⑤ Create the QR image and email it**
- Add an **HTTP** action: `GET https://quickchart.io/qr?size=400&margin=2&text=@{encodeUriComponent(variables('QrCode'))}`. You can use any QR image service, or your institution's own. Note that this sends the code to that service.
- **Office 365 Outlook › "Send an email (V2)"** to the respondent's email: attach the image (Attachments Name `ticket.png`, Content = *Body* of the GET step). Alternatively, embed it in HTML: `<img src="data:image/png;base64,@{base64(body('HTTP_GET_QR'))}" />`. Also write the code itself in text, as a manual fallback.
- **Order:** keep ④ *before* ⑤, and add a condition so the email is sent only when ④ returned status 200. Then nobody receives a QR code that is not registered.

### Fallback if the HTTP connector is unavailable
The HTTP action needs a Power Automate **premium** licence. Without it:
1. Keep steps ①–③ and ⑤ (generate and email the code). Also add **Excel Online › "Add a row into a table"** that writes the **exact QR code value** with the name, ID, email and department.
2. Before the event, download that Excel file, then go to **Dashboard → Registrants → Import Excel**. Re-importing later is safe: rows are matched on the QR code, existing registrations are updated, and check-ins are never touched.

---

## Excel / CSV registration import

**Dashboard → Registrants → Import Excel**
1. Choose the event, or *Any event*. A per-row **Event** column (event ID or exact name) overrides this choice.
2. Choose an **.xlsx** or **.csv** file (max **10 MB / 20,000 rows**). Old `.xls` files must be re-saved as `.xlsx`.
3. Pick the worksheet if there are several. The importer shows the file name, row count and the first 5 rows.
4. Check the **auto-detected column mapping** and override any field. It recognises variants like *QR Token / Unique Code → QR Code*, *Student Number / ID No. → ID*, *Email Address → Email*, *Program / Section → Department*.
5. **Validate rows.** The importer reports missing QR codes or names, duplicate QR codes within the file, unknown events, invalid emails (dropped, not fatal), and **numeric ID / QR cells that may have lost leading zeros**. Row numbers are included. It also warns before moving existing registrants to a different event.
6. **Import.** Rows are upserted in batches of 500 with a progress bar ("Importing 500 / 1,250…"), followed by a summary of imported, updated, skipped and failed rows. If one batch fails, earlier batches are kept and the failing row range is reported. Each import is logged in `import_logs`.

**Guarantees:** importing never creates, changes or deletes attendance. Present/Absent columns are ignored. Blank optional cells never erase existing data. The file type is checked from its **content**, not its extension. Formulas are never executed (only cached cell values are read).

**Leading zeros:** if Excel stored a student ID as a *number*, its leading zeros are already gone from the file and cannot be recovered. Format ID and QR columns as **Text** in Excel, or use CSV. The importer warns you when it sees numeric cells.

Samples: `samples/sample-registrations.csv` and `samples/sample-registrations.xlsx` (two worksheets; regenerate with `npm run samples`).

---

## Security model

| Layer | Protection |
|---|---|
| **Accounts** | Supabase Auth, public sign-up disabled, exactly two roles. Roles live in `app_user_roles` with **no** client INSERT/UPDATE policy, so users cannot self-promote. Disabled accounts have no effective role and are also banned in Auth. |
| **RLS** | Enabled on every table. Anonymous users have **no** table privileges at all. Scanner users **cannot read** attendees or attendance. They see the active event only through `get_active_event()` (id, name, date, venue). |
| **Attendance writes** | Only through functions. `record_qr_check_in` runs only for `service_role` (called by the Edge Function after it verifies the user). `admin_mark_present` / `admin_undo_check_in` check `is_admin()` and write an audit row to `attendance_corrections`. Direct `INSERT/UPDATE/DELETE` on `attendance` is revoked from browser roles, and rows are immutable. |
| **Functions** | Every privileged function is `SECURITY DEFINER` with `SET search_path = ''`, schema-qualified names, its own role check, and `EXECUTE` revoked from `PUBLIC`/`anon`. |
| **Edge Functions** | `check-in` validates the JWT with Supabase Auth and requires an enabled admin/scanner role. It returns only the attendee's **name** (plus event name and time) and generic errors without internals. `manage-scanner-users` is admin-only and can only change scanner accounts. `register-attendee` requires the 32+ character shared secret (constant-time compare), validates every field, and caps body size. |
| **Secrets** | The service-role key and webhook secret exist only as Edge Function secrets. The frontend uses only the publishable key. |
| **Scanner privacy** | Camera frames never leave the tablet and are never stored. Only the decoded QR text is sent. |
| **Exports** | CSV cells starting with `= + - @ TAB CR` are prefixed with `'` to block spreadsheet formula injection. |
| **Headers** | `vercel.json` sets `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy: camera=(self)`. |

---

## Testing

### Automated (run with `npm run check`)

Results from the most recent run in this repository: **97 tests passed across 6 files**. `tsc -b`, `oxlint --deny-warnings`, `vite build` and `deno check` (all three functions) also pass.

| File | What it verifies |
|---|---|
| `tests/database.test.ts` | Runs **all four migrations in PGlite** (real PostgreSQL) with emulated Supabase roles. Covers: single active event; atomic switch; check-in `ok` → `already` with the **unchanged original `scanned_at`**; UNIQUE constraint; wrong-event / invalid / empty / oversized codes; disabled and role-less callers refused; browser roles cannot call `record_qr_check_in`; `scanned_at` immutable; RLS (scanner sees no registrants or attendance; anon sees nothing; no self-promotion); import upsert never touches attendance and keeps existing values; Power Automate upsert is idempotent; stats definitions; audited manual check-in and undo; event delete protection; no time-out columns exist. |
| `tests/check-in.test.ts` | The real Edge Function handler: 401 / 403 / 400 / 405 paths, minimal response fields, generic 500s. Client response parsing never turns a malformed reply into success. Overlay text for every outcome; Asia/Manila times. |
| `tests/scanner.test.ts` | ScanGate: synchronous lock, slow server, 500 / 800 / 1000 ms cooldowns, overlay hold, per-code re-arm, retry after network error. Front-camera selection never picks a rear camera. Track verification, error classification, decode-region sizing. |
| `tests/scanner-page.test.tsx` | Renders the **real ScannerPage** with a fake html5-qrcode camera. Checks that it requests `facingMode: {exact: "user"}`, that 8 rapid decodes produce **1** request, that the full-screen overlay shows the name and **auto-dismisses**, that the **camera is started once and never stopped or restarted**, that the next attendee is accepted on the same session, that connection errors never show success, and that the invalid / wrong-event / no-event overlays render. |
| `tests/import-registration.test.ts` | Real `.xlsx` (multi-sheet) and `.csv` parsing; extension/content mismatch, `.xls`, empty and corrupt files; formulas not executed; header auto-mapping; validation with row numbers; leading-zero warnings; 500-row batching with accurate progress; partial-failure reporting; only the registration RPC is called. |
| `tests/authorization.test.ts` | Route guards; Edge Function staff auth; admin-only scanner management (cannot touch admins or self); webhook secret, validation and idempotency inputs; CORS restriction; CSV formula-injection protection. |

**Not covered by automated tests:** true multi-connection concurrency, because PGlite is single-connection. Correctness rests on PostgreSQL's unique-index semantics with `ON CONFLICT DO NOTHING`. To see it on a real database, follow `supabase/tests/manual_concurrency_check.sql` (two SQL sessions, about 2 minutes).

### Manual / physical-device checklist (requires the Xiaomi Pad 7)

These **cannot** be verified without the tablet and **have not been run**. Please tick them during your first rehearsal:

- [ ] Chrome on the Pad 7 asks for camera permission and the **front** camera opens (selfie view, header says "Front camera").
- [ ] The rear camera is never used (cover the front lens: the preview goes dark rather than switching cameras).
- [ ] Denying permission shows **Front Camera Access Denied** with instructions, and **Retry Camera** works after allowing.
- [ ] A QR on another phone (normal brightness, 25–50 cm) decodes reliably. Also try bright window light, a dim hall, and small or large phones.
- [ ] After a check-in the overlay shows the name and disappears, and the preview **continues without flicker or re-permission**.
- [ ] Holding the same phone up continuously does not trigger repeated overlays.
- [ ] Landscape and portrait both lay out without scrolling, and rotating does not stop the camera.
- [ ] Turning the screen off and on, or switching apps and back, recovers the camera (tap Retry Camera if not).
- [ ] Two tablets scanning the same code at once produce one **WELCOME** and one **ALREADY CHECKED IN**, and the dashboard shows one record.
- [ ] Wi-Fi off → **CONNECTION ERROR** (never WELCOME). Wi-Fi on → scanning works again.
- [ ] The admin dashboard on another device updates live; disconnecting it shows **Not live**.
- [ ] The PWA installs to the home screen and the screen stays awake during a 15-minute idle period.

---

## Troubleshooting the camera

| Symptom | Fix |
|---|---|
| "Secure Connection Required" | Open the **https://** address. Camera access is blocked on plain http (except `localhost`). |
| "Front Camera Access Denied" | Address-bar icon → Permissions → Camera → Allow, then **Retry Camera**. For the installed app: Android Settings → Apps → Chrome → Permissions → Camera. |
| "Front Camera Busy" | Close the camera app, video calls or other Chrome tabs using the camera, then retry. |
| "Front Camera Not Available" | The browser could not open or identify a front-facing camera. The app refuses to fall back to the rear camera. Restart Chrome and update Chrome / Android. |
| "Front camera (unverified)" | Chrome did not report the facing direction. Confirm visually that the preview shows the person facing the screen. |
| Codes are slow to read | Ask attendees to raise screen brightness and hold the phone steady inside the gold frame, 25–50 cm away. Avoid glare from lights behind the attendee. You can try `VITE_SCAN_FPS=15`. |

---

## Known limitations

- **Front-camera identification depends on the browser.** The app requests `facingMode: {exact: "user"}`, then falls back to device capabilities and labels (Android Chrome reports "facing front"). It never silently uses a rear camera. It cannot *prove* lens direction when a browser reports nothing, which is why the "unverified" state exists and **on-device verification is required**.
- **No uninterrupted scanning while the screen is locked or Chrome is in the background.** Android suspends the camera. The app recovers when the page becomes visible again.
- **No autofocus, torch or zoom assumptions.** Front cameras usually lack them.
- **Realtime is best-effort.** If the websocket drops, the dashboard shows *Not live* and catches up on reconnect. Scanners also poll every 30 s. The server always decides the active event.
- **Power Automate *Resubmit*** generates a new code (see above).
- **Fonts** come from Google Fonts. Without internet at first load, system fonts are used. The scanner itself needs internet anyway, because every check-in is confirmed online.
- **`npm audit`** reports moderate advisories in `workbox-build` (via `vite-plugin-pwa`). It is a build-time-only dependency that is not shipped to browsers. The only automatic "fix" downgrades the PWA plugin.
#   Q R - A t t e n d a n c e - A p p 
 
 
