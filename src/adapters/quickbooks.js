/**
 * QuickBooks Online adapter. All calls go through the BizCore backend proxy
 * which holds the OAuth token. See server/routes/quickbooks.js.
 *
 * @module adapters/quickbooks
 */

const BASE = '/api/quickbooks'

/**
 * Fetch invoices in a date range.
 * @param {{ from?: string, to?: string }} [params] — ISO dates.
 * @returns {Promise<Array<{id: string, client: string, amount: number, status: string, due: string}>>}
 */
export async function fetchInvoices(params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}/invoices${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`QuickBooks fetchInvoices: ${res.status}`)
  return res.json()
}

/**
 * Fetch the profit-and-loss report.
 * @param {{ from?: string, to?: string }} [params]
 * @returns {Promise<{ revenue: number, expenses: number, net: number, byCategory: Record<string, number> }>}
 */
export async function fetchProfitLoss(params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}/profit-loss${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`QuickBooks fetchProfitLoss: ${res.status}`)
  return res.json()
}

/**
 * Fetch expenses, grouped by category if requested.
 * @param {{ from?: string, to?: string, groupBy?: 'category' }} [params]
 * @returns {Promise<Array<{ category: string, amount: number }>>}
 */
export async function fetchExpenses(params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}/expenses${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`QuickBooks fetchExpenses: ${res.status}`)
  return res.json()
}

/**
 * Fetch the balance sheet snapshot.
 * @param {{ asOf?: string }} [params]
 * @returns {Promise<{ assets: number, liabilities: number, equity: number }>}
 */
export async function fetchBalanceSheet(params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}/balance-sheet${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`QuickBooks fetchBalanceSheet: ${res.status}`)
  return res.json()
}
