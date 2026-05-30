// The three connections that drive the business snapshot. After the
// STRIP-01..03 cleanup, BizCore only reads from these — everything
// else (Weekly Log, QuickBooks workbook, Sales History CSV) has been
// removed as redundant.
const SOURCES = [
  {
    key: 'corebridge',
    label: 'Corebridge (sales / CRM / POS)',
    auth: 'Bearer token',
    envVars: ['COREBRIDGE_API_TAG', 'COREBRIDGE_ACCOUNT_ID'],
    steps: [
      'Obtain a Bearer API tag from your Corebridge account.',
      'Reference the API spec at /swagger/docs/V1.',
      'Paste the tag into server-side .env.',
      'Pipeline page auto-syncs Newly Created / Completed / Paid / WIP buckets.',
    ],
  },
  {
    key: 'banksync',
    label: 'Bank (BankSync / Plaid)',
    auth: 'API key + per-bank linking',
    envVars: ['BANKSYNC_API_KEY', 'BANKSYNC_AUTO_SYNC', 'BANKSYNC_AUTO_SYNC_HOUR_LOCAL'],
    steps: [
      'Sign up for a BankSync (Plaid-backed) account and obtain an API key.',
      'Paste BANKSYNC_API_KEY into server-side .env.',
      'Link each Profit First bank account through the BankSync portal.',
      'Set BANKSYNC_AUTO_SYNC=1 to enable the daily 6am cron.',
      'On the Bank Accounts panel (Finance page), click "Full backfill (730d)" once to seed history.',
    ],
  },
  {
    key: 'gusto',
    label: 'Payroll (Gusto)',
    auth: 'Bearer token',
    envVars: ['GUSTO_API_TOKEN', 'GUSTO_COMPANY_ID', 'GUSTO_AUTO_SYNC'],
    steps: [
      'If you use Gusto: obtain an API token and your company UUID from the Gusto Embedded portal.',
      'Paste GUSTO_API_TOKEN + GUSTO_COMPANY_ID into server-side .env.',
      'Set GUSTO_AUTO_SYNC=1 to enable the daily 6am cron.',
      'Click "Sync from Gusto" on the Payroll panel to seed history.',
      'NOT on Gusto? No setup required — upload a Payroll Journal / Register PDF or CSV on the Payroll panel. Works for ADP, Paychex, QuickBooks Payroll, Patriot, OnPay, Rippling, and any other provider.',
    ],
  },
]

export default function Settings() {
  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Data source connections and setup steps.</p>

      <div className="grid-auto">
        {SOURCES.map((s) => (
          <div className="card" key={s.key}>
            <div className="row between" style={{ marginBottom: 12 }}>
              <span className={`source-badge ${s.key}`}>{s.label}</span>
              <span className="pill red">Not connected</span>
            </div>
            <div className="dim" style={{ marginBottom: 4 }}>
              Auth: <span className="mono">{s.auth}</span>
            </div>
            <div className="section-label" style={{ marginTop: 14 }}>Environment Variables</div>
            <ul className="mono dim" style={{ fontSize: 12, paddingLeft: 16, margin: '6px 0 12px' }}>
              {s.envVars.map((v) => <li key={v}>{v}</li>)}
            </ul>
            <div className="section-label">Setup Steps</div>
            <ol className="dim" style={{ paddingLeft: 18, margin: '6px 0 0', fontSize: 13 }}>
              {s.steps.map((step, i) => <li key={i} style={{ marginBottom: 4 }}>{step}</li>)}
            </ol>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 24 }}>
        <div className="section-label">AI Analysis (Anthropic Claude)</div>
        <p className="dim" style={{ marginTop: 8 }}>
          Finance, Pipeline and bank-PDF extraction call Claude through the
          server proxy at <span className="mono">/api/claude/messages</span>.
          The API key lives on the server only (env{' '}
          <span className="mono">ANTHROPIC_API_KEY</span>) — nothing is
          shipped to the browser bundle.
        </p>
        <p style={{ marginTop: 8, fontSize: 12 }}>
          <span className="pill green">secure</span>{' '}
          <span className="dim">
            The proxy is gated behind admin + the BizCore unlock cookie, so
            an attacker who somehow loads BizCore can&apos;t turn it into a
            free Claude pool.
          </span>
        </p>
      </div>
    </div>
  )
}
