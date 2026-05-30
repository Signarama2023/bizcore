# BizCore — Business Intelligence Dashboard

> Claude Code context file. Read this at the start of every BizCore-related session.
> Repo-level context lives in `../CLAUDE.md`; this file covers the BizCore sub-app specifically.

## What This Project Is

BizCore is a React BI dashboard for small-business owners (originally built for Signarama Temecula, a sign shop; being productized for other Corebridge-using owners). It serves at `/bizcore` from the same Express monolith that powers the team calendar — one Render service, one Dockerfile, one SQLite database on persistent disk.

**The trinity:** every business-health number comes from one of three live integrations.

| Source | What it provides |
|---|---|
| **Corebridge** (live API) | Sales pipeline — Newly Created / Completed / Paid / WIP, AR aging, top customers |
| **BankSync** (Plaid-backed, live) | Bank cash, real revenue (deposit truth), expenses, debt service outflows |
| **Payroll** — Gusto API or universal CSV/PDF upload | Labor cost (gross + employer taxes + benefits), employee count, payroll-to-revenue ratio |

The owner runs **Profit First** (Mike Michalowicz) with 5 named bank accounts (Income 7068, Opex 7076, Owners 7092, Profit 7100, Tax 7118) plus AMEX. Allocations from Income to the 4 reserves happen twice monthly per CAPs.

What the dashboard does:
- One-glance Dashboard with the latest AI verdict + live KPIs (Bank cash, MTD net flow, payroll MTD, outstanding debt)
- Pipeline page with the 4 Corebridge buckets (live sync)
- Finance page with bank balances + payroll cost
- Debts page (manual entry, auto-matched against BankSync payments)
- Evaluation page — comprehensive AI synthesis from every connected source, three-horizon framing (MTD / QTD / YTD), one-word verdict (STRONG / STABLE / MIXED / DETERIORATING / WEAK) + prioritized action list

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 (Vite) — no React Router, page switching via `useState` in `App.jsx` |
| Styling | Plain CSS with CSS variables (no Tailwind, no CSS-in-JS) |
| State | React local state + `localStorage` for ephemera (AI verdict cache, toggles) |
| Charts | Recharts (one library, used in EvaluationCharts.jsx) |
| Backend | Node.js + Express monolith at repo-root `server.js` (shared with the calendar) |
| Database | SQLite via `better-sqlite3` on Render persistent disk |
| AI | Anthropic Claude — proxied through `/api/claude/messages` (server-side key only) |
| Bank | BankSync (Plaid-backed); env `BANKSYNC_API_KEY` |
| Payroll | Gusto REST API (`GUSTO_API_TOKEN` + `GUSTO_COMPANY_ID`); falls back to user PDF/CSV upload extracted by Claude |
| Corebridge | Bearer-token API; env `COREBRIDGE_API_TAG` |
| QuickBooks | OAuth scaffolding dormant (SEC-03); kept as 503-gated dead code, not active |

---

## Project Structure

```
bizcore/
├── CLAUDE.md                           ← You are here
└── src/
    ├── App.jsx                         ← Root, page routing via useState
    ├── main.jsx                        ← Vite entry
    ├── styles/globals.css              ← Design system (CSS variables, cards, tables, badges)
    ├── components/
    │   ├── Sidebar.jsx                 ← Nav (Dashboard / Finance / Pipeline / Sales Team / Debts / Evaluation / Settings)
    │   ├── BankAccounts.jsx            ← Finance: BankSync status panel (only)
    │   ├── PayrollPanel.jsx            ← Finance: Gusto sync OR universal PDF/CSV upload
    │   ├── EvaluationCharts.jsx        ← All Recharts visualizations + DebtKpiBar + PayrollKpiBar
    │   ├── FreshnessBadge.jsx          ← Per-bucket "synced today" pill on Pipeline
    │   └── Markdown.jsx                ← Light markdown renderer for AI evaluation output
    ├── pages/
    │   ├── Dashboard.jsx               ← Trinity snapshot + AI verdict hero + connection health
    │   ├── Finance.jsx                 ← Just renders <BankAccounts /> + <PayrollPanel />
    │   ├── Pipeline.jsx                ← Corebridge live sync (4 buckets, by-period matrix, AR upload)
    │   ├── SalesTeam.jsx               ← Sales rep commission breakdown
    │   ├── Debts.jsx                   ← Debt CRUD + KPI strip + recent matched payments
    │   ├── Evaluation.jsx              ← AI-powered comprehensive read (calls Claude proxy)
    │   └── Settings.jsx                ← Connection setup checklist (Corebridge / Bank / Payroll)
    └── utils/
        ├── format.js                   ← fmt() — currency formatting (use everywhere)
        ├── claude.js                   ← callClaude / callClaudeWithPDF (via server proxy)
        ├── persistedBank.js            ← /api/banksync/persisted/* client
        ├── corebridge.js               ← /api/corebridge/pipeline client + period helpers
        ├── payroll.js                  ← /api/gusto/* + /api/payroll/upload client + extraction prompt
        ├── debts.js                    ← /api/debts/* client + enum constants
        ├── pipeline.js                 ← Corebridge AR aging CSV parser
        ├── evaluation.js               ← Builds the multi-source AI prompt
        ├── salesTeam.js                ← Sales rep aggregation
        ├── reminders.js                ← Stale-upload badge for Pipeline buckets
        ├── csv.js                      ← splitCSVLine + parseAmount primitives
        ├── spreadsheet.js              ← XLSX/CSV file reader (for payroll upload)
        └── quickbooks.js               ← Dormant — kept as reference, not imported
```

Backend lives in **`server.js`** at the repo root (NOT under `bizcore/server/`). All BizCore endpoints sit under `/api/...` alongside the calendar's endpoints.

---

## Routing

`App.jsx` switches pages via a `useState` string. No React Router.

```jsx
// To add a new page:
// 1. Import it in App.jsx
// 2. Add to the PAGES map
// 3. Add a nav entry in Sidebar.jsx NAV array
```

| Page ID | Component | Primary data source |
|---|---|---|
| `dashboard`   | Dashboard.jsx | Trinity APIs (live) + bizcore.evaluation.latest (LS) |
| `finance`     | Finance.jsx   | BankAccounts + PayrollPanel |
| `pipeline`    | Pipeline.jsx  | `/api/corebridge/pipeline` (live) |
| `sales-team`  | SalesTeam.jsx | Pipeline localStorage cache |
| `debts`       | Debts.jsx     | `/api/debts/*` |
| `evaluation`  | Evaluation.jsx | Claude proxy + every server endpoint |
| `settings`    | Settings.jsx  | Static env-var checklist |

---

## Data Architecture

```
React page
  → fetch /api/...  (admin + BizCore-cookie gated)
    → Express handler in repo-root server.js
      → SQLite read OR upstream API call (Corebridge / BankSync / Gusto / Anthropic)
        → normalize / reconcile / persist
          → JSON back to client
```

**Source of truth tables in SQLite:**
- `bank_accounts` + `bank_transactions` — BankSync (hard-reconciled at sync time, rolls back on mismatch)
- `payroll_runs` — Gusto API + manual-upload rows, keyed on `payroll_uuid` (Gusto UUID or `manual:...` synthetic)
- `debts` + `debt_payments` — manual entry + auto-matched bank transactions
- `ap_invoices` + `emails` — Phase 5 AP queue (paused on Postmark wiring)

**Why server-only:** every external credential (Plaid token, Gusto API token, Anthropic API key, Corebridge bearer) lives in `process.env` on Render. None reach the browser bundle. The Anthropic proxy in particular (SEC-05) was the rewrite that closed the original "key visible in BizCore JS" finding.

---

## AI Integration (Claude API)

All Claude calls route through the server-side proxy at `/api/claude/messages`. The proxy is gated behind admin auth + the BizCore cookie so an attacker can't turn it into a free Claude pool.

| Use case | Tokens | Where |
|---|---|---|
| Evaluation prompt | 3000 | `pages/Evaluation.jsx` |
| Payroll upload extraction | 8000–12000 (PDF can be big) | `utils/payroll.js` `PAYROLL_EXTRACTION_PROMPT` |
| Pipeline AI Analysis | 2000 | `pages/Pipeline.jsx` |

The prompt that does the heavy lifting is in `utils/evaluation.js` `buildEvaluationPrompt()`. It pulls from every server endpoint (BankSync accounts + cash-flow, Gusto summary, Debts summary, plus localStorage pipeline snapshots) and assembles a multi-section markdown prompt scoped to **three horizons: MTD / QTD / YTD**. The prompt has an explicit "Data hygiene — read this before you analyze" callout that names which categories appear in multiple sources (payroll, revenue, debt service) so the AI never sums across them.

Model: `claude-sonnet-4-6` (override via `ANTHROPIC_MODEL` env var). Confirm before bumping to a different tier.

---

## Environment Variables

All server-side. Render dashboard is the source of truth.

```env
# AI
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6              # optional

# BizCore gate (admin-only second password on top of regular auth)
BIZCORE_PASSWORD=                              # case-sensitive!

# Corebridge (sales / CRM / POS)
COREBRIDGE_API_TAG=
COREBRIDGE_BASE_URL=                           # optional, defaults to https://sar11114.corebridge.net/api/public
COREBRIDGE_AUTO_SYNC=1                         # enable calendar/pipeline cron
COREBRIDGE_AUTO_SYNC_HOURS_LOCAL=6,12,17,22    # cron hours
COREBRIDGE_PIPELINE_WIP_STATUSES=WIP,BUILT

# BankSync (Plaid-backed bank data)
BANKSYNC_API_KEY=
BANKSYNC_BASE_URL=                             # optional
BANKSYNC_AUTO_SYNC=1
BANKSYNC_AUTO_SYNC_HOUR_LOCAL=6
BANKSYNC_AUTO_SYNC_WINDOW_DAYS=14

# Gusto (payroll — optional; users without Gusto upload CSV/PDF instead)
GUSTO_API_TOKEN=
GUSTO_COMPANY_ID=
GUSTO_API_BASE=                                # optional, defaults to api.gusto.com
GUSTO_API_VERSION=2024-04-01                   # pin to avoid silent shape drift
GUSTO_AUTO_SYNC=1
GUSTO_AUTO_SYNC_HOUR_LOCAL=6
GUSTO_AUTO_SYNC_WINDOW_DAYS=30

# QuickBooks Online — DORMANT. Scaffolding from SEC-03 stays gated 503
# until someone wires QBO sync. Keep these unset.
# QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_REDIRECT_URI, QUICKBOOKS_ENV
```

Never commit `.env`. Never expose any of these to the browser bundle.

---

## Design System

All styles live in `src/styles/globals.css`. Use CSS variables — never hardcode colors or radii.

### Color tokens

```css
--bg, --bg2, --bg3, --bg4       /* Background layers */
--border, --border2             /* Borders, dividers */
--text, --dim, --muted          /* Text hierarchy */
--accent  / --accent-dim        /* Green  #4ade80 — payroll / positive */
--accent2 / --accent2-dim       /* Blue   #60a5fa — bank / live data */
--accent3 / --accent3-dim       /* Amber  #f59e0b — Corebridge / warnings */
--danger  / --danger-dim        /* Red    #f87171 — debt / errors / critical */
```

### Source convention

- 🔵 Blue (`--accent2`) = **Bank** (BankSync / live data)
- 🟡 Amber (`--accent3`) = **Corebridge** (sales / pipeline / warnings)
- 🟢 Green (`--accent`) = **Payroll** / positive / healthy
- 🔴 Red (`--danger`) = **Debt** / deficiencies / alerts

### Component classes

`.card`, `.card-sm`, `.grid-2`, `.grid-3`, `.grid-4`, `.grid-auto`, `.stat-label`, `.stat-value`, `.stat-delta`, `.source-badge.{corebridge|quickbooks}`, `.pill.{green|blue|yellow|red}`, `.data-table`, `.btn-{primary|outline|danger}`, `.section-label`, `.page-title`, `.page-subtitle`

### Fonts

- Display/Headers: **DM Serif Display** (serif, elegant)
- Body: **DM Sans**
- Numbers/Code: **DM Mono** (use `className="mono"`)

---

## Coding Conventions

- **No TypeScript** — plain JS throughout
- **No CSS frameworks** — use the existing CSS variable system
- **No React Router** — `useState` in App.jsx
- **Functional components only** — hooks fine, no class components
- **Dollar amounts** — use the `fmt()` helper from `utils/format.js`, never raw `.toLocaleString()`
- **Server-only credentials** — every external API key lives in `process.env`. Never add a Vite-prefixed env var (`VITE_*`) that exposes a secret
- **No new test framework** — project has no test runner today; that's a separate effort
- **Comments** — JSDoc on every exported function; explain the *why*, not the *what*
- **Hide-when-empty** — KPI cards / strips that have no data should render `null`, not empty placeholders. See `DebtKpiBar` / `PayrollKpiBar` for the pattern.

---

## What Used To Be Here (history)

The codebase went through a major strip on 2026-05-23 to make BizCore distributable. These were removed:

- `WeeklyLog.jsx` — manual weekly entry form (bank + payroll cover this now)
- `QuickBooksPanel.jsx` — XLSX workbook uploader (bank + payroll cover this)
- "Sales History" CSV importer on Finance (Corebridge Pipeline is canonical)
- "Manual statement uploads" PDF fallback on BankAccounts (BankSync canonical)
- `utils/sales.js`, `utils/document.js`, `utils/weekly.js`, `utils/bank.js`, `utils/banksync.js` — orphaned after the strip

The intent of the strip: every business-health number must come from one of the three live integrations. No "or upload a CSV" fallbacks. If a connection can't reach an account, that's a real product problem to fix (add Finicity / MX / Yodlee), not a workaround.

---

## Current Build Status

| Module | Status | Notes |
|---|---|---|
| App shell, sidebar, design system | ✅ Complete | |
| Dashboard (trinity-sourced) | ✅ Complete | Verdict hero + 4 KPI strip + pipeline + connection health |
| Finance (Bank + Payroll only) | ✅ Complete | Stripped of QB workbook / Weekly Log / Sales History |
| Pipeline (Corebridge live) | ✅ Complete | 4 buckets, period matrix, AR upload, PIPE-01 paid-bucket fix |
| Debts (CRUD + KPIs + matcher) | ✅ Complete | Auto-matcher attaches BankSync payments on each sync |
| Evaluation (multi-source AI) | ✅ Complete | DEBT-06 + PAY-05 KPI strips, PAY-06 anti-double-counting guard |
| Sales Team page | ✅ Complete | Commission breakdown from Corebridge |
| Settings | ✅ Complete | Trinity setup checklist (Corebridge / Bank / Payroll) |
| BankSync ingest + cron | ✅ Live | Hard reconciliation, daily sync |
| Gusto ingest + cron | ✅ Live | Daily sync, idempotent on payroll_uuid |
| Universal payroll upload | ✅ Live | PAY-08 — works for ADP, Paychex, QBO Payroll, Patriot, etc. |
| AP Email integration | ⏸ Paused | AP-02/03 committed, AP-01 blocked on Postmark setup |
| QBO OAuth | 🔲 Dormant | Scaffolding from SEC-03 stays gated 503 |

---

## Known Follow-Ups (flagged in commits, not blocking)

- **EvaluationCharts dead branches** — `WeeklyOrdersChart`, `qboRevenueByMonth`, `BankBalanceChart` localStorage fallback render empty placeholders post-strip. Needs a focused EvaluationCharts rework that drops them or re-sources from server APIs.
- **`buildPeriodMetricsSection` bank rollups** — section 2 of the AI prompt silently produces nothing for new users (was sourced from localStorage that no longer fills). Re-source from `/api/banksync/persisted/cash-flow`.
- **`CrossSourceChart` / `CrossSourceTable`** — currently 3-source (Corebridge + QBO + Bank). QBO branch dead; simplify to 2-source.
- **`utils/reminders.js`** — still used by `FreshnessBadge` on Pipeline. Use is becoming irrelevant (live sync = always fresh) but kill it during a Pipeline rework, not piecemeal.

---

## Key Business Context

- **Target user** — small-business owner ($1–10M revenue, 5–30 employees) running Corebridge. Originally Signarama Temecula (sign shop); productizing toward other sign shops + adjacent service businesses.
- **Single-tenant today**, distributed via friends self-hosting on their own Render. Multi-tenant is the next strategic fork (per-user secrets, isolation, billing).
- **Privacy** — all data stays on the customer's own SQLite. No third-party analytics, no shared infrastructure.
- **Corebridge** is sign-shop sales/POS/CRM software (NOT Corebridge Financial the insurance company). Bearer auth with `<API_TAG>`, spec at `/swagger/docs/V1`. Provides invoices, customers, orders, jobs. AR aging is a manual upload — Corebridge's API doesn't expose invoice balances.
- **Profit First** is the assumed operating methodology. The 5-bank-account + AMEX layout is baked into the data model.
- **Primary goal** — answer "is the business healthy this month?" with a one-word AI verdict backed by real numbers. Optimized for the morning glance, not deep drill-down.
