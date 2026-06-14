/**
 * PeerComparison — line-by-line NCUA schedule comparison against peer group.
 *
 * Callahan conventions enforced:
 *   - Top decile (90th+) = green badge
 *   - Bottom decile (<10th) = red badge
 *   - 1 star = bottom <10%, 5 stars = top 90%+
 *   - Peer group label on every chart
 *   - Excel/CSV download (non-negotiable)
 */

import React, { useState, useEffect, useCallback } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

const STARS = ['', '★☆☆☆☆', '★★☆☆☆', '★★★☆☆', '★★★★☆', '★★★★★'];

function StarBadge({ stars, percentileRank }) {
  if (stars == null) return <span>N/A</span>;
  const isTopDecile = percentileRank >= 90;
  const isBottomDecile = percentileRank < 10;
  const className = isTopDecile ? 'badge-green' : isBottomDecile ? 'badge-red' : '';
  return <span className={`star-badge ${className}`}>{STARS[stars] ?? '?'}</span>;
}

function formatValue(value, unit) {
  if (value == null) return 'N/A';
  if (unit === '$') return `$${Number(value).toLocaleString()}`;
  if (unit === '%') return `${(value * 100).toFixed(2)}%`;
  if (unit === 'x') return `${value.toFixed(2)}x`;
  if (unit === 'count') return Number(value).toLocaleString();
  return String(value);
}

function downloadCsv(metrics, charterNumber, period) {
  const headers = 'Metric,Institution Value,Peer Median,P10,P90,Percentile Rank,Stars';
  const rows = metrics.map((m) =>
    [m.callahan_label, m.institution_value, m.peer_median, m.peer_p10, m.peer_p90, m.percentile_rank, m.stars].join(',')
  );
  const blob = new Blob([[headers, ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `peer_comparison_${charterNumber}_${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function PeerComparison({ charterNumber, token }) {
  const [period, setPeriod] = useState('2026Q1');
  const [peerGroup, setPeerGroup] = useState('REGIONAL');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sortCol, setSortCol] = useState('callahan_label');
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    if (!charterNumber) return;
    setLoading(true);
    fetch(
      `${API}/peer-comparison/${charterNumber}?period=${period}&peer_group=${peerGroup}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
      .then((r) => r.ok ? r.json() : null)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [charterNumber, period, peerGroup, token]);

  const sortedMetrics = data?.metrics
    ? [...data.metrics].sort((a, b) => {
        const av = a[sortCol] ?? '';
        const bv = b[sortCol] ?? '';
        return sortAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
      })
    : [];

  const handleSort = (col) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  };

  const handleDownload = useCallback(() => {
    if (data?.metrics) downloadCsv(data.metrics, charterNumber, period);
  }, [data, charterNumber, period]);

  return (
    <div className="peer-comparison-page">
      <div className="page-header">
        <h1>Peer Comparison</h1>
        {data && (
          <span className="peer-group-label">{data.peer_group_label} ({data.peer_count} peers)</span>
        )}
        <button className="download-btn" onClick={handleDownload} disabled={!data?.metrics?.length}>
          Download CSV
        </button>
      </div>

      <div className="controls">
        <label>
          Period:
          <input type="text" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 80 }} />
        </label>
        <div className="peer-group-tabs">
          {['REGIONAL', 'STATE', 'ASSET_SIZE'].map((g) => (
            <button
              key={g}
              className={`peer-tab ${peerGroup === g ? 'active' : ''}`}
              onClick={() => setPeerGroup(g)}
            >
              {g === 'REGIONAL' ? 'Regional' : g === 'STATE' ? 'State' : 'Asset Size'}
            </button>
          ))}
        </div>
      </div>

      {loading && <p className="loading">Loading…</p>}

      {sortedMetrics.length > 0 && (
        <table className="metrics-table">
          <thead>
            <tr>
              {[
                ['callahan_label', 'Metric'],
                ['institution_value', 'Institution'],
                ['peer_median', 'Peer Median'],
                ['peer_p10', 'P10'],
                ['peer_p90', 'P90'],
                ['percentile_rank', 'Percentile'],
                ['stars', 'Stars'],
              ].map(([col, label]) => (
                <th key={col} onClick={() => handleSort(col)} className="sortable">
                  {label} {sortCol === col ? (sortAsc ? '↑' : '↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedMetrics.map((m) => (
              <tr key={m.metric_name} className={m.is_adverse ? 'adverse' : 'positive'}>
                <td>{m.callahan_label}</td>
                <td>{formatValue(m.institution_value, m.unit)}</td>
                <td>{formatValue(m.peer_median, m.unit)}</td>
                <td>{formatValue(m.peer_p10, m.unit)}</td>
                <td>{formatValue(m.peer_p90, m.unit)}</td>
                <td>
                  {m.percentile_rank != null
                    ? <span className={m.percentile_rank >= 90 ? 'rank-green' : m.percentile_rank < 10 ? 'rank-red' : ''}>
                        {m.percentile_rank.toFixed(0)}th
                      </span>
                    : 'N/A'}
                </td>
                <td><StarBadge stars={m.stars} percentileRank={m.percentile_rank} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
