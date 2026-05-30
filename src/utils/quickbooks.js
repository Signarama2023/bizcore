/**
 * QuickBooks Online client — talks to the team-calendar server's QuickBooks
 * OAuth proxy. The Client ID/Secret and OAuth tokens live server-side; this
 * module only checks status and triggers connect/disconnect.
 */

/** Connection status: { configured, connected, realmId, connectedAt, env }. */
export async function quickbooksStatus() {
  try {
    const r = await fetch('/api/quickbooks/status')
    if (!r.ok) return { configured: false, connected: false }
    return await r.json()
  } catch {
    return { configured: false, connected: false }
  }
}

/** Disconnect — clears the stored QuickBooks tokens on the server. */
export async function quickbooksDisconnect() {
  const r = await fetch('/api/quickbooks/disconnect', { method: 'POST' })
  if (!r.ok) {
    const b = await r.json().catch(() => ({}))
    throw new Error(b.error || `Disconnect failed (${r.status})`)
  }
  return r.json()
}
