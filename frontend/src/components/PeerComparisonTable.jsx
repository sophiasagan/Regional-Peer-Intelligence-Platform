/**
 * PeerComparisonTable — full-metric peer comparison grid. Matches Callahan FPR color coding.
 *
 * Row color (exact Callahan FPR convention):
 *   percentile ≥ 90 → green row
 *   percentile < 10 → red row
 *
 * Stars: 1–5 on every row (Callahan scale).
 * Download: full table as CSV — non-negotiable (P76 / Callahan rule).
 * Categories: metrics are grouped into collapsible sections (all expanded by default).
 *
 * Named-column mode (CUSTOM peer groups only):
 *   When metric rows carry peer_values, the Peer Median / Top Decile / Bottom Decile
 *   columns are replaced by one column per selected institution showing that
 *   institution's actual value. Rank and Stars columns are unchanged.
 *   The table wrapper becomes horizontally scrollable for large custom selections.
 */

import React, { useCallback, useEffect, useState } from 'react';
import PeerBandChart from './PeerBandChart';
import { METRIC_CATEGORIES, METRIC_TO_CATEGORY } from '../utils/metricCategories.js';

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

// Truncate long institution names in column headers so narrow named columns stay readable.
function shortName(name, max = 18) {
  if (!name || name.length <= max) return name;
  return name.slice(0, max - 1) + '…';
}

// Export all metrics regardless of collapse state; adds Category column.
// In named-column mode: replaces aggregate peer columns with one column per named institution.
function downloadCsv(metrics, charterNumber, period, peerGroupLabel, namedPeers) {
  if (!metrics?.length) return;
  const meta = `Peer Group: ${peerGroupLabel},Charter: ${charterNumber},Period: ${period}`;

  let headers, rows;
  if (namedPeers.length > 0) {
    const peerCols = namedPeers.map(p => `"${p.institution_name}"`).join(',');
    headers = `Category,Metric,Your Value,${peerCols},Rank,Stars,Adverse`;
    rows = metrics.map(m => {
      const peerValsMap = Object.fromEntries(
        (m.peer_values ?? []).map(pv => [pv.charter_number, pv.value])
      );
      const peerCells = namedPeers.map(p => peerValsMap[p.charter_number] ?? '').join(',');
      return [
        `"${METRIC_TO_CATEGORY[m.metric_name] ?? ''}"`,
        `"${m.metric_label}"`,
        m.institution_value ?? '',
        peerCells,
        m.rank_ordinal ?? (m.percentile_rank != null ? `${m.percentile_rank.toFixed(1)}th` : ''),
        m.stars ?? '',
        m.is_adverse ? 'Y' : 'N',
      ].join(',');
    });
  } else {
    headers = 'Category,Metric,Your Value,Peer Median,Top Decile (90th),Bottom Decile (10th),Percentile,Stars,Adverse';
    rows = metrics.map(m => [
      `"${METRIC_TO_CATEGORY[m.metric_name] ?? ''}"`,
      `"${m.metric_label}"`,
      m.institution_value ?? '',
      m.peer_median        ?? '',
      m.peer_p90           ?? '',
      m.peer_p10           ?? '',
      m.percentile_rank != null ? m.percentile_rank.toFixed(1) : '',
      m.stars              ?? '',
      m.is_adverse ? 'Y' : 'N',
    ].join(','));
  }

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
  const [search,      setSearch]      = useState('');

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

  // Filter by name search, then group by tier for section headers
  const query = search.trim().toLowerCase();
  const filtered = query
    ? institutions.filter(i => i.institution_name.toLowerCase().includes(query))
    : institutions;

  const byTier = [];
  let lastTier = null;
  for (const inst of filtered) {
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
          <div className="sp-search">
            <input
              type="search"
              className="sp-search-input"
              placeholder="Search institutions…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

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
            {byTier.length === 0 && query ? (
              <li className="sp-no-results">No institutions match "{search}"</li>
            ) : byTier.map((item) =>
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

// Inline SVG chevrons — Tabler-style, no package dependency
function ChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.5"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
function ChevronUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2.5"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 15 12 9 18 15" />
    </svg>
  );
}

// Group the incoming metrics prop into category sections.
// Returns { sections: [{key, label, rows}], uncategorized: MetricRow[] }
function buildSections(metrics) {
  const metricMap     = Object.fromEntries(metrics.map(m => [m.metric_name, m]));
  const categorized   = new Set(METRIC_CATEGORIES.flatMap(c => c.metrics));
  const uncategorized = metrics.filter(m => !categorized.has(m.metric_name));

  const sections = METRIC_CATEGORIES.map(cat => ({
    key:   cat.key,
    label: cat.label,
    rows:  cat.metrics.map(k => metricMap[k]).filter(Boolean),
  })).filter(s => s.rows.length > 0);

  return { sections, uncategorized };
}

export default function PeerComparisonTable({
  metrics = [],
  charterNumber,
  period,
  peerGroup = 'REGIONAL',
  peerGroupLabel = '',
  peerCount,
  token,
  customCharters,     // number[] | null — forwarded to PeerBandChart when peerGroup === 'CUSTOM'
  onCustomCharters,   // (charters: number[] | null) => void
}) {
  const [showPanel,         setShowPanel]         = useState(false);
  const [expandedCharts,    setExpandedCharts]    = useState(new Set());
  // collapsedSections: Set of category keys; empty = all expanded (default)
  const [collapsedSections, setCollapsedSections] = useState(new Set());

  function toggleChart(metricName) {
    setExpandedCharts(prev => {
      const next = new Set(prev);
      next.has(metricName) ? next.delete(metricName) : next.add(metricName);
      return next;
    });
  }

  function toggleSection(key) {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  // ── Named-column mode detection ─────────────────────────────────────────────
  // When the API returns peer_values on metric rows (CUSTOM group only), switch
  // from aggregate columns (median/p10/p90) to one column per named institution.
  const firstMetric = metrics[0];
  const isNamedMode = Boolean(firstMetric?.peer_values);
  // Ordered list of named peers — taken from any metric that has values.
  // All metrics share the same peer list, so the first non-null one suffices.
  const namedPeers = isNamedMode
    ? (metrics.find(m => m.peer_values?.length > 0)?.peer_values ?? [])
    : [];

  // Dynamic column count: Metric + Your Value + [peer cols or 3 agg cols] + Rank + Stars + Trend
  const COL_SPAN = isNamedMode ? 4 + namedPeers.length : 8;

  const handleDownload = useCallback(
    () => downloadCsv(metrics, charterNumber, period, peerGroupLabel, namedPeers),
    [metrics, charterNumber, period, peerGroupLabel, namedPeers],
  );

  function handleApply(selected) {
    setShowPanel(false);
    onCustomCharters?.(selected);
  }

  function handleReset() {
    onCustomCharters?.(null);
  }

  const isCustom = peerGroupLabel.startsWith('Custom');

  const { sections, uncategorized } = buildSections(metrics);
  const allSectionKeys = sections.map(s => s.key);
  const allCollapsed   = allSectionKeys.length > 0 && allSectionKeys.every(k => collapsedSections.has(k));

  // Warn if any metric came back from the API without a category mapping
  if (uncategorized.length > 0) {
    console.warn(
      '[PeerComparisonTable] Uncategorized metrics — add to metricCategories.js:',
      uncategorized.map(m => m.metric_name),
    );
  }

  const hasAnyCustomRank = metrics.some(m => m.data_quality === 'custom_rank');

  // ── Row renderer (shared between sections and uncategorized fallback) ───────
  function renderMetricRow(m) {
    const isTop    = m.percentile_rank != null && m.percentile_rank >= 90;
    const isBottom = m.percentile_rank != null && m.percentile_rank < 10;
    const nTotal        = m.peer_n != null ? m.peer_n + 1 : null;
    const isCustomTop    = m.data_quality === 'custom_rank' && m.rank_pos === 1;
    const isCustomBottom = m.data_quality === 'custom_rank' && nTotal != null && m.rank_pos === nTotal;
    const rowTop    = isTop    || isCustomTop;
    const rowBottom = isBottom || isCustomBottom;
    const chartOpen = expandedCharts.has(m.metric_name);

    // Per-institution value lookup for named mode
    const peerValMap = isNamedMode
      ? Object.fromEntries((m.peer_values ?? []).map(pv => [pv.charter_number, pv.value]))
      : null;

    return (
      <React.Fragment key={m.metric_name}>
        <tr className={`metric-row${rowTop ? ' row-top-decile' : rowBottom ? ' row-bottom-decile' : ''}`}>
          <td className="col-metric metric-name-cell">
            <span className="polarity-indicator" title={m.is_adverse ? 'Adverse metric' : 'Positive metric'}>
              {m.is_adverse ? '↓' : '↑'}
            </span>
            {m.metric_label}
          </td>
          <td className="col-your-value numeric-col">{fmt(m.institution_value, m.unit)}</td>

          {isNamedMode ? (
            /* Named-column mode: one cell per selected institution */
            namedPeers.map(p => (
              <td key={p.charter_number} className="numeric-col named-peer-col">
                {fmt(peerValMap?.[p.charter_number] ?? null, m.unit)}
              </td>
            ))
          ) : (
            /* Aggregate mode: median / top decile / bottom decile */
            <>
              <td className="numeric-col">{fmt(m.peer_median, m.unit)}</td>
              <td className="numeric-col">{fmt(m.peer_p90,    m.unit)}</td>
              <td className="numeric-col">{fmt(m.peer_p10,    m.unit)}</td>
            </>
          )}

          <td className="numeric-col">
            {m.percentile_rank != null
              ? `${Math.round(m.percentile_rank)}th`
              : m.data_quality === 'custom_rank'
                ? <span title={`Exact rank in custom group of ${nTotal ?? '?'} institutions`}>
                    {m.rank_ordinal ?? '—'}
                  </span>
                : m.data_quality === 'insufficient_peer_data'
                  ? <span className="muted" title="Too few peer institutions for reliable scoring">
                      {`— (n=${m.peer_n ?? '?'})`}
                    </span>
                  : m.data_quality === 'zero_variance'
                    ? <span className="muted" title="All peers report identical values — percentile undefined">
                        {m.rank_ordinal ?? 'tied (all equal)'}
                      </span>
                    : '—'}
          </td>
          <td><Stars count={m.stars} /></td>
          <td className="chart-toggle-col">
            <button
              className={`chart-toggle-btn${chartOpen ? ' active' : ''}`}
              onClick={() => toggleChart(m.metric_name)}
              aria-label={chartOpen ? 'Collapse trend chart' : 'Expand trend chart'}
              title={chartOpen ? 'Collapse chart' : 'View 3-year trend'}
            >
              <span className="chart-toggle-label">{chartOpen ? 'Close' : 'Trend'}</span>
              {chartOpen ? <ChevronUp /> : <ChevronDown />}
            </button>
          </td>
        </tr>
        {chartOpen && (
          <tr className="metric-chart-row">
            <td colSpan={COL_SPAN} className="metric-chart-cell">
              <PeerBandChart
                metric={m.metric_name}
                charterNumber={charterNumber}
                period={period}
                peerGroup={peerGroup}
                customCharters={customCharters}
                nPeriods={12}
                token={token}
                unit={m.unit}
              />
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  }

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
          {allSectionKeys.length > 0 && (
            <button
              className="cm-link-btn"
              onClick={() =>
                allCollapsed
                  ? setCollapsedSections(new Set())
                  : setCollapsedSections(new Set(allSectionKeys))
              }
              style={{ fontSize: 12 }}
              title={allCollapsed ? 'Expand all sections' : 'Collapse all sections'}
            >
              {allCollapsed ? 'Expand all' : 'Collapse all'}
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

      {isNamedMode && namedPeers.length > 10 && (
        <div className="peer-cap-warning peer-cap-warning--hard" role="alert">
          <strong>Too many peers selected ({namedPeers.length}).</strong>{' '}
          Side-by-side comparison works best with 10 or fewer institutions — columns are too narrow to read at this width.
          <button className="cm-link-btn peer-cap-dismiss" onClick={() => setShowPanel(true)}>
            Trim selection
          </button>
        </div>
      )}
      {isNamedMode && namedPeers.length > 7 && namedPeers.length <= 10 && (
        <div className="peer-cap-warning peer-cap-warning--soft" role="status">
          {namedPeers.length} institutions selected — scroll right to see all columns.
        </div>
      )}

      {metrics.length === 0 ? (
        <p className="table-empty">No comparison data available.</p>
      ) : (
        /* Horizontal scroll wrapper — essential when namedPeers.length grows wide */
        <div className="peer-table-scroll">
          <table className="peer-comparison-table">
            <thead>
              <tr>
                <th className="col-metric">Metric</th>
                <th className="col-your-value numeric-col">Your Value</th>

                {isNamedMode ? (
                  /* Named-column headers */
                  namedPeers.map(p => (
                    <th
                      key={p.charter_number}
                      className="numeric-col named-peer-col-header"
                      title={p.institution_name}
                    >
                      {shortName(p.institution_name)}
                    </th>
                  ))
                ) : (
                  /* Aggregate column headers */
                  <>
                    <th className="numeric-col">Peer Median</th>
                    <th className="numeric-col">Top Decile</th>
                    <th className="numeric-col">Bottom Decile</th>
                  </>
                )}

                <th className="numeric-col">
                  {hasAnyCustomRank ? 'Rank' : 'Percentile'}
                </th>
                <th>Stars</th>
                <th className="chart-toggle-col">Trend</th>
              </tr>
            </thead>
            <tbody>
              {sections.map(s => {
                const isCollapsed = collapsedSections.has(s.key);
                return (
                  <React.Fragment key={s.key}>
                    {/* ── Category section header ── */}
                    <tr
                      className="cat-section-header-row"
                      onClick={() => toggleSection(s.key)}
                      aria-expanded={!isCollapsed}
                    >
                      <td colSpan={COL_SPAN} className="cat-section-header-cell">
                        <div className="cat-section-header-inner">
                          <span className="cat-section-chevron" aria-hidden>
                            {isCollapsed ? '▶' : '▼'}
                          </span>
                          <span className="cat-section-label">{s.label}</span>
                          <span className="cat-section-count">{s.rows.length}</span>
                        </div>
                      </td>
                    </tr>

                    {/* ── Metric rows (hidden when collapsed) ── */}
                    {!isCollapsed && s.rows.map(renderMetricRow)}
                  </React.Fragment>
                );
              })}

              {/* Uncategorized metrics — should never appear; logged to console.warn above */}
              {uncategorized.map(renderMetricRow)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
