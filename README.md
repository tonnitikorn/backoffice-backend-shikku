# ShikkuLens POS — Backend

Express + TypeScript API for the ShikkuLens contact-lens shop POS/backoffice system, implementing the full v1.1 requirement (see `../prompt_requirement_doc_contact_lens_pos.md` Parts A–D — Part A/B are the real spec; Part C are the defaults this implementation uses; Part D is out of scope). MongoDB (Atlas) via Mongoose, with multi-document transactions for every stock-affecting operation.

## Setup

```bash
npm install
```

`.env` is already populated from `../atlas-credentials.env` (same repo tree, gitignored) plus generated JWT secrets, pointing at the `shikkulens` database on the shared Atlas cluster. `.env.test` points at a separate `shikkulens_test` database used only by the automated test suite. Neither file is committed — see `.env.example` for the shape.

## Run

```bash
npm run dev      # http://localhost:4000, health check at /health
```

## Seed demo data

```bash
npm run seed
```

Wipes and repopulates the `shikkulens` database with 2 branches, users for every role, a contact-lens product with generated SKUs, an "other" product, a confirmed purchase at both branches, a promotion + stackable coupon, a published shift schedule entry, and a simulated business day (shift open → a plain sale → a split-payment sale → a stock transfer between branches → an approved refund → shift close/approve) plus a shipped online order. Prints login credentials at the end, e.g.:

- `admin@shikkulens.local` / `adminPass123!`
- `manager.siam@shikkulens.local` / `branch_managerPass123!`
- `staff1.siam@shikkulens.local` / `staffPass123!`

Re-run any time to reset to a clean demo state (it wipes only the collections this app owns, in the `shikkulens` db).

## Tests

```bash
npm test
```

Runs against the isolated `shikkulens_test` database (real Atlas cluster, different DB name — never touches seeded dev data). Covers the two scenarios the spec explicitly calls for:

- **RBAC (B3)** — staff never receive the `cost` field, branch-scoped actions are rejected outside a staff member's own branch, and a staff report request older than 1 day is rejected by the API itself (not just hidden in the UI).
- **Concurrency (B6)** — two simultaneous sales of the last unit of stock: exactly one succeeds, verified against the real MongoDB replica set.

Plus stock-transfer state machine and shift-close cash-math coverage.

## Architecture

- `src/models` — one Mongoose schema per collection (~35 collections; see the plan/spec for the full list).
- `src/services` — all business logic; controllers stay thin. `inventoryService.moveStock` is the single choke point for every stock mutation (atomic conditional decrement + append-only ledger, same DB transaction).
- `src/middleware/auth.ts` — JWT auth, `requireRole`, `requireBranchScope`. This is the actual enforcement layer; the frontend's `RoleGate` is UI convenience only.
- `src/jobs/dailyJobs.ts` — ledger-vs-inventory reconciliation and overdue-transfer notifications, run on a daily interval from `index.ts`.
- LINE notifications and cloud file storage are stubbed behind `src/lib/lineClient.ts` (no-ops without `LINE_CHANNEL_ACCESS_TOKEN`) and local disk (`/uploads`) respectively — drop real credentials into `.env` to activate either, no code changes needed.

## Known simplifications (documented, not hidden)

- Loyalty points earn/redeem rules are an explicit Open Question in the spec (Part C) — `totalSpend` is tracked but points are not auto-awarded.
- Exchange-type refunds record the refund/stock side; the replacement sale is created as a normal second `POST /api/sales` call from the frontend rather than one atomic combined transaction.
- The shift-schedule calendar is list-based (add entries, publish) rather than a full drag-and-drop month grid.

## Production

- API: https://shikkulens-api.onrender.com (Render, free plan, Singapore) — defined in `render.yaml`; secrets (`MONGODB_URI`, `CORS_ORIGIN`, `ANTHROPIC_API_KEY`) live in the Render dashboard.
- Every push to `main` auto-deploys.
- `.github/workflows/keep-alive.yml` pings `/health` every 10 minutes so the free instance doesn't spin down.
- Uploaded photos are stored on local disk, which Render's free plan wipes on every deploy/restart.
- `seed` / `seed:demo` refuse to run with `NODE_ENV=production`; bootstrap an empty database with `npm run create-admin`.
