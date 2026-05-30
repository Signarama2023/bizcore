import { splitCSVLine, parseAmount } from './csv'

const DATE_KEYS = [
  'created date', 'date created', 'sale date', 'completed date', 'date completed',
  'paid date', 'date paid', 'invoice date', 'due date', 'start date', 'job date',
  'order date', 'date',
]
const CUSTOMER_KEYS = [
  'customer', 'client', 'account', 'company', 'customer name', 'company name',
  'account name', 'bill to', 'sold to', 'name',
]
const AMOUNT_KEYS = [
  'sales amount', 'sale amount', 'sales total', 'total amount', 'net amount',
  'amount', 'total', 'value', 'price', 'balance', 'gross', 'subtotal',
  'invoice amount', 'invoice total', 'job value', 'order total', 'order amount',
]
const DESCRIPTION_KEYS = ['description', 'memo', 'notes', 'item', 'details', 'job description']
const REFERENCE_KEYS = [
  'order #', 'order number', 'order no', 'order no.',
  'job #', 'job number', 'job no', 'job no.',
  'invoice #', 'invoice number', 'invoice no', 'invoice no.',
  'quote #', 'quote number',
  'number', 'no.', 'ref', 'reference', 'job', 'order', 'invoice', 'quote',
]
const STATUS_KEYS = ['status', 'stage', 'state', 'phase', 'order status', 'sales status', 'job status']
const REP_KEYS = [
  'rep', 'sales rep', 'salesperson', 'owner', 'assigned to', 'created by',
  'rep name', 'csr', 'account manager',
]

const SUBTOTAL_RX = /^\s*(\*|total|subtotal|grand\s*total|sum|page\s*:|generated\b)/i

function findIdx(headers, keys) {
  for (const k of keys) {
    const i = headers.indexOf(k)
    if (i >= 0) return i
  }
  return -1
}

function toISO(s) {
  if (!s) return null
  const t = String(s).trim().replace(/^"|"$/g, '')
  if (!t) return null
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/**
 * Detect a reporting period from Corebridge-style metadata rows.
 *   "Starting Date: 01/01/2026" + "Ending Date: 05/14/2026"  → range
 *   "As of 5/14/2026"                                          → snapshot
 */
function detectPeriod(text) {
  const head = text.slice(0, 4000)
  let start = null, end = null, asOf = null
  const startMatch = head.match(/Starting\s+Date\s*[:\s]+([\d\/\-]+)/i)
  const endMatch = head.match(/Ending\s+Date\s*[:\s]+([\d\/\-]+)/i)
  const asOfMatch = head.match(/\bAs\s+of\s+([\d\/\-]+)/i)
  if (startMatch) start = toISO(startMatch[1])
  if (endMatch) end = toISO(endMatch[1])
  if (asOfMatch) asOf = toISO(asOfMatch[1])
  if (start && end) return { start, end, kind: 'range' }
  if (asOf) return { start: asOf, end: asOf, kind: 'snapshot' }
  return null
}

function classifyPeriodSpan(period) {
  if (!period?.start || !period?.end) return null
  if (period.kind === 'snapshot') return 'snapshot'
  const d1 = new Date(period.start)
  const d2 = new Date(period.end)
  const days = Math.round((d2 - d1) / 86400000) + 1
  if (days <= 9) return 'weekly'
  if (days <= 35) return 'monthly'
  if (days <= 100) return 'quarterly'
  return 'ytd-or-annual'
}

/**
 * Unwrap Excel HYPERLINK formulas like:
 *   =HYPERLINK("https://.../Order.aspx?...","INV-31101")
 * Returns the display text ("INV-31101"). Plain strings pass through.
 */
function unwrapHyperlink(s) {
  if (s == null) return ''
  const t = String(s).trim()
  if (!t.toUpperCase().startsWith('=HYPERLINK')) return t
  const m = t.match(/=HYPERLINK\s*\(\s*"[^"]*"\s*,\s*"([^"]*)"\s*\)/i)
  return m ? m[1] : t
}

/**
 * Quote-aware CSV parser. Returns an array of records (each an array of cell
 * strings). Handles fields wrapped in double quotes, "" escapes, and — crucially
 * for Corebridge SSRS exports — newlines embedded inside quoted cells.
 */
function parseCSVRecords(text) {
  const s = String(text).replace(/^﻿/, '')
  const records = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\r') {
      // ignore — newline handled on \n
    } else if (c === '\n') {
      row.push(field); field = ''
      records.push(row); row = []
    } else {
      field += c
    }
  }
  if (field !== '' || row.length) { row.push(field); records.push(row) }
  return records
}

function isCorebridgeWIP(text) {
  // SSRS WIP export: a metadata block (hdrExecutionTime etc.) followed by a
  // column-header row containing OrderStatusText + Textbox121. Parse records
  // properly first — the header row has embedded-newline neighbours.
  const head = parseCSVRecords(text).slice(0, 30)
  const hasMeta = head.some((r) => r.some((c) => /hdrExecutionTime/i.test(c)))
  const hasColumns = head.some((r) =>
    r.some((c) => /^OrderStatusText$/i.test(c.trim())) &&
    r.some((c) => /^Textbox121$/i.test(c.trim())))
  return hasMeta && hasColumns
}

function isCorebridgeARAging(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).slice(0, 30)
  return lines.some((l) => /lblAgingCustomer/i.test(l)) &&
    lines.some((l) => /txtCustomerAgingTotal/i.test(l))
}

/**
 * Corebridge AR Aging Detail parser. One row per invoice with aging bucket.
 * Header: lblAgingCustomer, txtInvoiceNumber, txtCustomerAging, txtDueDateDisplay,
 *         txtOrderAging, txtBalanceDue, ..., txtCustomerAgingTotal (bucket label),
 *         ..., Textbox13 (grand total, repeated on every row).
 * Parsed with the quote-aware record parser so cells with embedded newlines
 * don't shred rows (which would silently undercount the AR total).
 */
function parseCorebridgeARAging(text) {
  const records = parseCSVRecords(text)
  if (records.length < 2) throw new Error('AR Aging: file too short.')

  // Find the header row anywhere in the first 30 records.
  let headerIdx = -1
  for (let i = 0; i < Math.min(30, records.length); i++) {
    const r = records[i]
    if (r.some((c) => /^txtInvoiceNumber$/i.test(String(c).trim()))
      && r.some((c) => /^txtBalanceDue$/i.test(String(c).trim()))) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) {
    throw new Error('AR Aging: missing expected columns (txtInvoiceNumber, txtBalanceDue).')
  }
  const headers = records[headerIdx].map((h) => String(h).trim())
  const idx = {
    invoice: headers.indexOf('txtInvoiceNumber'),
    customer: headers.indexOf('txtCustomerAging'),
    dueDate: headers.indexOf('txtDueDateDisplay'),
    daysPastDue: headers.indexOf('txtOrderAging'),
    balance: headers.indexOf('txtBalanceDue'),
    bucketLabel: headers.indexOf('txtCustomerAgingTotal'),
    grandTotal: headers.indexOf('Textbox13'),
  }

  const rows = []
  let grandTotal = 0

  for (let i = headerIdx + 1; i < records.length; i++) {
    const cells = records[i]
    if (!cells || cells.every((c) => !c || !String(c).trim())) continue
    const invoice = String(cells[idx.invoice] || '').trim()
    const balance = parseAmount(cells[idx.balance])

    // Grab grand total from any row that has it
    if (!grandTotal && idx.grandTotal >= 0) {
      const gt = parseAmount(cells[idx.grandTotal])
      if (Number.isFinite(gt) && gt) grandTotal = gt
    }

    // Skip customer-header rows (no invoice / no balance)
    if (!invoice || !Number.isFinite(balance) || balance === 0) continue

    const customer = idx.customer >= 0 ? String(cells[idx.customer] || '').trim() : ''
    const dueDate = idx.dueDate >= 0 ? toISO(cells[idx.dueDate]) : null
    const daysPastDueRaw = idx.daysPastDue >= 0 ? cells[idx.daysPastDue] : ''
    const daysPastDue = parseInt(String(daysPastDueRaw).trim(), 10) || 0
    const bucketLabel = idx.bucketLabel >= 0
      ? String(cells[idx.bucketLabel] || '').replace(/^Total:\s*/i, '').trim()
      : ''

    rows.push({
      date: dueDate,
      customer,
      amount: balance,
      reference: invoice,
      status: bucketLabel || 'Outstanding',
      rep: '',
      description: daysPastDue > 0 ? `${daysPastDue} days past due` : 'not yet due',
    })
  }

  if (rows.length === 0) throw new Error('AR Aging: no invoice rows found.')

  const sum = rows.reduce((s, r) => s + r.amount, 0)
  return {
    rows,
    skipped: 0,
    total: grandTotal || sum,
    weekOf: null,
    columns: {},
    period: { start: new Date().toISOString().slice(0, 10), end: new Date().toISOString().slice(0, 10), kind: 'snapshot' },
  }
}

/**
 * Corebridge SSRS "Work In Progress By Order Detail" parser.
 *
 * The export is denormalized — per order there is a summary row, one row per
 * product line item, and a footer row — and many cells stack two values with
 * an embedded newline. We parse it with a quote-aware record parser and
 * aggregate to one row per order.
 *
 * Column layout (by header name):
 *   - OrderStatusText  → "Order Status: WIP" / "Order Status: BUILT"
 *   - Textbox121       → "Customer Name\nINV-#####" (customer + invoice stacked)
 *   - OrderText        → order description
 *   - SalespersonName  → rep (may be stacked / duplicated)
 *   - SubtotalAmount   → "$order_subtotal\n$..." (order $ amount, first line)
 *   - ProductText      → line-item product name (blank on summary/footer rows)
 *   - Textbox4         → product substatus, e.g. "WIP : In Design"
 *   - ProductDueDate   → "due1\ndue2" datetimes
 *   - Textbox51        → footer row total: "...Subtotal: $#####"
 */
function parseCorebridgeWIP(text) {
  const records = parseCSVRecords(text)

  let headerIdx = -1
  for (let i = 0; i < Math.min(30, records.length); i++) {
    const r = records[i]
    if (r.some((c) => /^OrderStatusText$/i.test(c.trim())) &&
        r.some((c) => /^Textbox121$/i.test(c.trim()))) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) throw new Error('Corebridge WIP: header row not found.')

  const headers = records[headerIdx].map((h) => h.trim())
  const col = (name) => headers.indexOf(name)
  const idx = {
    status: col('OrderStatusText'),
    refCustomer: col('Textbox121'),
    description: col('OrderText'),
    rep: col('SalespersonName'),
    amount: col('SubtotalAmount'),
    productText: col('ProductText'),
    substatus: col('Textbox4'),
    dueDate: col('ProductDueDate'),
    footer: col('Textbox51'),
  }
  if (idx.refCustomer < 0) {
    throw new Error('Corebridge WIP: missing the Textbox121 (customer/invoice) column.')
  }

  const firstLine = (v) => String(v || '').split(/\r?\n/)[0].trim()
  const stripStatus = (v) => firstLine(v).replace(/^Order\s*Status:\s*/i, '').trim()
  const INV_RX = /\b(?:INV|EST|QUOTE|Q)[-\s]?\d/i

  const orders = new Map()
  for (let i = headerIdx + 1; i < records.length; i++) {
    const cells = records[i]
    if (!cells || cells.every((c) => !c || !c.trim())) continue

    // Textbox121 stacks the customer name and the invoice/quote number.
    const parts = String(cells[idx.refCustomer] || '')
      .split(/\r?\n/).map((p) => p.trim()).filter(Boolean)
    if (!parts.length) continue
    let invoice = '', customer = ''
    for (const p of parts) {
      if (INV_RX.test(p)) { if (!invoice) invoice = p }
      else if (!customer) customer = p
    }
    if (!invoice && parts.length > 1) invoice = parts[parts.length - 1]
    if (!customer) customer = parts[0]
    const key = invoice || customer
    if (!key) continue

    let order = orders.get(key)
    if (!order) {
      order = {
        reference: invoice,
        customer,
        description: idx.description >= 0 ? firstLine(cells[idx.description]) : '',
        rep: idx.rep >= 0 ? firstLine(cells[idx.rep]) : '',
        status: idx.status >= 0 ? stripStatus(cells[idx.status]) : 'WIP',
        amount: 0,
        dueDates: [],
        substatuses: new Set(),
      }
      orders.set(key, order)
    }

    // Order $ amount: prefer the footer "Subtotal:" total, else SubtotalAmount.
    if (!order.amount) {
      let amt = 0
      if (idx.footer >= 0) {
        const m = String(cells[idx.footer] || '').match(/Subtotal:\s*\$?([\d,]+(?:\.\d+)?)/i)
        if (m) amt = parseAmount(m[1]) || 0
      }
      if (!amt && idx.amount >= 0) amt = parseAmount(firstLine(cells[idx.amount])) || 0
      if (amt) order.amount = amt
    }

    // Product line-item rows carry the substatus + due dates.
    const productText = idx.productText >= 0 ? String(cells[idx.productText] || '').trim() : ''
    if (productText) {
      const ss = idx.substatus >= 0 ? firstLine(cells[idx.substatus]) : ''
      if (ss) order.substatuses.add(ss)
      if (idx.dueDate >= 0) {
        for (const d of String(cells[idx.dueDate] || '').split(/\r?\n/)) {
          const iso = toISO(d)
          if (iso) order.dueDates.push(iso)
        }
      }
    }
  }

  const rows = []
  let total = 0
  let earliestOverall = null
  for (const o of orders.values()) {
    const earliest = o.dueDates.slice().sort()[0] || null
    const substatusList = Array.from(o.substatuses).join(', ')
    rows.push({
      date: earliest,
      customer: o.customer,
      amount: o.amount,
      reference: o.reference,
      status: substatusList || o.status || 'WIP',
      rep: o.rep,
      description: o.description,
    })
    total += o.amount
    if (earliest && (!earliestOverall || earliest < earliestOverall)) earliestOverall = earliest
  }

  if (rows.length === 0) throw new Error('Corebridge WIP: no orders found below the header.')
  return {
    rows,
    skipped: 0,
    total,
    weekOf: earliestOverall,
    columns: {},
    period: detectPeriod(text) || null,
  }
}

export function parsePipelineCSV(text) {
  if (isCorebridgeARAging(text)) {
    return parseCorebridgeARAging(text)
  }
  if (isCorebridgeWIP(text)) {
    return parseCorebridgeWIP(text)
  }

  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/)
  if (lines.length < 2) throw new Error('File is empty or has only a header row.')

  let headerRowIdx = -1
  let idxs = {}

  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const cells = splitCSVLine(lines[i]).map((h) => h.toLowerCase().replace(/^"|"$/g, ''))
    const dateIdx = findIdx(cells, DATE_KEYS)
    const custIdx = findIdx(cells, CUSTOMER_KEYS)
    const amtIdx = findIdx(cells, AMOUNT_KEYS)
    const refIdx = findIdx(cells, REFERENCE_KEYS)
    const hasIdentifier = custIdx >= 0 || refIdx >= 0
    const hasMetric = amtIdx >= 0 || dateIdx >= 0
    if (hasIdentifier && hasMetric) {
      headerRowIdx = i
      idxs = {
        date: dateIdx,
        customer: custIdx,
        amount: amtIdx,
        reference: refIdx,
        status: findIdx(cells, STATUS_KEYS),
        rep: findIdx(cells, REP_KEYS),
        description: findIdx(cells, DESCRIPTION_KEYS),
      }
      break
    }
  }

  if (headerRowIdx < 0) {
    const firstNonEmpty = lines.find((l) => l.trim()) || ''
    const preview = splitCSVLine(firstNonEmpty).slice(0, 8).filter(Boolean).join(', ')
    throw new Error(
      `Couldn't find required columns. Need a customer/reference column and an amount/date column. First non-empty row: ${preview}`
    )
  }

  const rows = []
  let skipped = 0
  let total = 0
  let earliestDate = null

  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const cells = splitCSVLine(lines[i])
    if (SUBTOTAL_RX.test(cells[0] || '')) { skipped++; continue }

    const date = idxs.date >= 0 ? toISO(cells[idxs.date]) : null
    const customer = idxs.customer >= 0 ? unwrapHyperlink(cells[idxs.customer]) : ''
    const amount = idxs.amount >= 0 ? (parseAmount(cells[idxs.amount]) || 0) : 0
    const reference = idxs.reference >= 0 ? unwrapHyperlink(cells[idxs.reference]) : ''
    const status = idxs.status >= 0 ? unwrapHyperlink(cells[idxs.status]) : ''
    const rep = idxs.rep >= 0 ? unwrapHyperlink(cells[idxs.rep]) : ''
    const description = idxs.description >= 0 ? unwrapHyperlink(cells[idxs.description]) : ''

    // Skip footer / grand-total rows: a real row must have a customer or reference.
    if (!customer && !reference) { skipped++; continue }

    rows.push({ date, customer, amount, reference, status, rep, description })
    total += amount
    if (date && (!earliestDate || date < earliestDate)) earliestDate = date
  }

  if (rows.length === 0) throw new Error('Header row found but no usable rows below it.')

  return {
    rows,
    skipped,
    total,
    weekOf: earliestDate,
    columns: idxs,
    period: detectPeriod(text) || null,
  }
}

export { classifyPeriodSpan }

export function buildPipelinePrompt(buckets) {
  const sections = []
  for (const [label, snapshot] of Object.entries(buckets)) {
    if (!snapshot) continue
    const period = snapshot.period
    const periodLine = period
      ? (period.kind === 'snapshot'
          ? `Snapshot as of ${period.start}`
          : `Period: ${period.start} → ${period.end} (${classifyPeriodSpan(period)})`)
      : `Period not specified in file (uploaded ${snapshot.uploadedAt.slice(0, 10)})`
    sections.push(
      `## ${label}\n` +
      `${periodLine}.\n` +
      `${snapshot.count} records, $${Math.round(snapshot.total).toLocaleString()}.\n` +
      `Top customers by amount:\n` +
      snapshot.rows
        .slice()
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10)
        .map((r) => `  - ${r.customer || '(unknown)'} ${r.reference ? `[${r.reference}]` : ''}: $${Math.round(r.amount).toLocaleString()}${r.status ? ` (${r.status})` : ''}`)
        .join('\n')
    )
  }

  return `You are reviewing the sales pipeline + production for a small sign-shop owner. Reports are from Corebridge (their sales/CRM software). IMPORTANT: each bucket below has its own reporting period — they may not be the same span (e.g., one could be YTD, another monthly). Do NOT compare absolute totals across buckets unless their periods match. Annualize or normalize as needed when reasoning about run-rate.

${sections.join('\n\n')}

Provide:
1. **Funnel health** — describe new → completed → paid for the periods given, and call out any period-mismatch caveats.
2. **WIP signals** — anything in WIP that should be a priority (large $, stale, blocked)?
3. **Customer concentration** — any single customer dominating new sales or WIP?
4. **Top 3 actions for next week** — concrete, prioritized.

Keep response under 500 words. Use markdown. If a section is missing data, say so briefly instead of fabricating.`
}
