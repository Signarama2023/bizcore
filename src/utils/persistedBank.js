// Client wrapper around the BANK-04 persisted query API.
// Replaces the localStorage / PDF-extract path for chart + prompt data.
// All aggregation lives server-side; this file just calls the endpoints
// and returns the JSON shape.

async function get(path) {
  const r = await fetch(path, { credentials: 'same-origin' })
  if (r.status === 401) {
    const e = new Error('BizCore is locked — please unlock again.')
    e.bizcoreLocked = true
    throw e
  }
  if (!r.ok) {
    let body = ''
    try { body = await r.text() } catch { /* ignore */ }
    let msg = body
    try { msg = (JSON.parse(body) || {}).error || body } catch { /* not JSON */ }
    throw new Error(`Persisted bank ${r.status}: ${msg || 'unknown error'}`)
  }
  return r.json()
}

/**
 * List of accounts with last balance, last reconciled timestamp, and
 * last reconciliation gap. Drives the green/red reconciled pill on the
 * BankAccounts page and the "Total cash across PF accounts" number.
 */
export function fetchPersistedAccounts() {
  return get('/api/banksync/persisted/accounts').then((b) => b.accounts || [])
}

/**
 * Windowed transaction query. Used by the per-account expandable list
 * and any future drill-down view. By default includes transfer-flagged
 * rows (with _is_transfer=true); pass includeTransfers=false to filter.
 */
export function fetchPersistedTransactions({ account, from, to, limit, offset, includeTransfers = true } = {}) {
  const qs = new URLSearchParams()
  if (account) qs.set('account', account)
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  if (limit) qs.set('limit', String(limit))
  if (offset) qs.set('offset', String(offset))
  if (includeTransfers === false) qs.set('include_transfers', '0')
  return get('/api/banksync/persisted/transactions?' + qs.toString())
}

/**
 * Server-computed monthly net cash flow across all PF accounts in
 * the window, with internal PF transfers excluded. The Net Cash Flow
 * chart on the Evaluation page reads this directly — no client-side
 * aggregation, no fuzzy dedup heuristics.
 */
export function fetchPersistedCashFlow({ from, to } = {}) {
  const qs = new URLSearchParams()
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  return get('/api/banksync/persisted/cash-flow?' + qs.toString())
}

/**
 * Convenience: trigger the manual backfill endpoint. Used by the
 * BankAccounts "Backfill Now" button (BANK-07/08).
 */
export function triggerBackfill({ days = 730, accounts } = {}) {
  return fetch('/api/banksync/backfill', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ days, accounts }),
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      const e = new Error(body.error || `Backfill failed (HTTP ${r.status})`)
      e.detail = body
      throw e
    }
    return body
  })
}
