# console-e2e

Playwright against the **real built server serving the real built console** at one origin — what a
deploy runs, not a Vite dev server. Chromium only, one worker.

```bash
export DATABASE_URL=postgresql://shipyard:shipyard@127.0.0.1:5432/shipyard_console_test  # wiped!
pnpm --filter console-e2e test
```

- `DATABASE_URL` must name a database ending in `_test`; the harness wipes it on every run.
- `SHIPYARD_PORT` (default 3462); `CONSOLE_E2E_SKIP_BUILD=1` when the workspace is already built.
- `SHIPYARD_URL` points the suite at a server you started yourself (no webServer, no build).

## How a run goes

1. `harness/serve.mjs` (Playwright's `webServer`) builds schema → sequence → server → web, runs
   `prisma migrate deploy`, and starts `apps/server/dist/index.js` with `harness/github-stub.mjs`
   preloaded: GitHub's `compare` and workflow-runs calls are answered from a fixed commit graph, so
   commits waiting, CI dots and Ship buttons are identical on every run. Nothing leaves the machine.
2. `harness/global-setup.ts` wipes and seeds the baseline (`harness/seed.ts`) through the server's
   own Prisma client, writes the IDs to `.state/fixture.json`, and signs each role in once through
   the real form (password + TOTP), saving `.state/<role>.json`.
3. Tests start signed in: `test.use({ storageState: storageStateFor('admin') })`.

## Writing a test

- **IDs:** `fixture()` — app names (`history`, `neverDeployed`, `drifted`, `frozen`, `approval`,
  `canary`, `groupMember`), deploy IDs (`succeeded`, `rolledBack`, `refused`, `inProgress`,
  `awaitingApproval`), the group, the invite token.
- **A different world:** `withDb(async (db) => { await wipeAppData(db); … })` keeps users and
  sessions; build what you need with `createApp`, `createDeploy`, `sha(n)`, `digest(label)`, and
  put the baseline back with `withDb(reseedWorld)` in `afterAll`. Commit SHAs the stub knows are
  listed in `harness/github-stub.mjs`.
- **A server with no account (first-run setup):** `const snap = await withDb(enterZeroUserWorld)`
  copies the accounts and sessions out and empties everything; `withDb((db) => restoreAccounts(db,
  snap))` writes them back verbatim (same session token hashes, so every `storageState` stays
  valid) and reseeds the world. See `tests/setup.spec.ts`.
- **Error and loading states:** `page.route('**/api/…', …)` to fail or stall one call.
- **Signing in inside a test:** `signIn(page, USERS.viewer, { waitForFreshStep: true })` — a TOTP
  step is spent once per user.
- **Theme and axe:** `forceTheme(page, 'dark')` before `goto`, `settle(page)`, then
  `axeViolations(page)`.
- **The redesigned console (`harness/console.ts`):** `h1`, `dialog`, `appRow(page, app)` (Apps ›
  All apps), `needsYouRow(page, app)`, `alertBox`, `hold()` and `fakeDryRun()` for a held or faked
  call, and the two widths every screen is checked at — `test.use({ viewport: DESKTOP })` (1440 px)
  and `test.use(PHONE)` (390 px, `isMobile` and `hasTouch`, so `(pointer: coarse)` matches and
  @d3cloud/ui's 44 px touch targets apply).
- **The phone rules:** `expectPhoneFit(page, where)` fails when the document scrolls sideways
  (SHP-REQ-172) or a visible primary button is under 44 px (SHP-REQ-166), naming the culprits. The
  axe sweep runs it on every screen state at 390 px; `tests/phone.spec.ts` walks the main screens
  and proves every sheet opens from the bottom edge with its footer pinned (SHP-REQ-173).
