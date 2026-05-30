import { useEffect, useState } from 'react'
import { fmt } from '../utils/format'
import { fetchPersistedAccounts, fetchPersistedCashFlow } from '../utils/persistedBank'
import { debtsSummary } from '../utils/debts'
import { gustoSummary } from '../utils/payroll'
import { gustoStatus } from '../utils/payroll'
import { corebridgePipeline, periodRange } from '../utils/corebridge'
import { extractVerdict } from '../utils/evaluation'

/**
 * Dashboard — the "first thing the owner sees in the morning" snapshot.
 *
 * DASH-01 (2026-05-23): full rewrite to use the trinity APIs directly.
 * The old Dashboard read bizcore.document (QuickBooks workbook) and
 * bizcore.weekly (Weekly Log) from localStorage — both were stripped
 * out, so the old cards rendered permanently empty. The new page
 * reads:
 *
 *   - /api/banksync/persisted/accounts  → total bank cash, reconciled count
 *   - /api/banksync/persisted/cash-flow → MTD net cash flow, income deposits
 *   - /api/gusto/summary                → MTD payroll, payroll-to-revenue
 *   - /api/debts/summary                → outstanding debt, debt service MTD
 *   - /api/corebridge/pipeline          → live this-month pipeline buckets
 *   - bizcore.evaluation.latest (LS)    → last AI verdict for the hero
 *
 * Layout (vertical):
 *   1. Verdict hero (if an AI eval exists — otherwise a CTA)
 *   2. KPI strip (bank cash · MTD net flow · payroll MTD · debt outstanding)
 *   3. Pipeline this month (Corebridge buckets, live)
 *   4. Connection health row (Bank · Payroll · Corebridge)
 *
 * Removed from the old Dashboard:
 *   - Upload Reminders panel (manual uploads are gone — Bank syncs
 *     live, Payroll has a Gusto path)
 *   - Balance Sheet Snapshot card (sourced from QB workbook which
 *     no longer exists)
 *   - Setup Checklist (Settings page covers connection setup now)
 *   - Last-week new orders / WIP cards (from the Weekly Log)
 */

const VERDICT_META = {
  STRONG:        { color: 'var(--accent)',  gloss: 'The business is in good shape.' },
  STABLE:        { color: 'var(--accent2)', gloss: 'Holding steady — nothing on fire.' },
  MIXED:         { color: 'var(--accent3)', gloss: 'Bright spots and real concerns both.' },
  DETERIORATING: { color: 'var(--danger)',  gloss: 'Trending the wrong way — act now.' },
  WEAK:          { color: 'var(--danger)',  gloss: 'Needs attention soon.' },
}

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export default function Dashboard() {
  // null = still loading, {} = loaded (maybe empty), Error = failed
  const [bank, setBank]       = useState(null)
  const [cashFlow, setCash]   = useState(null)
  const [debts, setDebts]     = useState(null)
  const [payroll, setPayroll] = useState(null)
  const [payrollOk, setPayrollOk] = useState(null) // gustoStatus().configured (or persisted_runs)
  const [pipeline, setPipeline]   = useState(null)
  const [pipelineErr, setPipelineErr] = useState(null)
  const [analysis] = useState(() => loadJSON('bizcore.evaluation.latest'))

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchPersistedAccounts().catch(() => []),
      fetchPersistedCashFlow().catch(() => ({ months: [] })),
      debtsSummary().catch(() => null),
      gustoSummary().catch(() => null),
      gustoStatus().catch(() => ({ configured: false })),
    ]).then(([accts, cf, d, p, ps]) => {
      if (cancelled) return
      setBank(accts)
      setCash(cf)
      setDebts(d)
      setPayroll(p)
      setPayrollOk(ps)
    })

    // Pipeline is a separate, slower call (hits Corebridge live).
    // Fire it in parallel so the rest of the page renders fast.
    const { start, end } = periodRange('month')
    corebridgePipeline(start, end)
      .then((res) => { if (!cancelled) setPipeline(res) })
      .catch((err) => { if (!cancelled) { setPipeline({ buckets: {} }); setPipelineErr(err.message) } })
    return () => { cancelled = true }
  }, [])

  const loading = bank === null

  // ---- Headline numbers ----
  const totalBankCash = (bank || [])
    .filter((a) => a.pf_key && a.pf_key !== 'amex' && a.last_balance != null)
    .reduce((s, a) => s + Number(a.last_balance || 0), 0)
  const accountsConfigured = (bank || []).length
  const reconciledCount = (bank || [])
    .filter((a) => a.last_reconciled_at && Math.abs(a.last_reconcile_gap || 0) <= 1)
    .length

  const today = new Date().toISOString().slice(0, 10)
  const ym = today.slice(0, 7)
  const monthBucket = (cashFlow?.months || []).find((m) => m.month === ym)
  const monthNet = Number(monthBucket?.net || 0)
  const monthIncomeDeposits = Number(monthBucket?.by_account?.income || 0)

  const payrollMTD = Number(payroll?.month_to_date?.company_cost || 0)
  const payrollRatio = monthIncomeDeposits > 0 ? payrollMTD / monthIncomeDeposits : null
  let payrollRatioColor = 'var(--text)'
  if (payrollRatio != null) {
    payrollRatioColor = payrollRatio < 0.30 ? 'var(--accent)'
      : payrollRatio < 0.50 ? 'var(--accent3)'
      : 'var(--danger)'
  }

  const debtOutstanding = Number(debts?.total_outstanding || 0)
  const debtServiceMTD = Number(debts?.month_to_date?.debt_service || 0)

  // ---- Verdict freshness ----
  const verdict = analysis ? extractVerdict(analysis.result) : null
  const vMeta = (verdict && VERDICT_META[verdict]) || null
  const verdictAgeDays = analysis?.timestamp
    ? Math.floor((Date.now() - new Date(analysis.timestamp).getTime()) / 86400e3)
    : null
  const verdictStale = verdictAgeDays != null && verdictAgeDays >= 7

  // ---- Pipeline (this month) ----
  const buckets = pipeline?.buckets || {}
  const pipelineRows = [
    { key: 'newlyCreated',   label: 'Newly Created' },
    { key: 'completedSales', label: 'Completed' },
    { key: 'closedSales',    label: 'Paid' },
    { key: 'wip',            label: 'WIP' },
  ]

  // ---- Connection health ----
  const bankHealthy = accountsConfigured > 0 && reconciledCount === accountsConfigured
  const bankPartial = accountsConfigured > 0 && reconciledCount > 0 && reconciledCount < accountsConfigured
  const payrollHealthy = !!payrollOk?.configured || (payroll?.year_to_date?.run_count || 0) > 0
  const corebridgeHealthy = !!pipeline && !pipelineErr

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-subtitle">
        Where the business stands right now. Bank, payroll, debt and pipeline pulled live; AI verdict comes
        from the most recent Evaluation run.
      </p>

      {/* ---- Verdict hero ---- */}
      {analysis ? (
        <div className="card" style={{ marginTop: 16, borderLeft: `5px solid ${vMeta?.color || 'var(--accent2)'}` }}>
          <div className="row between" style={{ alignItems: 'flex-start', gap: 12 }}>
            <div>
              <div className="dim" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>
                Latest AI verdict {verdictStale && <span className="pill yellow" style={{ marginLeft: 6, fontSize: 10 }}>stale</span>}
              </div>
              {verdict ? (
                <div style={{ fontFamily: 'var(--font-display, serif)', fontSize: 36, color: vMeta?.color || 'var(--text)', lineHeight: 1.1 }}>
                  {verdict}
                </div>
              ) : (
                <div style={{ fontFamily: 'var(--font-display, serif)', fontSize: 22 }}>(verdict not parsed)</div>
              )}
              {vMeta?.gloss && (
                <div className="dim" style={{ fontSize: 13, marginTop: 4 }}>{vMeta.gloss}</div>
              )}
            </div>
            <div className="dim" style={{ fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {analysis.timestamp?.slice(0, 10)}<br />
              {verdictAgeDays === 0 ? 'today' : verdictAgeDays === 1 ? 'yesterday' : `${verdictAgeDays} days ago`}
              <br />{analysis.sourceCount || '?'} sources
            </div>
          </div>
          <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>
            Open the <strong>Evaluation</strong> page for the full breakdown and to re-run with current data.
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginTop: 16, borderLeft: '5px solid var(--accent2)' }}>
          <div className="section-label">No AI evaluation yet</div>
          <div className="dim" style={{ fontSize: 13, marginTop: 6 }}>
            Run your first evaluation on the <strong>Evaluation</strong> page — it reads from every connected
            source and gives you a one-word verdict plus a prioritized action list.
          </div>
        </div>
      )}

      {/* ---- KPI strip ---- */}
      <div className="grid-4" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="stat-label">Bank cash (today)</div>
          <div className="stat-value">{loading ? <span className="dim">…</span> : fmt(totalBankCash)}</div>
          <div className="stat-delta dim">
            {accountsConfigured === 0
              ? 'no accounts connected'
              : `${reconciledCount} / ${accountsConfigured} reconciled`}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Net cash flow MTD</div>
          <div className="stat-value" style={{ color: monthNet >= 0 ? 'var(--accent)' : 'var(--danger)' }}>
            {monthBucket ? fmt(monthNet) : <span className="dim">—</span>}
          </div>
          <div className="stat-delta dim">
            {monthBucket
              ? `${monthBucket.count} non-transfer tx · income deposits ${fmt(monthIncomeDeposits)}`
              : 'no transactions this month'}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Payroll MTD</div>
          <div className="stat-value">
            {payroll?.month_to_date?.run_count
              ? fmt(payrollMTD)
              : <span className="dim">—</span>}
          </div>
          <div className="stat-delta dim" style={{ color: payrollRatioColor }}>
            {payrollRatio != null
              ? `${(payrollRatio * 100).toFixed(1)}% of income deposits`
              : payrollHealthy ? 'no income deposits this month'
              : 'no payroll source configured'}
          </div>
        </div>
        <div className="card">
          <div className="stat-label">Outstanding debt</div>
          <div className="stat-value">
            {debts && debts.active_debts_count > 0
              ? fmt(debtOutstanding)
              : <span className="dim">—</span>}
          </div>
          <div className="stat-delta dim">
            {debts && debts.active_debts_count > 0
              ? `${debts.active_debts_count} active · ${fmt(debtServiceMTD)} paid MTD`
              : 'no debts entered (Debts page)'}
          </div>
        </div>
      </div>

      {/* ---- Pipeline this month ---- */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <div>
            <div className="section-label">Pipeline this month (Corebridge — live)</div>
            <div className="dim" style={{ fontSize: 12 }}>
              {pipeline?.start && pipeline?.end
                ? `${pipeline.start} → ${pipeline.end}`
                : pipelineErr
                  ? `Couldn't reach Corebridge: ${pipelineErr}`
                  : 'fetching…'}
            </div>
          </div>
        </div>
        {pipeline?.buckets && Object.keys(pipeline.buckets).length > 0 ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Bucket</th>
                <th className="num">Total</th>
                <th className="num">Records</th>
              </tr>
            </thead>
            <tbody>
              {pipelineRows.map((row) => {
                const b = buckets[row.key]
                return (
                  <tr key={row.key}>
                    <td>{row.label}</td>
                    <td className="num mono">{b ? fmt(b.total) : <span className="dim">—</span>}</td>
                    <td className="num dim">{b ? b.count : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="dim" style={{ fontSize: 12 }}>
            {pipelineErr
              ? 'Configure COREBRIDGE_API_TAG on the server, or check the Pipeline page for details.'
              : 'No pipeline data yet.'}
          </div>
        )}
      </div>

      {/* ---- Connection health ---- */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-label">Connection health</div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
          The three connections that drive the business snapshot. Fix any red ones on the Settings page.
        </div>
        <div className="grid-3">
          <ConnectionRow
            label="Corebridge"
            color="var(--accent3)"
            healthy={corebridgeHealthy}
            healthyMsg={`live · ${pipeline?.buckets?.closedSales?.count || 0} paid sales this month`}
            problemMsg={pipelineErr || 'no response from /api/corebridge/pipeline'}
          />
          <ConnectionRow
            label="Bank (BankSync)"
            color="var(--accent2)"
            healthy={bankHealthy}
            partial={bankPartial}
            healthyMsg={accountsConfigured > 0
              ? `${reconciledCount} / ${accountsConfigured} accounts reconciled`
              : 'no accounts connected yet'}
            problemMsg={accountsConfigured === 0
              ? 'No bank accounts — run a backfill from the Finance page'
              : `${accountsConfigured - reconciledCount} account(s) failed last reconciliation`}
          />
          <ConnectionRow
            label="Payroll"
            color="var(--accent)"
            healthy={payrollHealthy}
            healthyMsg={
              payrollOk?.configured
                ? `Gusto live · ${payroll?.year_to_date?.run_count || 0} runs persisted`
                : `Manual upload · ${payroll?.year_to_date?.run_count || 0} runs persisted`
            }
            problemMsg="No payroll source — Gusto not configured and no manual upload yet"
          />
        </div>
      </div>
    </div>
  )
}

function ConnectionRow({ label, color, healthy, partial, healthyMsg, problemMsg }) {
  const state = healthy ? 'ok' : partial ? 'partial' : 'down'
  const pill = state === 'ok' ? 'green' : state === 'partial' ? 'yellow' : 'red'
  const stateLabel = state === 'ok' ? '✓ healthy' : state === 'partial' ? '⚠ partial' : '✗ down'
  return (
    <div className="card-sm" style={{ background: 'var(--bg3)', borderLeft: `3px solid ${color}` }}>
      <div className="row between" style={{ marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span className={`pill ${pill}`} style={{ fontSize: 10 }}>{stateLabel}</span>
      </div>
      <div className="dim" style={{ fontSize: 11 }}>
        {state === 'ok' || state === 'partial' ? healthyMsg : problemMsg}
      </div>
    </div>
  )
}
