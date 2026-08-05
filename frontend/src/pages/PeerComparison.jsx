/**
 * PeerComparison — full peer comparison page.
 *
 * Peer group toggle matches Credit Quality's TopBar convention (P76 rule).
 * Select peers panel is provided by PeerComparisonTable (same as CQ page).
 * Callahan conventions: star scale, top/bottom decile coloring, CSV download.
 */

import React, { useState, useEffect } from 'react';
import PeerComparisonTable from '../components/PeerComparisonTable';

const API = import.meta.env.VITE_API_URL ?? '';

const STANDARD_PEER_GROUPS = [
  { key: 'REGIONAL',   label: 'Regional peers' },
  { key: 'ASSET_SIZE', label: 'National peers'  },
  { key: 'STATE',      label: 'State'           },
];

const PERIOD_OPTIONS = [
  { label: '2026Q1' },
  { label: '2025Q4' },
  { label: '2025Q3' },
  { label: '2025Q2' },
  { label: '2025Q1' },
];

function usePeerComparison(charterNumber, period, peerGroup, token, customCharters) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!charterNumber) return;
    setLoading(true);
    setData(null);
    const params = new URLSearchParams({ period, peer_group: peerGroup });
    if (customCharters?.length) params.set('custom_charters', customCharters.join(','));
    fetch(`${API}/peer-comparison/${charterNumber}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setData(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [charterNumber, period, peerGroup, token, customCharters]);

  return { data, loading };
}

function loadSavedPeerCharters() {
  try {
    const stored = localStorage.getItem('p76_peer_charters');
    return stored ? JSON.parse(stored) : null;
  } catch { return null; }
}

export default function PeerComparison({ charterNumber, token }) {
  const [period,         setPeriod]         = useState('2026Q1');
  // peerGroup can be 'REGIONAL' | 'ASSET_SIZE' | 'STATE' | 'CUSTOM'
  const [peerGroup,      setPeerGroup]      = useState('REGIONAL');
  // customCharters is PRESERVED when the user switches to a standard tab,
  // so they can return to "Custom" without re-selecting.
  const [customCharters, setCustomCharters] = useState(loadSavedPeerCharters);

  const effectivePeerGroup = peerGroup === 'CUSTOM' ? 'CUSTOM' : peerGroup;

  const { data, loading } = usePeerComparison(
    charterNumber, period, effectivePeerGroup, token,
    peerGroup === 'CUSTOM' ? customCharters : null,
  );

  function handleTabChange(key) {
    if (key === 'CUSTOM') {
      // Re-activate saved custom selection — if none yet, open the panel via table
      setPeerGroup('CUSTOM');
    } else {
      // Switch to standard group; keep customCharters alive for later return
      setPeerGroup(key);
    }
  }

  function handleCustomCharters(charters) {
    if (!charters) {
      // Reset: clear custom selection and fall back to REGIONAL
      setCustomCharters(null);
      setPeerGroup('REGIONAL');
    } else {
      setCustomCharters(charters);
      setPeerGroup('CUSTOM');
    }
  }

  const hasCustom      = customCharters?.length > 0;
  const metrics        = data?.metrics ?? [];
  const peerGroupLabel = data?.peer_group_label ?? '';
  const peerCount      = data?.peer_count;
  const instName       = data?.institution_name;

  return (
    <div className="peer-comparison-page">

      {/* ── Top bar ── */}
      <header className="cq-topbar">
        <div className="topbar-left">
          <h1 className="page-title">Peer Comparison</h1>
          {instName && <span className="inst-pill">{instName}</span>}
        </div>

        <div className="topbar-center">
          <span className="topbar-label">Peer group</span>
          <div className="peer-toggle" role="group" aria-label="Peer group">
            {STANDARD_PEER_GROUPS.map(({ key, label }) => (
              <button
                key={key}
                className={`toggle-btn ${peerGroup === key ? 'active' : ''}`}
                onClick={() => handleTabChange(key)}
              >
                {label}
              </button>
            ))}
            {/* Custom tab — only visible once the user has made a custom selection */}
            {hasCustom && (
              <button
                className={`toggle-btn toggle-btn--custom ${peerGroup === 'CUSTOM' ? 'active' : ''}`}
                onClick={() => handleTabChange('CUSTOM')}
                title={`Custom selection · ${customCharters.length} institution${customCharters.length === 1 ? '' : 's'}`}
              >
                Custom ({customCharters.length})
              </button>
            )}
          </div>
        </div>

        <div className="topbar-right">
          <span className="topbar-label">Period</span>
          <div className="period-selector" role="group" aria-label="Period">
            {PERIOD_OPTIONS.map(({ label }) => (
              <button
                key={label}
                className={`period-btn ${period === label ? 'active' : ''}`}
                onClick={() => setPeriod(label)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {loading && <div className="cq-loading">Loading…</div>}

      {/* ── Comparison table with built-in Select Peers panel ── */}
      <div className="cq-body">
        <PeerComparisonTable
          metrics={metrics}
          charterNumber={charterNumber}
          period={period}
          peerGroup={peerGroup}
          peerGroupLabel={peerGroupLabel}
          peerCount={peerCount}
          token={token}
          customCharters={peerGroup === 'CUSTOM' ? customCharters : null}
          onCustomCharters={handleCustomCharters}
        />
      </div>

    </div>
  );
}
