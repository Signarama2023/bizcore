import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import Finance from './pages/Finance'
import Pipeline from './pages/Pipeline'
import SalesTeam from './pages/SalesTeam'
// Debts page kept on disk (pages/Debts.jsx) but not mounted — sidebar
// nav entry and route map removed. Re-enable by adding it back here
// and to the Sidebar NAV array.
import Evaluation from './pages/Evaluation'
import Settings from './pages/Settings'
import './styles/globals.css'

const PAGES = {
  dashboard: Dashboard,
  finance: Finance,
  pipeline: Pipeline,
  'sales-team': SalesTeam,
  evaluation: Evaluation,
  settings: Settings,
}

export default function App() {
  const [activePage, setActivePage] = useState('dashboard')
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('bizcore.theme') || 'light' } catch { return 'light' }
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem('bizcore.theme', theme) } catch { /* quota */ }
  }, [theme])

  const connections = { quickbooks: false, corebridge: false }
  const Page = PAGES[activePage]
  return (
    <div className="app">
      <Sidebar
        active={activePage}
        onSelect={setActivePage}
        connections={connections}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      />
      <main className="content">
        <Page theme={theme} />
      </main>
    </div>
  )
}
