import { useEffect, useState } from 'react'
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid, ComposedChart,
} from 'recharts'
import { fmt } from '../utils/format'
import { fetchPersistedCashFlow, fetchPersistedAccounts } from '../utils/persistedBank'
import { debtsSummary } from '../utils/debts'
import { gustoSummary } from '../utils/payroll'

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function getPalette(theme) {
  if (theme === 'dark') {
    return {
      series: {
        income: '#4ade80', opex: '#60a5fa', owners: '#f59e0b',
        profit: '#22c55e', tax: '#f97316', amex: '#f87171',
        positive: '#4ade80', negative: '#f87171', neutral: '#60a5fa',
      },
      aging: ['#4ade80', '#f59e0b', '#f97316', '#f87171', '#dc2626'],
      tooltip: { background: '#3c4350', border: '1px solid #5a6373', borderRadius: 6, fontSize: 12, color: '#ffffff' },
      tooltipLabel: '#d6dae1',
      axis: '#8b93a1',
      grid: '#242a36',
      tickLine: '#2e3543',
      label: '#aab1c0',
      cursor: 'rgba(255, 255, 255, 0.06)',
    }
  }
  return {
    series: {
      income: '#16a34a', opex: '#2563eb', owners: '#b45309',
      profit: '#15803d', tax: '#c2410c', amex: '#dc2626',
      positive: '#16a34a', negative: '#dc2626', neutral: '#2563eb',
    },
    aging: ['#16a34a', '#b45309', '#c2410c', '#dc2626', '#991b1b'],
    tooltip: { background: '#ffffff', border: '1px solid #d2d6dd', borderRadius: 6, fontSize: 12, color: '#1c1f26' },
    tooltipLabel: '#596070',
    axis: '#596070',
    grid: '#e4e6eb',
    tickLine: '#d2d6dd',
    label: '#596070',
    cursor: 'rgba(37, 99, 235, 0.07)',
  }
}

function ChartCard({ title, hint, children, empty }) {
  return (
    <div className="card">
      <div className="section-label">{title}</div>
      {hint && <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>{hint}</div>}
      {empty ? (
        <div className="dim" style={{ fontSize: 12, padding: '24px 0', textAlign: 'center' }}>{empty}</div>
      ) : (
        <div style={{ width: '100%', height: 240 }}>{children}</div>
      )}
    </div>
  )
}

// Flatten + dedupe transactions for one account. Mirrors the helper in
// utils/evaluation.js but kept local since this file doesn't import it.
// Dedup key: date + amount + lowercased description. Newest upload wins.
function flattenAccountTx(list) {
  if (!Array.isArray(list)) return []
  const sorted = list.slice().sort(
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
      out.push({ date: String(t.date).slice(0, 10), amount: amt })
    }
  }
  return out
}

function BankBalanceChart({ p }) {
  const accounts = ['income', 'opex', 'owners', 'profit', 'tax']
  const [serverAccounts, setServerAccounts] = useState(null) // null = loading

  useEffect(() => {
    let cancelled = false
    fetchPersistedAccounts()
      .then((list) => { if (!cancelled) setServerAccounts(list) })
      .catch(() => { if (!cancelled) setServerAccounts([]) })
    return () => { cancelled = true }
  }, [])

  // If the server has reconciled balances for any PF accounts, draw the
  // CURRENT balance per account as a single horizontal point (we don't
  // have historical month-by-month balances from BankSync yet — that's
  // a future enhancement). Until then, fall back to the localStorage
  // ending-balance-by-month trend for any account NOT yet on BankSync.
  const fromServer = new Map()
  if (Array.isArray(serverAccounts)) {
    for (const a of serverAccounts) {
      if (a.last_balance != null && a.pf_key) fromServer.set(a.pf_key, a)
    }
  }
  const monthMap = new Map()
  for (const acct of accounts) {
    if (fromServer.has(acct)) {
      // Server-sourced: plot the current balance on the month of last_balance_at.
      const a = fromServer.get(acct)
      const m = (a.last_balance_at || '').slice(0, 7)
      if (!m) continue
      if (!monthMap.has(m)) monthMap.set(m, { month: m })
      monthMap.get(m)[acct] = a.last_balance
    } else {
      // Fallback: legacy localStorage path (PDF uploads, per-month ending balance).
      const list = loadJSON(`bizcore.bank.${acct}`) || []
      const sorted = list.slice().sort(
        (a, b) => (b.period?.end || '').localeCompare(a.period?.end || '')
      )
      const placed = new Set()
      for (const stmt of sorted) {
        const key = (stmt.period?.end || stmt.uploadedAt || '').slice(0, 7)
        if (!key) continue
        if (placed.has(key)) continue
        placed.add(key)
        if (!monthMap.has(key)) monthMap.set(key, { month: key })
        monthMap.get(key)[acct] = stmt.endingBalance ?? null
      }
    }
  }
  const data = Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month))
  if (data.length === 0) {
    return <ChartCard title="Bank balances over time" empty="Trigger a BankSync backfill from the BankAccounts page to populate this chart." />
  }
  const hint = serverAccounts?.length
    ? `Latest BankSync balance per PF account, plus historical ending balances from any account still on PDF upload.`
    : 'Latest ending balance per PF account in each calendar month (PDF-upload data — switch to BankSync to refresh live).'
  return (
    <ChartCard title="Bank balances over time" hint={hint}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={p.grid} strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: p.axis }} tickLine={{ stroke: p.tickLine }} />
          <YAxis tick={{ fontSize: 11, fill: p.axis }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tickLine={{ stroke: p.tickLine }} />
          <Tooltip contentStyle={p.tooltip} itemStyle={{ color: p.tooltip.color }} formatter={(v) => fmt(v)} labelStyle={{ color: p.tooltipLabel }} cursor={{ fill: p.cursor, stroke: p.cursor }} />
          <Legend wrapperStyle={{ fontSize: 11, color: p.label }} />
          {accounts.map((a) => (
            <Line
              key={a}
              type="monotone"
              dataKey={a}
              stroke={p.series[a]}
              strokeWidth={2}
              dot={{ r: 3 }}
              name={a.charAt(0).toUpperCase() + a.slice(1)}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function NetCashFlowChart({ p }) {
  // Source of truth: the server-side /api/banksync/persisted/cash-flow
  // endpoint (BANK-04). It already iterates bank_transactions by date,
  // detects PF transfers across accounts, and returns deduped monthly
  // totals. Falls back to the legacy localStorage path only if the
  // server has no data yet (i.e., backfill hasn't been run).
  const [server, setServer] = useState(null) // null = loading
  const [serverErr, setServerErr] = useState(null)

  // DEBT-05: pull /api/debts/summary so we can overlay monthly debt
  // service. Toggle defaults to off (preserves the original chart) and
  // persists across page loads.
  const [debtSummary, setDebtSummary] = useState(null) // null = loading or unavailable
  const [showDebt, setShowDebt] = useState(() => {
    try { return localStorage.getItem('bizcore.evaluation.showDebt') === '1' } catch { return false }
  })

  useEffect(() => {
    let cancelled = false
    fetchPersistedCashFlow()
      .then((b) => { if (!cancelled) setServer(b) })
      .catch((err) => { if (!cancelled) { setServer({ months: [] }); setServerErr(err.message) } })
    // Debt summary is a soft dependency — chart still renders if it fails
    // (e.g. server too old to have the route). Just hides the overlay.
    debtsSummary()
      .then((b) => { if (!cancelled) setDebtSummary(b) })
      .catch(() => { if (!cancelled) setDebtSummary({ per_month: [] }) })
    return () => { cancelled = true }
  }, [])

  function toggleDebt() {
    setShowDebt((v) => {
      const next = !v
      try { localStorage.setItem('bizcore.evaluation.showDebt', next ? '1' : '0') } catch {}
      return next
    })
  }

  // BankSync (server) is the only source — the localStorage PDF
  // fallback was removed in CLEAN-01 (the PDF upload UI itself was
  // removed in STRIP-04, so nothing writes those keys anymore).
  let data = []
  let hint = ''
  let badge = null
  if (server && Array.isArray(server.months) && server.months.length > 0) {
    // BANK-13: filter out months before BankSync had coverage of both
    // Income + Opex. Earlier months only had Profit/Tax/Owners with
    // 1-2 tx each — showing them implies real cash flow that didn't
    // exist in the data. coverage_started_month comes from the
    // /cash-flow endpoint (server computes it from the earliest
    // transaction on each PF account).
    const coverage = server.coverage_started_month || null
    const allMonths = server.months
    const filteredMonths = coverage
      ? allMonths.filter((m) => m.month >= coverage)
      : allMonths
    const droppedCount = allMonths.length - filteredMonths.length
    data = filteredMonths.map((m) => ({ month: m.month, net: m.net }))
    const coverageNote = (coverage && droppedCount > 0)
      ? ` First ${droppedCount} month${droppedCount === 1 ? '' : 's'} hidden — BankSync coverage of all operating accounts started ${coverage}.`
      : ''
    hint = `Server-computed from BankSync data: ${server.total_transactions?.toLocaleString?.() || 0} transactions in window, ${server.transfers_excluded?.toLocaleString?.() || 0} PF transfers excluded.${coverageNote} Hard-reconciled at backfill time.`
    badge = { label: 'BankSync', color: 'var(--accent)' }
  }
  // serverErr is captured for surfacing in the empty state — currently
  // the empty-state copy below ("trigger a BankSync backfill") covers
  // both "no data yet" and "/api errored" cases adequately.
  void serverErr

  // Index debt service by month, then merge onto the bar data so the
  // tooltip + line overlay line up with the existing bars even when
  // debt-payments cover months the cash-flow series doesn't (and v.v.).
  const debtByMonth = new Map()
  let debtMonthsTotal = 0
  if (debtSummary && Array.isArray(debtSummary.per_month)) {
    for (const m of debtSummary.per_month) {
      debtByMonth.set(m.month, Number(m.debt_service) || 0)
      debtMonthsTotal += 1
    }
  }
  const debtAvailable = debtMonthsTotal > 0
  // Union of months so a debt-only month still appears on the X axis.
  const monthSet = new Set(data.map((d) => d.month))
  for (const m of debtByMonth.keys()) monthSet.add(m)
  const merged = Array.from(monthSet)
    .sort((a, b) => a.localeCompare(b))
    .map((month) => {
      const baseNet = data.find((d) => d.month === month)?.net ?? 0
      const ds = debtByMonth.get(month) || 0
      // ex_debt = the operational net once you strip out the debt
      // service that was already inside the net figure. Plaid sign
      // convention has debits negative, so debt service is a withdrawal
      // already included in `net` → add it back to "remove" it.
      return { month, net: baseNet, debt_service: ds, ex_debt: baseNet + ds }
    })

  if (merged.length === 0) {
    return <ChartCard title="Net cash flow by month (real, ex-PF transfers)" empty={server === null ? 'Loading…' : 'No data yet — trigger a BankSync backfill from the BankAccounts page.'} />
  }

  const titleNode = (
    <div className="row between" style={{ alignItems: 'baseline', gap: 8 }}>
      <span>
        Net cash flow by month (real, ex-PF transfers)
        {badge && (
          <span className="pill" style={{ marginLeft: 8, fontSize: 10, background: badge.color, color: '#fff', padding: '2px 6px', borderRadius: 6 }}>
            {badge.label}
          </span>
        )}
      </span>
      {debtAvailable && (
        <label className="dim" style={{ fontSize: 11, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          title="Overlay debt service from /api/debts/summary so you can see how much of each month's net flow was loan/lease payments.">
          <input type="checkbox" checked={showDebt} onChange={toggleDebt}
            style={{ accentColor: 'var(--danger)', width: 12, height: 12 }} />
          Show debt service
        </label>
      )}
    </div>
  )

  const combinedHint = showDebt && debtAvailable
    ? `${hint} Red line is monthly debt service from /api/debts/summary; the cyan ghost bar is the operational net once debt payments are removed (net + |debt service|).`
    : hint

  return (
    <ChartCard title={titleNode} hint={combinedHint}>
      <ResponsiveContainer>
        <ComposedChart data={merged} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={p.grid} strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: p.axis }} tickLine={{ stroke: p.tickLine }} />
          <YAxis tick={{ fontSize: 11, fill: p.axis }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tickLine={{ stroke: p.tickLine }} />
          <Tooltip contentStyle={p.tooltip} itemStyle={{ color: p.tooltip.color }} formatter={(v) => fmt(v)} labelStyle={{ color: p.tooltipLabel }} cursor={{ fill: p.cursor, stroke: p.cursor }} />
          {showDebt && debtAvailable && <Legend wrapperStyle={{ fontSize: 11, color: p.label }} />}
          {/* Net bar — same look as before, colour-by-sign. */}
          <Bar dataKey="net" name="Net cash flow" radius={[4, 4, 0, 0]}>
            {merged.map((d, i) => (
              <Cell key={i} fill={d.net >= 0 ? p.series.positive : p.series.negative} />
            ))}
          </Bar>
          {showDebt && debtAvailable && (
            // Ghost bar: what the net would have been if debt service
            // wasn't pulling on it. Drawn in a muted neutral so the red
            // line + green/red net bars stay the primary reads.
            <Bar dataKey="ex_debt" name="Net ex-debt service" radius={[4, 4, 0, 0]}
              fill={p.series.neutral} fillOpacity={0.18} />
          )}
          {showDebt && debtAvailable && (
            <Line type="monotone" dataKey="debt_service" name="Debt service"
              stroke={p.series.amex} strokeWidth={2} dot={{ r: 3 }} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function PipelineFunnelChart({ p }) {
  const buckets = [
    { key: 'newlyCreated', label: 'Newly Created' },
    { key: 'completedSales', label: 'Completed' },
    { key: 'closedSales', label: 'Paid' },
    { key: 'wip', label: 'WIP (open)' },
  ]
  const data = buckets.map((b) => {
    const list = loadJSON(`bizcore.pipeline.${b.key}`) || []
    return { name: b.label, value: list[0]?.total || 0 }
  })
  if (data.every((d) => d.value === 0)) {
    return <ChartCard title="Pipeline funnel" empty="Upload Corebridge sales reports on the Pipeline page." />
  }
  return (
    <ChartCard title="Pipeline funnel" hint="Latest snapshot per bucket — periods may differ.">
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 4, left: 24 }}>
          <CartesianGrid stroke={p.grid} strokeDasharray="3 3" />
          <XAxis type="number" tick={{ fontSize: 11, fill: p.axis }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tickLine={{ stroke: p.tickLine }} />
          <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: p.axis }} tickLine={{ stroke: p.tickLine }} width={100} />
          <Tooltip contentStyle={p.tooltip} itemStyle={{ color: p.tooltip.color }} formatter={(v) => fmt(v)} labelStyle={{ color: p.tooltipLabel }} cursor={{ fill: p.cursor, stroke: p.cursor }} />
          <Bar dataKey="value" fill={p.series.neutral} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function ARAgingChart({ p }) {
  const list = loadJSON('bizcore.pipeline.arAging') || []
  const latest = list[0]
  if (!latest) return <ChartCard title="AR aging buckets" empty="Upload Corebridge AR Aging report to see buckets." />
  const byBucket = {}
  for (const r of latest.rows) {
    byBucket[r.status] = (byBucket[r.status] || 0) + r.amount
  }
  const order = ['Current', '1-30 Days Past Due', '31-60 Days Past Due', '61-90 Days Past Due', '>90 Days Past Due']
  const data = order.map((k) => ({ name: k, value: byBucket[k] || 0 })).filter((d) => d.value > 0)
  if (data.length === 0) return <ChartCard title="AR aging buckets" empty="No AR data parsed yet." />
  return (
    <ChartCard title="AR aging buckets" hint={`Total outstanding: ${fmt(latest.total)} across ${latest.count} invoices.`}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={p.grid} strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 9, fill: p.axis }} tickLine={{ stroke: p.tickLine }} />
          <YAxis tick={{ fontSize: 11, fill: p.axis }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tickLine={{ stroke: p.tickLine }} />
          <Tooltip contentStyle={p.tooltip} itemStyle={{ color: p.tooltip.color }} formatter={(v) => fmt(v)} labelStyle={{ color: p.tooltipLabel }} cursor={{ fill: p.cursor, stroke: p.cursor }} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={p.aging[i] || p.series.neutral} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

// Per-month deduped totals for one Corebridge pipeline bucket.
//   - Dedup by invoice reference (newest snapshot upload wins) so a sale
//     that appears in a Mar 1 export AND a Mar 8 export only counts once.
//   - Bucket each row by its OWN date, not the snapshot's period — same
//     "use the dates of the documents provided" rule the bank charts use.
function corebridgeByMonth(bucketKey) {
  const snaps = loadJSON(`bizcore.pipeline.${bucketKey}`) || []
  // Newest upload first so dedup keeps the most recent line.
  const sorted = snaps.slice().sort(
    (a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || '')
  )
  const seenRef = new Set()
  const byMonth = new Map()
  for (const s of sorted) {
    const rows = Array.isArray(s.rows) ? s.rows : []
    for (const r of rows) {
      const date = r.date && String(r.date).slice(0, 10)
      if (!date) continue
      const amt = Number(r.amount)
      if (!Number.isFinite(amt) || amt === 0) continue
      const refKey = String(r.reference || `${r.customer || ''}|${date}|${amt.toFixed(2)}`).trim().toLowerCase()
      if (seenRef.has(refKey)) continue
      seenRef.add(refKey)
      const m = date.slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(m)) continue
      byMonth.set(m, (byMonth.get(m) || 0) + amt)
    }
  }
  return byMonth
}

// Per-month QBO revenue from the imported workbook (sums every series with
// kind=revenue; each dataPoint already comes with a date).
function qboRevenueByMonth() {
  const doc = loadJSON('bizcore.document')
  const byMonth = new Map()
  if (!doc?.sheets) return byMonth
  for (const sh of doc.sheets) {
    for (const s of (sh.series || [])) {
      if (s.kind !== 'revenue') continue
      for (const dp of (s.dataPoints || [])) {
        const v = Number(dp.value)
        if (!Number.isFinite(v) || v === 0) continue
        const d = dp.date && String(dp.date).slice(0, 10)
        if (!d) continue
        const m = d.slice(0, 7)
        if (!/^\d{4}-\d{2}$/.test(m)) continue
        byMonth.set(m, (byMonth.get(m) || 0) + v)
      }
    }
  }
  return byMonth
}

// Per-month deposits hitting the Income (7068) PF account — uses the same
// transaction-level dedup as the Net Cash Flow chart, deposits only.
function incomeDepositsByMonth() {
  const list = loadJSON('bizcore.bank.income') || []
  const txs = flattenAccountTx(list)
  const byMonth = new Map()
  for (const t of txs) {
    if (t.amount <= 0) continue
    const m = t.date.slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(m)) continue
    byMonth.set(m, (byMonth.get(m) || 0) + t.amount)
  }
  return byMonth
}

function CrossSourceChart({ p }) {
  const corebridge = corebridgeByMonth('closedSales')
  const qbo = qboRevenueByMonth()
  // Bank deposits: try the server-persisted cash-flow first; only fall
  // back to localStorage if the server has nothing yet.
  const [serverCashFlow, setServerCashFlow] = useState(null)
  useEffect(() => {
    let cancelled = false
    fetchPersistedCashFlow()
      .then((b) => { if (!cancelled) setServerCashFlow(b) })
      .catch(() => { if (!cancelled) setServerCashFlow({ months: [] }) })
    return () => { cancelled = true }
  }, [])
  const bank = new Map()
  if (serverCashFlow && Array.isArray(serverCashFlow.months) && serverCashFlow.months.length > 0) {
    // The cross-source view wants INCOME deposits specifically (customer
    // payments hitting Income 7068) — that's the per-account breakdown
    // the server emits.
    for (const m of serverCashFlow.months) {
      const incomeNet = (m.by_account && m.by_account.income) || 0
      // Per-account net is dep - wd; for the Income account it's
      // dominated by deposits since outflows are PF transfers (already
      // excluded server-side). Use net as deposits proxy.
      if (incomeNet > 0) bank.set(m.month, incomeNet)
    }
  } else {
    // Fallback: localStorage (legacy path).
    const fb = incomeDepositsByMonth()
    for (const [k, v] of fb.entries()) bank.set(k, v)
  }
  // Union of all months that have at least one number.
  const allMonths = new Set([...corebridge.keys(), ...qbo.keys(), ...bank.keys()])
  const months = [...allMonths].sort()
  const data = months.map((m) => ({
    month: m,
    corebridge: Math.round(corebridge.get(m) || 0),
    qbo: Math.round(qbo.get(m) || 0),
    bank: Math.round(bank.get(m) || 0),
  }))
  if (data.length === 0) {
    return (
      <ChartCard
        title="Cross-source revenue check"
        empty="Upload Corebridge Closed Sales (Paid), a QuickBooks workbook with revenue, and the Income (7068) bank statement to see how the three sources line up by month."
      />
    )
  }
  // Compute discrepancies: max diff vs. min across the three for each month,
  // expressed as % of the average. Anything over 15% gets flagged.
  let flaggedCount = 0
  for (const d of data) {
    const vals = [d.corebridge, d.qbo, d.bank].filter((v) => v > 0)
    if (vals.length < 2) continue
    const min = Math.min(...vals), max = Math.max(...vals)
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length
    if (avg > 0 && (max - min) / avg > 0.15) flaggedCount++
  }
  const hint = flaggedCount > 0
    ? `Each month side-by-side: 🟡 Corebridge Paid vs 🔵 QBO Revenue vs 🟢 Income (7068) Deposits. ${flaggedCount} month${flaggedCount === 1 ? ' shows' : 's show'} a >15% gap between sources — those are the ones to investigate.`
    : 'Each month side-by-side: 🟡 Corebridge Paid vs 🔵 QBO Revenue vs 🟢 Income (7068) Deposits. Reconciles when all three bars are close in height.'
  return (
    <ChartCard title="Cross-source revenue check" hint={hint}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={p.grid} strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: p.axis }} tickLine={{ stroke: p.tickLine }} />
          <YAxis tick={{ fontSize: 11, fill: p.axis }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tickLine={{ stroke: p.tickLine }} />
          <Tooltip contentStyle={p.tooltip} itemStyle={{ color: p.tooltip.color }} formatter={(v) => fmt(v)} labelStyle={{ color: p.tooltipLabel }} cursor={{ fill: p.cursor, stroke: p.cursor }} />
          <Legend wrapperStyle={{ fontSize: 11, color: p.label }} />
          <Bar dataKey="corebridge" name="Corebridge Paid" fill={p.series.owners} radius={[4, 4, 0, 0]} />
          <Bar dataKey="qbo"        name="QBO Revenue"    fill={p.series.neutral} radius={[4, 4, 0, 0]} />
          <Bar dataKey="bank"       name="Income Deposits" fill={p.series.income} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function CrossSourceTable({ p: _p }) {
  const corebridge = corebridgeByMonth('closedSales')
  const qbo = qboRevenueByMonth()
  // BANK-16: use the same server cash-flow source as CrossSourceChart
  // above. The legacy incomeDepositsByMonth() reads from the
  // bizcore.bank.income localStorage key which hasn't been written
  // since STRIP-04 removed the BankAccounts PDF upload — stale data
  // there was the reason this table showed $184K while the BANK-14
  // diagnostic and the chart above said $130K for the same month.
  const [serverCashFlow, setServerCashFlow] = useState(null)
  useEffect(() => {
    let cancelled = false
    fetchPersistedCashFlow()
      .then((b) => { if (!cancelled) setServerCashFlow(b) })
      .catch(() => { if (!cancelled) setServerCashFlow({ months: [] }) })
    return () => { cancelled = true }
  }, [])
  const bank = new Map()
  if (serverCashFlow && Array.isArray(serverCashFlow.months)) {
    for (const m of serverCashFlow.months) {
      const incomeNet = (m.by_account && m.by_account.income) || 0
      if (incomeNet > 0) bank.set(m.month, incomeNet)
    }
  }
  const allMonths = new Set([...corebridge.keys(), ...qbo.keys(), ...bank.keys()])
  const months = [...allMonths].sort().reverse() // newest first
  if (months.length === 0) return null
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="section-label">Cross-source revenue — by the numbers</div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
        Same data as the chart above, in dollars. The "Spread" column is the
        max-minus-min across the three sources — bigger spread, more to investigate.
      </div>
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Month</th>
            <th style={{ textAlign: 'right' }}>Corebridge Paid</th>
            <th style={{ textAlign: 'right' }}>QBO Revenue</th>
            <th style={{ textAlign: 'right' }}>Income Deposits</th>
            <th style={{ textAlign: 'right' }}>Spread</th>
            <th style={{ textAlign: 'left' }}>Likely cause</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => {
            const cb = corebridge.get(m) || 0
            const qb = qbo.get(m) || 0
            const bk = bank.get(m) || 0
            const vals = [cb, qb, bk].filter((v) => v > 0)
            const min = vals.length ? Math.min(...vals) : 0
            const max = vals.length ? Math.max(...vals) : 0
            const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0
            const spread = max - min
            const spreadPct = avg > 0 ? spread / avg : 0
            let hint = '—'
            if (vals.length < 2) hint = `Only one source has data for this month`
            else if (spreadPct <= 0.05) hint = 'Reconciles ✓'
            else if (cb > bk && cb > qb) hint = 'Corebridge ahead — sales not yet deposited / recorded'
            else if (bk > cb && bk > qb) hint = 'Bank ahead — deposits from prior periods or non-sale income'
            else if (qb > cb && qb > bk) hint = 'QBO ahead — recorded revenue without matching cash'
            else hint = 'Mixed — review individual entries'
            return (
              <tr key={m}>
                <td style={{ textAlign: 'left' }}>{m}</td>
                <td style={{ textAlign: 'right' }} className="mono">{cb ? fmt(cb) : '—'}</td>
                <td style={{ textAlign: 'right' }} className="mono">{qb ? fmt(qb) : '—'}</td>
                <td style={{ textAlign: 'right' }} className="mono">{bk ? fmt(bk) : '—'}</td>
                <td style={{ textAlign: 'right', color: spreadPct > 0.15 ? 'var(--danger)' : 'inherit' }} className="mono">
                  {spread ? fmt(spread) : '—'}
                </td>
                <td style={{ textAlign: 'left', fontSize: 12 }}>{hint}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function WeeklyOrdersChart({ p }) {
  const weekly = loadJSON('bizcore.weekly') || []
  if (!weekly.length) return <ChartCard title="Weekly orders trend" empty="Add Weekly Log entries to see this trend." />
  const data = weekly.slice().sort((a, b) => a.weekStart.localeCompare(b.weekStart)).map((w) => ({
    week: w.weekStart,
    newOrders: w.newOrders || 0,
    completed: w.ordersCompleted || 0,
    wip: w.wip || 0,
  }))
  return (
    <ChartCard title="Weekly orders trend" hint={`${data.length} weeks logged — new orders, completed, WIP.`}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
          <CartesianGrid stroke={p.grid} strokeDasharray="3 3" />
          <XAxis dataKey="week" tick={{ fontSize: 11, fill: p.axis }} tickLine={{ stroke: p.tickLine }} />
          <YAxis tick={{ fontSize: 11, fill: p.axis }} tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tickLine={{ stroke: p.tickLine }} />
          <Tooltip contentStyle={p.tooltip} itemStyle={{ color: p.tooltip.color }} formatter={(v) => fmt(v)} labelStyle={{ color: p.tooltipLabel }} cursor={{ fill: p.cursor, stroke: p.cursor }} />
          <Legend wrapperStyle={{ fontSize: 11, color: p.label }} />
          <Line type="monotone" dataKey="newOrders" stroke={p.series.income} strokeWidth={2} dot={{ r: 3 }} name="New Orders" />
          <Line type="monotone" dataKey="completed" stroke={p.series.neutral} strokeWidth={2} dot={{ r: 3 }} name="Completed" />
          <Line type="monotone" dataKey="wip" stroke={p.series.owners} strokeWidth={2} dot={{ r: 3 }} name="WIP" />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/**
 * DEBT-06: KPI strip rendered above the Evaluation charts. Three cards:
 *   1. Total outstanding (sum of current balances across active debts)
 *   2. Monthly debt service MTD (sum of debt_payments this month)
 *   3. Debt-to-revenue MTD (debt service / income-account deposits)
 *
 * Reads /api/debts/summary and /api/banksync/persisted/cash-flow. Both
 * are soft dependencies — if either fails the strip just hides itself so
 * a stale server or no-data state doesn't break the page.
 */
export function DebtKpiBar() {
  const [summary, setSummary] = useState(null) // null = loading, {} = ready (maybe empty)
  const [cashFlow, setCashFlow] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      debtsSummary().catch(() => null),
      fetchPersistedCashFlow().catch(() => null),
    ]).then(([s, c]) => {
      if (cancelled) return
      if (!s) setError(true)
      setSummary(s || {})
      setCashFlow(c || { months: [] })
    })
    return () => { cancelled = true }
  }, [])

  // Hide entirely until /api/debts/summary resolves so the page doesn't
  // flicker in an empty card. After it loads, hide if there are no active
  // debts AND no historical payments — the page is genuinely
  // debt-free, no KPI to render.
  if (error || summary === null || cashFlow === null) return null
  const hasActive = Number(summary.active_debts_count) > 0
  const hasHistory = (summary.per_month || []).length > 0
  if (!hasActive && !hasHistory) return null

  const ymd = summary.as_of || new Date().toISOString().slice(0, 10)
  const ym = ymd.slice(0, 7)
  // Income-account deposits for the same MTD window the summary uses.
  // /cash-flow returns months with `by_account[pf_key]` already
  // PF-transfer-excluded. We pull the income column for the current
  // month — that's the real "revenue landed in the bank" denominator
  // rather than gross sales or invoiced revenue.
  const monthBucket = (cashFlow.months || []).find((m) => m.month === ym)
  const incomeDepositsMTD = Math.max(0, Number(monthBucket?.by_account?.income) || 0)
  const debtServiceMTD = Number(summary.month_to_date?.debt_service) || 0
  const debtToRevenue = incomeDepositsMTD > 0 ? debtServiceMTD / incomeDepositsMTD : null

  // Risk-tint the ratio:
  //   < 10%  → green   (manageable)
  //   < 25%  → amber   (notable)
  //   ≥ 25%  → red     (heavy)
  let ratioColor = 'var(--text)'
  if (debtToRevenue != null) {
    ratioColor = debtToRevenue < 0.10 ? 'var(--accent)'
      : debtToRevenue < 0.25 ? 'var(--accent3)'
      : 'var(--danger)'
  }

  return (
    <div className="card" style={{ marginTop: 16, borderLeft: '4px solid var(--danger)' }}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <div>
          <div className="section-label" style={{ color: 'var(--danger)' }}>Debt service snapshot</div>
          <div className="dim" style={{ fontSize: 12 }}>
            Pulled live from /api/debts/summary. Edit individual debts on the Debts page.
          </div>
        </div>
        <span className="dim mono" style={{ fontSize: 11 }}>as of {ymd}</span>
      </div>
      <div className="grid-3">
        <div className="card-sm" style={{ background: 'var(--bg3)' }}>
          <div className="stat-label">Total outstanding</div>
          <div className="stat-value">{fmt(summary.total_outstanding)}</div>
          <div className="stat-delta dim">
            {summary.active_debts_count || 0} active debt{summary.active_debts_count === 1 ? '' : 's'}
            {' · '}{fmt(summary.total_monthly_payment_expected)}/mo expected
          </div>
        </div>
        <div className="card-sm" style={{ background: 'var(--bg3)' }}>
          <div className="stat-label">Debt service MTD</div>
          <div className="stat-value">{fmt(debtServiceMTD)}</div>
          <div className="stat-delta dim">
            {summary.month_to_date?.payment_count || 0} matched payment{summary.month_to_date?.payment_count === 1 ? '' : 's'}
            {summary.quarter_to_date && (
              <> · QTD {fmt(summary.quarter_to_date.debt_service)}</>
            )}
          </div>
        </div>
        <div className="card-sm" style={{ background: 'var(--bg3)' }}>
          <div className="stat-label">Debt-to-revenue MTD</div>
          <div className="stat-value" style={{ color: ratioColor }}>
            {debtToRevenue == null ? '—' : `${(debtToRevenue * 100).toFixed(1)}%`}
          </div>
          <div className="stat-delta dim">
            {incomeDepositsMTD > 0
              ? <>debt service ÷ income deposits ({fmt(incomeDepositsMTD)})</>
              : 'no income deposits this month — denominator unavailable'}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * PAY-05: Payroll KPI strip. Closes the labor-cost gap from the
 * evaluation review. Three cards:
 *   1. Total payroll YTD (company cost) + run count
 *   2. Payroll MTD + QTD subtotal
 *   3. Payroll-to-revenue MTD — total_company_cost ÷ income deposits
 *      this month (same denominator approach as DebtKpiBar). Tinted
 *      green/amber/red against the sign-shop healthy band:
 *          < 30%  → green
 *          < 50%  → amber
 *          ≥ 50%  → red (or revenue is being mis-attributed)
 *
 * Hides itself entirely when Gusto isn't configured AND no historical
 * payroll runs exist, so the page doesn't show an empty card for a
 * Gusto-less business.
 */
export function PayrollKpiBar() {
  const [summary, setSummary] = useState(null)
  const [cashFlow, setCashFlow] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      gustoSummary().catch(() => null),
      fetchPersistedCashFlow().catch(() => null),
    ]).then(([s, c]) => {
      if (cancelled) return
      setSummary(s)
      setCashFlow(c || { months: [] })
    })
    return () => { cancelled = true }
  }, [])

  if (summary === null || cashFlow === null) return null
  const ytd = summary.year_to_date
  // Hide if no runs persisted at all.
  if (!ytd || !ytd.run_count) return null

  const ymd = summary.as_of || new Date().toISOString().slice(0, 10)
  const ym = ymd.slice(0, 7)
  const monthBucket = (cashFlow.months || []).find((m) => m.month === ym)
  const incomeDepositsMTD = Math.max(0, Number(monthBucket?.by_account?.income) || 0)
  const payrollMTD = Number(summary.month_to_date?.company_cost) || 0
  const payrollToRevenue = incomeDepositsMTD > 0 ? payrollMTD / incomeDepositsMTD : null

  let ratioColor = 'var(--text)'
  if (payrollToRevenue != null) {
    ratioColor = payrollToRevenue < 0.30 ? 'var(--accent)'
      : payrollToRevenue < 0.50 ? 'var(--accent3)'
      : 'var(--danger)'
  }

  return (
    <div className="card" style={{ marginTop: 16, borderLeft: '4px solid var(--accent)' }}>
      <div className="row between" style={{ marginBottom: 8 }}>
        <div>
          <div className="section-label" style={{ color: 'var(--accent)' }}>Payroll snapshot</div>
          <div className="dim" style={{ fontSize: 12 }}>
            Live from Gusto via /api/gusto/summary. Total company cost = gross + employer taxes (+ benefits) —
            the real labor cost, not just gross pay.
          </div>
        </div>
        <span className="dim mono" style={{ fontSize: 11 }}>as of {ymd}</span>
      </div>
      <div className="grid-3">
        <div className="card-sm" style={{ background: 'var(--bg3)' }}>
          <div className="stat-label">Total payroll YTD</div>
          <div className="stat-value">{fmt(ytd.company_cost)}</div>
          <div className="stat-delta dim">
            {ytd.run_count} run{ytd.run_count === 1 ? '' : 's'} · gross {fmt(ytd.gross_pay)} + er-tax {fmt(ytd.employer_taxes)}
          </div>
        </div>
        <div className="card-sm" style={{ background: 'var(--bg3)' }}>
          <div className="stat-label">Payroll MTD</div>
          <div className="stat-value">{fmt(payrollMTD)}</div>
          <div className="stat-delta dim">
            {summary.month_to_date?.run_count || 0} run{summary.month_to_date?.run_count === 1 ? '' : 's'}
            {summary.quarter_to_date && (
              <> · QTD {fmt(summary.quarter_to_date.company_cost)}</>
            )}
          </div>
        </div>
        <div className="card-sm" style={{ background: 'var(--bg3)' }}>
          <div className="stat-label">Payroll-to-revenue MTD</div>
          <div className="stat-value" style={{ color: ratioColor }}>
            {payrollToRevenue == null ? '—' : `${(payrollToRevenue * 100).toFixed(1)}%`}
          </div>
          <div className="stat-delta dim">
            {incomeDepositsMTD > 0
              ? <>payroll ÷ income deposits ({fmt(incomeDepositsMTD)})</>
              : 'no income deposits this month — denominator unavailable'}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function EvaluationCharts({ theme = 'light' }) {
  const p = getPalette(theme)
  return (
    <>
      {/* Headline: cross-source revenue check goes FIRST, full-width — this
          is the primary reconciliation lens. If Corebridge, QBO, and the
          Income (7068) bank account disagree for the same month, that
          month's the one to investigate. */}
      <div style={{ marginTop: 16 }}>
        <CrossSourceChart p={p} />
      </div>
      <CrossSourceTable p={p} />
      {/* Supporting charts continue below. */}
      <div className="grid-2" style={{ marginTop: 16, gap: 16 }}>
        <BankBalanceChart p={p} />
        <NetCashFlowChart p={p} />
        <PipelineFunnelChart p={p} />
        <ARAgingChart p={p} />
        <WeeklyOrdersChart p={p} />
      </div>
    </>
  )
}
