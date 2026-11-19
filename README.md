## Contents

1. [Run it locally](#1-run-it-locally)
2. [Deploy (first-time setup)](#2-deploy-first-time-setup)
3. [Running an event](#3-running-an-event)
4. [Importing registrations](#4-importing-registrations)
5. [Scanner settings](#5-scanner-settings)
6. [Troubleshooting](#6-troubleshooting)
7. [Known limitations](#7-known-limitations)
8. [More documentation](#8-more-documentation)

---

## 1. Run it locally

**You need:** Node.js 20.19+ (22 or 24 LTS recommended), Git, and the Supabase project from [step 2.1](#21-supabase).

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local` from Supabase Dashboard → **Project Settings → API**:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…     # or the legacy "anon" key
```

> **Never** put the service-role/secret key or the webhook secret in a `VITE_` variable. Those are bundled into the browser.

```bash
npm run dev               # http://localhost:5173
npm run check             # type-check + lint + tests
npm run build             # production build
npm run check:functions   # type-check the Edge Functions (downloads Deno)
```

The camera only works on **HTTPS or `localhost`**. To test the scanner on the tablet, use the deployed Vercel URL. A LAN address like `http://192.168.x.x:5173` will not get camera access.

---

## 2. Deploy (first-time setup)

Do these in order. Use `npx supabase …` for every Supabase command (no global install needed).

### 2.1 Supabase

**a. Create the project.** Supabase Dashboard → **New project**. Pick a region near the Philippines (e.g. Singapore) and save the database password.

**b. Link and apply the database migrations.**

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push --remote
```

- `<project-ref>` is the ID in your project URL: `https://<project-ref>.supabase.co`. It's also under **Project Settings → General → Project ID**.
- When asked for a password, use the **database password** from step a, not your Supabase account password.
- `--remote` matters: without it, newer CLI versions try to push to a local Docker database.
- No CLI? Run the four files in `supabase/migrations/` **in order** in the Dashboard's **SQL Editor**.
- Do **not** run `seed.sql` in production. It's local demo data.

The migrations also turn on Row Level Security for every table and enable Realtime. Nothing else to configure for those.

**c. Configure sign-in.** Dashboard → **Authentication → Sign In / Providers**:
- Keep **Email** enabled.
- Turn **off "Allow new users to sign up"**. Only administrators create accounts.

**d. Deploy the Edge Functions.**

```bash
npx supabase functions deploy check-in
npx supabase functions deploy register-attendee
npx supabase functions deploy manage-scanner-users
```

`config.toml` sets `verify_jwt = false` for these on purpose: each function checks the caller itself.

> If your project has **disabled legacy API keys**, create a secret key (Project Settings → API Keys) and run `npx supabase secrets set SERVICE_ROLE_KEY=sb_secret_…`.

**e. Set the webhook secret** (used by Power Automate). Any random string of 32+ characters, e.g. from a password generator:

```bash
npx supabase secrets set REGISTRATION_WEBHOOK_SECRET=<random-32+-characters>
```

Keep it out of the frontend and out of Git.

### 2.2 Add users

Dashboard → **Authentication → Users → Add user → Create new user**. Enter the email and a strong password, and tick **Auto Confirm User**.

**Every user you add here can sign in with full admin access.** No extra step is needed: migration `005_default_admin_role.sql` assigns the role automatically. Public sign-up is disabled, so only people you add can get in.

Tablet accounts with **restricted, scan-only access** should be created inside the app instead (**Dashboard → Scanner Users**).

### 2.3 GitHub

Create an **empty** repository on GitHub (no README or .gitignore), then:

```bash
git init
git add .
git commit -m "CIT QR Attendance System"
git branch -M main
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

When Git asks for a password, paste a **personal access token**, not your GitHub password. See [Troubleshooting](#setup-problems) if the push fails. `.gitignore` already keeps `.env.local` out of the repository.

### 2.4 Vercel

1. Vercel → **Add New → Project** → import the repository. Vercel detects **Vite**. Keep the build command `npm run build` and output directory `dist`.
2. Under **Environment Variables**, add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
   - *(optional)* any [scanner settings](#5-scanner-settings)
3. Click **Deploy**. Note your URL, e.g. `https://cit-qr-attendance.vercel.app`.

If you change environment variables later, **redeploy** (Deployments → ⋯ → Redeploy). Vite builds them into the app.

### 2.5 Point Supabase at your Vercel URL

1. Dashboard → **Authentication → URL Configuration**: set **Site URL** to your Vercel URL and add it under **Redirect URLs** (plus `http://localhost:5173` for local testing). Invitation emails link here.
2. Optional but recommended: restrict the Edge Functions to your site and set where invites land:
   ```bash
   npx supabase secrets set ALLOWED_ORIGINS=https://<your-app>.vercel.app SITE_URL=https://<your-app>.vercel.app
   ```
   `ALLOWED_ORIGINS` accepts a comma-separated list.

### 2.6 Set up the tablet

1. Open `https://<your-app>.vercel.app` in **Google Chrome** on the Xiaomi Pad 7 and sign in with a **scanner** account. You land on `/scan`.
2. Tap **Allow** when Chrome asks for the camera.
3. Check that the preview shows the **people in front of the screen** (mirrored, like a selfie) and the header says **"Front camera"** in green. If it says **"Front camera (unverified)"** in amber, just confirm visually that it's the front camera. To scan with the **back** camera instead, tap **⇄ Use back camera** under the preview. Each tablet remembers its choice.
4. Tap **⛶ Full screen** under the preview for event use. It hides the header (title, Sound, Dashboard, Log out) and Chrome's address bar, leaving only the scanner, the Attendance Log and the toggle. Tap **✕ Exit full screen** (or use Android's back gesture) to get the header back.
5. Chrome menu **⋮ → Add to Home screen / Install app**. Launching from the icon opens full-screen and keeps the screen awake. As a backup, set Android **Settings → Display → Sleep** to a long timeout.

### 2.7 Rehearsal test

1. As admin: **Dashboard → Events** → create an event → **Set active**.
2. Import `samples/sample-registrations.csv`, or add a registrant with QR value `ABC001`.
3. Show a QR code containing `ABC001` on a phone (any online QR generator works), 25–50 cm from the tablet, inside the gold frame:
   - First scan → **Juan Dela Cruz** appears at the top of the **Attendance Log**, highlighted green with the time
   - Same code again (move it away for ~1 s first) → amber **ALREADY CHECKED IN** with the original time
   - An unregistered code → red **INVALID QR CODE**
4. On a laptop signed in as admin, the dashboard shows **Live** and the counts update within a second of each scan.

Before the first real event, go through the [physical-device checklist](docs/testing.md#physical-device-checklist).

---

## 3. Running an event

| Task | Where |
|---|---|
| Create an event and make it the one being scanned | **Dashboard → Events → Set active**. Only one event can be active. Tablets switch automatically. |
| Add registrants | Automatically via [Power Automate](docs/power-automate.md), by [spreadsheet import](#4-importing-registrations), or manually under **Dashboard → Registrants**. |
| Create scanner accounts | **Dashboard → Scanner Users → + New scanner user**. Set a temporary password, or send an email invite (needs SMTP under Authentication → Emails). |
| Block a scanner immediately | **Dashboard → Scanner Users → Disable**. |
| Watch attendance | **Dashboard**: present / absent / rate / recent check-ins, updated live. |
| Fix a mistake | Admins can manually mark someone present or undo a check-in. Both are logged. |

### What the tablet shows

The scanner screen shows the camera on one side and the **Attendance Log** on the other: everyone checked in to the active event, newest first, with their check-in time. It includes check-ins from other tablets and manual check-ins (refreshed every 10 s). The tablet shows only names and times.

| Situation | What appears |
|---|---|
| First valid scan | The name goes to the **top of the log**, highlighted green ✓ with the time. No full-screen overlay; the next person can scan right away. |
| Already checked in | amber **ALREADY CHECKED IN** + original time |
| Unknown code | red **INVALID QR CODE** |
| Registered for another event | red **NOT REGISTERED FOR THIS EVENT** |
| No active event | red **NO ACTIVE EVENT** |
| Network failure or timeout | red **CONNECTION ERROR** (never shows success) |

Every outcome except a successful check-in still uses a full-screen overlay, so problems are hard to miss. Times are shown in Asia/Manila time.

---

## 4. Importing registrations

**Start from a template:** in the import window, click **Download Excel template (.xlsx)** or **Download CSV template (.csv)**. The Excel file is also at [`public/templates/attendee-import-template.xlsx`](public/templates/attendee-import-template.xlsx). Fill in the **Attendees** sheet, one attendee per row. Only **QR Code** and **Full Name** are required. The **How to fill in** sheet explains each column and shows example rows. The ID and QR columns are pre-formatted as Text, so leading zeros are kept. (Regenerate it with `npm run template`.)

| QR Code | Full Name | Student ID | Email | Department | Section | Event |
|---|---|---|---|---|---|---|
| *required* | *required* | optional | optional | optional | optional | optional: blank = the event you pick when importing |

**Dashboard → Registrants → Import Excel**

1. Choose the event (or *Any event*). A per-row **Event** column (ID or exact name) overrides this.
2. Choose an **.xlsx** or **.csv** file (max 10 MB / 20,000 rows). Re-save old `.xls` files as `.xlsx`.
3. Pick the worksheet, check the preview, and confirm the auto-detected column mapping.
4. **Validate rows**. Problems are listed with row numbers.
5. **Import**. You get a summary of imported, updated, skipped and failed rows.

Good to know:
- Importing **never** changes attendance. Present/Absent columns are ignored.
- Re-importing is safe: rows are matched on the QR code and updated.
- Blank optional cells never erase existing data.
- **Leading zeros:** if Excel stored an ID as a *number*, its leading zeros are already lost. Format ID and QR columns as **Text**, or use CSV. The importer warns you when it sees numeric cells.

Sample files are in `samples/` (regenerate the .xlsx with `npm run samples`).

---

## 5. Scanner settings

Defaults live in `src/config.ts`. Override any of them with Vercel environment variables, then redeploy.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_SCAN_COOLDOWN_MS` | 500 | Minimum gap between processed scans. Try 500 / 800 / 1000. |
| `VITE_SUCCESS_OVERLAY_MS` | 1200 | Length of the "just checked in" flash on the newest log row. |
| `VITE_CHECK_IN_LOG_REFRESH_MS` | 10000 | How often the Attendance Log re-syncs to show check-ins from other tablets. |
| `VITE_ERROR_OVERLAY_MS` | 2500 | How long duplicate / invalid / error overlays stay up. |
| `VITE_SAME_CODE_REARM_MS` | 1000 | The same QR must leave the view this long before it's accepted again. |
| `VITE_SCAN_FPS` | 15 | Decode attempts per second. The whole camera picture is scanned, so a code is read anywhere in view. |
| `VITE_CHECK_IN_TIMEOUT_MS` | 10000 | After this, the scanner shows CONNECTION ERROR. |

---

## 6. Troubleshooting

### Setup problems

| Problem | Fix |
|---|---|
| `db push` says `failed to connect to postgres … 127.0.0.1:54322` | It's targeting a local database. Run `npx supabase db push --remote`. |
| `git push` says `Repository not found` | Check the repo exists at that exact URL in your browser. If it does, Git is signed in as a different account: remove the `git:https://github.com` entries in **Windows Credential Manager** and push again. |
| `git push` says `Password authentication is not supported` | Use a **personal access token** as the password: GitHub → Settings → Developer settings → Personal access tokens → Generate (scope `repo`). For an organization with SSO, also authorize the token for it. |
| Changed a Vercel env variable but nothing changed | Redeploy. Values are built in at build time. |
| Invite emails link to the wrong site | Set the Site URL ([step 2.5](#25-point-supabase-at-your-vercel-url)). |

### Camera problems

| Message / symptom | Fix |
|---|---|
| "Secure Connection Required" | Open the **https://** address. |
| "Camera Access Denied" | Address-bar icon → Permissions → Camera → Allow, then **Retry Camera**. For the installed app: Android Settings → Apps → Chrome → Permissions → Camera. |
| "Front/Back Camera Busy" | Close the camera app, video calls or other tabs using the camera, then retry. |
| "Front/Back Camera Not Available" | Restart Chrome; update Chrome and Android, or switch cameras with **⇄**. The app never silently uses the other camera. |
| "Front camera (unverified)" | Chrome didn't report the camera direction. Confirm visually that it's the right camera. |
| Codes are slow to read | Attendees should raise screen brightness and hold the phone steady, 25–50 cm away. Avoid strong light behind them. You can try `VITE_SCAN_FPS=20`. |

---

## 7. Known limitations

- **Camera direction detection depends on the browser.** The app never silently uses the other camera, but if Chrome doesn't report the direction it shows "unverified", so check on the device.
- **Scanning stops while the screen is locked or Chrome is in the background.** It recovers when the page is visible again.
- **Realtime is best-effort.** If the connection drops, the dashboard shows *Not live* and catches up on reconnect. Tablets also re-check the active event every 30 s.
- **Power Automate *Resubmit*** on a run that already succeeded creates a second registration with a new code. See [docs/power-automate.md](docs/power-automate.md).
- **Internet is required.** Every check-in is confirmed online.
- **Fonts:** Nexa ExtraLight and Nexa Heavy (Fontfabric) are served from `public/fonts/`. Check that your Nexa license allows web embedding.
- **`npm audit`** reports moderate advisories in `workbox-build`, a build-time-only dependency that isn't shipped to browsers.

---

## 8. More documentation

| Document | Contents |
|---|---|
| [docs/power-automate.md](docs/power-automate.md) | Microsoft Forms + Power Automate flow that generates, registers and emails QR codes |
| [docs/architecture.md](docs/architecture.md) | How check-in works, project structure, security model |
| [docs/testing.md](docs/testing.md) | Automated test coverage and the physical-device checklist |
