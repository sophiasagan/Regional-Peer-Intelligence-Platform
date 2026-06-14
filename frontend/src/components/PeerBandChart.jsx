/**
 * PeerBandChart — the ONLY chart type in P76. Replaces all other chart types.
 *
 * Visual spec (Callahan color language):
 *   Your institution:    solid 2.5px #1565C0, circle markers
 *   IQR band (p25-p75): light gray fill, 20% opacity
 *   Top decile line:     solid 1px teal #0F6E56  — p10 for ADVERSE, p90 for POSITIVE
 *   Bottom decile line:  solid 1px coral #993C1D — p90 for ADVERSE, p10 for POSITIVE
 *   Peer median:         dashed 1px gray
 *   Regional peers:      dashed purple 1.5px #6A1B9A — P76 EXCLUSIVE, fetched when peerGroup≠REGIONAL
 *   Examiner threshold:  red dashed horizontal ReferenceLine
 *
 * Below chart: percentile bar — position represents adjusted rank (already inverted for adverse),
 * so higher position = better regardless of metric polarity.
 *
 * Annotations on institution line:
 *   ◆ diamond:   institution crossed peer median (direction change)
 *   ● teal dot:  entered top decile
 *   ● coral dot: entered bottom decile
 *   △ threshold: period where institution exceeds examiner threshold
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ReferenceLine,
  ResponsiveContainer,
} from 'recharts';

const API = import.meta.env.VITE_API_URL ?? '';

const C = {
  institution: '#1565C0',
  topDecile:   '#0F6E56',
  bottomDecile:'#993C1D',
  peerMedian:  '#757575',
  bandFill:    '#B0BEC5',
  regional:    '#6A1B9A',
  threshold:   '#D32F2F',
};

const ADVERSE_METRICS = new Set([
  'delinq_rate_total', 'delinq_rate_90plus', 'chargeoff_rate_total_annualized',
  'oreo_to_assets', 'non_accrual_rate', 'tdr_to_loans',
  'operating_expense_ratio', 'credit_loss_expense_to_loans', 'borrowings_to_assets',
  'efficiency_ratio', 'delinq_rate_credit_card', 'delinq_rate_auto_total',
  'delinq_rate_first_mortgage', 'delinq_rate_commercial', 'delinq_rate_commercial_re',
]);

const UNIT_LABELS = {
  '%': v => v != null ? `${(v * 100).toFixed(3)}%` : '—',
  'x': v => v != null ? `${v.toFixed(3)}x`           : '—',
  '$': v => v != null
    ? v >= 1e9 ? `$${(v/1e9).toFixed(2)}B` : `$${(v/1e6).toFixed(1)}M`
    : '—',
  'count': v => v != null ? Math.round(v).toLocaleString() : '—',
};

function fmt(v, unit = '%') {
  return (UNIT_LABELS[unit] ?? UNIT_LABELS['%'])(v);
}

function fmtAxisTick(v, unit) {
  if (v == null) return '';
  if (unit === '%') return `${(v * 100).toFixed(2)}%`;
  if (unit === 'x') return `${v.toFixed(2)}x`;
  return v.toFixed(2);
}

// Compute adjusted percentile rank (0–100, higher = better, polarity already handled).
function computeAdjustedRank(value, p10, p25, p50, p75, p90, isAdverse) {
  if (value == null || p10 == null || p90 == null) return null;
  const pts = [
    [0,   p10 - (p90 - p10)],
    [10,  p10],
    [25,  p25 ?? p10 + (p50 - p10) * 0.6],
    [50,  p50 ?? (p10 + p90) / 2],
    [75,  p75 ?? p90 - (p90 - p50) * 0.6],
    [90,  p90],
    [100, p90 + (p90 - p10)],
  ];
  let rawRank = 50;
  for (let i = 1; i < pts.length; i++) {
    const [pLo, vLo] = pts[i - 1];
    const [pHi, vHi] = pts[i];
    if (value <= vHi) {
      rawRank = vHi === vLo ? pLo : pLo + (value - vLo) / (vHi - vLo) * (pHi - pLo);
      break;
    }
    rawRank = pts[pts.length - 1][0];
  }
  rawRank = Math.max(0, Math.min(100, rawRank));
  return isAdverse ? 100 - rawRank : rawRank;
}

// Detect crossovers (inst crosses peer median) and decile entries.
function detectAnnotations(data, isAdverse) {
  const crossovers   = new Set();
  const topEntries   = new Set();
  const bottomEntries = new Set();
  const thresholdHits = new Set();

  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1];
    const curr = data[i];
    const iv = curr.institution;
    const pv = prev.institution;
    if (iv == null || pv == null) continue;

    // Crossover: institution crosses peer median
    if (prev.p50 != null && curr.p50 != null) {
      const wasAbove = pv > prev.p50;
      const isAbove  = iv > curr.p50;
      if (wasAbove !== isAbove) crossovers.add(curr.period);
    }

    // Top decile entry
    const topThresh  = isAdverse ? curr.p10  : curr.p90;
    const prevTop    = isAdverse ? prev.p10  : prev.p90;
    if (topThresh != null && prevTop != null) {
      const wasTop = isAdverse ? pv < prevTop : pv > prevTop;
      const isTop  = isAdverse ? iv < topThresh : iv > topThresh;
      if (!wasTop && isTop) topEntries.add(curr.period);
    }

    // Bottom decile entry
    const botThresh = isAdverse ? curr.p90  : curr.p10;
    const prevBot   = isAdverse ? prev.p90  : prev.p10;
    if (botThresh != null && prevBot != null) {
      const wasBot = isAdverse ? pv > prevBot  : pv < prevBot;
      const isBot  = isAdverse ? iv > botThresh : iv < botThresh;
      if (!wasBot && isBot) bottomEntries.add(curr.period);
    }
  }

  return { crossovers, topEntries, bottomEntries, thresholdHits };
}

// Custom dot for the institution line — marks annotation events.
function InstDot({ cx, cy, payload, annotations }) {
  if (!cx || !cy || !payload) return null;
  const { period } = payload;
  if (annotations.topEntries.has(period)) {
    return (
      <g>
        <circle cx={cx} cy={cy} r={7} fill={C.topDecile} stroke="white" strokeWidth={1.5} />
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize={9}>★</text>
      </g>
    );
  }
  if (annotations.bottomEntries.has(period)) {
    return (
      <g>
        <circle cx={cx} cy={cy} r={7} fill={C.bottomDecile} stroke="white" strokeWidth={1.5} />
        <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle" fill="white" fontSize={9}>▼</text>
      </g>
    );
  }
  if (annotations.crossovers.has(period)) {
    const d = `M${cx},${cy - 6} L${cx + 5},${cy} L${cx},${cy + 6} L${cx - 5},${cy} Z`;
    return <path d={d} fill={C.institution} stroke="white" strokeWidth={1} />;
  }
  return <circle cx={cx} cy={cy} r={3} fill={C.institution} stroke="white" strokeWidth={1} />;
}

// Percentile bar displayed below chart.
function PercentileBar({ adjustedRank, peerCount, isAdverse, callahanLabel }) {
  if (adjustedRank == null) return null;
  const pct  = adjustedRank.toFixed(0);
  const good = adjustedRank >= 50;
  const barColor = good ? C.topDecile : C.bottomDecile;

  return (
    <div className="percentile-bar-wrapper">
      <div className="percentile-text">
        Your institution is at the <strong>{pct}th percentile</strong>
        {' '}among {peerCount} peer institutions
        {isAdverse && (
          <span className="polarity-note"> — lower {callahanLabel} = better</span>
        )}
      </div>
      <div className="percentile-track" role="meter" aria-valuenow={adjustedRank} aria-valuemin={0} aria-valuemax={100}>
        <div className="percentile-fill" style={{ width: `${adjustedRank}%`, backgroundColor: barColor }} />
        <div className="percentile-marker" style={{ left: `${adjustedRank}%` }} />
        <div className="percentile-labels">
          <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
        </div>
      </div>
    </div>
  );
}

// Annotation summary shown below the chart.
function AnnotationSummary({ annotations, isAdverse }) {
  const items = [];
  annotations.topEntries.forEach(p =>
    items.push({ period: p, cls: 'ann-top',    icon: '★', text: 'Entered top decile' }));
  annotations.bottomEntries.forEach(p =>
    items.push({ period: p, cls: 'ann-bottom', icon: '▼', text: 'Entered bottom decile' }));
  annotations.crossovers.forEach(p =>
    items.push({ period: p, cls: 'ann-cross',  icon: '◆', text: `Crossed peer median` }));

  if (!items.length) return null;
  items.sort((a, b) => a.period.localeCompare(b.period));

  return (
    <ul className="annotation-list">
      {items.map(({ period, cls, icon, text }) => (
        <li key={`${cls}-${period}`} className={`annotation-item ${cls}`}>
          <span className="ann-icon">{icon}</span>
          <span className="ann-period">{period}</span>
          <span className="ann-text">{text}</span>
        </li>
      ))}
    </ul>
  );
}

const CustomTooltip = ({ active, payload, label, unit, isAdverse }) => {
  if (!active || !payload?.length) return null;
  const order = ['institution', 'regional', 'p50', 'topDecileLine', 'bottomDecileLine'];
  const sorted = [...payload].sort(
    (a, b) => order.indexOf(a.dataKey) - order.indexOf(b.dataKey)
  );
  return (
    <div className="chart-tooltip">
      <p className="tooltip-period">{label}</p>
      {sorted.map(p => p.value != null && (
        <p key={p.dataKey} style={{ color: p.stroke || p.color }}>
          {p.name}: {fmt(p.value, unit)}
        </p>
      ))}
    </div>
  );
};

function exportCsv(data, metric, charterNumber, period, callahanLabel, peerGroupLabel) {
  if (!data?.length) return;
  const meta  = `${callahanLabel} — Charter ${charterNumber} — ${period} — ${peerGroupLabel}`;
  const hdr   = 'Period,Your Institution,Peer Median,Top Decile,Bottom Decile,IQR P25,IQR P75,Regional Median,Peer Count';
  const rows  = data.map(d => [
    d.period,
    d.institution ?? '',
    d.p50          ?? '',
    d.topDecileLine ?? '',
    d.bottomDecileLine ?? '',
    d.peer_p25     ?? '',
    d.peer_p75     ?? '',
    d.regional     ?? '',
    d.peer_count   ?? '',
  ].join(','));
  const blob = new Blob([[meta, '', hdr, ...rows].join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${metric}_${charterNumber}_${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main component ──────────────────────────────────────────────────────────

export default function PeerBandChart({
  // Self-fetch props
  metric,
  charterNumber,
  period,
  peerGroup = 'REGIONAL',
  nPeriods  = 12,
  token,
  // Optional override props (skip fetch when provided)
  institutionData,
  peerMedian: peerMedianProp,
  peerTopDecile: peerTopDecileProp,
  peerBottomDecile: peerBottomDecileProp,
  peerBand: peerBandProp,
  regionalMedian: regionalMedianProp,
  // Display
  threshold,
  unit = '%',
  onPeerGroupChange,
}) {
  const [apiData,        setApiData]        = useState(null);
  const [regionalApiData, setRegionalApiData] = useState(null);
  const [meta,           setMeta]           = useState(null);
  const [loading,        setLoading]        = useState(false);

  // Fetch main peer group data
  useEffect(() => {
    if (institutionData) return;  // skip fetch when data provided as props
    if (!charterNumber || !metric || !period) return;
    setLoading(true);
    fetch(
      `${API}/peer-comparison/${charterNumber}/metric/${metric}?period=${period}&peer_group=${peerGroup}&n_periods=${nPeriods}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
      .then(r => r.ok ? r.json() : null)
      .then(res => {
        if (res) { setMeta(res); setApiData(res.data ?? []); }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [metric, charterNumber, period, peerGroup, nPeriods, token, institutionData]);

  // Fetch REGIONAL data as comparison line when main peer group is not REGIONAL
  useEffect(() => {
    if (institutionData || peerGroup === 'REGIONAL') { setRegionalApiData(null); return; }
    if (!charterNumber || !metric || !period) return;
    fetch(
      `${API}/peer-comparison/${charterNumber}/metric/${metric}?period=${period}&peer_group=REGIONAL&n_periods=${nPeriods}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
      .then(r => r.ok ? r.json() : null)
      .then(res => res && setRegionalApiData(res.data ?? []))
      .catch(console.error);
  }, [metric, charterNumber, period, peerGroup, nPeriods, token, institutionData]);

  const handleDownload = useCallback(() => {
    exportCsv(plotData, metric, charterNumber, period,
      meta?.callahan_label ?? metric, meta?.peer_group_label ?? peerGroup);
  }, [apiData, regionalApiData, meta, metric, charterNumber, period, peerGroup]);

  // ── Build chart data ─────────────────────────────────────────────────────

  const isAdverse = ADVERSE_METRICS.has(metric);
  const rawData   = institutionData ? null : (apiData ?? []);

  // Regional median indexed by period for merge
  const regionalByPeriod = (regionalApiData ?? []).reduce((acc, d) => {
    acc[d.period] = d.peer_p50;
    return acc;
  }, {});

  const plotData = rawData
    ? rawData.map(d => ({
        period:          d.period,
        institution:     d.institution_value,
        p50:             d.peer_p50,
        peer_p25:        d.peer_p25,
        peer_p75:        d.peer_p75,
        peer_p10:        d.peer_p10,
        peer_p90:        d.peer_p90,
        peer_count:      d.peer_count,
        // IQR band — stacked Area technique: base + height
        iqr_base:        d.peer_p25,
        iqr_height:      d.peer_p25 != null && d.peer_p75 != null ? d.peer_p75 - d.peer_p25 : null,
        // Top/bottom decile lines depend on polarity
        topDecileLine:    isAdverse ? d.peer_p10 : d.peer_p90,
        bottomDecileLine: isAdverse ? d.peer_p90 : d.peer_p10,
        // Regional comparison (purple dashed) — only when peerGroup ≠ REGIONAL
        regional:        peerGroup !== 'REGIONAL' ? regionalByPeriod[d.period] : undefined,
      }))
    : [];  // TODO: map from data props when provided

  const annotations  = detectAnnotations(plotData, isAdverse);
  const lastPoint    = [...plotData].reverse().find(d => d.institution != null);
  const adjustedRank = lastPoint
    ? computeAdjustedRank(
        lastPoint.institution,
        lastPoint.peer_p10, lastPoint.peer_p25,
        lastPoint.p50,
        lastPoint.peer_p75, lastPoint.peer_p90,
        isAdverse,
      )
    : null;

  const callahanLabel  = meta?.callahan_label  ?? metric;
  const peerGroupLabel = meta?.peer_group_label ?? peerGroup;
  const showRegional   = peerGroup !== 'REGIONAL' && regionalApiData?.length > 0;

  if (loading) return <div className="chart-placeholder">Loading {metric}…</div>;
  if (!plotData.length) return <div className="chart-placeholder">No data for {metric} / {period}</div>;

  const axisTickFmt = v => fmtAxisTick(v, unit);

  return (
    <div className="peer-band-chart">

      {/* ── Header (Callahan layout) ── */}
      <div className="chart-header">
        <div className="chart-header-left">
          <h2 className="chart-metric-title">{callahanLabel}</h2>
          <span className="chart-period-label">{nPeriods / 4}Y / {nPeriods}Q</span>
        </div>
        <div className="chart-header-right">
          {onPeerGroupChange ? (
            <button
              className="peer-group-pill clickable"
              onClick={onPeerGroupChange}
              title="Click to change peer group"
            >
              {peerGroupLabel}
            </button>
          ) : (
            <span className="peer-group-pill">{peerGroupLabel}</span>
          )}
          <button
            className="download-btn"
            onClick={handleDownload}
            title="Export to Excel"
          >
            Export to Excel
          </button>
        </div>
      </div>

      {/* ── Chart ── */}
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={plotData} margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E0E0E0" vertical={false} />
          <XAxis dataKey="period" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={axisTickFmt} width={62} />
          <Tooltip
            content={<CustomTooltip unit={unit} isAdverse={isAdverse} />}
          />
          <Legend
            verticalAlign="top"
            height={32}
            iconType="line"
            wrapperStyle={{ fontSize: 11 }}
          />

          {/* IQR band (p25–p75): stacked Area — base is transparent, height is gray */}
          <Area
            type="monotone"
            dataKey="iqr_base"
            stackId="iqr"
            stroke="none"
            fill="transparent"
            fillOpacity={1}
            legendType="none"
            tooltipType="none"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="iqr_height"
            stackId="iqr"
            stroke="none"
            fill={C.bandFill}
            fillOpacity={0.2}
            name="IQR (p25–p75)"
            isAnimationActive={false}
          />

          {/* Top decile line — teal */}
          <Line
            type="monotone"
            dataKey="topDecileLine"
            stroke={C.topDecile}
            strokeWidth={1}
            dot={false}
            name="Top decile"
            legendType="line"
          />

          {/* Bottom decile line — coral */}
          <Line
            type="monotone"
            dataKey="bottomDecileLine"
            stroke={C.bottomDecile}
            strokeWidth={1}
            dot={false}
            name="Bottom decile"
            legendType="line"
          />

          {/* Peer median — dashed gray */}
          <Line
            type="monotone"
            dataKey="p50"
            stroke={C.peerMedian}
            strokeWidth={1}
            strokeDasharray="4 4"
            dot={false}
            name="Peer median"
          />

          {/* Regional peer median — P76 EXCLUSIVE — purple dashed */}
          {showRegional && (
            <Line
              type="monotone"
              dataKey="regional"
              stroke={C.regional}
              strokeWidth={1.5}
              strokeDasharray="6 3"
              dot={false}
              name="Regional peers"
            />
          )}

          {/* Institution — bold primary, annotated dots */}
          <Line
            type="monotone"
            dataKey="institution"
            stroke={C.institution}
            strokeWidth={2.5}
            name="Your institution"
            dot={(props) => (
              <InstDot key={props.index} {...props} annotations={annotations} />
            )}
            activeDot={{ r: 5, fill: C.institution }}
            isAnimationActive={false}
          />

          {/* Examiner threshold — red dashed horizontal */}
          {threshold != null && (
            <ReferenceLine
              y={threshold}
              stroke={C.threshold}
              strokeWidth={1}
              strokeDasharray="6 3"
              label={{
                value: `NCUA watch: ${fmt(threshold, unit)}`,
                position: 'insideTopRight',
                fill: C.threshold,
                fontSize: 11,
              }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* ── Percentile bar ── */}
      <PercentileBar
        adjustedRank={adjustedRank}
        peerCount={lastPoint?.peer_count}
        isAdverse={isAdverse}
        callahanLabel={callahanLabel}
      />

      {/* ── Annotation summary (crossovers, decile entries) ── */}
      <AnnotationSummary annotations={annotations} isAdverse={isAdverse} />
    </div>
  );
}
