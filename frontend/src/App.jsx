import React from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom'
import CreditQuality    from './pages/CreditQuality'
import MarketMap        from './pages/MarketMap'
import NLQuery          from './pages/NLQuery'
import PeerComparison   from './pages/PeerComparison'
import Reports          from './pages/Reports'
import CallahanMigration from './pages/CallahanMigration'

const NAV = [
  { to: '/credit-quality',      icon: '📊', label: 'Credit Quality'    },
  { to: '/market-map',          icon: '🗺',  label: 'Market Map'        },
  { to: '/peer-comparison',     icon: '⚖️',  label: 'Peer Comparison'   },
  { to: '/query',               icon: '💬', label: 'Ask Intelligence'  },
  { to: '/reports',             icon: '📄', label: 'Reports'           },
  { to: '/onboarding/callahan', icon: '🔀', label: 'Peer Group Setup'  },
]

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">P76 Intelligence</div>
      <nav className="sidebar-nav">
        {NAV.map(({ to, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
          >
            <span className="nav-icon">{icon}</span>
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <Sidebar />
        <div className="main-area">
          <div className="page-body">
            <Routes>
              <Route path="/"                     element={<Navigate to="/credit-quality" replace />} />
              <Route path="/credit-quality"       element={<CreditQuality />} />
              <Route path="/market-map"           element={<MarketMap />} />
              <Route path="/peer-comparison"      element={<PeerComparison />} />
              <Route path="/query"                element={<NLQuery />} />
              <Route path="/reports"              element={<Reports />} />
              <Route path="/onboarding/callahan"  element={<CallahanMigration />} />
              <Route path="*"                     element={<Navigate to="/credit-quality" replace />} />
            </Routes>
          </div>
        </div>
      </div>
    </BrowserRouter>
  )
}
