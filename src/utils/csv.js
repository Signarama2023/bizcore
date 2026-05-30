/**
 * Tiny CSV primitives extracted from the now-removed utils/sales.js
 * during the STRIP-01 cleanup. Two helpers, shared by:
 *   - utils/pipeline.js  → parses Corebridge AR aging CSV uploads
 *   - utils/bank.js      → parses fallback PDF/CSV statements
 *                          (the fallback path itself goes away in
 *                          STRIP-04 — bank.js can drop this import
 *                          then, or be removed entirely)
 *
 * Kept here rather than inlined so behaviour stays identical to
 * what the old sales.js exported (same dollar / accounting / quoted-
 * field semantics).
 */

/**
 * Parse a single CSV line into trimmed cell strings. Handles
 * double-quoted fields and escaped quotes ("" → ") per RFC 4180.
 */
export function splitCSVLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQ = false
      else cur += c
    } else {
      if (c === '"') inQ = true
      else if (c === ',') { out.push(cur); cur = '' }
      else cur += c
    }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

/**
 * Parse an amount cell tolerantly. Handles ($1,234.56) accounting
 * negatives, currency symbols, thousands separators, and whitespace.
 * Returns NaN on anything unparseable so callers can distinguish "no
 * value" from "zero".
 */
export function parseAmount(s) {
  if (s == null || s === '') return NaN
  const cleaned = String(s).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : NaN
}
