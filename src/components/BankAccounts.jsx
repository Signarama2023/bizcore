import { useEffect, useState } from 'react'
import { fmt } from '../utils/format'
import { fetchPersistedAccounts, triggerBackfill } from '../utils/persistedBank'

/**
 * Bank Accounts panel — live BankSync (Plaid-backed) data only.
 *
 * STRIP-04 (2026-05-23): the manual PDF/CSV/XLSX statement upload
 * fallback was removed. ~450 lines of upload state, transaction
 * dedup, PF transfer detection, top-payee tables, and per-account
 * statement history are gone. Reasons:
 *
 *   - BankSync is the canonical source for everything it can reach.
 *     Mixing live BankSync data with manually-uploaded snapshots in
 *     the same view confused which number was authoritative.
 *   - If BankSync can't reach an account, that's a real product
 *     problem to solve (per Mark's directive), not something to
 *     paper over with PDF uploads — those PDFs were rarely current
 *     and silently went stale.
 *   - Reduced product surface = simpler onboarding for new
 *     customers ("connect your bank" vs "connect your bank OR
 *     upload statements monthly").
 *
 * If you need historical months that pre-date Plaid's 730-day
 * window, do one full backfill on day-of-connect (the
 * "Full backfill (730d)" button below grabs everything Plaid will
 * return). Older months can't be retrieved through any API and
 * shouldn't be ad-hoc-uploaded into the same dataset; they'd
 * mismatch reconciliation arithmetic.
 *
 * If you need an account BankSync doesn't see (e.g. a private bank,
 * a credit card issuer not in Plaid's catalog), that's a feature
 * request to add Finicity / MX / Yodlee as a fallback connector,
 * not a "upload PDFs forever" workaround.
 */
export default function BankAccounts() {
  const [accounts, setAccounts] = useState(null) // null = loading
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState(null)
  const [error, setError] = useState('')

  const refresh = async () => {
    try {
      const list = await fetchPersistedAccounts()
      setAccounts(list)
    } catch (err) {
      setAccounts([])
      setError(err.message)
    }
  }
  useEffect(() => { refresh() }, [])

  const doBackfill = async (days) => {
    setRunning(true)
    setError('')
    setLastRun(null)
    try {
      const result = await triggerBackfill({ days })
      setLastRun(result)
      await refresh()
    } catch (err) {
      setError(err.message)
      if (err.detail) setLastRun(err.detail)
    } finally {
      setRunning(false)
    }
  }

  // Headline numbers come from the persisted accounts feed — same
  // source the Evaluation page reads — so the bank-cash figure here
  // matches what the AI sees. Non-AMEX accounts only.
  const totalCash = (accounts || [])
    .filter((a) => a.pf_key && a.pf_key !== 'amex' && a.last_balance != null)
    .reduce((s, a) => s + Number(a.last_balance || 0), 0)
  const reconciledCount = (accounts || [])
    .filter((a) => a.last_reconciled_at && Math.abs(a.last_reconcile_gap || 0) <= 1)
    .length

  return (
    <div className="card" style={{ marginTop: 16, borderLeft: '4px solid var(--accent2)' }}>
      <div className="row between" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div className="section-label" style={{ color: 'var(--accent2)' }}>
            Bank Accounts — live (BankSync canonical)
          </div>
          <div className="dim" style={{ fontSize: 12 }}>
            Every transaction comes from BankSync&apos;s Plaid backend with a stable transaction ID.
            Reconciled at sync time; failed reconciliations roll back instead of polluting the dataset.
            This is what the Evaluation tool reads.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn-outline"
            onClick={() => doBackfill(30)}
            disabled={running}
            title="Quick 30-day pull (idempotent — safe to repeat)"
          >
            {running ? 'Syncing…' : 'Sync last 30d'}
          </button>
          <button
            className="btn-primary"
            onClick={() => doBackfill(730)}
            disabled={running}
            title="Full 2-year backfill (slower; usually only needed once at connect time)"
          >
            {running ? 'Syncing…' : 'Full backfill (730d)'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: 8 }}>
          <span className="pill red">Error</span>
          <span style={{ marginLeft: 8, fontSize: 12 }}>{error}</span>
        </div>
      )}

      {accounts === null ? (
        <div className="dim" style={{ fontSize: 12 }}>Loading…</div>
      ) : accounts.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>
          No accounts persisted yet. Click <strong>Full backfill (730d)</strong> to pull every account
          BankSync can reach. If BankSync env vars aren&apos;t set on the server you&apos;ll get a 502/503
          — see Settings page for the env-var checklist.
        </div>
      ) : (
        <>
          <div className="grid-3" style={{ marginBottom: 12 }}>
            <div className="card-sm" style={{ background: 'var(--bg3)' }}>
              <div className="stat-label">Accounts reconciled</div>
              <div className="stat-value">{reconciledCount} / {accounts.length}</div>
              <div className="stat-delta dim">across connected accounts</div>
            </div>
            <div className="card-sm" style={{ background: 'var(--bg3)' }}>
              <div className="stat-label">Total bank cash</div>
              <div className="stat-value">{fmt(totalCash)}</div>
              <div className="stat-delta dim">non-AMEX latest balances</div>
            </div>
            <div className="card-sm" style={{ background: 'var(--bg3)' }}>
              <div className="stat-label">Last sync</div>
              <div className="stat-value" style={{ fontSize: 16 }}>
                {accounts.reduce((latest, a) => (a.last_sync_at && (!latest || a.last_sync_at > latest)) ? a.last_sync_at : latest, null)?.slice(0, 16) || '—'}
              </div>
              <div className="stat-delta dim">most-recent reconcile</div>
            </div>
          </div>

          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>PF Key</th>
                <th style={{ textAlign: 'left' }}>Account</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
                <th style={{ textAlign: 'left' }}>Status</th>
                <th style={{ textAlign: 'right' }}># tx</th>
                <th style={{ textAlign: 'left' }}>Range</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const gap = Math.abs(a.last_reconcile_gap || 0)
                const reconciled = a.last_reconciled_at && gap <= 1
                return (
                  <tr key={a.id}>
                    <td>{a.pf_key || <span className="dim">unmapped</span>}</td>
                    <td className="dim" style={{ fontSize: 12 }}>
                      {a.account_name || '(unnamed)'}{' '}
                      <span className="mono">{a.account_number_last4 ? `…${a.account_number_last4}` : ''}</span>
                    </td>
                    <td className="num mono" style={{ textAlign: 'right' }}>
                      {a.last_balance != null ? fmt(a.last_balance) : '—'}
                    </td>
                    <td>
                      {reconciled ? (
                        <span className="pill green" style={{ fontSize: 10 }}>✓ reconciled</span>
                      ) : a.last_reconciled_at ? (
                        <span className="pill red" style={{ fontSize: 10 }}>⚠ gap {fmt(gap)}</span>
                      ) : (
                        <span className="pill yellow" style={{ fontSize: 10 }}>never synced</span>
                      )}
                    </td>
                    <td className="num mono" style={{ textAlign: 'right', fontSize: 12 }}>{a.tx_count}</td>
                    <td className="dim mono" style={{ fontSize: 11 }}>
                      {a.earliest_tx || '—'} → {a.latest_tx || '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {lastRun && (
        <details style={{ marginTop: 12 }}>
          <summary className="dim" style={{ fontSize: 12, cursor: 'pointer' }}>
            Last run result — {lastRun.ok ? '✓ success' : '✗ rolled back'}
            ({lastRun.transactions_new || 0} new tx, {lastRun.pf_accounts_found || 0} accounts)
          </summary>
          <pre style={{
            fontSize: 11, marginTop: 8, padding: 8,
            background: 'var(--bg3)', borderRadius: 4, overflow: 'auto',
          }}>
            {JSON.stringify(lastRun, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
