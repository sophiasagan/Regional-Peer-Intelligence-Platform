/**
 * CreditQuality — primary credit quality dashboard.
 *
 * Layout: sticky top bar → KPI row → Early Warning (if alerts) →
 *   [Trend chart card] → [Delinquency by Product card] → [Peer Comparison card]
 *
 * P76 exclusive features (always present, clearly labeled):
 *   EarlyWarningPanel  — "Know before your examiner does"
 *   SignalSeparator    — "Is this a you-problem or a market-problem?"
 *   Regional peer toggle — always visible in top bar
 *   PeerBandChart      — the ONLY chart type; regional line = purple dashed
 *
 * Callahan UX parity (NEVER violate):
 *   Exact Callahan metric names · top decile = green · bottom = red
 *   Stars 1–5 · Period default 3Y/12Q · Every chart has CSV download
 *   Always show peer group label on every chart
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import EarlyWarningPanel      from '../components/EarlyWarningPanel';
import PeerBandChart          from '../components/PeerBandChart';
import SignalSeparator        from '../components/SignalSeparator';
import KpiCard                from '../components/KpiCard';
import LoanTypeBreakdownChart from '../components/LoanTypeBreakdownChart';
import PeerComparisonTable    from '../components/PeerComparisonTable';

const API = import.meta.env.VITE_API_URL ?? '';

// Metrics that get the SignalSeparator
const SIGNAL_METRICS = new Set([
  'delinq_rate_total', 'delinq_rate_90plus', 'chargeoff_rate_total_annualized',
  'alll_coverage', 'alll_to_loans', 'non_accrual_rate', 'tdr_to_loans',
  'delinq_rate_credit_card', 'delinq_rate_auto_total',
  'delinq_rate_first_mortgage', 'delinq_rate_commercial', 'delinq_rate_commercial_re',
]);

// KPI cards — exact Callahan labels
const KPI_DEFS = [
  { metric: 'delinq_rate_total',               label: 'Total Delinquency Ratio',   unit: '%', adverse: true  },
  { metric: 'delinq_rate_90plus',              label: '90+ Day Delinquency',        unit: '%', adverse: true  },
  { metric: 'chargeoff_rate_total_annualized', label: 'Net Charge-Off Ratio',       unit: '%', adverse: true  },
  { metric: 'alll_coverage',                   label: 'ALLL Coverage Ratio',        unit: 'x', adverse: false },
];

// Metric tabs — horizontal strip above the trend chart
const METRIC_TABS = [
  { value: 'delinq_rate_total',               label: 'Total Delinquency' },
  { value: 'delinq_rate_90plus',              label: '90+ Day Delinq' },
  { value: 'chargeoff_rate_total_annualized', label: 'Net Charge-Off' },
  { value: 'alll_coverage',                   label: 'ALLL Coverage' },
  { value: 'alll_to_loans',                   label: 'ALLL to Loans' },
  { value: 'net_worth_ratio',                 label: 'Net Worth Ratio' },
  { value: 'roa_annualized',                  label: 'Return on Assets' },
  { value: 'efficiency_ratio',                label: 'Efficiency Ratio' },
];

const PERIOD_OPTIONS = [
  { label: '1Y', nPeriods: 4  },
  { label: '3Y', nPeriods: 12 },
  { label: '5Y', nPeriods: 20 },
];

// ── Hooks ──────────────────────────────────────────────────────────────────

function useInstitutionInfo(charterNumber, period, token) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (!charterNumber || !period) return;
    fetch(
      `${API}/peer-comparison/institution/${charterNumber}?period=${period}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    )
      .then(r => r.ok ? r.json() : null)
      .then(data => data && setInfo(data))
      .catch(console.error);
  }, [charterNumber, period, token]);
  return info;
}

function usePeerComparison(charterNumber, period, peerGroup, token, customCharters) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!charterNumber || !period) return;
    const params = new URLSearchParams({ period, peer_group: peerGroup });
    if (customCharters?.length) params.set('custom_charters', customCharters.join(','));
    fetch(
      `${API}/peer-comparison/${charterNumber}?${params}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    )
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setData(d))
      .catch(console.error);
  }, [charterNumber, period, peerGroup, token, customCharters]);
  return data;
}

function useAlerts(charterNumber, period, peerGroup, token) {
  const [alerts, setAlerts] = useState([]);
  useEffect(() => {
    if (!charterNumber || !period) return;
    fetch(
      `${API}/alerts/${charterNumber}?period=${period}&peer_group=${peerGroup}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    )
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setAlerts(d.alerts ?? []))
      .catch(console.error);
  }, [charterNumber, period, peerGroup, token]);
  return alerts;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function TopBar({
  institutionName, stateAbbrev,
  peerGroup, onPeerGroupChange,
  periodLabel, onPeriodChange,
  onDownload,
}) {
  return (
    <header className="cq-topbar">
      <div className="topbar-left">
        <h1 className="page-title">Credit Quality</h1>
        {institutionName && (
          <span className="inst-pill">
            {institutionName}{stateAbbrev ? ` (${stateAbbrev})` : ''}
          </span>
        )}
      </div>

      <div className="topbar-center">
        <span className="topbar-label">Peer group</span>
        <div className="peer-toggle" role="group" aria-label="Peer group">
          <button
            className={`toggle-btn ${peerGroup === 'REGIONAL'   ? 'active' : ''}`}
            onClick={() => onPeerGroupChange('REGIONAL')}
          >
            Regional peers
          </button>
          <button
            className={`toggle-btn ${peerGroup === 'ASSET_SIZE' ? 'active' : ''}`}
            onClick={() => onPeerGroupChange('ASSET_SIZE')}
          >
            National peers
          </button>
          <button
            className={`toggle-btn ${peerGroup === 'STATE'      ? 'active' : ''}`}
            onClick={() => onPeerGroupChange('STATE')}
          >
            State
          </button>
        </div>
      </div>

      <div className="topbar-right">
        <span className="topbar-label">Period</span>
        <div className="period-selector" role="group" aria-label="Time period">
          {PERIOD_OPTIONS.map(opt => (
            <button
              key={opt.label}
              className={`period-btn ${periodLabel === opt.label ? 'active' : ''}`}
              onClick={() => onPeriodChange(opt.label, opt.nPeriods)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button className="download-btn" onClick={onDownload} title="Download dashboard data">
          Download
        </button>
      </div>
    </header>
  );
}

function KpiRow({ metrics, comparison }) {
  const byName = Object.fromEntries(
    (comparison?.metrics ?? []).map(m => [m.metric_name, m])
  );
  return (
    <div className="kpi-row">
      {metrics.map(def => {
        const m = byName[def.metric] ?? {};
        return (
          <KpiCard
            key={def.metric}
            label={def.label}
            value={m.institution_value}
            peerMedian={m.peer_median}
            stars={m.stars}
            percentileRank={m.percentile_rank}
            unit={def.unit}
            isAdverse={def.adverse}
          />
        );
      })}
    </div>
  );
}

function MetricTabs({ activeMetric, onSelect, comparison }) {
  const byName = Object.fromEntries(
    (comparison?.metrics ?? []).map(m => [m.metric_name, m])
  );
  return (
    <div className="metric-tabs" role="tablist" aria-label="Select metric">
      {METRIC_TABS.map(tab => {
        const m      = byName[tab.value];
        const stars  = m?.stars;
        const active = activeMetric === tab.value;
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={active}
            className={`metric-tab${active ? ' active' : ''}`}
            onClick={() => onSelect(tab.value)}
          >
            {tab.label}
            {stars != null && !active && (
              <span className="tab-stars" aria-hidden>
                {'★'.repeat(stars)}{'☆'.repeat(5 - stars)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function CreditQuality({ charterNumber = 68708, token }) {
  const [period,         setPeriod]        = useState('2026Q1');
  const [periodLabel,    setPeriodLabel]   = useState('3Y');
  const [nPeriods,       setNPeriods]      = useState(12);
  const [peerGroup,      setPeerGroup]     = useState('REGIONAL');
  const [activeMetric,   setActiveMetric]  = useState('delinq_rate_total');
  const [customCharters, setCustomCharters] = useState(null);

  const [geographyType, setGeographyType] = useState('state');
  const [geographyId,   setGeographyId]   = useState(null);

  const loanBreakdownRef = useRef(null);

  const instInfo   = useInstitutionInfo(charterNumber, period, token);
  const comparison = usePeerComparison(charterNumber, period, peerGroup, token, customCharters);
  const alerts     = useAlerts(charterNumber, period, peerGroup, token);

  useEffect(() => {
    if (instInfo?.state_abbrev && !geographyId) {
      setGeographyId(instInfo.state_abbrev);
    }
  }, [instInfo?.state_abbrev]);

  function handlePeriodChange(label, n) {
    setPeriodLabel(label);
    setNPeriods(n);
  }

  const handleDownload = useCallback(() => {
    if (!comparison?.metrics?.length) return;
    const lines = [
      `Credit Quality Dashboard — ${instInfo?.institution_name ?? charterNumber} — ${period}`,
      `Peer Group: ${comparison.peer_group_label} (${comparison.peer_count} institutions)`,
      '',
      'Metric,Your Value,Peer Median,Top Decile,Bottom Decile,Percentile,Stars',
      ...comparison.metrics.map(m => [
        `"${m.callahan_label}"`,
        m.institution_value ?? '',
        m.peer_median        ?? '',
        m.peer_p90           ?? '',
        m.peer_p10           ?? '',
        m.percentile_rank != null ? m.percentile_rank.toFixed(1) : '',
        m.stars ?? '',
      ].join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `credit_quality_${charterNumber}_${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [comparison, instInfo, charterNumber, period]);

  const showSignal = SIGNAL_METRICS.has(activeMetric);
  const peerLabel  = comparison?.peer_group_label ?? '';

  return (
    <div className="credit-quality-page">

      {/* ── Sticky top bar ── */}
      <TopBar
        institutionName={instInfo?.institution_name}
        stateAbbrev={instInfo?.state_abbrev}
        peerGroup={peerGroup}
        onPeerGroupChange={setPeerGroup}
        periodLabel={periodLabel}
        onPeriodChange={handlePeriodChange}
        onDownload={handleDownload}
      />

      {/* ── KPI row ── */}
      <KpiRow metrics={KPI_DEFS} comparison={comparison} />

      {/* ── Early warning — P76 exclusive ── */}
      <div className="cq-alerts-area">
        <EarlyWarningPanel
          charterNumber={charterNumber}
          period={period}
          peerGroup={peerGroup}
          token={token}
          alerts={alerts}
        />
      </div>

      <div className="cq-body">

        {/* ── Trend chart card ── */}
        <div className="cq-card">
          <div className="cq-card-header">
            <span className="cq-card-title">Trend Analysis</span>
            <span className="cq-card-meta">Updates with: peer group · time period</span>
          </div>

          {/* Metric tabs — click a tab to switch the chart below */}
          <MetricTabs
            activeMetric={activeMetric}
            onSelect={setActiveMetric}
            comparison={comparison}
          />

          <div className="cq-card-body">
            <PeerBandChart
              metric={activeMetric}
              charterNumber={charterNumber}
              period={period}
              peerGroup={peerGroup}
              nPeriods={nPeriods}
              token={token}
            />

            {/* Signal separator — below every delinquency/charge-off chart */}
            {showSignal && (
              <>
                <div className="signal-geo-controls">
                  <select
                    value={geographyType}
                    onChange={e => { setGeographyType(e.target.value); setGeographyId(''); }}
                    className="geo-type-select"
                    aria-label="Geography type"
                  >
                    <option value="state">State</option>
                    <option value="msa">MSA</option>
                    <option value="county">County</option>
                  </select>
                  <input
                    className="geo-id-input"
                    type="text"
                    value={geographyId ?? ''}
                    onChange={e => setGeographyId(e.target.value)}
                    placeholder={
                      geographyType === 'state'  ? 'e.g. MI' :
                      geographyType === 'msa'    ? 'MSA code' : 'County FIPS'
                    }
                    aria-label="Geography ID"
                  />
                </div>
                <SignalSeparator
                  charterNumber={charterNumber}
                  metric={activeMetric}
                  period={period}
                  peerGroup={peerGroup}
                  geographyType={geographyType}
                  geographyId={geographyId}
                  token={token}
                />
              </>
            )}
          </div>
        </div>

        {/* ── Delinquency by Product ── */}
        <div className="cq-card" ref={loanBreakdownRef}>
          <div className="cq-card-header">
            <span className="cq-card-title">Delinquency by Product</span>
            <span className="cq-card-meta">Callahan · updates with peer group</span>
          </div>
          <div className="cq-card-body">
            <LoanTypeBreakdownChart
              charterNumber={charterNumber}
              period={period}
              peerGroup={peerGroup}
              token={token}
            />
          </div>
        </div>

        {/* ── Peer comparison table ── */}
        <div className="cq-card">
          <PeerComparisonTable
            metrics={comparison?.metrics ?? []}
            charterNumber={charterNumber}
            period={period}
            peerGroup={peerGroup}
            peerGroupLabel={peerLabel}
            peerCount={comparison?.peer_count}
            onCustomCharters={setCustomCharters}
          />
        </div>

      </div>
    </div>
  );
}
