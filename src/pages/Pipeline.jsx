import { useState } from 'react'
import { fmt } from '../utils/format'
import { callClaude } from '../utils/claude'
import { readSpreadsheet } from '../utils/spreadsheet'
import { parsePipelineCSV, buildPipelinePrompt, classifyPeriodSpan } from '../utils/pipeline'
import { corebridgePipelineMulti } from '../utils/corebridge'
import FreshnessBadge from '../components/FreshnessBadge'

/** Live-sync panel — one click pulls all four periods from a single
 *  Corebridge snapshot, so the period matrix is mathematically
 *  consistent (week ⊆ month ⊆ year for every bucket). PIPE-02. */
function CorebridgeSyncPanel({ onSyncAll, syncing, message, error }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div className="section-label">Sync from Corebridge</div>
          <div className="dim" style={{ fontSize: 12, maxWidth: 560 }}>
            One click fills Today / This Week / This Month / This Year columns from a single
            Corebridge snapshot — guaranteed-consistent math across all four. Accounts
            Receivable still uploads manually below.
          </div>
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <button className="btn-primary" onClick={onSyncAll} disabled={syncing}>
            {syncing ? 'Syncing all periods…' : 'Sync all periods'}
          </button>
        </div>
      </div>
      {message && <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>{message}</div>}
      {error && (
        <div style={{ marginTop: 8 }}>
          <span className="pill red">Error</span>
          <span style={{ marginLeft: 8, fontSize: 12 }}>{error}</span>
        </div>
      )}
    </div>
  )
}

const BUCKETS = [
  { key: 'newlyCreated', label: 'Newly Created Sales', hint: 'New orders/quotes opened this week.' },
  { key: 'completedSales', label: 'Completed Sales', hint: 'Jobs finished/delivered this week.' },
  { key: 'closedSales', label: 'Closed Sales (Paid)', hint: 'Invoices paid this week.' },
  { key: 'wip', label: 'Work In Progress', hint: 'Jobs currently in production.' },
  { key: 'arAging', label: 'Accounts Receivable', hint: 'Outstanding invoices grouped by aging bucket.' },
]

function loadBuckets() {
  const result = {}
  for (const b of BUCKETS) {
    try {
      const raw = localStorage.getItem(`bizcore.pipeline.${b.key}`)
      result[b.key] = raw ? JSON.parse(raw) : []
    } catch { result[b.key] = [] }
  }
  return result
}

function persistBucket(key, snapshots) {
  try { localStorage.setItem(`bizcore.pipeline.${key}`, JSON.stringify(snapshots)) } catch {}
}

// ---- Corebridge per-period store — keeps Week / Month / Year side by side ----
const CB_PERIODS = ['day', 'week', 'month', 'year']
const CB_PERIOD_LABELS = { day: 'Today', week: 'This Week', month: 'This Month', year: 'This Year' }
const CB_STORE_KEY = 'bizcore.pipeline.corebridge'
const CB_MATRIX_BUCKETS = [
  { key: 'newlyCreated', label: 'Newly Created' },
  { key: 'completedSales', label: 'Completed' },
  { key: 'closedSales', label: 'Closed (Paid)' },
  { key: 'wip', label: 'WIP' },
]

function loadCorebridgeStore() {
  try {
    const raw = localStorage.getItem(CB_STORE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function persistCorebridgeStore(store) {
  try { localStorage.setItem(CB_STORE_KEY, JSON.stringify(store)) } catch {}
}

// PIPE-04 / PIPE-06: per-bucket × per-period manual overrides. Mark
// types the value from the matching Corebridge PDF when he generates
// the report. The matrix prefers the override over the API-derived
// value. Cleared cell = falls back to API.
//
// Storage shape: { [bucketKey]: { [periodKey]: number } }
// e.g. { closedSales: { month: 149632.77 }, newlyCreated: { month: 64118.68 } }
//
// PIPE-06 (this version) migrates the legacy PIPE-04 flat shape
// ({ [periodKey]: number }, assumed closedSales) to the nested form
// on read. Only Closed (Paid) was overridable in PIPE-04, so the
// migration is unambiguous.
const CB_OVERRIDE_KEY = 'bizcore.pipeline.corebridge.overrides'
// Buckets that support manual override. WIP is a live snapshot from
// the API and matches reality — no override needed.
const CB_OVERRIDE_BUCKETS = new Set(['newlyCreated', 'completedSales', 'closedSales'])
function loadCorebridgeOverrides() {
  try {
    const raw = localStorage.getItem(CB_OVERRIDE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    // Detect legacy PIPE-04 shape: top-level keys are periods, values are numbers.
    const looksLikeLegacy = Object.keys(parsed).every(
      (k) => ['day', 'week', 'month', 'year'].includes(k) && typeof parsed[k] !== 'object'
    )
    if (looksLikeLegacy && Object.keys(parsed).length > 0) {
      const migrated = { closedSales: { ...parsed } }
      try { localStorage.setItem(CB_OVERRIDE_KEY, JSON.stringify(migrated)) } catch {}
      return migrated
    }
    return parsed
  } catch { return {} }
}
function persistCorebridgeOverrides(o) {
  try { localStorage.setItem(CB_OVERRIDE_KEY, JSON.stringify(o)) } catch {}
}

/**
 * Matrix of Corebridge buckets (rows) × periods (columns). Each sync fills its
 * own column, so the weekly, monthly and yearly numbers show at the same time.
 *
 * PIPE-04: Closed (Paid) row supports manual per-period override — the
 * Corebridge "Sales by Customer — Closed" PDF total goes in here when
 * the report doesn't match what the API returns. Other rows still
 * come from the API sync.
 */
function CorebridgeMatrix({ store, overrides, onOverrideChange }) {
  // Local input state so typing doesn't fire setState on every keystroke
  // and re-render the world. Commit on blur or Enter.
  // Keyed by `${bucketKey}|${periodKey}` so each cell has its own state.
  const [editing, setEditing] = useState({})

  function getOverride(bucketKey, periodKey) {
    return overrides?.[bucketKey]?.[periodKey]
  }

  function commitOverride(bucketKey, periodKey, raw) {
    const cleaned = String(raw || '').replace(/[$,\s]/g, '')
    const next = { ...overrides, [bucketKey]: { ...(overrides[bucketKey] || {}) } }
    if (!cleaned) {
      delete next[bucketKey][periodKey]
    } else {
      const v = parseFloat(cleaned)
      if (!isFinite(v)) {
        delete next[bucketKey][periodKey]
      } else {
        next[bucketKey][periodKey] = v
      }
    }
    if (Object.keys(next[bucketKey]).length === 0) delete next[bucketKey]
    onOverrideChange(next)
    const cellKey = `${bucketKey}|${periodKey}`
    setEditing((e) => { const n = { ...e }; delete n[cellKey]; return n })
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="section-label">Corebridge — by period</div>
      <div className="dim" style={{ fontSize: 12, marginBottom: 10 }}>
        Click "Sync all periods" above to refresh the API rows. <strong>Newly Created</strong>,&nbsp;
        <strong>Completed</strong>, and <strong>Closed (Paid)</strong> are manually overridable —
        type the total from the matching Corebridge "Sales by Customer" PDF when the API number
        doesn't match the report. WIP is API-only (it's a live snapshot).
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Bucket</th>
            {CB_PERIODS.map((p) => <th key={p} className="num">{CB_PERIOD_LABELS[p]}</th>)}
          </tr>
        </thead>
        <tbody>
          {CB_MATRIX_BUCKETS.map((b) => (
            <tr key={b.key}>
              <td>{b.label}</td>
              {CB_PERIODS.map((p) => {
                const cell = store[p]?.buckets?.[b.key]
                // PIPE-06: every row except WIP is overridable per period.
                if (CB_OVERRIDE_BUCKETS.has(b.key)) {
                  const override = getOverride(b.key, p)
                  const cellKey = `${b.key}|${p}`
                  const editingValue = editing[cellKey]
                  const displayValue = editingValue !== undefined
                    ? editingValue
                    : (override != null ? String(override) : '')
                  return (
                    <td key={p} className="num">
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder={cell ? fmt(cell.total).replace('$', '') : '0'}
                        value={displayValue}
                        onChange={(e) => setEditing((s) => ({ ...s, [cellKey]: e.target.value }))}
                        onBlur={(e) => commitOverride(b.key, p, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.target.blur()
                          if (e.key === 'Escape') {
                            setEditing((s) => { const n = { ...s }; delete n[cellKey]; return n })
                            e.target.blur()
                          }
                        }}
                        style={{
                          width: '90%', textAlign: 'right',
                          background: override != null ? 'var(--bg2)' : 'transparent',
                          color: 'var(--text)', border: '1px solid var(--border2)',
                          borderRadius: 'var(--r-sm)', padding: '4px 6px',
                          font: 'inherit', fontSize: 13,
                        }}
                      />
                      {override != null && (
                        <div style={{ fontSize: 9, color: 'var(--accent3)', marginTop: 2 }}>
                          from PDF
                        </div>
                      )}
                    </td>
                  )
                }
                return (
                  <td key={p} className="num">
                    {cell
                      ? <>{fmt(cell.total)} <span className="dim" style={{ fontSize: 11 }}>({cell.count})</span></>
                      : <span className="dim">—</span>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="dim" style={{ fontSize: 11 }}>Range synced</td>
            {CB_PERIODS.map((p) => (
              <td key={p} className="num dim" style={{ fontSize: 11 }}>
                {store[p] ? `${store[p].start} → ${store[p].end}` : 'not synced'}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

export default function Pipeline() {
  const [data, setData] = useState(loadBuckets)
  const [error, setError] = useState('')
  const [analysis, setAnalysis] = useState('')
  const [loading, setLoading] = useState(false)
  const [cbSyncing, setCbSyncing] = useState(false)
  const [cbMsg, setCbMsg] = useState('')
  const [cbError, setCbError] = useState('')
  const [cbStore, setCbStore] = useState(loadCorebridgeStore)
  // PIPE-04: manual overrides for the Closed (Paid) row, per period.
  const [cbOverrides, setCbOverrides] = useState(loadCorebridgeOverrides)
  function updateOverrides(next) {
    setCbOverrides(next)
    persistCorebridgeOverrides(next)
  }
  // PIPE-01: last server-side diagnostics block — surfaces which
  // Corebridge status strings were treated as "Paid" so we can spot a
  // status leaking into the wrong bucket (the original symptom).
  const [cbDiag, setCbDiag] = useState(null)

  function saveBucket(key, snapshots) {
    setData((prev) => ({ ...prev, [key]: snapshots }))
    persistBucket(key, snapshots)
  }

  // PIPE-02: atomic multi-period sync. One server call returns
  // today/week/month/year buckets computed from the same Corebridge
  // snapshot — so the period matrix is mathematically consistent
  // (week ≤ month ≤ year for every bucket). Replaces the prior
  // per-period sync model that allowed staggered syncs to produce
  // a week total larger than its enclosing month total.
  async function syncAllFromCorebridge() {
    setCbSyncing(true)
    setCbMsg('')
    setCbError('')
    try {
      const result = await corebridgePipelineMulti()
      const periods = result.periods || {}
      const syncedAt = result.syncedAt || new Date().toISOString()

      // Fill the per-period matrix store (all 4 columns from the same call)
      const nextStore = {}
      for (const kind of ['day', 'week', 'month', 'year']) {
        const p = periods[kind]
        if (!p) continue
        const periodBuckets = {}
        for (const key of ['newlyCreated', 'completedSales', 'closedSales', 'wip']) {
          const b = p.buckets?.[key]
          periodBuckets[key] = { total: b?.total || 0, count: b?.count || 0 }
        }
        nextStore[kind] = { syncedAt, start: p.start, end: p.end, buckets: periodBuckets }
      }
      setCbStore(() => {
        persistCorebridgeStore(nextStore)
        return nextStore
      })

      // Mirror the MONTH bucket's row-less totals into the legacy
      // bucket-card store so the cards below the matrix stay in
      // sync. (Row-level detail still comes from manual CSV uploads
      // or a single-range call.)
      const summary = []
      const monthPeriod = periods.month
      if (monthPeriod) {
        for (const key of ['newlyCreated', 'completedSales', 'closedSales', 'wip']) {
          const b = monthPeriod.buckets?.[key]
          if (!b) continue
          const snapshot = {
            uploadedAt: syncedAt,
            fileName: `Corebridge sync · ${monthPeriod.start} → ${monthPeriod.end}`,
            source: 'corebridge-api',
            weekOf: monthPeriod.start,
            period: { start: monthPeriod.start, end: monthPeriod.end, kind: 'range' },
            rows: [], // multi-period response is summary-only; no rows
            total: b.total || 0,
            count: b.count || 0,
          }
          const existing = (data[key] || []).filter((s) => s.source !== 'corebridge-api')
          saveBucket(key, [snapshot, ...existing].slice(0, 12))
          summary.push(`${BUCKETS.find((x) => x.key === key)?.label || key}: ${snapshot.count}`)
        }
      }
      setCbMsg(`Synced all periods at ${syncedAt.slice(11, 16)} — ${summary.join(' · ')}`)
      if (result.diagnostics) setCbDiag({ ...result.diagnostics, kind: 'all', start: periods.year?.start, end: periods.year?.end })
    } catch (err) {
      setCbError(err.message)
    } finally {
      setCbSyncing(false)
    }
  }

  async function handleImport(bucketKey, file) {
    if (!file) return
    setError('')
    try {
      const { text } = await readSpreadsheet(file)
      const parsed = parsePipelineCSV(text)
      const snapshot = {
        uploadedAt: new Date().toISOString(),
        fileName: file.name,
        weekOf: parsed.weekOf,
        period: parsed.period || null,
        rows: parsed.rows,
        total: parsed.total,
        count: parsed.rows.length,
      }
      // Keep up to 12 weeks of history (newest first)
      const existing = data[bucketKey] || []
      saveBucket(bucketKey, [snapshot, ...existing].slice(0, 12))
    } catch (err) {
      setError(`${bucketKey}: ${err.message}`)
    }
  }

  function clearBucket(key) {
    if (!window.confirm(`Clear all snapshots for ${BUCKETS.find((b) => b.key === key).label}?`)) return
    saveBucket(key, [])
  }

  async function runAnalysis() {
    const buckets = {}
    for (const b of BUCKETS) {
      const latest = data[b.key]?.[0]
      if (latest) buckets[b.label] = latest
    }
    if (Object.keys(buckets).length === 0) {
      setError('Upload at least one report before running AI analysis.')
      return
    }
    setLoading(true)
    setError('')
    setAnalysis('')
    try {
      const result = await callClaude(buildPipelinePrompt(buckets), { maxTokens: 1500 })
      setAnalysis(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const hasAnyData = BUCKETS.some((b) => (data[b.key] || []).length > 0)

  return (
    <div>
      <h1 className="page-title">Pipeline</h1>
      <p className="page-subtitle">
        Corebridge reports — Newly Created Sales, Completed Sales, Closed Sales (Paid), and WIP. The period of each upload is parsed from the file (YTD, monthly, weekly, or snapshot); compare across buckets with that in mind.
      </p>

      <CorebridgeSyncPanel
        onSyncAll={syncAllFromCorebridge}
        syncing={cbSyncing}
        message={cbMsg}
        error={cbError}
      />

      {/* PIPE-01 diagnostic disclosure — only shows after a sync. Lets
          you confirm exactly which Corebridge status strings hit the
          Paid bucket. If a status that isn't actually paid shows up
          here ("Invoiced", "Pending Payment", etc.), the regex in
          server.js needs another pass. */}
      {cbDiag && (
        <details className="card-sm" style={{ background: 'var(--bg3)', marginTop: -8, marginBottom: 16 }}>
          <summary className="dim" style={{ fontSize: 11, cursor: 'pointer' }}>
            Diagnostics — {cbDiag.kind} sync · {cbDiag.start} → {cbDiag.end}
          </summary>
          <div style={{ marginTop: 6, fontSize: 11 }}>
            <div>
              <span className="dim">Statuses Corebridge returned:</span>{' '}
              <span className="mono">{(cbDiag.statuses_seen || []).join(' · ') || '—'}</span>
            </div>
            <div style={{ marginTop: 4 }}>
              <span className="dim">Counted as <strong style={{ color: 'var(--accent3)' }}>Paid</strong>:</span>{' '}
              <span className="mono">{(cbDiag.paid_statuses_counted || []).join(' · ') || '—'}</span>
            </div>
            <div className="dim" style={{ marginTop: 4, fontSize: 10 }}>
              Source feed had {cbDiag.changed_feed_records} status-change records and {cbDiag.wip_feed_records} live-WIP records.
              The Paid bucket also requires DateCompleted inside the window — see PIPE-01 in server.js.
            </div>
          </div>
        </details>
      )}

      <CorebridgeMatrix
        store={cbStore}
        overrides={cbOverrides}
        onOverrideChange={updateOverrides}
      />

      <div className="grid-auto">
        {BUCKETS.map((b) => {
          const latest = data[b.key]?.[0]
          const prior = data[b.key]?.[1]
          const span = latest?.period ? classifyPeriodSpan(latest.period) : null
          const priorSpan = prior?.period ? classifyPeriodSpan(prior.period) : null
          // Only show delta if both uploads cover comparable spans
          const comparable = span && priorSpan && span === priorSpan
          const wow = (comparable && prior?.total)
            ? (latest.total - prior.total) / prior.total
            : null
          return (
            <div className="card" key={b.key}>
              <div className="stat-label">{b.label}</div>
              <div className="stat-value">{latest ? fmt(latest.total) : <span className="dim">—</span>}</div>
              <div className="stat-delta dim">
                {!latest && 'no report yet'}
                {latest && `${latest.count} records`}
                {latest?.period?.kind === 'range' && ` · ${latest.period.start} → ${latest.period.end}`}
                {latest?.period?.kind === 'snapshot' && ` · as of ${latest.period.start}`}
                {latest && !latest?.period && ` · uploaded ${latest.uploadedAt.slice(0, 10)}`}
              </div>
              {span && (
                <div className="stat-delta dim">
                  <span className="pill blue" style={{ fontSize: 10 }}>{span}</span>
                </div>
              )}
              {wow != null && (
                <div className={`stat-delta ${wow > 0 ? 'up' : wow < 0 ? 'down' : 'dim'}`}>
                  {wow > 0 ? '+' : ''}{(wow * 100).toFixed(1)}% vs prior {span}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {hasAnyData && (
        <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn-primary" onClick={runAnalysis} disabled={loading}>
            {loading ? 'Analyzing…' : 'Run Pipeline AI Analysis'}
          </button>
        </div>
      )}

      {error && (
        <div className="card" style={{ marginTop: 16, borderColor: 'var(--danger)' }}>
          <span className="pill red">Error</span>
          <span style={{ marginLeft: 8 }}>{error}</span>
        </div>
      )}

      {BUCKETS.map((b) => (
        <BucketSection
          key={b.key}
          bucket={b}
          snapshots={data[b.key] || []}
          onImport={(file) => handleImport(b.key, file)}
          onClear={() => clearBucket(b.key)}
        />
      ))}

      {analysis && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="section-label">AI Pipeline Analysis</div>
            <span className="source-badge corebridge">Claude · Sonnet 4.6</span>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-body)', margin: 0, fontSize: 14 }}>
            {analysis}
          </pre>
        </div>
      )}
    </div>
  )
}

function BucketSection({ bucket, snapshots, onImport, onClear }) {
  const latest = snapshots[0]
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <div className="section-label">{bucket.label}</div>
            <FreshnessBadge reminderKey={bucket.key} />
          </div>
          <div className="dim" style={{ fontSize: 12 }}>{bucket.hint}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <label className="btn-outline" style={{ cursor: 'pointer' }}>
            Upload report
            <input
              type="file"
              accept=".csv,.xlsx,.xls,.xlsm,text/csv"
              onChange={(e) => { onImport(e.target.files?.[0]); e.target.value = '' }}
              style={{ display: 'none' }}
            />
          </label>
          {latest && (
            <button className="btn-danger" onClick={onClear} title="Clear all snapshots for this bucket">
              Clear
            </button>
          )}
        </div>
      </div>

      {!latest ? (
        <p className="dim" style={{ marginTop: 8 }}>
          No report uploaded yet. Upload a CSV or Excel from Corebridge to track {bucket.label.toLowerCase()}.
        </p>
      ) : (
        <>
          <div style={{ marginBottom: 8, fontSize: 12 }}>
            <span className="dim">Latest: </span>
            <span className="mono">{latest.fileName}</span>
            <span className="dim"> · uploaded {latest.uploadedAt.slice(0, 10)}</span>
            {latest.period?.kind === 'range' && (
              <span className="dim"> · period {latest.period.start} → {latest.period.end} ({classifyPeriodSpan(latest.period)})</span>
            )}
            {latest.period?.kind === 'snapshot' && (
              <span className="dim"> · as of {latest.period.start}</span>
            )}
            <span className="dim"> · {latest.count} records · {fmt(latest.total)}</span>
            {snapshots.length > 1 && (
              <span className="dim"> · {snapshots.length} total uploads</span>
            )}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Reference</th>
                <th>Status</th>
                <th>Rep</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {latest.rows.slice(0, 25).map((r, i) => (
                <tr key={i}>
                  <td className="mono dim">{r.date || '—'}</td>
                  <td>
                    {r.customer || <span className="dim">—</span>}
                    {r.description && (
                      <div className="dim" style={{ fontSize: 11, marginTop: 2, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.description}
                      </div>
                    )}
                  </td>
                  <td className="mono">{r.reference || <span className="dim">—</span>}</td>
                  <td>{r.status ? <span className="pill blue">{r.status}</span> : <span className="dim">—</span>}</td>
                  <td className="dim">{r.rep || '—'}</td>
                  <td className="num">{r.amount ? fmt(r.amount) : <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {latest.rows.length > 25 && (
            <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
              Showing 25 of {latest.rows.length} rows.
            </div>
          )}
          {snapshots.length > 1 && (
            <div className="dim" style={{ fontSize: 12, marginTop: 12 }}>
              Prior uploads: {snapshots.slice(1, 6).map((s) => `${s.uploadedAt.slice(0, 10)} (${fmt(s.total)})`).join(', ')}
              {snapshots.length > 6 && ` … +${snapshots.length - 6} more`}
            </div>
          )}
        </>
      )}
    </div>
  )
}
