/**
 * Sales-team aggregation — groups Pipeline rows by salesperson and
 * computes commission per configurable rate.
 *
 * SALES-01 (2026-05-23): These functions are now PURE — they take the
 * pipeline buckets as a parameter rather than reading localStorage
 * directly. The SalesTeam page fetches /api/corebridge/pipeline live
 * and passes the result in. Reasons:
 *   - localStorage was per-browser, per-user, easily stale
 *   - the server has the live Corebridge data anyway
 *   - the new date-range selector needs to refresh on every change
 *     (would have been awkward against the localStorage snapshot)
 *
 * `buckets` shape (from /api/corebridge/pipeline response.buckets):
 *   {
 *     newlyCreated:   { rows: [...], total, count },
 *     completedSales: { rows: [...], total, count },
 *     closedSales:    { rows: [...], total, count },
 *     wip:            { rows: [...], total, count },
 *   }
 * Each row has { date, customer, amount, reference, status, rep,
 * description } — see cbOrderToPipelineRow in server.js.
 *
 * Commission RATES are still localStorage-backed (loadCommissionRates /
 * saveCommissionRates) — those are owner preferences, not Pipeline data,
 * and don't belong in a server fetch.
 */

const BUCKET_TO_FIELDS = {
  newlyCreated:   { count: 'newCount',       total: 'newTotal' },
  completedSales: { count: 'completedCount', total: 'completedTotal' },
  closedSales:    { count: 'paidCount',      total: 'paidTotal' },
  wip:            { count: 'wipCount',       total: 'wipTotal' },
}

function freshRep(name) {
  return {
    name,
    newCount: 0, newTotal: 0,
    completedCount: 0, completedTotal: 0,
    paidCount: 0, paidTotal: 0,
    wipCount: 0, wipTotal: 0,
  }
}

/** Month key 'YYYY-MM' from a pipeline row's date, or null if undated. */
function rowMonth(row) {
  const d = (row && row.date) || ''
  return /^\d{4}-\d{2}/.test(String(d)) ? String(d).slice(0, 7) : null
}

/** Iterate every row across all four buckets, yielding [bucketKey, row]. */
function* iterAllRows(buckets) {
  if (!buckets) return
  for (const bucket of Object.keys(BUCKET_TO_FIELDS)) {
    const rows = buckets[bucket]?.rows
    if (!Array.isArray(rows)) continue
    for (const row of rows) yield [bucket, row]
  }
}

/** Sorted (newest first) list of 'YYYY-MM' months present in the buckets. */
export function availableMonths(buckets) {
  const months = new Set()
  for (const [, row] of iterAllRows(buckets)) {
    const m = rowMonth(row)
    if (m) months.add(m)
  }
  return Array.from(months).sort().reverse()
}

/**
 * Aggregate Pipeline rows by salesperson. If `month` is given ('YYYY-MM'),
 * only rows whose date falls in that month are counted. Returns rep
 * summaries sorted by paid revenue desc.
 */
export function aggregateBySalesperson(buckets, month = null) {
  const repMap = new Map()
  const getRep = (name) => {
    const norm = (name || '').trim() || '(unassigned)'
    if (!repMap.has(norm)) repMap.set(norm, freshRep(norm))
    return repMap.get(norm)
  }
  for (const [bucket, row] of iterAllRows(buckets)) {
    if (month && rowMonth(row) !== month) continue
    const fields = BUCKET_TO_FIELDS[bucket]
    const rep = getRep(row.rep)
    rep[fields.count]++
    rep[fields.total] += row.amount || 0
  }
  return Array.from(repMap.values()).sort((a, b) => b.paidTotal - a.paidTotal)
}

/**
 * Single-pass aggregate by month → salesperson.
 * Returns { 'YYYY-MM': repArray }. Undated rows are skipped.
 */
export function aggregateByMonthAndSalesperson(buckets) {
  const months = new Map() // month -> Map(name -> rep)
  for (const [bucket, row] of iterAllRows(buckets)) {
    const m = rowMonth(row)
    if (!m) continue
    if (!months.has(m)) months.set(m, new Map())
    const map = months.get(m)
    const norm = (row.rep || '').trim() || '(unassigned)'
    if (!map.has(norm)) map.set(norm, freshRep(norm))
    const fields = BUCKET_TO_FIELDS[bucket]
    const rep = map.get(norm)
    rep[fields.count]++
    rep[fields.total] += row.amount || 0
  }
  const out = {}
  for (const [m, map] of months) {
    out[m] = Array.from(map.values()).sort((a, b) => b.paidTotal - a.paidTotal)
  }
  return out
}

// Commission rates are still per-owner localStorage preferences —
// they're not Pipeline data and don't change when the date range
// changes, so they stay synchronous.
const DEFAULT_RATES = {
  'Grant Cleary': 0.04,
}

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function loadCommissionRates() {
  const stored = loadJSON('bizcore.commissionRates') || {}
  return { ...DEFAULT_RATES, ...stored }
}

export function saveCommissionRates(rates) {
  try { localStorage.setItem('bizcore.commissionRates', JSON.stringify(rates)) } catch { /* quota */ }
}

export function computeCommission(rep, rate, basis = 'paid') {
  const r = Number(rate) || 0
  const total = basis === 'completed' ? rep.completedTotal : rep.paidTotal
  return total * r
}

/**
 * Full commission picture for a rep:
 *   earned — commission on realised revenue (Paid, or Completed per basis).
 *            What's been "earned" and would be paid out.
 *   wip    — potential commission on open WIP (in production, not yet earned).
 *   total  — what you'd owe this rep once current WIP also closes.
 */
export function computeCommissions(rep, rate, basis = 'paid') {
  const r = Number(rate) || 0
  const earnedBase = basis === 'completed' ? rep.completedTotal : rep.paidTotal
  const earned = (earnedBase || 0) * r
  const wip = (rep.wipTotal || 0) * r
  return { earned, wip, total: earned + wip }
}

/**
 * Returns rep-by-rep rows of pipeline data for a given salesperson,
 * optionally restricted to a single month ('YYYY-MM'). Pulled from the
 * same buckets object the aggregations use.
 */
export function rowsForSalesperson(buckets, name, month = null) {
  const out = { newlyCreated: [], completedSales: [], closedSales: [], wip: [] }
  if (!buckets) return out
  for (const bucket of Object.keys(out)) {
    const rows = buckets[bucket]?.rows
    if (!Array.isArray(rows)) continue
    out[bucket] = rows.filter((r) =>
      (r.rep || '').trim() === name && (!month || rowMonth(r) === month))
  }
  return out
}
