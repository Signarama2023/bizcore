import { useEffect, useState } from 'react'
import { fmt } from '../utils/format'
import {
  gustoStatus, gustoSync, gustoPayrolls, gustoSummary,
  uploadPayrollRuns, deletePayrollRun, PAYROLL_EXTRACTION_PROMPT,
} from '../utils/payroll'
import { callClaude, callClaudeWithPDF } from '../utils/claude'
import { readSpreadsheet } from '../utils/spreadsheet'

/**
 * Defensive JSON parse — strips ```json fences and falls back to
 * first-{ ... last-} extraction. Same pattern BankAccounts uses for
 * PDF statement extraction; the model occasionally wraps despite the
 * "no fences" instruction.
 */
function parseExtractedRuns(text) {
  let cleaned = String(text || '').trim()
  const fenced = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/)
  if (fenced) cleaned = fenced[1].trim()
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1)
  const parsed = JSON.parse(cleaned)
  return Array.isArray(parsed.runs) ? parsed.runs : []
}

/**
 * PAY-04: Gusto payroll panel rendered inside the Finance page. Shows
 * configuration state, sync controls, summary KPI cards (YTD / MTD /
 * employer-tax YTD / last check), and a table of recent payroll runs.
 *
 * Hides itself entirely when /api/gusto/status returns
 * configured:false, so businesses without Gusto wired in don't see an
 * empty card. (Same hide-when-empty pattern as DebtKpiBar in
 * EvaluationCharts.jsx.)
 */
export default function PayrollPanel() {
  const [status, setStatus] = useState(null) // null = loading
  const [summary, setSummary] = useState(null)
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  // PAY-08 upload state — separate from Gusto-sync state so the two
  // flows can show progress independently.
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const [uploadDetail, setUploadDetail] = useState(null) // last { accepted, rejected, ... } from server

  async function refresh() {
    setError('')
    try {
      const [s, sum, list] = await Promise.all([
        gustoStatus(),
        gustoSummary().catch(() => null),
        gustoPayrolls().catch(() => []),
      ])
      setStatus(s)
      setSummary(sum)
      setRows(list)
    } catch (err) {
      setError(err.message)
      setStatus({ configured: false })
    }
  }
  useEffect(() => { refresh() }, [])

  async function handleSync() {
    setSyncing(true)
    setSyncMsg('')
    setError('')
    try {
      const result = await gustoSync()
      setSyncMsg(`Synced since ${result.since}: ${result.runs_upserted}/${result.runs_discovered} runs persisted.`)
      await refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSyncing(false)
    }
  }

  // PAY-08 upload flow. Extracts payroll runs from PDF/CSV/XLSX via
  // Claude, then POSTs to /api/payroll/upload. Same Claude proxy the
  // BankAccounts PDF flow uses, so no API key ever touches the
  // browser bundle.
  async function handleUpload(file) {
    if (!file) return
    setUploading(true)
    setUploadMsg(`Reading ${file.name}…`)
    setUploadDetail(null)
    setError('')
    try {
      let extractionText
      const isPDF = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
      if (isPDF) {
        setUploadMsg(`Extracting payroll from ${file.name} with Claude (this can take 30–60s for a multi-period report)…`)
        extractionText = await callClaudeWithPDF(file, PAYROLL_EXTRACTION_PROMPT, { maxTokens: 12000 })
      } else {
        // CSV / XLSX / XLSM. Read locally into text, then ask Claude
        // to extract — formats vary too much per provider to parse
        // statically.
        const { text } = await readSpreadsheet(file)
        setUploadMsg(`Extracting payroll from ${file.name} with Claude…`)
        extractionText = await callClaude(
          `${PAYROLL_EXTRACTION_PROMPT}\n\n# Report contents (CSV/spreadsheet, raw)\n\n${text.slice(0, 80000)}`,
          { maxTokens: 8000 }
        )
      }
      const runs = parseExtractedRuns(extractionText)
      if (runs.length === 0) {
        setUploadMsg('')
        throw new Error("Couldn't find any payroll runs in that file. If it's a Payroll Summary across many periods, try a Payroll Journal instead — those break the runs out per pay period.")
      }
      setUploadMsg(`Extracted ${runs.length} run${runs.length === 1 ? '' : 's'} — persisting…`)
      const result = await uploadPayrollRuns(runs, { sourceFilename: file.name })
      setUploadDetail(result)
      setUploadMsg(
        `Saved ${result.accepted}/${runs.length} runs from ${file.name}` +
        (result.rejected ? ` · ${result.rejected} rejected (expand details below)` : '')
      )
      await refresh()
    } catch (err) {
      setError(`Upload failed: ${err.message}`)
      setUploadMsg('')
    } finally {
      setUploading(false)
    }
  }

  async function handleDelete(row) {
    if (!window.confirm(`Delete this uploaded payroll row?\n\n${row.pay_period_start} → ${row.pay_period_end} · ${row.source_filename || '(no file)'}\n\nThis cannot be undone (re-upload the source file if you change your mind).`)) {
      return
    }
    setError('')
    try {
      await deletePayrollRun(row.id)
      await refresh()
    } catch (err) {
      setError(`Delete failed: ${err.message}`)
    }
  }

  // While loading, render nothing — avoids the section flickering in.
  if (status === null) return null

  // PAY-08 always renders the panel — even without Gusto configured
  // and no historical rows. Reason: the universal upload flow is the
  // primary entry point for non-Gusto users, so they need to see the
  // panel to find the upload button. The empty state explains what
  // they can do.

  const ytd = summary?.year_to_date
  const mtd = summary?.month_to_date
  const qtd = summary?.quarter_to_date
  const lastSyncOk = status.last_sync?.ok
  const lastSyncAt = status.last_sync?.finished_at?.slice(0, 16)

  return (
    <div className="card" style={{ marginTop: 16, borderLeft: '4px solid var(--accent)' }}>
      <div className="row between" style={{ alignItems: 'flex-start', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div className="section-label" style={{ color: 'var(--accent)' }}>
            Payroll
          </div>
          <div className="dim" style={{ fontSize: 12 }}>
            Total company cost = gross pay + employer-side taxes (+ employer benefits) — what the Evaluation
            tool uses for payroll-to-revenue. Either sync live from Gusto, OR upload a Payroll Journal / Register
            from any provider (ADP, Paychex, QuickBooks Payroll, Patriot, OnPay, Rippling, etc.). Both write to
            the same underlying table.
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* Upload is universal — works for any provider, always shown. */}
          <label
            className="btn-outline"
            style={{ cursor: uploading ? 'wait' : 'pointer', opacity: uploading ? 0.6 : 1 }}
            title="Export a Payroll Journal / Payroll Register / Payroll Summary from your provider, then drop the file here. Works with PDF, CSV, XLSX."
          >
            {uploading ? 'Uploading…' : 'Upload payroll report'}
            <input
              type="file"
              accept=".pdf,.csv,.xlsx,.xls,.xlsm,application/pdf,text/csv"
              disabled={uploading}
              onChange={(e) => { handleUpload(e.target.files?.[0]); e.target.value = '' }}
              style={{ display: 'none' }}
            />
          </label>
          {status.configured ? (
            <button className="btn-primary" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync from Gusto'}
            </button>
          ) : (
            <span className="pill yellow" style={{ fontSize: 11, alignSelf: 'center' }}>
              Gusto not configured (upload still works)
            </span>
          )}
        </div>
      </div>

      {syncMsg && <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>{syncMsg}</div>}
      {uploadMsg && <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>{uploadMsg}</div>}
      {uploadDetail?.rejected > 0 && (
        <details style={{ marginBottom: 8 }}>
          <summary className="dim" style={{ fontSize: 11, cursor: 'pointer', color: 'var(--accent3)' }}>
            {uploadDetail.rejected} row{uploadDetail.rejected === 1 ? '' : 's'} rejected — expand to see why
          </summary>
          <table className="data-table" style={{ marginTop: 6, fontSize: 11 }}>
            <thead><tr><th>#</th><th>Reason</th></tr></thead>
            <tbody>
              {uploadDetail.rejected_rows.map((r, i) => (
                <tr key={i}>
                  <td className="mono dim">{r.index}</td>
                  <td>{r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {error && (
        <div style={{ marginBottom: 8 }}>
          <span className="pill red">Error</span>
          <span style={{ marginLeft: 8, fontSize: 12 }}>{error}</span>
        </div>
      )}

      {summary && ytd?.run_count > 0 && (
        <div className="grid-4" style={{ marginBottom: 12 }}>
          <div className="card-sm" style={{ background: 'var(--bg3)' }}>
            <div className="stat-label">Total payroll YTD</div>
            <div className="stat-value">{fmt(ytd.company_cost)}</div>
            <div className="stat-delta dim">
              {ytd.run_count} run{ytd.run_count === 1 ? '' : 's'} ·
              gross {fmt(ytd.gross_pay)} + er-tax {fmt(ytd.employer_taxes)}
            </div>
          </div>
          <div className="card-sm" style={{ background: 'var(--bg3)' }}>
            <div className="stat-label">Payroll MTD</div>
            <div className="stat-value">{fmt(mtd?.company_cost)}</div>
            <div className="stat-delta dim">
              {mtd?.run_count || 0} run{mtd?.run_count === 1 ? '' : 's'} · QTD {fmt(qtd?.company_cost)}
            </div>
          </div>
          <div className="card-sm" style={{ background: 'var(--bg3)' }}>
            <div className="stat-label">Employer taxes YTD</div>
            <div className="stat-value">{fmt(ytd.employer_taxes)}</div>
            <div className="stat-delta dim">
              {ytd.gross_pay > 0
                ? `${((ytd.employer_taxes / ytd.gross_pay) * 100).toFixed(1)}% of gross`
                : '—'}
            </div>
          </div>
          <div className="card-sm" style={{ background: 'var(--bg3)' }}>
            <div className="stat-label">Last check date</div>
            <div className="stat-value" style={{ fontSize: 18 }}>
              {status.latest_check_date || '—'}
            </div>
            <div className="stat-delta dim">
              {lastSyncAt
                ? <>{lastSyncOk ? '✓' : '✗'} synced {lastSyncAt}</>
                : 'never synced'}
            </div>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>
          {status.configured
            ? 'No payroll runs persisted yet. Click "Sync from Gusto" to pull the last 2 years, or upload a Payroll Journal from any provider.'
            : 'No payroll data yet. Either configure Gusto on the server, or upload a Payroll Journal / Register exported from your payroll provider — PDF, CSV, or Excel all work.'}
        </div>
      ) : (
        <details open>
          <summary className="dim" style={{ fontSize: 12, cursor: 'pointer', marginBottom: 6 }}>
            Recent payroll runs ({rows.length})
          </summary>
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Check date</th>
                <th>Pay period</th>
                <th className="num">Gross</th>
                <th className="num">Employer tax</th>
                <th className="num">Total cost</th>
                <th className="num">Employees</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 30).map((r) => {
                const isManual = r.source === 'manual-upload'
                return (
                  <tr key={r.id}>
                    <td className="mono">{r.check_date || '—'}</td>
                    <td className="mono dim" style={{ fontSize: 12 }}>
                      {r.pay_period_start} → {r.pay_period_end}
                    </td>
                    <td className="num mono">{fmt(r.gross_pay)}</td>
                    <td className="num mono">{fmt(r.employer_taxes)}</td>
                    <td className="num mono" style={{ fontWeight: 600 }}>{fmt(r.total_company_cost)}</td>
                    <td className="num">{r.employee_count ?? '—'}</td>
                    <td>
                      {isManual ? (
                        <span className="pill yellow" style={{ fontSize: 10 }}
                          title={r.source_filename ? `Uploaded from ${r.source_filename}` : 'Manual upload'}>
                          upload
                        </span>
                      ) : (
                        <span className="pill green" style={{ fontSize: 10 }}>
                          {r.source === 'gusto-api' ? 'gusto' : r.source}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {isManual && (
                        <button
                          className="btn-outline"
                          onClick={() => handleDelete(r)}
                          style={{ fontSize: 10, padding: '2px 8px', color: 'var(--danger)' }}
                          title="Delete this uploaded row (Gusto-synced rows can't be deleted here)"
                        >
                          delete
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {rows.length > 30 && (
            <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
              Showing the 30 most recent of {rows.length}. Older runs are still in the database;
              the Evaluation tool sees all of them.
            </div>
          )}
        </details>
      )}
    </div>
  )
}
