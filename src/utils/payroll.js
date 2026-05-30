/**
 * Payroll client wrappers. Two source types coexist in the same table
 * on the server (payroll_runs):
 *   - Gusto API rows (gustoSync, etc. below)
 *   - Manual-upload rows from any other payroll provider —
 *     extracted client-side by Claude from a PDF / CSV the owner
 *     exports from ADP, Paychex, QuickBooks Payroll, Patriot,
 *     OnPay, etc. (uploadPayrollRuns below)
 *
 * Server holds all credentials and persists into SQLite; this util is
 * just the wire layer. Mirrors utils/debts.js + utils/persistedBank.js
 * — no business logic, no normalisation beyond what the server returns.
 */

async function handle(res) {
  if (!res.ok) {
    let detail = null
    try { detail = await res.json() } catch { /* not JSON */ }
    const err = new Error(detail?.error || `${res.status} ${res.statusText}`)
    err.status = res.status
    err.detail = detail
    throw err
  }
  return res.json()
}

/**
 * { configured, persisted_runs, latest_check_date, last_sync }
 * configured=false when GUSTO_API_TOKEN or GUSTO_COMPANY_ID env vars
 * are unset on the server (returns 200 with configured:false rather
 * than 503 so the UI can render a setup hint).
 */
export async function gustoStatus() {
  return handle(await fetch('/api/gusto/status', { credentials: 'include' }))
}

/**
 * Trigger a manual sync. Returns { ok, since, runs_discovered,
 * runs_upserted } or { ok:false, error }.
 *
 * since is optional 'YYYY-MM-DD'. Server defaults to 730 days back.
 */
export async function gustoSync({ since } = {}) {
  return handle(await fetch('/api/gusto/sync', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(since ? { since } : {}),
  }))
}

/** List persisted payroll runs. Most-recent check_date first. */
export async function gustoPayrolls({ from, to } = {}) {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to)   params.set('to', to)
  const qs = params.toString()
  const data = await handle(
    await fetch(`/api/gusto/payrolls${qs ? `?${qs}` : ''}`, { credentials: 'include' })
  )
  return data.payrolls || []
}

/**
 * Totals MTD / QTD / YTD + per_month series. Same shape pattern as
 * /api/debts/summary; the Evaluation prompt fetches both in parallel.
 *
 * Note: this endpoint aggregates rows from EVERY source
 * (Gusto API, manual-upload, future QBO/bank-inferred). Naming kept
 * gustoSummary for backwards compat with the existing import sites.
 */
export async function gustoSummary() {
  return handle(await fetch('/api/gusto/summary', { credentials: 'include' }))
}

/**
 * Persist a batch of Claude-extracted payroll runs (manual-upload
 * source). Each row is server-validated; the server computes
 * total_company_cost and the deterministic synthetic payroll_uuid so
 * the same report uploaded twice is idempotent.
 *
 * Returns { ok, accepted, rejected, accepted_rows, rejected_rows }.
 * accepted_rows + rejected_rows surface what went where so the UI
 * can show per-row outcomes.
 */
export async function uploadPayrollRuns(runs, { sourceFilename } = {}) {
  return handle(await fetch('/api/payroll/upload', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs, source_filename: sourceFilename || null }),
  }))
}

/**
 * Delete a single manual-upload payroll row by id. Server rejects
 * with 403 if the row's source isn't 'manual-upload'.
 */
export async function deletePayrollRun(id) {
  return handle(await fetch(`/api/payroll/runs/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  }))
}

/**
 * Claude extraction prompt for payroll reports. The owner exports a
 * Payroll Journal / Payroll Register / Payroll Summary from ADP,
 * Paychex, QuickBooks Payroll, Gusto, Patriot, OnPay, etc. and we ask
 * Claude to pull every run into a strict JSON shape that maps onto
 * our payroll_runs schema 1:1.
 *
 * Notes baked into the prompt:
 *   - Output ONLY JSON, no markdown fences (the parser strips fences
 *     defensively but cleaner is faster).
 *   - employer_taxes is the EMPLOYER side only — the sum of company
 *     FICA, FUTA, SUI/SDI/etc., NOT employee withholdings. Most
 *     reports split these clearly; some smaller providers combine
 *     them. When unclear, prefer the conservative under-count and
 *     null out the field rather than guess wrong.
 *   - Future-dated check_dates are rejected by the server (>14 days
 *     ahead is treated as a likely parse error); the prompt is told
 *     to use the report year explicitly rather than infer it.
 */
export const PAYROLL_EXTRACTION_PROMPT = `You are extracting payroll runs from a Payroll Journal / Payroll Register / Payroll Summary report. The report can come from any provider (ADP, Paychex, QuickBooks Payroll, Gusto, Patriot, OnPay, Rippling, Square Payroll, etc.) so column names and formats vary.

Output ONLY a single valid JSON object — no markdown fences, no commentary. Schema:

{
  "runs": [
    {
      "pay_period_start": "YYYY-MM-DD",
      "pay_period_end":   "YYYY-MM-DD",
      "check_date":       "YYYY-MM-DD" | null,
      "gross_pay":        <number>,
      "employer_taxes":   <number — EMPLOYER side only: company FICA + FUTA + SUI + SDI + ER Medicare + similar; do NOT include employee withholdings>,
      "employee_taxes_withheld": <number — total withheld from employee paychecks: employee FICA + federal/state/local income tax + employee Medicare + SDI + similar>,
      "net_pay":          <number — what hit employee bank accounts after withholdings>,
      "benefits":         <number — employer-side benefits cost (employer health, 401k match, etc.); null if unclear>,
      "reimbursements":   <number; null if not on the report>,
      "employee_count":   <integer; null if not reported>
    }
  ]
}

Rules:
- Each row in "runs" is ONE pay period (one payroll run). If the report covers a quarter or year, emit one run per pay period found.
- Dates must be ISO format YYYY-MM-DD. Use the report's stated year — never infer the year from context. If a date is shown as MM/DD without a year, use the year that's printed somewhere on the report (page header, fiscal year, etc.). NEVER use a check_date more than 14 days in the future.
- gross_pay is the total gross wages for that payroll run, summed across all employees. NOT total cost — exclude employer taxes from this field.
- employer_taxes is critical: it must be the EMPLOYER side only. Common labels: "Employer Taxes", "Company Taxes", "ER Taxes", "Employer Tax Total", "Company-Paid Taxes". If the report only shows a combined "Total Taxes" without splitting employer vs employee, set employer_taxes to null rather than guess.
- net_pay must be <= gross_pay (gross minus withholdings = net). If your numbers come out the other way, you've mis-mapped a column — re-check.
- If the report is structured as a single summary row (no per-period breakdown), emit a single run with the broadest pay_period it covers.
- Do not include garnishments, deductions, or reimbursements in gross_pay.
- Empty / missing values: null is fine. Do not invent.`
