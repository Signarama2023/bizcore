/**
 * Corebridge Financial adapter. Calls the BizCore backend proxy.
 * Corebridge has no public API — credentials are obtained via a Corebridge rep.
 *
 * @module adapters/corebridge
 */

const BASE = '/api/corebridge'

/**
 * Fetch all active policies.
 * @returns {Promise<Array<{ id: string, kind: string, carrier: string, premium: number, renewal: string, status: string }>>}
 */
export async function fetchPolicies() {
  const res = await fetch(`${BASE}/policies`)
  if (!res.ok) throw new Error(`Corebridge fetchPolicies: ${res.status}`)
  return res.json()
}

/**
 * Fetch full details for a specific policy.
 * @param {string} policyId
 * @returns {Promise<object>}
 */
export async function fetchPolicyDetails(policyId) {
  const res = await fetch(`${BASE}/policies/${encodeURIComponent(policyId)}`)
  if (!res.ok) throw new Error(`Corebridge fetchPolicyDetails: ${res.status}`)
  return res.json()
}

/**
 * Fetch the premium payment schedule for a policy.
 * @param {string} policyId
 * @returns {Promise<Array<{ date: string, amount: number, status: string }>>}
 */
export async function fetchPremiumSchedule(policyId) {
  const res = await fetch(`${BASE}/policies/${encodeURIComponent(policyId)}/premium-schedule`)
  if (!res.ok) throw new Error(`Corebridge fetchPremiumSchedule: ${res.status}`)
  return res.json()
}

/**
 * Fetch upcoming renewals within a horizon.
 * @param {{ withinDays?: number }} [params]
 * @returns {Promise<Array<{ policyId: string, kind: string, renewal: string, premium: number }>>}
 */
export async function fetchRenewals(params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}/renewals${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`Corebridge fetchRenewals: ${res.status}`)
  return res.json()
}
