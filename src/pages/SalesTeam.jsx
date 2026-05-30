import { Fragment, useEffect, useState } from 'react'
import { fmt } from '../utils/format'
import { corebridgePipeline, periodRange } from '../utils/corebridge'
import {
  availableMonths,
  aggregateByMonthAndSalesperson,
  loadCommissionRates,
  saveCommissionRates,
  computeCommissions,
  rowsForSalesperson,
} from '../utils/salesTeam'

const inputStyle = {
  background: 'var(--bg3)',
  color: 'var(--text)',
  border: '1px solid var(--border2)',
  borderRadius: 'var(--r-sm)',
  padding: '4px 6px',
  font: 'inherit',
  fontSize: 13,
  width: 70,
  textAlign: 'right',
}

const selectStyle = {
  background: 'var(--bg3)',
  color: 'var(--text)',
  border: '1px solid var(--border2)',
  borderRadius: 'var(--r-sm)',
  padding: '4px 8px',
  font: 'inherit',
  fontSize: 12,
}

const dateInputStyle = {
  background: 'var(--bg3)',
  color: 'var(--text)',
  border: '1px solid var(--border2)',
  borderRadius: 'var(--r-sm)',
  padding: '4px 6px',
  font: 'inherit',
  fontSize: 12,
}

/** 'YYYY-MM' → "May 2026" */
function monthLabel(m) {
  if (!m) return '—'
  const [y, mo] = m.split('-').map(Number)
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// Persisted date-range preference. 'ytd' / 'qtd' / 'mtd' / 'custom'.
const RANGE_PREF_KEY = 'bizcore.salesTeam.range'
const RANGE_CUSTOM_START = 'bizcore.salesTeam.customStart'
const RANGE_CUSTOM_END   = 'bizcore.salesTeam.customEnd'

function loadRangePref() {
  try { return localStorage.getItem(RANGE_PREF_KEY) || 'ytd' } catch { return 'ytd' }
}
function saveRangePref(v) {
  try { localStorage.setItem(RANGE_PREF_KEY, v) } catch {}
}

export default function SalesTeam() {
  // SALES-01: data now comes from /api/corebridge/pipeline, not
  // localStorage. The date range selector below drives the fetch.
  const [range, setRange] = useState(loadRangePref)
  const [customStart, setCustomStart] = useState(() => {
    try { return localStorage.getItem(RANGE_CUSTOM_START) || periodRange('year').start } catch { return periodRange('year').start }
  })
  const [customEnd, setCustomEnd] = useState(() => {
    try { return localStorage.getItem(RANGE_CUSTOM_END) || periodRange('year').end } catch { return periodRange('year').end }
  })
  const [buckets, setBuckets] = useState(null) // null = loading
  const [meta, setMeta] = useState({ start: '', end: '', diagnostics: null })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [rates, setRates] = useState(() => loadCommissionRates())
  const [basis, setBasis] = useState('paid')
  const [selectedMonth, setSelectedMonth] = useState(null)
  const [expanded, setExpanded] = useState(null)

  // Compute the effective { start, end } from the range pref.
  function resolveRange() {
    if (range === 'mtd')     return periodRange('month')
    if (range === 'qtd')     return periodRange('quarter')
    if (range === 'ytd')     return periodRange('year')
    return { start: customStart, end: customEnd }
  }

  // Fetch on mount + whenever range (or custom dates while in custom
  // mode) changes. Errors surface inline rather than alerting.
  useEffect(() => {
    let cancelled = false
    const { start, end } = resolveRange()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
      setError('Invalid date range — make sure end is on or after start')
      return
    }
    setLoading(true)
    setError('')
    corebridgePipeline(start, end)
      .then((res) => {
        if (cancelled) return
        setBuckets(res.buckets || {})
        setMeta({ start: res.start, end: res.end, diagnostics: res.diagnostics || null })
        // Re-pick the latest month inside the new range.
        const months = availableMonths(res.buckets || {})
        setSelectedMonth(months[0] || null)
        setExpanded(null)
      })
      .catch((err) => {
        if (cancelled) return
        setBuckets({})
        setError(err.message || String(err))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [range, customStart, customEnd]) // eslint-disable-line react-hooks/exhaustive-deps

  function updateRange(next) {
    setRange(next)
    saveRangePref(next)
  }
  function updateCustomStart(v) {
    setCustomStart(v)
    try { localStorage.setItem(RANGE_CUSTOM_START, v) } catch {}
  }
  function updateCustomEnd(v) {
    setCustomEnd(v)
    try { localStorage.setItem(RANGE_CUSTOM_END, v) } catch {}
  }

  function updateRate(repName, value) {
    const num = Number(value)
    const rate = Number.isFinite(num) && num >= 0 ? num / 100 : 0
    const next = { ...rates, [repName]: rate }
    setRates(next)
    saveCommissionRates(next)
  }

  // Derived from buckets — recompute when buckets change.
  const byMonth = buckets ? aggregateByMonthAndSalesperson(buckets) : {}
  const months = buckets ? availableMonths(buckets) : []
  const basisLabel = basis === 'paid' ? 'Paid sales' : 'Completed sales'

  // Per-month commission totals, used by the monthly overview table.
  function monthTotals(m) {
    const reps = byMonth[m] || []
    let earned = 0, wip = 0, newT = 0, comp = 0, paid = 0, wipT = 0
    for (const rep of reps) {
      const c = computeCommissions(rep, rates[rep.name], basis)
      earned += c.earned
      wip += c.wip
      newT += rep.newTotal
      comp += rep.completedTotal
      paid += rep.paidTotal
      wipT += rep.wipTotal
    }
    return { earned, wip, total: earned + wip, newT, comp, paid, wipT }
  }

  const hasData = months.length > 0
  const reps = byMonth[selectedMonth] || []
  const repComm = reps.map((r) => computeCommissions(r, rates[r.name], basis))
  const monthEarned = repComm.reduce((s, c) => s + c.earned, 0)
  const monthWip = repComm.reduce((s, c) => s + c.wip, 0)
  const monthOwed = monthEarned + monthWip
  const monthPaid = reps.reduce((s, r) => s + r.paidTotal, 0)
  const monthCompleted = reps.reduce((s, r) => s + r.completedTotal, 0)
  const monthWipRev = reps.reduce((s, r) => s + r.wipTotal, 0)
  const monthNew = reps.reduce((s, r) => s + r.newTotal, 0)

  // Grand totals across every month in the current range, for the
  // overview footer.
  const grand = months.reduce((acc, m) => {
    const t = monthTotals(m)
    acc.earned += t.earned; acc.wip += t.wip; acc.total += t.total
    acc.newT += t.newT; acc.comp += t.comp; acc.paid += t.paid; acc.wipT += t.wipT
    return acc
  }, { earned: 0, wip: 0, total: 0, newT: 0, comp: 0, paid: 0, wipT: 0 })

  const rangeLabel = {
    mtd: 'This month', qtd: 'This quarter', ytd: 'Year to date', custom: 'Custom',
  }[range] || 'Year to date'

  return (
    <div>
      <h1 className="page-title">Sales Team &amp; Commissions</h1>
      <p className="page-subtitle">
        Commission liability broken down by month, live from the Corebridge Pipeline.
        &ldquo;Earned&rdquo; is commission on realised revenue; &ldquo;Potential on WIP&rdquo; is what you&apos;d
        also owe once open work-in-progress closes at the current rates.
      </p>

      {/* ---- SALES-01: date range selector ---- */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="dim" style={{ fontSize: 12, marginRight: 4 }}>Range:</span>
            {[
              { k: 'mtd', label: 'This month' },
              { k: 'qtd', label: 'This quarter' },
              { k: 'ytd', label: 'Year to date' },
              { k: 'custom', label: 'Custom…' },
            ].map((opt) => (
              <button
                key={opt.k}
                className={range === opt.k ? 'btn-primary' : 'btn-outline'}
                onClick={() => updateRange(opt.k)}
                style={{ fontSize: 12, padding: '4px 10px' }}
              >
                {opt.label}
              </button>
            ))}
            {range === 'custom' && (
              <>
                <input type="date" value={customStart} onChange={(e) => updateCustomStart(e.target.value)} style={dateInputStyle} />
                <span className="dim" style={{ fontSize: 12 }}>→</span>
                <input type="date" value={customEnd}   onChange={(e) => updateCustomEnd(e.target.value)}   style={dateInputStyle} />
              </>
            )}
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="dim" style={{ fontSize: 12 }}>Earned basis:</span>
            <select value={basis} onChange={(e) => setBasis(e.target.value)} style={selectStyle}>
              <option value="paid">Paid sales (Closed)</option>
              <option value="completed">Completed sales</option>
            </select>
            {loading && <span className="dim" style={{ fontSize: 12 }}>Fetching from Corebridge…</span>}
          </div>
        </div>
        <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
          {meta.start && meta.end
            ? <>Showing <strong>{rangeLabel}</strong>: {meta.start} → {meta.end}.</>
            : <>Fetching range…</>}
        </div>
        {error && (
          <div style={{ marginTop: 8 }}>
            <span className="pill red">Error</span>
            <span style={{ marginLeft: 8, fontSize: 12 }}>{error}</span>
          </div>
        )}
      </div>

      {buckets === null ? (
        <div className="card"><div className="dim" style={{ fontSize: 12 }}>Loading…</div></div>
      ) : !hasData ? (
        <div className="card">
          <div className="section-label">No dated salesperson activity in this range</div>
          <p className="dim" style={{ marginTop: 8 }}>
            {error
              ? 'Couldn\'t reach Corebridge. Check the COREBRIDGE_API_TAG env var on the server.'
              : 'Try a wider range, or check the Pipeline page to confirm orders are syncing.'}
          </p>
        </div>
      ) : (
        <>
          {/* ---- Monthly overview ---- */}
          <div className="card">
            <div className="row between" style={{ marginBottom: 12 }}>
              <div>
                <div className="section-label">Commission by month</div>
                <div className="dim" style={{ fontSize: 12 }}>
                  Click a month to see its per-salesperson breakdown below.
                </div>
              </div>
            </div>

            {/* SALES-01 (2): inline guard against the obvious additive
                misread. The four bucket-dollar columns each tell their
                own story but DO share orders — a single sale appears in
                Newly Created (when opened), Completed (when finished),
                AND Paid (when invoiced). Adding the columns across a
                row inflates by 2-3x. */}
            <div
              className="dim"
              style={{
                fontSize: 11,
                marginBottom: 8,
                padding: '6px 10px',
                background: 'var(--bg3)',
                borderLeft: '3px solid var(--accent3)',
                borderRadius: 'var(--r-sm)',
              }}
            >
              <strong>Heads up:</strong> the four bucket columns share orders — a single sale appears in
              Newly Created when opened, Completed when delivered, AND Paid when invoiced. <em>Do not sum the
              columns across a row</em> — you'll triple-count. The commission math correctly uses Paid (or
              Completed) only.
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th className="num">New $</th>
                  <th className="num">Completed $</th>
                  <th className="num">Paid $</th>
                  <th className="num">WIP $</th>
                  <th className="num">Earned</th>
                  <th className="num">Potential (WIP)</th>
                  <th className="num">Total owed</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => {
                  const t = monthTotals(m)
                  const isSel = m === selectedMonth
                  return (
                    <tr
                      key={m}
                      onClick={() => { setSelectedMonth(m); setExpanded(null) }}
                      style={{
                        cursor: 'pointer',
                        background: isSel ? 'var(--bg3)' : undefined,
                      }}
                    >
                      <td style={{ fontWeight: isSel ? 600 : 400 }}>
                        {isSel ? '▸ ' : ''}{monthLabel(m)}
                      </td>
                      <td className="num">{fmt(t.newT)}</td>
                      <td className="num">{fmt(t.comp)}</td>
                      <td className="num">{fmt(t.paid)}</td>
                      <td className="num">{fmt(t.wipT)}</td>
                      <td className="num" style={{ color: 'var(--accent)' }}>{fmt(t.earned)}</td>
                      <td className="num" style={{ color: 'var(--accent2)' }}>{fmt(t.wip)}</td>
                      <td className="num" style={{ color: 'var(--accent3)', fontWeight: 600 }}>{fmt(t.total)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border2)' }}>
                  <td>{rangeLabel} total</td>
                  <td className="num">{fmt(grand.newT)}</td>
                  <td className="num">{fmt(grand.comp)}</td>
                  <td className="num">{fmt(grand.paid)}</td>
                  <td className="num">{fmt(grand.wipT)}</td>
                  <td className="num" style={{ color: 'var(--accent)' }}>{fmt(grand.earned)}</td>
                  <td className="num" style={{ color: 'var(--accent2)' }}>{fmt(grand.wip)}</td>
                  <td className="num" style={{ color: 'var(--accent3)' }}>{fmt(grand.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* ---- Selected-month headline ---- */}
          <div className="grid-4" style={{ marginTop: 16 }}>
            <div className="card">
              <div className="stat-label">{monthLabel(selectedMonth)} — commission owed</div>
              <div className="stat-value" style={{ color: 'var(--accent3)' }}>{fmt(monthOwed)}</div>
              <div className="stat-delta dim">earned + potential on open WIP</div>
            </div>
            <div className="card">
              <div className="stat-label">Earned (payable)</div>
              <div className="stat-value" style={{ color: 'var(--accent)' }}>{fmt(monthEarned)}</div>
              <div className="stat-delta dim">on {basisLabel} · {fmt(basis === 'paid' ? monthPaid : monthCompleted)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Potential on open WIP</div>
              <div className="stat-value" style={{ color: 'var(--accent2)' }}>{fmt(monthWip)}</div>
              <div className="stat-delta dim">if {fmt(monthWipRev)} of WIP closes</div>
            </div>
            <div className="card">
              <div className="stat-label">Top performer ({basisLabel.toLowerCase()})</div>
              <div className="stat-value" style={{ fontSize: 18 }}>{reps[0]?.name || '—'}</div>
              <div className="stat-delta dim">
                {reps[0] ? fmt(basis === 'paid' ? reps[0].paidTotal : reps[0].completedTotal) : ''}
              </div>
            </div>
          </div>

          {/* ---- Selected-month per-salesperson detail ---- */}
          <div className="card" style={{ marginTop: 16 }}>
            <div className="row between" style={{ marginBottom: 12 }}>
              <div>
                <div className="section-label">{monthLabel(selectedMonth)} — by salesperson</div>
                <div className="dim" style={{ fontSize: 12 }}>
                  Edit each rep&apos;s commission rate inline (saved locally, applies to all months).
                </div>
              </div>
              <select
                value={selectedMonth || ''}
                onChange={(e) => { setSelectedMonth(e.target.value); setExpanded(null) }}
                style={selectStyle}
              >
                {months.map((m) => (
                  <option key={m} value={m}>{monthLabel(m)}</option>
                ))}
              </select>
            </div>

            {reps.length === 0 ? (
              <p className="dim">No salesperson activity dated in {monthLabel(selectedMonth)}.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Salesperson</th>
                    <th className="num">New $</th>
                    <th className="num">Completed $</th>
                    <th className="num">Paid $</th>
                    <th className="num">WIP $</th>
                    <th className="num">Rate</th>
                    <th className="num">Earned</th>
                    <th className="num">Potential (WIP)</th>
                    <th className="num">Total owed</th>
                  </tr>
                </thead>
                <tbody>
                  {reps.map((rep) => {
                    const rate = rates[rep.name] || 0
                    const c = computeCommissions(rep, rate, basis)
                    const isOpen = expanded === rep.name
                    return (
                      <Fragment key={rep.name}>
                        <tr>
                          <td>
                            <button
                              onClick={() => setExpanded(isOpen ? null : rep.name)}
                              style={{
                                background: 'transparent',
                                border: 0,
                                color: 'var(--text)',
                                font: 'inherit',
                                cursor: 'pointer',
                                padding: 0,
                                textAlign: 'left',
                              }}
                            >
                              {isOpen ? '▾' : '▸'} {rep.name}
                            </button>
                          </td>
                          <td className="num">
                            {fmt(rep.newTotal)}
                            <div className="dim mono" style={{ fontSize: 10 }}>{rep.newCount} orders</div>
                          </td>
                          <td className="num">
                            {fmt(rep.completedTotal)}
                            <div className="dim mono" style={{ fontSize: 10 }}>{rep.completedCount} orders</div>
                          </td>
                          <td className="num">
                            {fmt(rep.paidTotal)}
                            <div className="dim mono" style={{ fontSize: 10 }}>{rep.paidCount} orders</div>
                          </td>
                          <td className="num">
                            {fmt(rep.wipTotal)}
                            <div className="dim mono" style={{ fontSize: 10 }}>{rep.wipCount} orders</div>
                          </td>
                          <td className="num">
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              value={Number(((rate || 0) * 100).toFixed(2))}
                              onChange={(e) => updateRate(rep.name, e.target.value)}
                              style={inputStyle}
                            />
                            <span className="dim" style={{ marginLeft: 4 }}>%</span>
                          </td>
                          <td className="num" style={{ color: 'var(--accent)' }}>{fmt(c.earned)}</td>
                          <td className="num" style={{ color: 'var(--accent2)' }}>{fmt(c.wip)}</td>
                          <td className="num" style={{ color: 'var(--accent3)', fontWeight: 600 }}>{fmt(c.total)}</td>
                        </tr>
                        {isOpen && <RepDetailRow buckets={buckets} rep={rep} month={selectedMonth} />}
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border2)' }}>
                    <td>Total</td>
                    <td className="num">{fmt(monthNew)}</td>
                    <td className="num">{fmt(monthCompleted)}</td>
                    <td className="num">{fmt(monthPaid)}</td>
                    <td className="num">{fmt(monthWipRev)}</td>
                    <td className="num dim">—</td>
                    <td className="num" style={{ color: 'var(--accent)' }}>{fmt(monthEarned)}</td>
                    <td className="num" style={{ color: 'var(--accent2)' }}>{fmt(monthWip)}</td>
                    <td className="num" style={{ color: 'var(--accent3)' }}>{fmt(monthOwed)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function RepDetailRow({ buckets, rep, month }) {
  const rows = rowsForSalesperson(buckets, rep.name, month)
  const bucketLabels = {
    newlyCreated: 'Newly Created',
    completedSales: 'Completed',
    closedSales: 'Paid',
    wip: 'WIP',
  }
  return (
    <tr>
      <td colSpan={9} style={{ background: 'var(--bg3)' }}>
        <div style={{ padding: 8 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>{rep.name} — orders by bucket</div>
          <div className="grid-2" style={{ gap: 12 }}>
            {Object.entries(bucketLabels).map(([key, label]) => {
              const list = rows[key] || []
              if (list.length === 0) return null
              const top = list.slice().sort((a, b) => b.amount - a.amount).slice(0, 10)
              return (
                <div key={key} className="card-sm" style={{ background: 'var(--bg2)' }}>
                  <div className="section-label" style={{ marginBottom: 6 }}>{label} ({list.length})</div>
                  <table className="data-table" style={{ fontSize: 12 }}>
                    <tbody>
                      {top.map((r, i) => (
                        <tr key={i}>
                          <td className="mono dim">{r.reference || '—'}</td>
                          <td>{r.customer || '—'}</td>
                          <td className="num">{fmt(r.amount)}</td>
                        </tr>
                      ))}
                      {list.length > 10 && (
                        <tr><td colSpan={3} className="dim" style={{ fontSize: 11 }}>… {list.length - 10} more</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>
        </div>
      </td>
    </tr>
  )
}
