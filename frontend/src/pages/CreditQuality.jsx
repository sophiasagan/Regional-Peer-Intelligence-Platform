/**
 * CreditQuality — primary credit quality dashboard.
 *
 * P76 exclusive features (always present, clearly labeled):
 *   EarlyWarningPanel  — "Know before your examiner does" — auto-expands on any alert
 *   SignalSeparator    — "Is this a you-problem or a market-problem?" — below every delinquency chart
 *   Regional peer toggle — always visible in peer group selector
 *   PeerBandChart      — the ONLY chart type for trend views; regional line = purple dashed
 *   LoanTypeBreakdownChart — "Delinquency by Product" (Callahan) — grouped bars
 *
 * Callahan UX parity (NEVER violate):
 *   Exact Callahan metric names everywhere
 *   Top decile = green badge, Bottom decile = red badge
 *   Stars: 1 = <10th pctile, 5 = ≥90th pctile
 *   Period default: 3 years / 12 quarters
 *   Every chart has Excel/CSV download
 *   Always show peer group label on every chart
 */

import React, { useState, useEffect, useCallback } from 'react';
import EarlyWarningPanel      from '../components/EarlyWarningPanel';
import PeerBandChart          from '../components/PeerBandChart';
import SignalSeparator        from '../components/SignalSeparator';
import MetricLibrary          from '../components/MetricLibrary';
import KpiCard                from '../components/KpiCard';
import LoanTypeBreakdownChart from '../components/LoanTypeBreakdownChart';
import PeerComparisonTable    from '../components/PeerComparisonTable';

const API = import.meta.env.VITE_API_URL ?? '';

// Metrics that require SignalSeparator below their trend chart
const SIGNAL_METRICS = new Set([
  'delinq_rate_total', 'delinq_rate_90plus', 'chargeoff_rate_total_annualized',
  'alll_coverage', 'alll_to_loans', 'non_accrual_rate', 'tdr_to_loans',
  'delinq_rate_credit_card', 'delinq_rate_auto_total',
  'delinq_rate_first_mortgage', 'delinq_rate_commercial', 'delinq_rate_commercial_re',
]);

// Top 4 KPI cards (exact Callahan labels)
const KPI_DEFS = [
  { metric: 'delinq_rate_total',               label: 'Total Delinquency Ratio',   unit: '%', adverse: true  },
  { metric: 'delinq_rate_90plus',              label: '90+ Day Delinquency',        unit: '%', adverse: true  },
  { metric: 'chargeoff_rate_total_annualized', label: 'Net Charge-Off Ratio',       unit: '%', adverse: true  },
  { metric: 'alll_coverage',                   label: 'ALLL Coverage Ratio',        unit: 'x', adverse: false },
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
  institutionName, stateAbbrev, peerGroupLabel,
  peerGroup, onPeerGroupChange,
  periodLabel, onPeriodChange,
  onDownload,
}) {
  return (
    <header className="cq-topbar">
      <div className="topbar-left">
        <h1 className="page-title">Credit quality</h1>
      </div>

      <div className="topbar-center">
        {institutionName && (
          <span className="inst-pill">
            {institutionName}{stateAbbrev ? ` (${stateAbbrev})` : ''}
          </span>
        )}
        {peerGroupLabel && (
          <span className="peer-pill">{peerGroupLabel}</span>
        )}

        {/* Regional / National toggle — always visible (P76 rule) */}
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

function MetricSelector({ activeMetric, onSelect, comparison }) {
  const byName = Object.fromEntries(
    (comparison?.metrics ?? []).map(m => [m.metric_name, m])
  );
  const options = [
    { value: 'delinq_rate_total',               label: 'Total Delinquency Ratio' },
    { value: 'delinq_rate_90plus',              label: '90+ Day Delinquency' },
    { value: 'chargeoff_rate_total_annualized', label: 'Net Charge-Off Ratio' },
    { value: 'alll_coverage',                   label: 'ALLL Coverage Ratio' },
    { value: 'alll_to_loans',                   label: 'ALLL to Total Loans' },
    { value: 'net_worth_ratio',                 label: 'Net Worth Ratio' },
    { value: 'roa_annualized',                  label: 'Return on Assets' },
    { value: 'efficiency_ratio',                label: 'Efficiency Ratio' },
  ];
  return (
    <div className="metric-selector-row">
      <label htmlFor="metric-select" className="metric-select-label">Metric:</label>
      <select
        id="metric-select"
        className="metric-select"
        value={activeMetric}
        onChange={e => onSelect(e.target.value)}
      >
        {options.map(o => {
          const m = byName[o.value];
          const stars = m?.stars != null ? ` (${'★'.repeat(m.stars)}${'☆'.repeat(5 - m.stars)})` : '';
          return (
            <option key={o.value} value={o.value}>
              {o.label}{stars}
            </option>
          );
        })}
      </select>
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
  const [customCharters, setCustomCharters] = useState(null);  // null = use default peer group

  // Geography for SignalSeparator — defaults to institution's state
  const [geographyType, setGeographyType] = useState('state');
  const [geographyId,   setGeographyId]   = useState(null);

  // Scroll-to ref for loan breakdown (used by MetricLibrary "Delinquency by Product")
  const loanBreakdownRef = React.useRef(null);

  const instInfo    = useInstitutionInfo(charterNumber, period, token);
  const comparison  = usePeerComparison(charterNumber, period, peerGroup, token, customCharters);
  const alerts      = useAlerts(charterNumber, period, peerGroup, token);

  function handleCustomCharters(charters) {
    setCustomCharters(charters);   // null resets to default peer group
  }

  // Set geography default from institution's state once loaded
  useEffect(() => {
    if (instInfo?.state_abbrev && !geographyId) {
      setGeographyId(instInfo.state_abbrev);
    }
  }, [instInfo?.state_abbrev]);

  function handlePeriodChange(label, n) {
    setPeriodLabel(label);
    setNPeriods(n);
  }

  function handleMetricSelect(name) {
    setActiveMetric(name);
  }

  function handleSpecialView(special) {
    if (special === 'loan_breakdown') {
      loanBreakdownRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    // FPR, CUPP, Trendwatch — future: navigate to those views
  }

  // Full dashboard CSV download (KPI metrics + peer comparison table)
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

      {/* ── Top bar ── */}
      <TopBar
        institutionName={instInfo?.institution_name}
        stateAbbrev={instInfo?.state_abbrev}
        peerGroupLabel={peerLabel}
        peerGroup={peerGroup}
        onPeerGroupChange={setPeerGroup}
        periodLabel={periodLabel}
        onPeriodChange={handlePeriodChange}
        onDownload={handleDownload}
      />

      {/* ── KPI row — 4 cards matching Callahan top-of-page layout ── */}
      <KpiRow metrics={KPI_DEFS} comparison={comparison} />

      {/* ── Early warning panel — P76 exclusive — auto-expands on any alert ── */}
      <EarlyWarningPanel
        charterNumber={charterNumber}
        period={period}
        peerGroup={peerGroup}
        token={token}
        alerts={alerts}
      />

      {/* ── Two-column body: MetricLibrary | Main content ── */}
      <div className="dashboard-layout">

        <MetricLibrary
          activeMetric={activeMetric}
          onMetricSelect={handleMetricSelect}
          onSpecialView={handleSpecialView}
        />

        <main className="dashboard-main">

          {/* ── Main chart ── */}
          <section className="chart-section">
            <MetricSelector
              activeMetric={activeMetric}
              onSelect={handleMetricSelect}
              comparison={comparison}
            />

            {/* PeerBandChart is the ONLY chart type for trend views (P76 rule) */}
            <PeerBandChart
              metric={activeMetric}
              charterNumber={charterNumber}
              period={period}
              peerGroup={peerGroup}
              nPeriods={nPeriods}
              token={token}
            />

            {/* Signal separator — P76 exclusive — below every delinquency/charge-off chart */}
            {showSignal && (
              <>
                {/* Geography scope controls for signal separation */}
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
          </section>

          {/* ── Delinquency by Product — second chart (Callahan) ── */}
          <section className="loan-breakdown-section" ref={loanBreakdownRef}>
            <LoanTypeBreakdownChart
              charterNumber={charterNumber}
              period={period}
              peerGroup={peerGroup}
              token={token}
            />
          </section>

          {/* ── Peer comparison table — lower section ── */}
          <section className="peer-table-section">
            <PeerComparisonTable
              metrics={comparison?.metrics ?? []}
              charterNumber={charterNumber}
              period={period}
              peerGroup={peerGroup}
              peerGroupLabel={peerLabel}
              peerCount={comparison?.peer_count}
              onCustomCharters={handleCustomCharters}
            />
          </section>

        </main>
      </div>
    </div>
  );
}
