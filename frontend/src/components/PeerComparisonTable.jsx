/**
 * PeerComparisonTable — full-metric peer comparison grid. Matches Callahan FPR color coding.
 *
 * Row color (exact Callahan FPR convention):
 *   percentile ≥ 90 → green row
 *   percentile < 10 → red row
 *
 * Stars: 1–5 on every row (Callahan scale).
 * Download: full table as CSV — non-negotiable (P76 / Callahan rule).
 *
 * Column order: Metric | Your Value | Peer Median | Top Decile | Bottom Decile | Percentile | Stars
 */

import React, { useCallback } from 'react';

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

export default function PeerComparisonTable({
  metrics = [],
  charterNumber,
  period,
  peerGroupLabel = '',
  peerCount,
}) {
  const handleDownload = useCallback(
    () => downloadCsv(metrics, charterNumber, period, peerGroupLabel),
    [metrics, charterNumber, period, peerGroupLabel],
  );

  return (
    <div className="peer-comparison-table-wrapper">
      <div className="table-header">
        <div className="table-title-group">
          <h3>Peer Comparison</h3>
          <span className="peer-group-pill">{peerGroupLabel}</span>
          {peerCount != null && (
            <span className="peer-count-label">{peerCount} institutions</span>
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
