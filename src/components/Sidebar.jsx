const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'finance', label: 'Finance', source: 'quickbooks' },
  { id: 'pipeline', label: 'Pipeline', source: 'corebridge' },
  { id: 'sales-team', label: 'Sales Team', source: 'corebridge' },
  // Debts tab removed from nav. Page file + /api/debts endpoints +
  // auto-matcher are intact — Dashboard KPIs still read debtsSummary().
  { id: 'evaluation', label: 'Evaluation' },
  { id: 'settings', label: 'Settings' },
]

const SOURCES = [
  { key: 'quickbooks', label: 'QuickBooks' },
  { key: 'corebridge', label: 'Corebridge' },
]

export default function Sidebar({ active, onSelect, connections = {}, theme = 'light', onToggleTheme }) {
  return (
    <nav className="sidebar">
      <div className="sidebar-brand">BizCore</div>
      {NAV.map((item) => (
        <button
          key={item.id}
          className={active === item.id ? 'active' : ''}
          onClick={() => onSelect(item.id)}
        >
          <span>{item.label}</span>
          {item.source && (
            <span className={`status-dot ${connections[item.source] ? 'ok' : ''}`} />
          )}
        </button>
      ))}
      <div className="sidebar-section-label">Data Sources</div>
      {SOURCES.map((s) => (
        <div key={s.key} className="row between" style={{ padding: '6px 12px' }}>
          <span className={`source-badge ${s.key}`}>{s.label}</span>
          <span className={`status-dot ${connections[s.key] ? 'ok' : ''}`} />
        </div>
      ))}
      <div className="sidebar-section-label">Appearance</div>
      <button onClick={onToggleTheme}>
        <span>{theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'}</span>
      </button>

      <div className="sidebar-section-label">Security</div>
      {/* Browser HTTP Basic Auth: hitting /api/bizcore/logout returns a 401
          which causes most browsers to discard the cached Basic credentials.
          Then we reload the root, which re-prompts. Closing the tab also
          works if the browser doesn't honor the 401. */}
      <button
        onClick={() => {
          fetch('/api/bizcore/logout', { method: 'POST' })
            .finally(() => { window.location.href = '/' })
        }}
        title="Require the BizCore password again"
      >
        <span>🔒 Lock BizCore</span>
      </button>
    </nav>
  )
}
