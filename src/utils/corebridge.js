/**
 * Corebridge client — talks to the team-calendar server's read-only
 * Corebridge proxy (/api/corebridge/pipeline). The server already holds the
 * Corebridge API tag (it powers the calendar's auto-sync); this just reuses
 * that connection to fill the BizCore Pipeline buckets.
 */

/**
 * Resolve a period choice to a { start, end } YYYY-MM-DD range. Each option
 * is the calendar period to date — independent, never cumulative:
 *   day     → today
 *   week    → Monday of this week → today
 *   month   → 1st of this month → today
 *   quarter → 1st of the current quarter (Jan/Apr/Jul/Oct) → today
 *   year    → Jan 1 of this year → today
 */
export function periodRange(kind) {
  const today = new Date()
  const iso = (d) => d.toISOString().slice(0, 10)
  const end = iso(today)
  if (kind === 'day') {
    return { start: end, end }
  }
  if (kind === 'week') {
    const d = new Date(today)
    const dow = d.getDay() // 0 = Sun
    d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow))
    return { start: iso(d), end }
  }
  if (kind === 'quarter') {
    const qStartMonth = Math.floor(today.getMonth() / 3) * 3
    return { start: iso(new Date(today.getFullYear(), qStartMonth, 1)), end }
  }
  if (kind === 'year') {
    return { start: iso(new Date(today.getFullYear(), 0, 1)), end }
  }
  // 'month' (default)
  return { start: iso(new Date(today.getFullYear(), today.getMonth(), 1)), end }
}

/**
 * Pull the four order-based Pipeline buckets from Corebridge for a range.
 * Returns { start, end, buckets: { newlyCreated, completedSales,
 * closedSales, wip } } where each bucket is { rows, total, count }.
 */
export async function corebridgePipeline(start, end) {
  const qs = new URLSearchParams({ start, end })
  const r = await fetch(`/api/corebridge/pipeline?${qs.toString()}`)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `Corebridge sync failed (${r.status})`)
  return body
}

/**
 * PIPE-02: atomic multi-period pull. One Corebridge fetch on the server,
 * bucketed into today / week / month / year. Because every column is
 * derived from the same underlying dataset, math is guaranteed:
 * week ≤ month ≤ year for every bucket — no more "week total higher
 * than month total" from staggered per-period syncs.
 *
 * Returns:
 *   {
 *     syncedAt: ISO timestamp,
 *     periods: {
 *       day:   { start, end, buckets: { newlyCreated, completedSales, closedSales, wip } },
 *       week:  { ... },
 *       month: { ... },
 *       year:  { ... }
 *     },
 *     diagnostics: { changed_feed_records, wip_feed_records, widest_window }
 *   }
 *
 * Each bucket is { total, count } — no rows. For row-level detail use
 * corebridgePipeline(start, end) on a single range.
 */
export async function corebridgePipelineMulti() {
  const r = await fetch('/api/corebridge/pipeline-multi')
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `Corebridge sync failed (${r.status})`)
  return body
}
