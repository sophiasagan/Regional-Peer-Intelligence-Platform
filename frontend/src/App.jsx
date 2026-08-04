import React, { useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom'
import CreditQuality    from './pages/CreditQuality'
import MarketMap        from './pages/MarketMap'
import NLQuery          from './pages/NLQuery'
import PeerComparison   from './pages/PeerComparison'
import Reports          from './pages/Reports'
import PeerGroupSetup   from './pages/PeerGroupSetup'
import Setup            from './pages/Setup'
import Home             from './pages/Home'

const DEMO_TOKEN = import.meta.env.VITE_DEMO_TOKEN ?? 'demo';

// Ask Intelligence is hidden by default while the semantic layer is incomplete.
// Set VITE_SHOW_ASK_INTELLIGENCE=true in .env to re-enable the nav link.
// The route stays mounted regardless so the page can be accessed directly for testing.
const _SHOW_ASK = import.meta.env.VITE_SHOW_ASK_INTELLIGENCE === 'true';

const NAV = [
  { to: '/home',             icon: '🏠', label: 'Home'             },
  { to: '/credit-quality',   icon: '📊', label: 'Credit Quality'   },
  { to: '/market-map',       icon: '🗺',  label: 'Market Map'       },
  { to: '/peer-comparison',  icon: '⚖️',  label: 'Peer Comparison'  },
  ...(_SHOW_ASK ? [{ to: '/query', icon: '💬', label: 'Ask Intelligence' }] : []),
  { to: '/reports',          icon: '📄', label: 'Reports'          },
  { to: '/peer-group-setup', icon: '🔀', label: 'Peer Group Setup' },
]

function Sidebar({ charterNumber, onReset }) {
  const navigate = useNavigate();
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">Magnus</div>
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
      <div className="sidebar-footer">
        <div className="sidebar-charter">Charter {charterNumber}</div>
        <button
          className="sidebar-change-btn"
          onClick={() => { onReset(); navigate('/setup'); }}
        >
          Change institution
        </button>
      </div>
    </aside>
  )
}

export default function App() {
  const [charterNumber, setCharterNumber] = useState(() => {
    const stored = localStorage.getItem('p76_charter_number');
    return stored ? parseInt(stored, 10) : null;
  });

  function handleSetCharter(num) {
    localStorage.setItem('p76_charter_number', String(num));
    setCharterNumber(num);
  }

  function handleReset() {
    localStorage.removeItem('p76_charter_number');
    localStorage.removeItem('p76_peer_charters');
    localStorage.removeItem('p76_peer_group_label');
    setCharterNumber(null);
  }

  return (
    <BrowserRouter>
      <Routes>
        {/* ── Setup (no sidebar, full-screen) ── */}
        <Route
          path="/setup"
          element={
            charterNumber
              ? <Navigate to="/peer-group-setup" replace />
              : <Setup onComplete={handleSetCharter} />
          }
        />

        {/* ── App shell (requires charter number) ── */}
        {charterNumber ? (
          <Route
            path="/*"
            element={
              <div className="app-shell">
                <Sidebar charterNumber={charterNumber} onReset={handleReset} />
                <div className="main-area">
                  <div className="page-body">
                    <Routes>
                      <Route path="/"                element={<Navigate to="/home" replace />} />
                      <Route path="/home"            element={<Home charterNumber={charterNumber} token={DEMO_TOKEN} onReset={handleReset} />} />
                      <Route path="/peer-group-setup" element={<PeerGroupSetup charterNumber={charterNumber} token={DEMO_TOKEN} />} />
                      <Route path="/credit-quality"  element={<CreditQuality charterNumber={charterNumber} token={DEMO_TOKEN} />} />
                      <Route path="/market-map"      element={<MarketMap charterNumber={charterNumber} token={DEMO_TOKEN} />} />
                      <Route path="/peer-comparison" element={<PeerComparison charterNumber={charterNumber} token={DEMO_TOKEN} />} />
                      <Route path="/query"           element={<NLQuery charterNumber={charterNumber} token={DEMO_TOKEN} />} />
                      <Route path="/reports"         element={<Reports charterNumber={charterNumber} token={DEMO_TOKEN} />} />
                      <Route path="*"                element={<Navigate to="/home" replace />} />
                    </Routes>
                  </div>
                </div>
              </div>
            }
          />
        ) : (
          <Route path="*" element={<Navigate to="/setup" replace />} />
        )}
      </Routes>
    </BrowserRouter>
  )
}
