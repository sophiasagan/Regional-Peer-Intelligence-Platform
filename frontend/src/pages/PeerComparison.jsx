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

const PEER_GROUPS = [
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

export default function PeerComparison({ charterNumber, token }) {
  const [period,         setPeriod]         = useState('2026Q1');
  const [peerGroup,      setPeerGroup]      = useState('REGIONAL');
  const [customCharters, setCustomCharters] = useState(null);

  const { data, loading } = usePeerComparison(
    charterNumber, period, peerGroup, token, customCharters,
  );

  function handlePeerGroupChange(group) {
    setPeerGroup(group);
    setCustomCharters(null);   // reset custom selection when switching group type
  }

  function handleCustomCharters(charters) {
    if (!charters) {
      setCustomCharters(null);
    } else {
      setCustomCharters(charters);
      // Custom selection is treated as CUSTOM group type — keep peer_group as base
    }
  }

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
            {PEER_GROUPS.map(({ key, label }) => (
              <button
                key={key}
                className={`toggle-btn ${peerGroup === key ? 'active' : ''}`}
                onClick={() => handlePeerGroupChange(key)}
              >
                {label}
              </button>
            ))}
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
          peerGroup={customCharters ? 'CUSTOM' : peerGroup}
          peerGroupLabel={peerGroupLabel}
          peerCount={peerCount}
          onCustomCharters={handleCustomCharters}
        />
      </div>

    </div>
  );
}
