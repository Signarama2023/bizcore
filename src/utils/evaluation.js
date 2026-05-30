/**
 * Evaluation prompt builder — aggregates persisted data sources in BizCore
 * (QB workbook, Weekly Log, Pipeline buckets, AR Aging, bank statements) into
 * one prompt for comprehensive AI analysis. A selection map controls which
 * sources are included.
 */

import { computeReminders } from './reminders'

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function num(n) {
  if (n == null || Number.isNaN(n)) return 'n/a'
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`
}

/** A source is included unless the selection map explicitly sets it false. */
function isEnabled(selection, key) {
  return !selection || selection[key] !== false
}

const PIPELINE_LABELS = {
  newlyCreated: 'Newly Created Sales',
  completedSales: 'Completed Sales',
  closedSales: 'Closed Sales (Paid)',
  wip: 'Work In Progress',
  arAging: 'AR Aging',
}

const PF_ACCOUNTS = [
  { key: 'income', label: 'Income (7068)', purpose: 'All revenue deposits' },
  { key: 'opex', label: 'Opex (7076)', purpose: 'Operating expenses' },
  { key: 'owners', label: 'Owners (7092)', purpose: "Owner's compensation" },
  { key: 'profit', label: 'Profit (7100)', purpose: 'Profit reserve' },
  { key: 'tax', label: 'Tax (7118)', purpose: 'Tax reserve' },
  { key: 'amex', label: 'AMEX', purpose: 'Credit card (liability)' },
]

function summarizeFinance(doc) {
  if (!doc?.sheets) return null
  const byKind = {}
  for (const sheet of doc.sheets) {
    for (const s of sheet.series || []) {
      if (!byKind[s.kind]) byKind[s.kind] = []
      byKind[s.kind].push({
        label: s.label,
        source: sheet.name,
        sourceFile: sheet.source,
        dataPoints: s.dataPoints || [],
        sum: s.summary?.sum,
      })
    }
  }
  return byKind
}

function totalLatest(seriesList) {
  if (!seriesList?.length) return 0
  return seriesList.reduce((sum, s) => {
    const last = s.dataPoints?.[s.dataPoints.length - 1]
    return sum + (last?.value || 0)
  }, 0)
}

function summarizeWeekly(weekly) {
  if (!weekly?.length) return null
  return weekly.slice().sort((a, b) => a.weekStart.localeCompare(b.weekStart)).slice(-12)
}

// ---------- Period rollups (month / quarter / year) ----------
// The owner asked the evaluation to focus on three time horizons only:
// the current month-to-date, the current quarter-to-date, and the
// current year-to-date. These helpers bucket every loaded data source
// into those three windows so the AI compares apples-to-apples instead
// of weekly noise vs. annual totals.

function pad2(n) { return String(n).padStart(2, '0') }
function ymd(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` }
function dateOf(s) {
  if (!s) return null
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function periodWindows(now = new Date()) {
  const u = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const y = u.getUTCFullYear()
  const m = u.getUTCMonth() // 0-11
  const qIdx = Math.floor(m / 3) // 0..3
  const monthStart   = new Date(Date.UTC(y, m, 1))
  const quarterStart = new Date(Date.UTC(y, qIdx * 3, 1))
  const yearStart    = new Date(Date.UTC(y, 0, 1))
  const monthName    = u.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  return [
    { key: 'month',   label: `${monthName} ${y} (MTD)`,        start: monthStart,   end: u },
    { key: 'quarter', label: `Q${qIdx + 1} ${y} (QTD)`,        start: quarterStart, end: u },
    { key: 'year',    label: `${y} year-to-date`,              start: yearStart,    end: u },
  ]
}

/** Sum dataPoints from a QB monthly series whose date falls in [start, end]. */
function rollupSeries(seriesList, start, end) {
  if (!seriesList?.length) return null
  let total = 0
  let any = false
  for (const s of seriesList) {
    for (const dp of (s.dataPoints || [])) {
      const d = dateOf(dp.date)
      if (!d) continue
      if (d >= start && d <= end) { total += Number(dp.value) || 0; any = true }
    }
  }
  return any ? total : null
}

/** Sum a numeric field on weekly-log entries whose weekStart falls in [start, end]. */
function rollupWeekly(weekly, start, end, field) {
  if (!weekly?.length) return null
  let total = 0
  let any = false
  for (const w of weekly) {
    const d = dateOf(w.weekStart)
    if (!d) continue
    if (d < start || d > end) continue
    const v = w[field]
    if (v == null) continue
    total += Number(v) || 0
    any = true
  }
  return any ? total : null
}

/** Latest non-null value of a field on weekly entries up to `end`. */
function latestWeeklyValue(weekly, end, field) {
  if (!weekly?.length) return null
  let chosen = null
  for (const w of weekly) {
    const d = dateOf(w.weekStart)
    if (!d || d > end) continue
    if (w[field] == null) continue
    if (!chosen || d > chosen.date) chosen = { date: d, value: w[field] }
  }
  return chosen ? chosen.value : null
}

/**
 * Flatten + dedupe every transaction across a list of bank statements for
 * one account. Owner-stated rule: "don't add anything together, use the
 * dates of the documents provided." Each transaction is bucketed by its
 * own date, so a Feb-May statement and a March-only statement contribute
 * the right amounts to the right months regardless of how the statements
 * are sliced.
 *
 * Within an account, the same (date, amount, description) triplet is
 * treated as one transaction even if it appears in two overlapping
 * statements (re-uploads / quarterly + monthly overlap). Most recent
 * statement upload wins, so corrected re-uploads supersede earlier ones.
 */
function flattenBankTx(snapshots) {
  if (!Array.isArray(snapshots)) return []
  // Process newest-uploaded first so dedup keeps the most recent version.
  const sorted = snapshots.slice().sort(
    (a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || '')
  )
  const seen = new Set()
  const out = []
  for (const stmt of sorted) {
    const txs = Array.isArray(stmt.transactions) ? stmt.transactions : []
    for (const t of txs) {
      if (!t || !t.date) continue
      const amt = Number(t.amount)
      if (!Number.isFinite(amt)) continue
      const desc = String(t.description || '').trim().toLowerCase()
      const key = `${t.date}|${amt.toFixed(2)}|${desc}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ date: String(t.date).slice(0, 10), amount: amt, description: t.description || '' })
    }
  }
  return out
}

/** Find the most recent ending balance up to `end`, across all statements for an account. */
function latestEndingBalanceAt(snapshots, end) {
  if (!Array.isArray(snapshots)) return null
  let chosen = null
  for (const s of snapshots) {
    const periodEnd = dateOf(s.period?.end) || dateOf(s.uploadedAt)
    if (!periodEnd || periodEnd > end) continue
    if (s.endingBalance == null) continue
    if (!chosen || periodEnd > chosen.date) chosen = { date: periodEnd, value: s.endingBalance }
  }
  return chosen ? chosen.value : null
}

/**
 * Sum deposits / withdrawals / net for one account in [start, end] by
 * iterating each transaction's own date. Used by the period rollups —
 * "use the dates of the documents provided" applied transaction-by-
 * transaction. latestBalance still comes from the most recent statement
 * that ended on or before `end` (balance is a point-in-time number, not
 * a sum).
 */
function rollupBank(snapshots, start, end) {
  if (!snapshots?.length) return null
  const txs = flattenBankTx(snapshots)
  let dep = 0, wd = 0, count = 0
  for (const t of txs) {
    const d = dateOf(t.date)
    if (!d || d < start || d > end) continue
    if (t.amount > 0) dep += t.amount
    else wd += Math.abs(t.amount)
    count++
  }
  return {
    dep, wd, net: dep - wd,
    latestBalance: latestEndingBalanceAt(snapshots, end),
    hadActivity: count > 0,
    txCount: count,
  }
}

/**
 * Build the period-rollup section for the prompt. Returns a markdown string
 * with three sub-blocks (Month / Quarter / Year) showing the same metrics
 * for each, so the AI can directly compare horizons.
 */
function buildPeriodMetricsSection({ finance, weekly, accountHistory, pipeline }) {
  const windows = periodWindows()
  const lines = [
    '# 2. Period Rollups (Month / Quarter / Year)',
    '',
    'The owner has scoped this evaluation to three time horizons only:',
    'current month-to-date, current quarter-to-date, and current year-to-date.',
    'Compare these three windows against each other — not weekly granularity.',
    '',
  ]
  for (const w of windows) {
    lines.push(`## ${w.label}  (${ymd(w.start)} → ${ymd(w.end)})`)
    // QB monthly P&L rollups
    const rev   = rollupSeries(finance?.revenue,   w.start, w.end)
    const exp   = rollupSeries(finance?.expense,   w.start, w.end)
    const profit = rollupSeries(finance?.profit,    w.start, w.end)
    if (rev   != null) lines.push(`- Revenue (QB): ${num(rev)}`)
    if (exp   != null) lines.push(`- Expenses (QB): ${num(exp)}`)
    if (profit != null) lines.push(`- Profit (QB): ${num(profit)}`)
    // Weekly-log rollups
    const newOrd = rollupWeekly(weekly, w.start, w.end, 'newOrders')
    const compl  = rollupWeekly(weekly, w.start, w.end, 'ordersCompleted')
    if (newOrd != null) lines.push(`- New orders booked (Weekly Log): ${num(newOrd)}`)
    if (compl  != null) lines.push(`- Completed (Weekly Log): ${num(compl)}`)
    const wipLatest = latestWeeklyValue(weekly, w.end, 'wip')
    const arLatest  = latestWeeklyValue(weekly, w.end, 'arBalance')
    if (wipLatest != null) lines.push(`- WIP (latest in window): ${num(wipLatest)}`)
    if (arLatest  != null) lines.push(`- AR balance (latest in window): ${num(arLatest)}`)
    // Bank rollups per PF account
    const bankLines = []
    let cashNet = 0
    let cashAny = false
    for (const a of PF_ACCOUNTS) {
      const list = accountHistory?.[a.key]
      if (!list) continue
      const r = rollupBank(list, w.start, w.end)
      if (!r) continue
      const piece = r.hadActivity
        ? `dep ${num(r.dep)} / wd ${num(r.wd)} / net ${num(r.net)}`
        : 'no statements in window'
      const bal = r.latestBalance != null ? `, latest bal ${num(r.latestBalance)}` : ''
      bankLines.push(`  - ${a.label}: ${piece}${bal}`)
      if (a.key !== 'amex' && r.latestBalance != null) { cashNet += r.latestBalance; cashAny = true }
    }
    if (bankLines.length) {
      lines.push('- Bank activity in window:')
      lines.push(...bankLines)
      if (cashAny) lines.push(`  - Combined cash balance across PF accounts: ${num(cashNet)}`)
    }
    // Pipeline snapshot intersection
    const pipeBits = []
    for (const k of ['newlyCreated', 'completedSales', 'closedSales']) {
      const snap = pipeline?.[k]
      if (!snap) continue
      const ps = dateOf(snap.period?.start)
      const pe = dateOf(snap.period?.end) || ps
      if (!ps && !pe) continue
      const overlaps = (ps || pe) <= w.end && (pe || ps) >= w.start
      if (overlaps) pipeBits.push(`${PIPELINE_LABELS[k]} ${num(snap.total)} (${snap.period?.start || '?'} → ${snap.period?.end || '?'})`)
    }
    if (pipeBits.length) lines.push(`- Corebridge snapshots overlapping this window: ${pipeBits.join('; ')}`)
    lines.push('')
  }
  return lines.join('\n')
}

const VERDICT_RX = /\b(STRONG|STABLE|MIXED|DETERIORATING|WEAK)\b/

/** The headline verdict keyword (lives in section 1 of the response). */
export function extractVerdict(text) {
  const m = String(text || '').match(VERDICT_RX)
  return m ? m[1] : null
}

/**
 * Split an evaluation response into its `## ` sections, in document order.
 * Returns [{ num, title, body }]. `num` is the leading "1." etc. if present.
 */
export function parseEvaluationSections(text) {
  if (!text) return []
  const out = []
  for (const chunk of String(text).split(/\n(?=##\s)/)) {
    const m = chunk.match(/^##\s+(\d+)?[.)]?\s*([^\n]+)\n?([\s\S]*)$/)
    if (!m) continue
    const title = m[2].trim()
    if (!title) continue
    out.push({ num: m[1] ? parseInt(m[1], 10) : null, title, body: (m[3] || '').trim() })
  }
  return out
}

/**
 * Pull the "## 9. Dig Deeper" bullets out of an AI evaluation response.
 */
export function extractDigDeeperNotes(text) {
  if (!text) return []
  const m = text.match(/##\s*9\.?\s*Dig Deeper\s*\n([\s\S]*?)(?:\n##\s|\n#\s|$)/i)
  if (!m) return []
  const bullets = m[1].split(/\n/).filter((l) => /^\s*[-*]\s/.test(l))
  return bullets.map((line) => {
    const stripped = line.replace(/^\s*[-*]\s*/, '').trim()
    const lm = stripped.match(/^\*\*([^*]+):\*\*\s*(.*)$/) || stripped.match(/^([^:]+):\s*(.*)$/)
    if (lm) return { label: lm[1].trim(), note: lm[2].trim() }
    return { label: '', note: stripped }
  }).filter((n) => n.note)
}

/**
 * List every togglable data source for the Evaluation selection UI.
 * Each entry: { key, group, label, detail }.
 *  - QuickBooks documents are listed per source FILE (so Balance Sheet and
 *    P&L can be included while other workbooks are excluded).
 */
export function listEvaluationSources() {
  const out = []

  const doc = loadJSON('bizcore.document')
  if (doc?.sheets?.length) {
    const bySrc = new Map()
    for (const sh of doc.sheets) {
      const src = sh.source || '(unknown file)'
      if (!bySrc.has(src)) bySrc.set(src, { sheets: 0, series: 0 })
      const e = bySrc.get(src)
      e.sheets += 1
      e.series += sh.series?.length || 0
    }
    for (const [src, e] of bySrc) {
      out.push({
        key: `doc:${src}`,
        group: 'QuickBooks documents',
        label: src,
        detail: `${e.sheets} sheet${e.sheets === 1 ? '' : 's'} · ${e.series} series`,
      })
    }
  }

  const weekly = loadJSON('bizcore.weekly') || []
  if (weekly.length) {
    out.push({ key: 'weekly', group: 'Weekly Log', label: 'Weekly Log entries', detail: `${weekly.length} weeks` })
  }

  for (const [k, label] of Object.entries(PIPELINE_LABELS)) {
    const snaps = loadJSON(`bizcore.pipeline.${k}`) || []
    if (snaps.length) {
      out.push({ key: `pipeline:${k}`, group: 'Corebridge Pipeline', label, detail: `${snaps.length} upload${snaps.length === 1 ? '' : 's'}` })
    }
  }

  for (const a of PF_ACCOUNTS) {
    const snaps = loadJSON(`bizcore.bank.${a.key}`) || []
    if (snaps.length) {
      out.push({ key: `bank:${a.key}`, group: 'Bank Statements', label: a.label, detail: `${snaps.length} statement${snaps.length === 1 ? '' : 's'}` })
    }
  }

  return out
}

export function countSelected(selection) {
  const all = listEvaluationSources()
  return {
    total: all.length,
    selected: all.filter((s) => isEnabled(selection, s.key)).length,
  }
}

// Async since BANK-07 — bank data now comes from the server-side
// /api/banksync/persisted/* endpoints rather than localStorage. The
// other inputs (QB workbook, weekly log, Corebridge pipeline) are
// still localStorage-driven and stay synchronous in their helpers.
//
// PAY-05 adds /api/gusto/summary alongside the bank fetches so the AI
// can compute payroll-to-revenue ratios per horizon (the labor-cost
// gap from the evaluation review).
export async function buildEvaluationPrompt(selection = {}) {
  // Fetch server-persisted bank data + payroll summary in parallel.
  // Used by the period-rollup section and the per-account section
  // below. Each catches its own error so a single endpoint hiccup
  // falls back gracefully rather than blocking the whole evaluation.
  let persistedAccounts = []
  let persistedCashFlow = null
  let payrollSummary = null
  try {
    const [accts, cf, pay] = await Promise.all([
      fetch('/api/banksync/persisted/accounts', { credentials: 'same-origin' })
        .then((r) => r.ok ? r.json() : { accounts: [] }),
      fetch('/api/banksync/persisted/cash-flow', { credentials: 'same-origin' })
        .then((r) => r.ok ? r.json() : { months: [] }),
      fetch('/api/gusto/summary', { credentials: 'same-origin' })
        .then((r) => r.ok ? r.json() : null)
        .catch(() => null),
    ])
    persistedAccounts = accts.accounts || []
    persistedCashFlow = cf
    payrollSummary = pay
  } catch { /* fall back to legacy */ }
  const hasServerBank = persistedAccounts.length > 0 || (persistedCashFlow?.months || []).length > 0
  const hasPayroll = !!(payrollSummary && payrollSummary.year_to_date && payrollSummary.year_to_date.run_count > 0)

  const doc = loadJSON('bizcore.document')
  const weekly = loadJSON('bizcore.weekly') || []
  const reminders = computeReminders()

  // Filter QB workbook sheets to the selected source files
  const enabledDoc = doc?.sheets
    ? { sheets: doc.sheets.filter((sh) => isEnabled(selection, `doc:${sh.source || '(unknown file)'}`)) }
    : null
  const finance = summarizeFinance(enabledDoc)
  const weeklyData = summarizeWeekly(weekly)

  // Pipeline buckets, filtered by selection
  const pipeline = {}
  for (const k of Object.keys(PIPELINE_LABELS)) {
    if (!isEnabled(selection, `pipeline:${k}`)) continue
    const snapshots = loadJSON(`bizcore.pipeline.${k}`)
    if (snapshots?.length) pipeline[k] = snapshots[0]
  }

  const sections = []

  // 1. Books (QuickBooks workbook)
  if (finance && Object.keys(finance).length) {
    let s = '# 1. Books (QuickBooks documents)\n'
    if (finance.revenue?.length) {
      s += '\n## Revenue series\n'
      for (const r of finance.revenue) {
        const recent = r.dataPoints.slice(-10).map((d) => `${d.date.slice(0, 7)}=${num(d.value)}`).join(', ')
        s += `- **${r.label}** (sheet: ${r.source}): total ${num(r.sum)} · recent points: ${recent}\n`
      }
    }
    if (finance.expense?.length) {
      s += '\n## Expense series\n'
      for (const e of finance.expense) {
        s += `- **${e.label}** (sheet: ${e.source}): total ${num(e.sum)}\n`
      }
    }
    if (finance.profit?.length) {
      s += '\n## Profit series\n'
      for (const p of finance.profit) {
        s += `- **${p.label}**: total ${num(p.sum)}\n`
      }
    }
    if (finance.cash || finance.liability || finance.equity || finance.inventory) {
      s += '\n## Balance Sheet (latest snapshot)\n'
      s += `- Cash: ${num(totalLatest(finance.cash))}\n`
      // QuickBooks AR is intentionally omitted — billing runs through
      // Corebridge, not QB. Real AR is in section 4 (Corebridge AR Aging).
      s += `- Inventory/WIP: ${num(totalLatest(finance.inventory))}\n`
      s += `- Other assets: ${num(totalLatest(finance.asset))}\n`
      s += `- Liabilities: ${num(totalLatest(finance.liability))}\n`
      s += `- Equity: ${num(totalLatest(finance.equity))}\n`
    }
    sections.push(s)
  }

  // 2. Period rollups (month / quarter / year). This replaces the prior
  // weekly-by-week table as the primary horizon for the analysis. Weekly Log
  // entries still feed into this rollup; the latest week's salesperson
  // breakdown is appended below for the "top customers / reps" reading.
  // Build the accountHistory map up-front since the section needs it too.
  const accountHistoryForPeriod = {}
  for (const a of PF_ACCOUNTS) {
    if (!isEnabled(selection, `bank:${a.key}`)) continue
    const list = loadJSON(`bizcore.bank.${a.key}`) || []
    if (list.length) accountHistoryForPeriod[a.key] = list
  }
  if (
    (finance && Object.keys(finance).length) ||
    (isEnabled(selection, 'weekly') && weeklyData?.length) ||
    Object.keys(accountHistoryForPeriod).length ||
    Object.keys(pipeline).length
  ) {
    sections.push(buildPeriodMetricsSection({
      finance,
      weekly: weeklyData,
      accountHistory: accountHistoryForPeriod,
      pipeline,
    }))
  }
  // Latest-week salesperson snapshot (kept for revenue concentration signal,
  // but no longer the headline view — the period rollup above leads).
  if (isEnabled(selection, 'weekly') && weeklyData?.length) {
    const latest = weeklyData[weeklyData.length - 1]
    if (latest?.repNewOrders?.length) {
      let s = `# 2a. Latest-week salesperson mix (week of ${latest.weekStart})\n`
      for (const r of latest.repNewOrders.slice().sort((a, b) => b.amount - a.amount)) {
        s += `- ${r.name}: ${num(r.amount)}\n`
      }
      sections.push(s)
    }
  }

  // 3. Sales Pipeline
  const funnelKeys = ['newlyCreated', 'completedSales', 'closedSales', 'wip']
  if (funnelKeys.some((k) => pipeline[k])) {
    let s = '# 3. Sales Pipeline (Corebridge)\n\n'
    for (const k of funnelKeys) {
      const snap = pipeline[k]
      if (!snap) continue
      const periodStr = snap.period?.kind === 'snapshot'
        ? `snapshot as of ${snap.period.start}`
        : snap.period
          ? `${snap.period.start} → ${snap.period.end}`
          : `uploaded ${snap.uploadedAt.slice(0, 10)} (period unknown)`
      s += `- **${PIPELINE_LABELS[k]}** (${periodStr}): ${num(snap.total)} across ${snap.count} records\n`
    }
    s += '\nIMPORTANT: The funnel buckets above share orders (a single sale appears in Newly Created when opened, Completed when delivered, and Paid when invoiced). Do NOT sum customer totals across buckets — that produces 2-3x double-counting. The "realized revenue" view is the Paid (Closed Sales) bucket alone. Open committed work is in WIP.\n'

    const topByBucketLabel = {
      closedSales: 'Top customers by realized revenue (Closed / Paid only)',
      wip: 'Top customers by open WIP',
    }
    for (const bucketKey of ['closedSales', 'wip']) {
      const rows = pipeline[bucketKey]?.rows || []
      if (!rows.length) continue
      const byCustomer = {}
      for (const r of rows) {
        if (!r.customer) continue
        byCustomer[r.customer] = (byCustomer[r.customer] || 0) + (r.amount || 0)
      }
      const top = Object.entries(byCustomer).sort((a, b) => b[1] - a[1]).slice(0, 10)
      if (top.length) {
        s += `\n## ${topByBucketLabel[bucketKey]}\n`
        for (const [cust, amt] of top) s += `- ${cust}: ${num(amt)}\n`
      }
    }
    sections.push(s)
  }

  // 4. AR Health
  if (pipeline.arAging) {
    let s = `# 4. AR Health (Corebridge AR Aging — snapshot as of ${pipeline.arAging.period?.start || pipeline.arAging.uploadedAt.slice(0, 10)})\n\n`
    s += `- Total outstanding: ${num(pipeline.arAging.total)}\n`
    s += `- Number of open invoices: ${pipeline.arAging.count}\n\n`
    const byBucket = {}
    for (const r of pipeline.arAging.rows) {
      byBucket[r.status] = (byBucket[r.status] || 0) + r.amount
    }
    s += '## Aging breakdown\n'
    for (const [bucket, amount] of Object.entries(byBucket).sort()) {
      const pctOfTotal = pipeline.arAging.total ? (amount / pipeline.arAging.total * 100).toFixed(1) : '?'
      s += `- ${bucket}: ${num(amount)} (${pctOfTotal}%)\n`
    }
    const pastDue = pipeline.arAging.rows.filter((r) => !String(r.status).toLowerCase().includes('current'))
    if (pastDue.length) {
      const byCust = {}
      for (const r of pastDue) {
        if (!r.customer) continue
        byCust[r.customer] = (byCust[r.customer] || 0) + r.amount
      }
      const top = Object.entries(byCust).sort((a, b) => b[1] - a[1]).slice(0, 10)
      if (top.length) {
        s += '\n## Top past-due customers\n'
        for (const [cust, amt] of top) s += `- ${cust}: ${num(amt)}\n`
      }
    }
    sections.push(s)
  }

  // 5. Profit First Bank Accounts — BankSync (server) only.
  // CLEAN-01: dropped the legacy localStorage PDF fallback. The PDF
  // upload UI was removed in STRIP-04, so nothing writes the fallback
  // keys (bizcore.bank.*) anymore. If hasServerBank is false here the
  // owner has no bank data at all — section is omitted.
  if (hasServerBank && (persistedCashFlow?.months || []).length > 0) {
    let s = '# 5. Profit First Bank & Credit Accounts (BankSync — server-reconciled)\n\n'
    s += 'This business runs on the **Profit First** methodology (Mike Michalowicz). Revenue lands in Income, then is allocated twice monthly per CAPs to Opex / Owners / Profit / Tax. AMEX charges are paid down from Opex.\n\n'
    s += 'Data below is sourced from BankSync (Plaid-backed) via the server-persisted bank_transactions table. Per-account balances come from the most recent reconciled sync. Internal PF transfers between accounts are detected and excluded from the per-month flow.\n\n'
    // Current balances per account
    s += '## Latest balances (reconciled)\n'
    let totalBankCash = 0
    for (const acct of persistedAccounts) {
      if (!acct.pf_key) continue
      const label = `${acct.pf_key.charAt(0).toUpperCase()}${acct.pf_key.slice(1)} (${acct.account_number_last4 || '?'})`
      const recoBadge = acct.last_reconcile_gap === 0 ? '✓ reconciled' : `⚠ gap ${num(acct.last_reconcile_gap)}`
      s += `- **${label}**: ${num(acct.last_balance)}  (${recoBadge}, last sync ${acct.last_sync_at?.slice(0, 16) || 'never'}, ${acct.tx_count} txs on file)\n`
      if (acct.pf_key !== 'amex' && acct.last_balance != null) totalBankCash += Number(acct.last_balance) || 0
    }
    s += `\n**Total bank cash across PF accounts (latest balances)**: ${num(totalBankCash)}\n`
    // Per-month cash flow (server already excludes transfers)
    if (persistedCashFlow.months.length) {
      s += '\n## Per-month real cash flow (PF transfers already excluded)\n'
      for (const m of persistedCashFlow.months.slice(-12)) {
        s += `- **${m.month}**: deposits ${num(m.deposits)} · withdrawals ${num(m.withdrawals)} · net ${num(m.net)} (${m.count} non-transfer tx)`
        const acctBits = Object.entries(m.by_account || {}).map(([k, v]) => `${k} ${num(v)}`).join(', ')
        if (acctBits) s += ` · per-acct: ${acctBits}`
        s += '\n'
      }
      s += `\n(${persistedCashFlow.transfers_excluded} internal PF transfers across the loaded window were excluded from these totals.)\n`
    }
    sections.push(s)
  }

  // 6. Payroll (Gusto) — closes the labor-cost gap. total_company_cost
  // is gross + employer_taxes (+ employer benefits) which is the real
  // cash-out-the-door labor figure. Payroll-to-revenue uses Income
  // (7068) deposits per matching month as the denominator — same
  // approach the DEBT-06 debt-to-revenue KPI uses, so the two ratios
  // are directly comparable.
  if (hasPayroll) {
    let s = '# 6. Payroll Cost (Gusto — server-persisted)\n\n'
    s += 'total_company_cost = gross + employer_taxes (+ employer benefits where present). '
    s += 'This is the real "cash out the door" labor cost. Gross alone would understate it by ~7-10% in California.\n\n'

    const fmtRatio = (num, denom) => {
      if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return 'n/a (no Income deposits in window)'
      return `${((num / denom) * 100).toFixed(1)}%`
    }
    // Pull income deposits per matching window from the cash-flow
    // months series. ymd is "YYYY-MM"; the cash-flow series is also
    // monthly, so we sum each month that falls inside the horizon.
    const incomeDepositsInWindow = (startYmd, endYmd) => {
      const months = persistedCashFlow?.months || []
      let total = 0
      for (const m of months) {
        if (m.month >= startYmd.slice(0, 7) && m.month <= endYmd.slice(0, 7)) {
          total += Number(m.by_account?.income) || 0
        }
      }
      return total
    }

    for (const [label, key] of [
      ['Month-to-date', 'month_to_date'],
      ['Quarter-to-date', 'quarter_to_date'],
      ['Year-to-date', 'year_to_date'],
    ]) {
      const w = payrollSummary[key]
      if (!w || !w.run_count) continue
      const income = incomeDepositsInWindow(w.window.start, w.window.end)
      s += `## ${label} (${w.window.start} → ${w.window.end})\n`
      s += `- Total company cost: ${num(w.company_cost)} across ${w.run_count} payroll run${w.run_count === 1 ? '' : 's'}\n`
      s += `- Gross pay: ${num(w.gross_pay)} · Employer taxes: ${num(w.employer_taxes)}`
      if (w.gross_pay > 0) s += ` (${((w.employer_taxes / w.gross_pay) * 100).toFixed(1)}% of gross)`
      s += '\n'
      if (w.max_employee_count) s += `- Max employees on a single run: ${w.max_employee_count}\n`
      s += `- **Payroll-to-revenue ratio:** ${fmtRatio(w.company_cost, income)} (denom: Income 7068 deposits ${num(income)})\n\n`
    }

    if (payrollSummary.per_month?.length) {
      s += '## Per-month payroll trend (YTD)\n'
      for (const m of payrollSummary.per_month) {
        s += `- ${m.month}: total ${num(m.company_cost)} · gross ${num(m.gross_pay)} · er-tax ${num(m.employer_taxes)} · ${m.run_count} run${m.run_count === 1 ? '' : 's'}\n`
      }
      s += '\n'
    }

    s += 'CRITICAL: Payroll-to-revenue trend across horizons is the single biggest health signal for this kind of business. '
    s += 'If MTD ratio is meaningfully higher than YTD, labor is outpacing revenue — flag it loudly with a specific number. '
    s += 'For a 5-10 person sign shop, healthy payroll-to-revenue runs 25-40%; above 50% is a red flag (or revenue is being mis-attributed).\n\n'
    // Anti-double-counting guard (PAY-06). The three other sources
    // that touch payroll describe the SAME dollars from different
    // angles — QB books include payroll as an expense line, BankSync
    // Opex withdrawals include the Gusto debit that funded payroll.
    // Without this guard the AI can stack them and report ~3x the
    // real labor cost.
    s += '**PAYROLL IS REPORTED ONCE, FROM THREE ANGLES — DO NOT SUM:**\n'
    s += '- This Gusto section (6) is the **authoritative payroll number**. Use it for any labor-cost claim.\n'
    s += '- QB workbook expenses in section 1 ALREADY INCLUDE payroll as a line item (Wages / Salaries / Payroll Expenses). The QB total expense figure is NOT additive to Gusto payroll.\n'
    s += '- BankSync Opex withdrawals in section 5 ALREADY INCLUDE the Gusto debit that moves cash from Opex into Gusto to fund payroll + employer taxes. Bank Opex outflows are NOT additive to Gusto payroll either.\n'
    s += '- Treat the three sources as a **three-way cross-check** of the same labor cost, not three separate costs. Use the cross-source sanity check below to verify they tie within ~5%.\n'
    sections.push(s)
  }

  // 7. Data freshness
  let freshness = '# 7. Data Freshness\n\n'
  freshness += '| Source | Status | Age |\n|---|---|---|\n'
  for (const r of reminders) {
    freshness += `| ${r.label} | ${r.status.state} | ${r.status.label} |\n`
  }
  sections.push(freshness)

  if (sections.length <= 1) {
    return null // nothing but freshness — caller should block the run
  }

  return `You are evaluating Signarama Temecula (a small sign-shop business) comprehensively. The business runs on the **Profit First** methodology (Mike Michalowicz) with 5 named bank accounts (Income 7068, Opex 7076, Owners 7092, Profit 7100, Tax 7118) and an AMEX credit card. Revenue flows into Income, then is allocated twice monthly per CAPs to Opex / Owners / Profit / Tax. Combine the selected data sources below into a single holistic assessment. Be direct, specific, and cite real dollar amounts from the data — do not fabricate. Only sources the owner selected are included; do not speculate about omitted ones.

# Data hygiene — read this before you analyze

The same dollar movement is intentionally reported by **multiple sources from different angles** so we can cross-check them. **DO NOT ADD ACROSS SOURCES** — that produces 2-3x double-counting. Specifically:

- **Payroll** appears in three places, all describing the SAME spend:
  1. Gusto (Section 6) — the **authoritative** payroll cost (gross + employer taxes + benefits)
  2. QB workbook expenses (Section 1) — payroll is a line item INSIDE total expenses
  3. BankSync Opex withdrawals (Section 5) — the Gusto debit that funded payroll
  → Use Gusto as the labor-cost number. The other two are sanity checks against it.

- **Revenue** appears in three places, all describing the SAME sales:
  1. Corebridge Closed/Paid (Section 3) — sales recognised at payment
  2. QB workbook revenue (Section 1) — same sales on the P&L
  3. BankSync Income (7068) deposits (Section 5) — same sales hitting the bank
  → For a single-revenue-stream question, pick ONE source and stick with it. Use the others to flag drift.

- **Debt service** (Section 6 — to be confirmed against the debts page if visible) appears as bank Opex withdrawals AND in the debt_payments table. Don't add those either.

When in doubt, pick the source closest to actual cash movement (BankSync > Gusto > QB workbook > Corebridge > Weekly Log).

# Evaluation horizons — three windows only

The owner has scoped this evaluation to **month-to-date (MTD)**, **quarter-to-date (QTD)**, and **year-to-date (YTD)**. Section 2 below already aggregates every loaded source into those three windows. **Use those windows as the primary lens for every quantitative comparison.** Do not analyze week-over-week trends, multi-year history, or arbitrary date ranges; the owner doesn't want that level of resolution. When a section asks for a "trend" or a "trajectory", read it as "how does this look in MTD vs QTD vs YTD?".

${sections.join('\n\n')}

# Evaluation Instructions

Produce a comprehensive evaluation with these sections (use ## markdown headings exactly). In every numbered section, organize your numbers and conclusions around the three horizons (Month / Quarter / Year) from section 2 above.

## 1. Executive Verdict
3-4 sentences. Pick one of: **STRONG / STABLE / MIXED / DETERIORATING**. State the single most important driver, scoped to the current month / quarter / year picture.

## 2. Cash & Liquidity (Profit First lens)
Aggregate cash across the PF bank accounts, AMEX outstanding, net position. Where balances are available for the MTD / QTD / YTD windows, comment on direction across the three. Estimated DSO from AR aging. Per-account commentary: Is Income flowing properly to the 4 reserve accounts? Are Profit and Tax balances growing as expected? Is Opex sustainable? Is AMEX being paid down? Near-term cash risk if any.

## 3. Revenue & Pipeline
Top-line trajectory across the books AND the Corebridge funnel — but explicitly framed as MTD vs QTD vs YTD. Conversion ratios (new → completed → paid). WIP-to-revenue ratio. Customer concentration risk. Annualize the MTD figure when comparing to YTD so the comparison is fair.

## 4. Operations & Margin
Payroll-to-revenue ratio at MTD / QTD / YTD — **use the ratios from section 6 (Payroll Cost) directly; do not recompute from gross pay alone.** Gross margin from books if available. Cost trends across the three horizons. Flag whichever ratio (payroll-to-revenue, AMEX growth, debt service) is the biggest year-over-period mover, with a specific dollar delta.

## 5. AR Collection
Aging distribution risk, top past-due customers by amount, recommended collection actions. (Aging is a point-in-time snapshot — no horizon split needed, but compare the aging snapshot date against the current period.)

## 6. Cross-Source Sanity Check
Do the QB books align with Corebridge pipeline numbers and bank statement cash flow **within the same horizon**? Specifically:

(a) **Revenue tie-out** — do Income (7068) deposits roughly match Closed/Paid Corebridge sales for the matching MTD / QTD / YTD window? Do they match QB workbook revenue?

(b) **Profit First allocations** — do allocations OUT of Income sum to roughly what was deposited in?

(c) **Payroll tie-out** — does Gusto total_company_cost approximately match (within ~5%) the payroll line on the QB P&L AND the size of the Gusto debit visible in BankSync Opex withdrawals for the same window? **All three should be the same number.** If any one diverges from the other two by more than ~5%, flag it: either the QB upload is stale, BankSync is missing transactions, or a payroll run was processed outside Gusto.

Flag any meaningful discrepancies or stale uploads. **Do not sum across the three sources — they describe the same dollars from different angles.**

## 7. Top 5 Strategic Actions
Prioritized for next 30 days. Each with rough impact estimate. Use the horizon comparisons to justify priority (e.g. "QTD is X% below YTD pace → focus on Y").

## 8. Watchlist
3-5 specific metrics to track at the **monthly / quarterly / yearly** cadence with target thresholds. (No weekly metrics.)

## 9. Dig Deeper
Output 3-6 short investigation notes — anomalies or open questions surfaced by comparing the three horizons. ONE LINE EACH, starting with a bold label and colon. Examples:
- **AR > 90 days:** Three invoices total $381 from National Branding; consider write-off.
- **AMEX growth quarter over year:** QTD spend is pacing 23% higher than YTD average — review category breakdown.

Keep total response under 1500 words. Cite specific dollar amounts from the section-2 rollups. If data for any window is missing, say so briefly rather than fabricating.`
}
