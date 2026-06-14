/**
 * KpiCard — top-of-page metric summary card. Matches Callahan's FPR card layout.
 *
 * Color convention (exact Callahan):
 *   Top decile (≥90th pctile)    → green badge
 *   Bottom decile (<10th pctile) → red badge
 *
 * Stars (1–5, Callahan scale):
 *   1 = <10th pctile  …  5 = ≥90th pctile
 *
 * ADVERSE metrics (delinquency, charge-offs, efficiency):
 *   Lower raw value → higher percentile → more stars → green badge.
 *   Star and color logic is already inverted by the backend rank_institution().
 *   The frontend just reads percentile_rank as-is.
 */

import React from 'react';

function Stars({ count }) {
  if (count == null) return <span className="kpi-stars-none">—</span>;
  return (
    <span className="kpi-stars" aria-label={`${count} of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < count ? 'star filled' : 'star empty'}>★</span>
      ))}
    </span>
  );
}

function TrendArrow({ qoqChange, isAdverse }) {
  if (qoqChange == null || qoqChange === 0) return null;
  const rising = qoqChange > 0;
  // Adverse metric rising = getting worse = red; falling = improving = green
  const good = isAdverse ? !rising : rising;
  return (
    <span className={`kpi-trend-arrow ${good ? 'trend-good' : 'trend-bad'}`} aria-hidden>
      {rising ? '▲' : '▼'}
    </span>
  );
}

function fmtValue(v, unit) {
  if (v == null || (typeof v === 'number' && isNaN(v))) return '—';
  switch (unit) {
    case '%':    return `${(v * 100).toFixed(2)}%`;
    case 'x':    return `${v.toFixed(2)}x`;
    case '$':    return v >= 1e9
                   ? `$${(v / 1e9).toFixed(2)}B`
                   : `$${(v / 1e6).toFixed(1)}M`;
    case 'count': return Math.round(v).toLocaleString();
    default:     return v.toFixed(4);
  }
}

export default function KpiCard({
  label,
  value,
  peerMedian,
  stars,
  percentileRank,
  qoqChange,
  unit = '%',
  isAdverse = false,
}) {
  const isTopDecile    = percentileRank != null && percentileRank >= 90;
  const isBottomDecile = percentileRank != null && percentileRank < 10;

  let cardClass = 'kpi-card';
  if (isTopDecile)    cardClass += ' kpi-top-decile';
  if (isBottomDecile) cardClass += ' kpi-bottom-decile';

  return (
    <div className={cardClass}>
      <div className="kpi-header">
        <span className="kpi-label">{label}</span>
        {isTopDecile    && <span className="decile-badge badge-green">Top decile</span>}
        {isBottomDecile && <span className="decile-badge badge-red">Bottom decile</span>}
      </div>

      <div className="kpi-body">
        <span className="kpi-value">{fmtValue(value, unit)}</span>
        <TrendArrow qoqChange={qoqChange} isAdverse={isAdverse} />
      </div>

      <div className="kpi-peer">
        Peer median: <strong>{fmtValue(peerMedian, unit)}</strong>
      </div>

      <div className="kpi-footer">
        <Stars count={stars} />
        {percentileRank != null && (
          <span className="kpi-percentile">{Math.round(percentileRank)}th pctile</span>
        )}
      </div>
    </div>
  );
}
