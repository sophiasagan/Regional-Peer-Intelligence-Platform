/**
 * CompetitorTable — ranked competitor table with metric tabs.
 *
 * Self-fetching: calls GET /market-share/?geography_type=&geography_id=&period=&metric=
 *
 * Tabs: Deposits | Loans | Members | Mortgage Originations
 * Columns: Rank | Institution | Type | Metric Value | Share % | QoQ | YoY | Confidence
 * "Your institution" row is always highlighted.
 * Every chart has a CSV download button — non-negotiable (Callahan UX rule).
 * Confidence badge required on every geographic figure (P76 rule).
 */

import React, { useState, useEffect, useCallback } from 'react';
import ConfidenceBadge from './ConfidenceBadge';

const API = import.meta.env.VITE_API_URL ?? '';

// ── Metric tab definitions ────────────────────────────────────────────────────

const METRIC_TABS = [
  { key: 'deposits',              label: 'Deposits',              valueLabel: 'Deposits ($)',          format: 'dollar'  },
  { key: 'loans',                 label: 'Loans',                 valueLabel: 'Loan Balance ($)',       format: 'dollar'  },
  { key: 'members',               label: 'Members',               valueLabel: 'Members',               format: 'count'   },
  { key: 'mortgage_originations', label: 'Mortgage Originations', valueLabel: 'Origination Volume ($)', format: 'dollar'  },
];

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtValue(v, format) {
  if (v == null) return '—';
  if (format === 'dollar') {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v.toLocaleString()}`;
  }
  if (format === 'count') return v.toLocaleString();
  return String(v);
}

function fmtShare(v) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(2)}%`;
}

function fmtChange(v) {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)} pp`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TypeBadge({ type }) {
  const isCu = type === 'cu';
  return (
    <span className={`type-badge ${isCu ? 'type-badge--cu' : 'type-badge--bank'}`}>
      {isCu ? 'CU' : 'Bank'}
    </span>
  );
}

function ChangeCell({ value }) {
  if (value == null) return <td className="numeric muted">—</td>;
  const up   = value > 0;
  const down = value < 0;
  return (
    <td className={`numeric ${up ? 'positive' : down ? 'negative' : ''}`}>
      {up ? '▲' : down ? '▼' : '●'} {fmtChange(value)}
    </td>
  );
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCsv(rows, geoType, geoId, period, metric, peerGroupLabel) {
  if (!rows.length) return;

  const header = [
    `"Market Share — ${peerGroupLabel ?? geoId} — ${period} — ${metric}"`,
    `"Geography: ${geoType} / ${geoId}"`,
    '',
    'Rank,Institution,Type,charter_or_cert,Metric Value,Market Share,Share Change QoQ (pp),Share Change YoY (pp),Confidence,Data Period',
  ];

  const body = rows.map((r, i) =>
    [
      i + 1,
      `"${r.institution_name}"`,
      r.institution_type,
      r.charter_or_cert,
      r.metric_value ?? '',
      r.market_share != null ? (r.market_share * 100).toFixed(4) : '',
      r.share_change_prior_period != null ? r.share_change_prior_period.toFixed(4) : '',
      r.share_change_yoy          != null ? r.share_change_yoy.toFixed(4)          : '',
      r.confidence,
      r.data_period,
    ].join(',')
  );

  const blob = new Blob([[...header, ...body].join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `market_share_${geoId}_${period}_${metric}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Data hook ─────────────────────────────────────────────────────────────────

function useMarketShareData(geoType, geoId, period, metric, token) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!geoId || !period || !geoType) return;
    setLoading(true);
    setError(null);
    setData(null);

    const params = new URLSearchParams({
      geography_type:   geoType,
      geography_id:     geoId,
      period,
      metric,
      institution_types: 'bank,cu',
    });

    fetch(`${API}/market-share/?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [geoType, geoId, period, metric, token]);

  return { data, loading, error };
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CompetitorTable({
  geoType,
  geoId,
  period,
  charterNumber,   // tenant's charter — row is highlighted when charter_or_cert = 'ncua:{charterNumber}'
  token,
  // optional: controlled metric from parent (e.g. map sidebar)
  defaultMetric = 'deposits',
}) {
  const [activeMetric, setActiveMetric] = useState(defaultMetric);
  const [sortCol,      setSortCol]      = useState('market_share');
  const [sortAsc,      setSortAsc]      = useState(false);   // descending by default

  // Sync with parent's controlled metric (e.g. map metric bar click)
  useEffect(() => { setActiveMetric(defaultMetric); }, [defaultMetric]);

  const { data, loading, error } = useMarketShareData(geoType, geoId, period, activeMetric, token);

  const myId = charterNumber ? `ncua:${charterNumber}` : null;

  const rows = data?.rows ?? [];
  const activeTab = METRIC_TABS.find(t => t.key === activeMetric) ?? METRIC_TABS[0];

  // Sort
  const sorted = [...rows].sort((a, b) => {
    const av = a[sortCol] ?? -Infinity;
    const bv = b[sortCol] ?? -Infinity;
    if (av === bv) return 0;
    return sortAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });

  function toggleSort(col) {
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(false); }
  }

  function SortTh({ col, children }) {
    const active = sortCol === col;
    return (
      <th
        className={`sortable ${active ? 'sort-active' : ''}`}
        onClick={() => toggleSort(col)}
        aria-sort={active ? (sortAsc ? 'ascending' : 'descending') : 'none'}
      >
        {children}{active ? (sortAsc ? ' ↑' : ' ↓') : ''}
      </th>
    );
  }

  const handleDownload = useCallback(() => {
    exportCsv(rows, geoType, geoId, period, activeMetric, data?.geography_id);
  }, [rows, geoType, geoId, period, activeMetric, data]);

  // ── Render: no geography selected ─────────────────────────────────────────
  if (!geoId) {
    return (
      <div className="ct-empty-state">
        <p>Click a county on the map or enter a geography to see the competitive breakdown.</p>
      </div>
    );
  }

  const worstConf = data?.confidence ?? 'estimated';

  return (
    <div className="competitor-table-wrapper">
      {/* ── Header ── */}
      <div className="ct-header">
        <div className="ct-title-row">
          <h3 className="ct-title">
            Competitive Breakdown
            <span className="ct-geo-label"> — {geoId} ({period})</span>
          </h3>
          <ConfidenceBadge level={worstConf} />
          <button
            className="download-btn"
            onClick={handleDownload}
            disabled={!rows.length}
            title="Export to CSV"
          >
            Export to Excel
          </button>
        </div>

        {/* ── Metric tabs ── */}
        <div className="ct-tabs" role="tablist">
          {METRIC_TABS.map(tab => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeMetric === tab.key}
              className={`ct-tab ${activeMetric === tab.key ? 'ct-tab--active' : ''}`}
              onClick={() => setActiveMetric(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Total market ── */}
      {data && (
        <div className="ct-market-total">
          Total market {activeTab.label.toLowerCase()}:{' '}
          <strong>{fmtValue(data.total_market, activeTab.format)}</strong>
          {' '}across{' '}
          <strong>{rows.length}</strong> institutions
        </div>
      )}

      {/* ── Loading / error ── */}
      {loading && <div className="ct-loading">Loading…</div>}
      {error   && <div className="ct-error">Error: {error.message}</div>}

      {/* ── Table ── */}
      {!loading && rows.length === 0 && geoId && (
        <div className="ct-empty-state">
          No {activeTab.label.toLowerCase()} data available for this geography and period.
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div className="ct-scroll-container">
          <table className="competitor-table" role="grid">
            <thead>
              <tr>
                <th className="col-rank">#</th>
                <SortTh col="institution_name">Institution</SortTh>
                <th>Type</th>
                <SortTh col="metric_value">{activeTab.valueLabel}</SortTh>
                <SortTh col="market_share">Share %</SortTh>
                <SortTh col="share_change_prior_period">QoQ</SortTh>
                <SortTh col="share_change_yoy">YoY</SortTh>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, idx) => {
                const isYours = myId && row.charter_or_cert === myId;
                return (
                  <tr
                    key={row.charter_or_cert}
                    className={`
                      ct-row
                      ct-row--${row.institution_type}
                      ${isYours ? 'ct-row--yours' : ''}
                    `.trim()}
                  >
                    <td className="col-rank">{idx + 1}</td>
                    <td className="ct-name">
                      {row.institution_name}
                      {isYours && <span className="ct-yours-tag">Your institution</span>}
                    </td>
                    <td><TypeBadge type={row.institution_type} /></td>
                    <td className="numeric">{fmtValue(row.metric_value, activeTab.format)}</td>
                    <td className="numeric">{fmtShare(row.market_share)}</td>
                    <ChangeCell value={row.share_change_prior_period} />
                    <ChangeCell value={row.share_change_yoy} />
                    <td><ConfidenceBadge level={row.confidence} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
