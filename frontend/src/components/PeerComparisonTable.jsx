/**
 * PeerComparisonTable — full-metric peer comparison grid. Matches Callahan FPR color coding.
 *
 * Row color (exact Callahan FPR convention):
 *   percentile ≥ 90 → green row
 *   percentile < 10 → red row
 *
 * Stars: 1–5 on every row (Callahan scale).
 * Download: full table as CSV — non-negotiable (P76 / Callahan rule).
 */

import React, { useCallback, useEffect, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

function Stars({ count }) {
  if (count == null) return <span className="stars-empty">—</span>;
  return (
    <span className="stars" aria-label={`${count} of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < count ? 'star filled' : 'star empty'}>★</span>
      ))}
    </span>
  );
}

function fmt(value, unit) {
  if (value == null || (typeof value === 'number' && isNaN(value))) return '—';
  switch (unit) {
    case '%':     return `${(value * 100).toFixed(2)}%`;
    case 'x':     return `${value.toFixed(2)}x`;
    case '$':     return value >= 1e9
                    ? `$${(value / 1e9).toFixed(2)}B`
                    : `$${(value / 1e6).toFixed(1)}M`;
    case 'count': return Math.round(value).toLocaleString();
    default:      return value.toFixed(4);
  }
}

function fmtAssets(v) {
  if (!v) return '';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${v.toLocaleString()}`;
}

function downloadCsv(metrics, charterNumber, period, peerGroupLabel) {
  if (!metrics?.length) return;
  const meta    = `Peer Group: ${peerGroupLabel},Charter: ${charterNumber},Period: ${period}`;
  const headers = 'Metric,Your Value,Peer Median,Top Decile (90th),Bottom Decile (10th),Percentile,Stars,Adverse';
  const rows    = metrics.map(m => [
    `"${m.callahan_label}"`,
    m.institution_value ?? '',
    m.peer_median        ?? '',
    m.peer_p90           ?? '',
    m.peer_p10           ?? '',
    m.percentile_rank != null ? m.percentile_rank.toFixed(1) : '',
    m.stars              ?? '',
    m.is_adverse ? 'Y' : 'N',
  ].join(','));
  const blob = new Blob([[meta, '', headers, ...rows].join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `peer_comparison_${charterNumber}_${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Select Peers panel ────────────────────────────────────────────────────────

function SelectPeersPanel({ charterNumber, period, peerGroup, onApply, onClose }) {
  const [data,        setData]        = useState(null);
  const [checked,     setChecked]     = useState(new Set());
  const [loading,     setLoading]     = useState(true);
  const [expandBelow, setExpandBelow] = useState(false);
  const [expandAbove, setExpandAbove] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      period,
      peer_group:    peerGroup,
      expand_below:  expandBelow ? 1 : 0,
      expand_above:  expandAbove ? 1 : 0,
    });
    fetch(`${API}/peer-comparison/${charterNumber}/peer-list?${params}`)
      .then(r => r.ok ? r.json() : null)
      .then(res => {
        if (!res) return;
        setData(res);
        // Base-group institutions start checked; adjacent-tier ones start unchecked
        setChecked(prev => {
          const next = new Set(prev);
          res.institutions.forEach(i => {
            if (i.in_base_group && !next.has(i.charter_number)) next.add(i.charter_number);
          });
          return next;
        });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [charterNumber, period, peerGroup, expandBelow, expandAbove]);

  const institutions = data?.institutions ?? [];

  function toggleAll(val) {
    setChecked(val ? new Set(institutions.map(i => i.charter_number)) : new Set());
  }
  function toggle(ch) {
    setChecked(prev => {
      const next = new Set(prev);
      next.has(ch) ? next.delete(ch) : next.add(ch);
      return next;
    });
  }

  const allChecked  = institutions.length > 0 && checked.size === institutions.length;
  const someChecked = checked.size > 0 && checked.size < institutions.length;

  // Group by tier for section headers
  const byTier = [];
  let lastTier = null;
  for (const inst of institutions) {
    if (inst.tier_label !== lastTier) {
      byTier.push({ type: 'header', label: inst.tier_label, isBase: inst.is_base_tier });
      lastTier = inst.tier_label;
    }
    byTier.push({ type: 'inst', inst });
  }

  return (
    <div className="select-peers-panel">
      <div className="sp-header">
        <span className="sp-title">Select peer institutions</span>
        <button className="sp-close" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {/* Tier expansion toggles */}
      <div className="sp-tier-bar">
        <button
          className={`sp-tier-btn ${expandBelow ? 'sp-tier-btn--on' : ''}`}
          disabled={!data?.available_below}
          onClick={() => setExpandBelow(v => !v)}
          title={data?.below_tier_label ? `Include ${data.below_tier_label}` : 'No smaller tier'}
        >
          ← {data?.below_tier_label ?? 'Tier below'}
        </button>

        <span className="sp-tier-current" title="Current asset tier">
          {data?.base_tier_label ?? '…'}
        </span>

        <button
          className={`sp-tier-btn ${expandAbove ? 'sp-tier-btn--on' : ''}`}
          disabled={!data?.available_above}
          onClick={() => setExpandAbove(v => !v)}
          title={data?.above_tier_label ? `Include ${data.above_tier_label}` : 'No larger tier'}
        >
          {data?.above_tier_label ?? 'Tier above'} →
        </button>
      </div>

      {loading ? (
        <div className="sp-loading">Loading…</div>
      ) : (
        <>
          <div className="sp-controls">
            <label className="sp-check-all">
              <input
                type="checkbox"
                checked={allChecked}
                ref={el => el && (el.indeterminate = someChecked)}
                onChange={e => toggleAll(e.target.checked)}
              />
              {checked.size} of {institutions.length} selected
            </label>
          </div>

          <ul className="sp-list">
            {byTier.map((item, i) =>
              item.type === 'header' ? (
                <li key={`h-${item.label}`} className={`sp-tier-header ${item.isBase ? '' : 'sp-tier-header--adjacent'}`}>
                  {item.label}{item.isBase ? ' (base tier)' : ''}
                </li>
              ) : (
                <li key={item.inst.charter_number} className="sp-item">
                  <label className="sp-label">
                    <input
                      type="checkbox"
                      checked={checked.has(item.inst.charter_number)}
                      onChange={() => toggle(item.inst.charter_number)}
                    />
                    <span className="sp-name">{item.inst.institution_name}</span>
                    <span className="sp-meta muted">
                      {item.inst.state}{item.inst.total_assets ? ` · ${fmtAssets(item.inst.total_assets)}` : ''}
                    </span>
                  </label>
                </li>
              )
            )}
          </ul>

          <div className="sp-footer">
            <button
              className="cm-btn cm-btn--primary"
              disabled={checked.size === 0}
              onClick={() => onApply([...checked])}
            >
              Apply ({checked.size})
            </button>
            <button className="cm-btn cm-btn--ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PeerComparisonTable({
  metrics = [],
  charterNumber,
  period,
  peerGroup = 'REGIONAL',
  peerGroupLabel = '',
  peerCount,
  onCustomCharters,   // (charters: number[] | null) => void
}) {
  const [showPanel, setShowPanel] = useState(false);

  const handleDownload = useCallback(
    () => downloadCsv(metrics, charterNumber, period, peerGroupLabel),
    [metrics, charterNumber, period, peerGroupLabel],
  );

  function handleApply(selected) {
    setShowPanel(false);
    onCustomCharters?.(selected);
  }

  function handleReset() {
    onCustomCharters?.(null);
  }

  const isCustom = peerGroupLabel.startsWith('Custom');

  return (
    <div className="peer-comparison-table-wrapper">
      <div className="table-header">
        <div className="table-title-group">
          <h3>Peer Comparison</h3>
          <span className="peer-group-pill">{peerGroupLabel}</span>
          {peerCount != null && (
            <span className="peer-count-label">{peerCount} institutions</span>
          )}
          <button
            className="cm-link-btn"
            onClick={() => setShowPanel(v => !v)}
            style={{ fontSize: 12 }}
          >
            {showPanel ? 'Close' : 'Select peers'}
          </button>
          {isCustom && (
            <button className="cm-link-btn" onClick={handleReset} style={{ fontSize: 12, color: '#757575' }}>
              Reset
            </button>
          )}
        </div>
        <button
          className="download-btn"
          onClick={handleDownload}
          disabled={!metrics.length}
          title="Download CSV"
        >
          Download CSV
        </button>
      </div>

      {showPanel && charterNumber && period && (
        <SelectPeersPanel
          charterNumber={charterNumber}
          period={period}
          peerGroup={isCustom ? 'REGIONAL' : peerGroup}
          onApply={handleApply}
          onClose={() => setShowPanel(false)}
        />
      )}

      {metrics.length === 0 ? (
        <p className="table-empty">No comparison data available.</p>
      ) : (
        <table className="peer-comparison-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="numeric-col">Your Value</th>
              <th className="numeric-col">Peer Median</th>
              <th className="numeric-col">Top Decile</th>
              <th className="numeric-col">Bottom Decile</th>
              <th className="numeric-col">Percentile</th>
              <th>Stars</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map(m => {
              const isTop    = m.percentile_rank != null && m.percentile_rank >= 90;
              const isBottom = m.percentile_rank != null && m.percentile_rank < 10;
              return (
                <tr
                  key={m.metric_name}
                  className={`metric-row${isTop ? ' row-top-decile' : isBottom ? ' row-bottom-decile' : ''}`}
                >
                  <td className="metric-name-cell">
                    <span className="polarity-indicator" title={m.is_adverse ? 'Adverse metric' : 'Positive metric'}>
                      {m.is_adverse ? '↓' : '↑'}
                    </span>
                    {m.callahan_label}
                  </td>
                  <td className="numeric-col">{fmt(m.institution_value, m.unit)}</td>
                  <td className="numeric-col">{fmt(m.peer_median,       m.unit)}</td>
                  <td className="numeric-col">{fmt(m.peer_p90,          m.unit)}</td>
                  <td className="numeric-col">{fmt(m.peer_p10,          m.unit)}</td>
                  <td className="numeric-col">
                    {m.percentile_rank != null ? `${Math.round(m.percentile_rank)}th` : '—'}
                  </td>
                  <td><Stars count={m.stars} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
