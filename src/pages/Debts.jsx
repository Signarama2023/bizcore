import { Fragment, useEffect, useState } from 'react'
import { fmt } from '../utils/format'
import {
  listDebts, debtsSummary, getDebt, createDebt, updateDebt, deleteDebt,
  DEBT_TYPES, DEBT_STATUSES, PF_KEYS,
} from '../utils/debts'

// Display label for a debt_type enum value. Falls back to the raw string
// so a future server-added type still shows up readable.
function typeLabel(value) {
  return DEBT_TYPES.find((t) => t.value === value)?.label || value
}

// Per-debt utilisation = current_balance / original_principal, clamped to
// [0, 1.1] so a slightly-over balance (interest accrual) still renders.
function utilisation(d) {
  const cur = Number(d.current_balance)
  const orig = Number(d.original_principal)
  if (!Number.isFinite(cur) || !Number.isFinite(orig) || orig <= 0) return null
  return Math.min(Math.max(cur / orig, 0), 1.1)
}

function formatDate(s) {
  if (!s) return '—'
  // SQLite returns ISO strings; we render the date portion only.
  return String(s).slice(0, 10)
}

// Best-effort merchant-list parse for the inline edit form. Server stores
// match_merchants_json as a JSON-encoded array but PATCH accepts either.
function parseMerchantList(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const inputStyle = {
  background: 'var(--bg2)', color: 'var(--text)',
  border: '1px solid var(--border2)', borderRadius: 'var(--r-sm)',
  padding: '6px 8px', font: 'inherit', fontSize: 13, width: '100%',
}

const labelStyle = { display: 'block', fontSize: 11, color: 'var(--dim)', marginBottom: 2 }

/**
 * Inline form used for both "add a debt" and "edit a debt". Keeps state
 * local so a typing user doesn't refetch the list on every keystroke.
 *
 * onSave({ ...fields }) is called with cleaned values; the parent runs the
 * server call so it can refresh state on success.
 */
function DebtForm({ initial, onSave, onCancel, saving }) {
  const [fields, setFields] = useState(() => ({
    name: initial?.name || '',
    lender: initial?.lender || '',
    debt_type: initial?.debt_type || 'term_loan',
    original_principal: initial?.original_principal ?? '',
    monthly_payment: initial?.monthly_payment ?? '',
    interest_rate: initial?.interest_rate != null ? String(initial.interest_rate * 100) : '',
    start_date: initial?.start_date || '',
    term_months: initial?.term_months ?? '',
    next_payment_date: initial?.next_payment_date || '',
    manual_balance: initial?.manual_balance ?? '',
    match_amount: initial?.match_amount ?? '',
    match_amount_tolerance: initial?.match_amount_tolerance ?? '',
    match_account_pf_key: initial?.match_account_pf_key || '',
    match_merchants: initial?.match_merchants?.join(', ') || '',
    status: initial?.status || 'active',
    notes: initial?.notes || '',
  }))
  const [error, setError] = useState('')

  function set(k, v) { setFields((f) => ({ ...f, [k]: v })) }

  function submit(e) {
    e.preventDefault()
    setError('')
    // Translate UI values back to the server's expected shapes:
    //   - interest_rate: percent in UI, decimal on the wire (server validates 0–1)
    //   - blank strings: server treats '' as null, but we send the intent explicitly
    //   - match_merchants: array (server also accepts JSON string)
    const payload = {
      name: fields.name.trim(),
      lender: fields.lender.trim() || null,
      debt_type: fields.debt_type,
      original_principal: fields.original_principal === '' ? null : Number(fields.original_principal),
      monthly_payment: fields.monthly_payment === '' ? null : Number(fields.monthly_payment),
      interest_rate: fields.interest_rate === '' ? null : Number(fields.interest_rate) / 100,
      start_date: fields.start_date || null,
      term_months: fields.term_months === '' ? null : Number(fields.term_months),
      next_payment_date: fields.next_payment_date || null,
      manual_balance: fields.manual_balance === '' ? null : Number(fields.manual_balance),
      match_amount: fields.match_amount === '' ? null : Number(fields.match_amount),
      match_amount_tolerance: fields.match_amount_tolerance === '' ? null : Number(fields.match_amount_tolerance),
      match_account_pf_key: fields.match_account_pf_key || null,
      match_merchants_json: parseMerchantList(fields.match_merchants),
      status: fields.status,
      notes: fields.notes.trim() || null,
    }
    if (!payload.name) { setError('Name is required.'); return }
    onSave(payload).catch((err) => setError(err.message))
  }

  return (
    <form onSubmit={submit} className="card-sm" style={{ background: 'var(--bg3)', marginTop: 10 }}>
      <div className="grid-3" style={{ gap: 10 }}>
        <div>
          <label style={labelStyle}>Name *</label>
          <input style={inputStyle} value={fields.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Lender</label>
          <input style={inputStyle} value={fields.lender} onChange={(e) => set('lender', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Type *</label>
          <select style={inputStyle} value={fields.debt_type} onChange={(e) => set('debt_type', e.target.value)}>
            {DEBT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Original principal ($)</label>
          <input style={inputStyle} type="number" step="0.01" value={fields.original_principal}
            onChange={(e) => set('original_principal', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Monthly payment ($)</label>
          <input style={inputStyle} type="number" step="0.01" value={fields.monthly_payment}
            onChange={(e) => set('monthly_payment', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Interest rate (%)</label>
          <input style={inputStyle} type="number" step="0.001" value={fields.interest_rate}
            onChange={(e) => set('interest_rate', e.target.value)}
            placeholder="e.g. 6.9" />
        </div>

        <div>
          <label style={labelStyle}>Start date</label>
          <input style={inputStyle} type="date" value={fields.start_date}
            onChange={(e) => set('start_date', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Term (months)</label>
          <input style={inputStyle} type="number" step="1" value={fields.term_months}
            onChange={(e) => set('term_months', e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Next payment date</label>
          <input style={inputStyle} type="date" value={fields.next_payment_date}
            onChange={(e) => set('next_payment_date', e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>Current balance — manual ($)</label>
          <input style={inputStyle} type="number" step="0.01" value={fields.manual_balance}
            onChange={(e) => set('manual_balance', e.target.value)}
            placeholder="overrides computed" />
        </div>
        <div>
          <label style={labelStyle}>Status</label>
          <select style={inputStyle} value={fields.status} onChange={(e) => set('status', e.target.value)}>
            {DEBT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div />
      </div>

      <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <div className="section-label" style={{ marginBottom: 6 }}>Auto-match rules</div>
        <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
          BankSync runs these against every new transaction. A payment matches when amount is within
          tolerance AND (any merchant substring is in the description OR account matches, when both
          are set). See DEBT-03 in server.js for the scoring rules.
        </div>
        <div className="grid-3" style={{ gap: 10 }}>
          <div>
            <label style={labelStyle}>Expected payment ($)</label>
            <input style={inputStyle} type="number" step="0.01" value={fields.match_amount}
              onChange={(e) => set('match_amount', e.target.value)}
              placeholder="defaults to monthly_payment" />
          </div>
          <div>
            <label style={labelStyle}>Amount tolerance ($)</label>
            <input style={inputStyle} type="number" step="0.01" value={fields.match_amount_tolerance}
              onChange={(e) => set('match_amount_tolerance', e.target.value)}
              placeholder="default $5.00" />
          </div>
          <div>
            <label style={labelStyle}>Pay from account</label>
            <select style={inputStyle} value={fields.match_account_pf_key}
              onChange={(e) => set('match_account_pf_key', e.target.value)}>
              {PF_KEYS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>Merchant keywords (comma- or newline-separated)</label>
          <input style={inputStyle} value={fields.match_merchants}
            onChange={(e) => set('match_merchants', e.target.value)}
            placeholder="e.g. NMEF, NORTH MILL EQUIP" />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <label style={labelStyle}>Notes</label>
        <textarea style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
          value={fields.notes} onChange={(e) => set('notes', e.target.value)} />
      </div>

      {error && (
        <div style={{ marginTop: 10 }}>
          <span className="pill red">Error</span>
          <span style={{ marginLeft: 8, fontSize: 12 }}>{error}</span>
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="btn-outline" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : (initial ? 'Save changes' : 'Add debt')}
        </button>
      </div>
    </form>
  )
}

/**
 * Expanded panel under a debt row: shows the form (for editing) plus the
 * recent payments table. Re-fetches the debt detail when opened so the
 * payments list and current_balance reflect the latest BankSync run.
 */
function DebtDetail({ debtId, onSaved, onClosed }) {
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function load() {
    setError('')
    try { setDetail(await getDebt(debtId)) }
    catch (err) { setError(err.message); setDetail(null) }
  }
  useEffect(() => { load() }, [debtId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save(payload) {
    setSaving(true)
    try {
      const updated = await updateDebt(debtId, payload)
      setDetail((d) => d ? { ...d, debt: updated } : d)
      if (onSaved) onSaved(updated)
    } finally {
      setSaving(false)
    }
  }

  async function handleClose() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setSaving(true)
    try {
      await deleteDebt(debtId, { hard: false })
      if (onClosed) onClosed()
    } catch (err) { setError(err.message) }
    finally { setSaving(false); setConfirmDelete(false) }
  }

  if (error) return (
    <div style={{ padding: 12 }}>
      <span className="pill red">Error</span>
      <span style={{ marginLeft: 8, fontSize: 12 }}>{error}</span>
    </div>
  )
  if (!detail) return <div className="dim" style={{ padding: 12, fontSize: 12 }}>Loading…</div>

  const payments = detail.payments || []

  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: 12 }}>
      <DebtForm initial={detail.debt} onSave={save} onCancel={onClosed} saving={saving} />

      <div className="row between" style={{ marginTop: 16, marginBottom: 6 }}>
        <div className="section-label">Recent payments (last 20)</div>
        <button className={confirmDelete ? 'btn-danger' : 'btn-outline'}
          onClick={handleClose} disabled={saving}
          style={{ fontSize: 12, padding: '4px 10px' }}>
          {confirmDelete ? 'Click again to confirm close' : 'Close debt (hide)'}
        </button>
      </div>
      {payments.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>
          No payments matched yet. BankSync runs the auto-matcher on every backfill — if a payment
          should have matched, check the keywords/amount/account on the form above.
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Amount</th>
              <th>Matched by</th>
              <th>Bank tx</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td className="mono">{formatDate(p.payment_date)}</td>
                <td className="num mono">{fmt(p.amount)}</td>
                <td className="dim" style={{ fontSize: 12 }}>{p.matched_by || 'manual'}</td>
                <td className="dim mono" style={{ fontSize: 11 }}>
                  {p.bank_transaction_id ? `#${p.bank_transaction_id}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function Debts() {
  const [debts, setDebts] = useState(null) // null = loading
  const [summary, setSummary] = useState(null)
  const [statusFilter, setStatusFilter] = useState('active')
  const [expandedId, setExpandedId] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addSaving, setAddSaving] = useState(false)
  const [error, setError] = useState('')

  async function refresh() {
    setError('')
    try {
      const [list, sum] = await Promise.all([
        listDebts(statusFilter === 'active' ? null : statusFilter),
        debtsSummary(),
      ])
      setDebts(list)
      setSummary(sum)
    } catch (err) {
      setError(err.message)
      setDebts([])
      setSummary(null)
    }
  }
  useEffect(() => { refresh() }, [statusFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleAdd(payload) {
    setAddSaving(true)
    try {
      await createDebt(payload)
      setShowAdd(false)
      await refresh()
    } finally { setAddSaving(false) }
  }

  const activeDebts = (debts || []).filter((d) => d.status === 'active')
  const totalMatched = (summary?.per_month || []).reduce((s, m) => s + (m.payments || 0), 0)

  return (
    <div>
      <div className="row between" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
        <div>
          <div className="page-title">Debts</div>
          <div className="page-subtitle">
            Every active loan, lease, and revolving line — with auto-matched BankSync payments so the
            current balance and monthly debt service stay honest.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            style={{ ...inputStyle, width: 'auto' }}>
            <option value="active">Active only</option>
            <option value="paid_off">Paid off</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <button className="btn-primary" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? 'Cancel' : '+ Add debt'}
          </button>
        </div>
      </div>

      {error && (
        <div className="card-sm" style={{ marginBottom: 12 }}>
          <span className="pill red">Error</span>
          <span style={{ marginLeft: 8, fontSize: 12 }}>{error}</span>
        </div>
      )}

      {summary && (
        <div className="grid-4" style={{ marginBottom: 16 }}>
          <div className="card-sm">
            <div className="stat-label">Total outstanding</div>
            <div className="stat-value">{fmt(summary.total_outstanding)}</div>
            <div className="stat-delta dim">{summary.active_debts_count} active debt{summary.active_debts_count === 1 ? '' : 's'}</div>
          </div>
          <div className="card-sm">
            <div className="stat-label">Monthly payment expected</div>
            <div className="stat-value">{fmt(summary.total_monthly_payment_expected)}</div>
            <div className="stat-delta dim">sum of scheduled payments</div>
          </div>
          <div className="card-sm">
            <div className="stat-label">Debt service MTD</div>
            <div className="stat-value">{fmt(summary.month_to_date.debt_service)}</div>
            <div className="stat-delta dim">
              {summary.month_to_date.payment_count} payment{summary.month_to_date.payment_count === 1 ? '' : 's'} ·
              window {formatDate(summary.month_to_date.window.start)} → {formatDate(summary.month_to_date.window.end)}
            </div>
          </div>
          <div className="card-sm">
            <div className="stat-label">Matched payments YTD</div>
            <div className="stat-value">{totalMatched.toLocaleString()}</div>
            <div className="stat-delta dim">auto-attached from BankSync</div>
          </div>
        </div>
      )}

      {showAdd && (
        <DebtForm onSave={handleAdd} onCancel={() => setShowAdd(false)} saving={addSaving} />
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="section-label" style={{ marginBottom: 8 }}>
          {statusFilter === 'active' ? 'Active debts' :
           statusFilter === 'paid_off' ? 'Paid-off debts' :
           statusFilter === 'closed' ? 'Closed debts' : 'All debts'}
          {debts != null && <span className="dim" style={{ marginLeft: 8, fontSize: 12 }}>({debts.length})</span>}
        </div>

        {debts == null ? (
          <div className="dim" style={{ fontSize: 12 }}>Loading…</div>
        ) : debts.length === 0 ? (
          <div className="dim" style={{ fontSize: 12 }}>
            No debts to show. Use <strong>+ Add debt</strong> to enter one — or check the status filter
            if you&apos;re looking for a closed/paid-off loan.
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Lender</th>
                <th>Type</th>
                <th className="num">Current balance</th>
                <th className="num">Original</th>
                <th className="num">Monthly</th>
                <th>Next payment</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {debts.map((d) => {
                const util = utilisation(d)
                const isOpen = expandedId === d.id
                return (
                  // Fragment carries the iteration key; the row/detail pair
                  // expands to two siblings inside <tbody>, which React's
                  // shorthand <> can't key.
                  <Fragment key={d.id}>
                    <tr style={{ cursor: 'pointer' }}
                      onClick={() => setExpandedId(isOpen ? null : d.id)}>
                      <td>
                        <strong>{d.name}</strong>
                        {d.status !== 'active' && (
                          <span className="pill yellow" style={{ marginLeft: 8, fontSize: 10 }}>
                            {DEBT_STATUSES.find((s) => s.value === d.status)?.label || d.status}
                          </span>
                        )}
                      </td>
                      <td className="dim">{d.lender || '—'}</td>
                      <td className="dim" style={{ fontSize: 12 }}>{typeLabel(d.debt_type)}</td>
                      <td className="num mono">
                        {fmt(d.current_balance)}
                        {util != null && (
                          <div style={{ marginTop: 2 }}>
                            <div style={{
                              background: 'var(--bg3)', height: 4, borderRadius: 2, overflow: 'hidden',
                            }}>
                              <div style={{
                                width: `${Math.round(util * 100)}%`, height: '100%',
                                background: util > 0.75 ? 'var(--danger)' :
                                            util > 0.4  ? 'var(--accent3)' :
                                                          'var(--accent)',
                              }} />
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="num mono dim">{fmt(d.original_principal)}</td>
                      <td className="num mono">{fmt(d.monthly_payment)}</td>
                      <td className="mono dim" style={{ fontSize: 12 }}>{formatDate(d.next_payment_date)}</td>
                      <td className="dim" style={{ fontSize: 11 }}>{isOpen ? '▾' : '▸'}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8} style={{ padding: 0 }}>
                          <DebtDetail
                            debtId={d.id}
                            onSaved={refresh}
                            onClosed={() => { setExpandedId(null); refresh() }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {summary?.per_month?.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Monthly debt service (YTD)</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Payments</th>
                <th className="num">Debt service</th>
              </tr>
            </thead>
            <tbody>
              {summary.per_month.map((m) => (
                <tr key={m.month}>
                  <td className="mono">{m.month}</td>
                  <td className="num">{m.payments}</td>
                  <td className="num mono">{fmt(m.debt_service)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="dim" style={{ fontSize: 11, marginTop: 8 }}>
            These figures come from <code>debt_payments</code> — the auto-matcher writes one row per
            BankSync transaction that scored above the threshold (see DEBT-03 in server.js).
            Unmatched transactions stay in <code>bank_transactions</code> only and don&apos;t count here.
          </div>
        </div>
      )}

      {(activeDebts.length === 0 && debts != null && statusFilter === 'active' && !showAdd) && (
        <div className="card-sm" style={{ marginTop: 12, background: 'var(--bg3)' }}>
          <div className="section-label" style={{ marginBottom: 4 }}>No active debts entered yet</div>
          <div className="dim" style={{ fontSize: 12 }}>
            Add the AMEX revolving balance, the SBA loan, the NMEF Bucket Truck note, and the short-term
            2026 loans from the Balance Sheet to seed the page. The auto-matcher will attach BankSync
            payments to them on the next sync.
          </div>
        </div>
      )}
    </div>
  )
}
