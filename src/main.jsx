import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// Security: BizCore re-locks every time you leave it. Leaving the page (closing
// the tab, navigating away, or refreshing) clears the unlock cookie, so the
// next visit always requires the password again.
window.addEventListener('pagehide', () => {
  try { navigator.sendBeacon('/api/bizcore/logout') } catch { /* leaving anyway */ }
})
// If the page is restored from the back/forward cache, the unlock cookie is
// already gone — reload so the server shows the password screen.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) window.location.reload()
})

// BANK-07: one-time migration to BankSync-as-source-of-truth.
// On first load of the new bundle, detect legacy bizcore.bank.* keys
// in localStorage. Prompt the user once; on confirm, wipe the legacy
// data and trigger an initial backfill from the BankSync API.
//
// We mark the migration as performed in localStorage so this only
// runs once per browser, even if the user closes the prompt and
// reloads. The "migration_done" flag is independent of the data wipe
// so a deferral doesn't trigger a re-prompt every visit.
//
// The leading semicolon below defuses ASI: without it, JS parses the
// IIFE as a call to the return value of window.addEventListener(...)
// above, which is undefined → TypeError on app load.
;(function maybeMigrateBankStorage() {
  const MIGRATION_FLAG = 'bizcore.bank.migration_v1'
  if (localStorage.getItem(MIGRATION_FLAG) === 'done' || localStorage.getItem(MIGRATION_FLAG) === 'deferred') return
  // Find any legacy bank keys.
  const legacyKeys = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('bizcore.bank.') && k !== MIGRATION_FLAG) legacyKeys.push(k)
  }
  if (legacyKeys.length === 0) {
    // Nothing to migrate; mark done so future runs skip the check.
    try { localStorage.setItem(MIGRATION_FLAG, 'done') } catch { /* ignore */ }
    return
  }
  // Defer the prompt until after the React app mounts (avoids a
  // jarring alert before any UI is visible). One-shot.
  // Sequence: confirm → backfill → only wipe & mark done on success.
  // If the backfill fails the legacy localStorage is left intact so
  // the user isn't stranded with no bank data.
  const promptUser = async () => {
    const msg = [
      'BizCore migration: switching bank data to live BankSync source',
      '',
      `${legacyKeys.length} locally-cached bank statement upload${legacyKeys.length === 1 ? '' : 's'} found.`,
      '',
      'OK = pull a fresh backfill from BankSync; on success, clear local cache and reload.',
      '(Original PDFs on your computer are untouched — re-uploadable as fallback if needed.)',
      '',
      'Cancel = defer; you can run the migration later from the BankAccounts page.',
    ].join('\n')
    if (!window.confirm(msg)) {
      try { localStorage.setItem(MIGRATION_FLAG, 'deferred') } catch { /* ignore */ }
      return
    }
    // Trigger backfill FIRST. Only wipe + mark done on success.
    let body
    try {
      const r = await fetch('/api/banksync/backfill', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ days: 730 }),
      })
      body = await r.json().catch(() => ({}))
      if (!r.ok) {
        throw new Error(body.error || `HTTP ${r.status}`)
      }
    } catch (err) {
      window.alert(
        'Backfill failed: ' + err.message + '\n\n' +
        'Migration deferred — your local PDF data is unchanged. ' +
        'Fix the underlying issue (BankSync env vars / API access / account mapping), then retry from the BankAccounts page.'
      )
      try { localStorage.setItem(MIGRATION_FLAG, 'deferred') } catch { /* ignore */ }
      return
    }
    // Backfill succeeded — safe to clear the local cache.
    for (const k of legacyKeys) {
      try { localStorage.removeItem(k) } catch { /* ignore */ }
    }
    try { localStorage.setItem(MIGRATION_FLAG, 'done') } catch { /* ignore */ }
    window.alert(
      `Backfill complete: ${body.transactions_new || 0} transactions persisted across ${body.pf_accounts_found || 0} PF accounts.\n\n` +
      (body.unmapped?.length ? `${body.unmapped.length} BankSync account(s) not recognized as PF — see the BankAccounts page.\n\n` : '') +
      'Reloading BizCore to pull live data...'
    )
    window.location.reload()
  }
  // Wait one tick so the React tree paints before the alert.
  setTimeout(promptUser, 1500)
})()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
