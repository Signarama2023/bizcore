/**
 * Thin client for /api/debts.
 *
 * The server keeps the canonical debt list, validates types/dates/numbers,
 * and auto-matches BankSync payments to debts inside the BankSync backfill
 * transaction (see DEBT-03 in server.js). This util is just the wire layer
 * — no business logic, no normalisation beyond what hydrateDebtRow already
 * returns.
 */

const HEADERS = { 'content-type': 'application/json' }

async function handle(res) {
  if (!res.ok) {
    let detail = null
    try { detail = await res.json() } catch { /* not JSON */ }
    const msg = detail?.error || `${res.status} ${res.statusText}`
    const err = new Error(msg)
    err.status = res.status
    err.detail = detail
    throw err
  }
  return res.json()
}

/** List debts. status: 'active' | 'paid_off' | 'closed' | 'all' (omit for active+paid_off). */
export async function listDebts(status) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  const data = await handle(await fetch(`/api/debts${qs}`, { credentials: 'include' }))
  return data.debts || []
}

/** Summary KPIs — outstanding, expected monthly payment, MTD + QTD debt service, per-month series. */
export async function debtsSummary() {
  return handle(await fetch('/api/debts/summary', { credentials: 'include' }))
}

/** One debt + last 20 payments. */
export async function getDebt(id) {
  return handle(await fetch(`/api/debts/${id}`, { credentials: 'include' }))
}

/** Full payment history for a debt, optionally windowed. */
export async function getDebtPayments(id, { from, to } = {}) {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString()
  const data = await handle(
    await fetch(`/api/debts/${id}/payments${qs ? `?${qs}` : ''}`, { credentials: 'include' })
  )
  return data.payments || []
}

/** Create a debt — name + debt_type are required. */
export async function createDebt(fields) {
  const data = await handle(await fetch('/api/debts', {
    method: 'POST', credentials: 'include', headers: HEADERS, body: JSON.stringify(fields),
  }))
  return data.debt
}

/** Patch a debt — send only the fields you're changing. */
export async function updateDebt(id, fields) {
  const data = await handle(await fetch(`/api/debts/${id}`, {
    method: 'PATCH', credentials: 'include', headers: HEADERS, body: JSON.stringify(fields),
  }))
  return data.debt
}

/**
 * Close a debt (soft delete — keeps payment history). Pass hard=true to
 * permanently DELETE. The server enforces 'closed' as a status soft-delete
 * sentinel, not a true row removal, so the auto-matcher won't re-attach
 * BankSync transactions to a closed debt.
 */
export async function deleteDebt(id, { hard = false } = {}) {
  const qs = hard ? '?hard=1' : ''
  return handle(await fetch(`/api/debts/${id}${qs}`, {
    method: 'DELETE', credentials: 'include',
  }))
}

/** Enum constants mirrored from server.js — keep in sync. */
export const DEBT_TYPES = [
  { value: 'term_loan', label: 'Term Loan' },
  { value: 'sba', label: 'SBA Loan' },
  { value: 'line_of_credit', label: 'Line of Credit' },
  { value: 'revolving', label: 'Revolving (credit card)' },
  { value: 'lease', label: 'Lease' },
]

export const DEBT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'paid_off', label: 'Paid off' },
  { value: 'closed', label: 'Closed (hidden)' },
]

export const PF_KEYS = [
  { value: '', label: '— any account —' },
  { value: 'income', label: 'Income (7068)' },
  { value: 'opex', label: 'Opex (7076)' },
  { value: 'owners', label: 'Owners (7092)' },
  { value: 'profit', label: 'Profit (7100)' },
  { value: 'tax', label: 'Tax (7118)' },
  { value: 'amex', label: 'AMEX' },
]
