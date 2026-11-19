# Testing

## Automated tests

Run everything with:

```bash
npm run check             # tsc + oxlint + vitest
npm run check:functions   # deno check of the three Edge Functions
```

Last recorded run: **105 tests passed across 6 files**; `tsc -b` and `oxlint --deny-warnings` also passed.

| File | What it verifies |
|---|---|
| `tests/database.test.ts` | Runs **all migrations in PGlite** (real PostgreSQL in WebAssembly) with emulated Supabase roles. Single active event; atomic switch; check-in `ok` â†’ `already` with unchanged original `scanned_at`; UNIQUE constraint; wrong-event / invalid / empty / oversized codes; disabled and role-less callers refused; browser roles can't call `record_qr_check_in`; `scanned_at` immutable; RLS (scanner sees no registrants or attendance, anon sees nothing, no self-promotion); import upsert never touches attendance; Power Automate upsert is idempotent; stats; audited manual check-in and undo; event delete protection. |
| `tests/check-in.test.ts` | The real Edge Function handler: 401 / 403 / 400 / 405 paths, minimal response fields, generic 500s. Malformed replies never become success. Overlay text for every outcome; Asia/Manila times. |
| `tests/scanner.test.ts` | ScanGate: synchronous lock, slow server, 500 / 800 / 1000 ms cooldowns, overlay hold, per-code re-arm, retry after network error. Front-camera selection never picks a rear camera. |
| `tests/scanner-page.test.tsx` | Renders the real ScannerPage with a fake camera: requests `facingMode: {exact: "user"}`, 8 rapid decodes produce **1** request, a success goes to the top of the Attendance Log highlighted (no overlay) and survives a slow, older log sync, other outcomes still show their overlay, camera started once and never restarted, connection errors never show success. |
| `tests/import-registration.test.ts` | Real `.xlsx` (multi-sheet) and `.csv` parsing; mismatched, `.xls`, empty and corrupt files; formulas not executed; header auto-mapping; validation with row numbers; leading-zero warnings; 500-row batching and progress; partial-failure reporting. |
| `tests/authorization.test.ts` | Route guards; Edge Function staff auth; admin-only scanner management; webhook secret, validation and idempotency; CORS restriction; CSV formula-injection protection. |

**Not covered:** true multi-connection concurrency (PGlite is single-connection). Correctness relies on PostgreSQL's unique index with `ON CONFLICT DO NOTHING`. To see it on a real database, follow `supabase/tests/manual_concurrency_check.sql` (two SQL sessions, about 2 minutes).

---

## Physical-device checklist

These need the Xiaomi Pad 7 and **have not been run yet**. Tick them during the first rehearsal:

- [ ] Chrome asks for camera permission and the **front** camera opens (selfie view, header says "Front camera").
- [ ] The rear camera is never used (cover the front lens: the preview goes dark rather than switching cameras).
- [ ] Denying permission shows **Front Camera Access Denied**, and **Retry Camera** works after allowing.
- [ ] A QR on another phone (normal brightness, 25â€“50 cm) decodes reliably. Also try bright window light, a dim hall, and small and large phones.
- [ ] After a check-in, the name appears at the top of the Attendance Log, highlighted, and the preview **continues without flicker or re-permission**.
- [ ] Holding the same phone up continuously doesn't add repeated entries or trigger overlays.
- [ ] A check-in on a second tablet (or a manual check-in on the dashboard) appears in this tablet's log within about 10 s.
- [ ] The log is readable from where attendees stand. Consider whether showing names on a public screen is acceptable for your event.
- [ ] Landscape and portrait both fit without scrolling, and rotating doesn't stop the camera.
- [ ] Turning the screen off and on, or switching apps and back, recovers the camera (tap Retry Camera if not).
- [ ] Two tablets scanning the same code at once give one new log entry and one **ALREADY CHECKED IN**, and the dashboard shows one record.
- [ ] Wi-Fi off â†’ **CONNECTION ERROR** (never a new log entry). Wi-Fi on â†’ scanning works again.
- [ ] The admin dashboard on another device updates live; disconnecting it shows **Not live**.
- [ ] The PWA installs to the home screen and the screen stays awake through 15 minutes idle.
