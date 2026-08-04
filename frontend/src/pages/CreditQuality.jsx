/**
 * CreditQuality — primary credit quality dashboard.
 *
 * Layout (P76 hierarchy):
 *   1. Urgent alert banner   — full-width, conditional on alert_level === "urgent"
 *   2. Early warning section — expanded cards for watch/alert/urgent; quiet status line for none
 *   3. KPI cards             — value + stars + percentile; peer median in (i) tooltip
 *   4. Metric chip row       — 4 primary KPIs always visible; everything else in "More metrics" dropdown
 *   5. Trend chart           — PeerBandChart (unchanged)
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
import { createPortal } from 'react-dom';
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

// KPI cards — exact Callahan labels. These 4 are also the always-visible chips.
const KPI_DEFS = [
  { metric: 'delinq_rate_total',               label: 'Total Delinquency Ratio',   unit: '%', adverse: true  },
  { metric: 'delinq_rate_90plus',              label: '90+ Day Delinquency',        unit: '%', adverse: true  },
  { metric: 'chargeoff_rate_total_annualized', label: 'Net Charge-Off Ratio',       unit: '%', adverse: true  },
  { metric: 'alll_coverage',                   label: 'ALLL Coverage Ratio',        unit: 'x', adverse: false },
];

const METRIC_TABS = [
  // ── Asset Quality ──────────────────────────────────────────────────────────
  { divider: true, label: 'Asset Quality' },
  { value: 'delinq_rate_total',               label: 'Total Delinquency'   },
  { value: 'delinq_rate_90plus',              label: '90+ Day Delinq'      },
  { value: 'chargeoff_rate_total_annualized', label: 'Net Charge-Off'      },
  { value: 'alll_coverage',                   label: 'ALLL Coverage'       },
  { value: 'alll_to_loans',                   label: 'ALLL to Loans'       },
  { value: 'non_accrual_rate',                label: 'Non-Accrual Rate'    },
  { value: 'tdr_to_loans',                    label: 'TDR / Modifications' },
  // ── Delinquency by Product ─────────────────────────────────────────────────
  { divider: true, label: 'Delinquency by Product' },
  { value: 'delinq_rate_cc',                  label: 'Credit Card Delinq'  },
  { value: 'delinq_rate_auto',                label: 'Auto Delinquency'    },
  { value: 'delinq_rate_1st_mortgage',        label: '1st Mortgage Delinq' },
  { value: 'delinq_rate_nonfarm_nonre',       label: 'Non-Farm Non-RE Delinq' },
  { value: 'delinq_rate_commercial_re',       label: 'Commercial RE Delinq'},
  // ── Capital ────────────────────────────────────────────────────────────────
  { divider: true, label: 'Capital' },
  { value: 'net_worth_ratio',                 label: 'Net Worth Ratio'     },
  { value: 'rbc_ratio',                       label: 'Risk-Based Capital'  },
  // ── Earnings ───────────────────────────────────────────────────────────────
  { divider: true, label: 'Earnings' },
  { value: 'roa_annualized',                  label: 'Return on Assets'    },
  { value: 'nim',                             label: 'Net Interest Margin' },
  { value: 'efficiency_ratio',                label: 'Efficiency Ratio'    },
  // ── Lending / Balance Sheet ────────────────────────────────────────────────
  { divider: true, label: 'Lending' },
  { value: 'loan_to_share',                   label: 'Loan-to-Share Ratio' },
  { value: 'acct_025B',                       label: 'Total Loans'         },
  { value: 'acct_010',                        label: 'Total Assets'        },
  { value: 'acct_018',                        label: 'Total Shares'        },
  { value: 'acct_083',                        label: 'Members'             },
  // ── Growth (YoY — prior-year same quarter) ─────────────────────────────────
  { divider: true, label: 'Growth (YoY)' },
  { value: 'loan_growth_rate',                label: 'Loan Growth'         },
  { value: 'share_growth_rate',               label: 'Share Growth'        },
  { value: 'asset_growth_rate',               label: 'Asset Growth'        },
  { value: 'member_growth_rate',              label: 'Member Growth'       },
];

const PERIOD_OPTIONS = [
  { label: '1Y', nPeriods: 4  },
  { label: '3Y', nPeriods: 12 },
  { label: '5Y', nPeriods: 20 },
];

// Primary chips — the 4 KPI metrics (match KPI_DEFS order)
const PRIMARY_VALUES = new Set(KPI_DEFS.map(d => d.metric));

// Build "More metrics" menu items, preserving group headers but skipping any
// header whose entire group is in the primary set.
const MORE_TABS = (() => {
  const out = [];
  let pendingDivider = null;
  for (const tab of METRIC_TABS) {
    if (tab.divider) {
      pendingDivider = tab;
    } else if (!PRIMARY_VALUES.has(tab.value)) {
      if (pendingDivider) { out.push(pendingDivider); pendingDivider = null; }
      out.push(tab);
    }
  }
  return out;
})();

const MORE_VALUES = new Set(MORE_TABS.filter(t => !t.divider).map(t => t.value));

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

// Lifted to page level so we can derive the urgency signal before EarlyWarningPanel renders.
function useEarlyWarning(charterNumber, period, peerGroup, token) {
  const [ewData, setEwData] = useState(null);
  useEffect(() => {
    if (!charterNumber || !period) return;
    setEwData(null);
    const params = new URLSearchParams({ period, peer_group: peerGroup });
    fetch(`${API}/alerts/${charterNumber}/early-warning?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setEwData(d))
      .catch(console.error);
  }, [charterNumber, period, peerGroup, token]);
  return ewData;
}

// ── Section 1 — Urgent alert banner ───────────────────────────────────────

function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return `${(v * 100).toFixed(2)}%`;
}

function buildUrgentText(type, card) {
  const val = fmtPct(card.institution_value ?? card.current_value);
  if (type === 'projection' && card.already_breached) {
    return `${card.metric_label} has reached the ${fmtPct(card.threshold_value)} examiner threshold — currently ${fmtPct(card.current_value)}`;
  }
  if (type === 'projection' && card.quarters_to_threshold != null) {
    const q = Math.round(card.quarters_to_threshold);
    return `${card.metric_label} on track to reach ${fmtPct(card.threshold_value)} in ~${q} quarter${q !== 1 ? 's' : ''} — currently ${fmtPct(card.current_value)}`;
  }
  if (type === 'acceleration' && card.acceleration_ratio != null) {
    return `${card.metric_label} rising at ${card.acceleration_ratio.toFixed(1)}× the historical rate — currently ${val}`;
  }
  if (type === 'divergence') {
    return `${card.metric_label} diverging from peers — currently ${val}`;
  }
  return `${card.metric_label} — currently ${val}`;
}

function UrgentBanner({ ewData, expanded, onReviewDetail }) {
  if (!ewData) return null;
  const urgentCards = [
    ewData.acceleration && { type: 'acceleration', ...ewData.acceleration },
    ewData.divergence   && { type: 'divergence',   ...ewData.divergence   },
    ewData.projection   && { type: 'projection',   ...ewData.projection   },
  ].filter(c => c && c.alert_level === 'urgent');

  if (urgentCards.length === 0) return null;
  const primary = urgentCards[0];

  return (
    <div className="cq-urgent-banner" role="alert">
      <span className="cq-urgent-icon" aria-hidden>⚠</span>
      <div className="cq-urgent-body">
        <strong>{buildUrgentText(primary.type, primary)}</strong>
        {urgentCards.length > 1 && (
          <span className="cq-urgent-more">
            {' '}+{urgentCards.length - 1} more signal{urgentCards.length - 1 > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <button
        type="button"
        className="btn btn--danger cq-urgent-action"
        onClick={onReviewDetail}
        aria-expanded={expanded}
      >
        Review detail {expanded ? '↑' : '↓'}
      </button>
    </div>
  );
}

// ── Slim collapsed row for a single urgent EW card ─────────────────────────
// Reuses existing .ew-panel / .ew-panel-toggle / .ew-level-badge classes —
// no new CSS required.

const EW_TYPE_LABELS = {
  acceleration: 'Trend Acceleration',
  divergence:   'Peer Divergence',
  projection:   'Threshold Projection',
};

function EwCollapsedRow({ type, onExpand }) {
  return (
    <button
      type="button"
      className="ew-collapsed-row"
      onClick={onExpand}
      aria-expanded={false}
      aria-label={`Show ${EW_TYPE_LABELS[type] ?? type} detail`}
    >
      <span className="ew-collapsed-row-label">{EW_TYPE_LABELS[type] ?? type}</span>
      <span
        className="ew-level-badge"
        style={{ color: '#D32F2F', backgroundColor: '#FEF2F2', border: '1px solid #EF4444' }}
      >
        Urgent
      </span>
      {/* Inline SVG chevron — Tabler-style, no package dependency needed */}
      <svg
        className="ew-collapsed-row-chevron"
        width="14" height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}

// ── Section 2b — Quiet status line for normal panels ─────────────────────

const PANEL_QUIET_LABELS = {
  acceleration: 'Trend acceleration',
  divergence:   'Peer divergence',
  projection:   'Threshold projection',
};

function QuietStatusLine({ ewData }) {
  if (!ewData) return null;
  const quietPanels = [
    ewData.acceleration && { type: 'acceleration', level: ewData.acceleration.alert_level },
    ewData.divergence   && { type: 'divergence',   level: ewData.divergence.alert_level   },
    ewData.projection   && { type: 'projection',   level: ewData.projection.alert_level   },
  ].filter(c => c && c.level === 'none');

  if (quietPanels.length === 0) return null;

  return (
    <div className="cq-quiet-status" aria-label="Normal early-warning panels">
      {quietPanels.map(p => (
        <span key={p.type} className="cq-quiet-item">
          <span className="cq-quiet-check" aria-hidden>✓</span>
          {PANEL_QUIET_LABELS[p.type]} normal
        </span>
      ))}
    </div>
  );
}

// ── Section 3 — KPI row ────────────────────────────────────────────────────

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

// ── Section 4 — Metric chip selector ──────────────────────────────────────

// Renders the "More metrics" button + its dropdown via createPortal so the menu
// escapes both overflow-x:auto on .metric-tabs and overflow:hidden on .cq-card.
function MoreMetricsDropdown({ activeMetric, onSelect }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuPos,  setMenuPos]  = useState({ top: 0, left: 0 });
  const btnRef  = useRef(null);
  const menuRef = useRef(null);

  const activeMoreLabel = MORE_VALUES.has(activeMetric)
    ? MORE_TABS.find(t => !t.divider && t.value === activeMetric)?.label
    : null;

  function handleToggle() {
    if (moreOpen) {
      setMoreOpen(false);
    } else {
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        setMenuPos({ top: rect.bottom + 4, left: rect.left });
      }
      setMoreOpen(true);
    }
  }

  useEffect(() => {
    if (!moreOpen) return;
    function handleOutside(e) {
      if (
        menuRef.current && !menuRef.current.contains(e.target) &&
        btnRef.current  && !btnRef.current.contains(e.target)
      ) {
        setMoreOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [moreOpen]);

  const menu = moreOpen && createPortal(
    <div
      ref={menuRef}
      className="more-metrics-menu"
      role="listbox"
      style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
    >
      {MORE_TABS.map((tab, i) => {
        if (tab.divider) {
          return <div key={`div-${i}`} className="more-metrics-divider">{tab.label}</div>;
        }
        return (
          <button
            key={tab.value}
            role="option"
            aria-selected={activeMetric === tab.value}
            className={`more-metrics-item${activeMetric === tab.value ? ' active' : ''}`}
            onClick={() => { onSelect(tab.value); setMoreOpen(false); }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`metric-tab more-metrics-btn${activeMoreLabel ? ' active' : ''}`}
        onClick={handleToggle}
        aria-haspopup="listbox"
        aria-expanded={moreOpen}
      >
        {activeMoreLabel ?? 'More metrics'}
        <span className="more-metrics-chevron" aria-hidden>{moreOpen ? ' ▲' : ' ▼'}</span>
      </button>
      {menu}
    </>
  );
}

function MetricSelector({ activeMetric, onSelect }) {
  return (
    <div className="metric-tabs" role="tablist" aria-label="Select metric">
      {KPI_DEFS.map(def => (
        <button
          key={def.metric}
          role="tab"
          aria-selected={activeMetric === def.metric}
          className={`metric-tab${activeMetric === def.metric ? ' active' : ''}`}
          onClick={() => onSelect(def.metric)}
        >
          {def.label}
        </button>
      ))}
      <MoreMetricsDropdown activeMetric={activeMetric} onSelect={onSelect} />
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

function loadSavedPeerCharters() {
  try {
    const stored = localStorage.getItem('p76_peer_charters');
    return stored ? JSON.parse(stored) : null;
  } catch { return null; }
}

export default function CreditQuality({ charterNumber, token }) {
  const [period,         setPeriod]        = useState('2026Q1');
  const [periodLabel,    setPeriodLabel]   = useState('3Y');
  const [nPeriods,       setNPeriods]      = useState(12);
  const [peerGroup,      setPeerGroup]     = useState('REGIONAL');
  const [activeMetric,   setActiveMetric]  = useState('delinq_rate_total');
  const [customCharters, setCustomCharters] = useState(loadSavedPeerCharters);

  const [geographyType, setGeographyType] = useState('state');
  const [geographyId,   setGeographyId]   = useState(null);

  const loanBreakdownRef = useRef(null);
  const ewDetailRef      = useRef(null);

  const instInfo   = useInstitutionInfo(charterNumber, period, token);
  const comparison = usePeerComparison(charterNumber, period, peerGroup, token, customCharters);
  const alerts     = useAlerts(charterNumber, period, peerGroup, token);
  const ewData     = useEarlyWarning(charterNumber, period, peerGroup, token);

  // Collapse urgent cards by default — they're already summarised in the banner.
  // Reset whenever ewData changes (period / peer group switch).
  const [ewDetailExpanded, setEwDetailExpanded] = useState(false);
  useEffect(() => { setEwDetailExpanded(false); }, [ewData]);

  // True when at least one EW panel is above "none" — drives whether the detailed panel renders
  const hasElevated = ewData != null && [
    ewData.acceleration, ewData.divergence, ewData.projection,
  ].some(c => c && c.alert_level !== 'none');

  // Types whose alert_level is 'urgent' — these are the ones summarised in the banner
  const urgentTypes = ewData
    ? ['acceleration', 'divergence', 'projection'].filter(
        type => ewData[type]?.alert_level === 'urgent'
      )
    : [];
  const hasUrgent = urgentTypes.length > 0;

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
        `"${m.metric_label}"`,
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

      {/* ── 1. Urgent alert banner — conditional, full width ── */}
      <UrgentBanner
        ewData={ewData}
        expanded={ewDetailExpanded}
        onReviewDetail={() => {
          const expanding = !ewDetailExpanded;
          setEwDetailExpanded(expanding);
          if (expanding) {
            requestAnimationFrame(() =>
              ewDetailRef.current?.scrollIntoView({ behavior: 'smooth' })
            );
          }
        }}
      />

      {/* ── 2a. Elevated panels (watch / alert / urgent) ───────────────────────
          Urgent cards are collapsed by default — they're already summarised in
          the banner above. The slim EwCollapsedRow rows keep the section visible
          and make it clear there's detail to review.
          Watch / alert cards are never duplicated in the banner, so they always
          render expanded.
          ─────────────────────────────────────────────────────────────────────── */}
      {hasElevated && (
        <div ref={ewDetailRef} className="cq-alerts-area">
          {hasUrgent && !ewDetailExpanded ? (
            <>
              {/* Slim collapsed row for each urgent card — one per type */}
              {urgentTypes.map(type => (
                <EwCollapsedRow
                  key={type}
                  type={type}
                  onExpand={() => {
                    setEwDetailExpanded(true);
                    requestAnimationFrame(() =>
                      ewDetailRef.current?.scrollIntoView({ behavior: 'smooth' })
                    );
                  }}
                />
              ))}
              {/* Non-urgent elevated cards (watch / alert) — always expanded */}
              <EarlyWarningPanel
                charterNumber={charterNumber}
                period={period}
                peerGroup={peerGroup}
                token={token}
                alerts={alerts}
                ewData={ewData}
                managed
                visibleLevels={['watch', 'alert']}
              />
            </>
          ) : (
            /* Expanded state — all elevated cards (watch + alert + urgent) */
            <EarlyWarningPanel
              charterNumber={charterNumber}
              period={period}
              peerGroup={peerGroup}
              token={token}
              alerts={alerts}
              ewData={ewData}
              managed
              visibleLevels={['watch', 'alert', 'urgent']}
            />
          )}
        </div>
      )}

      {/* ── 2b. Quiet status line for normal panels — small text, no panels ── */}
      <QuietStatusLine ewData={ewData} />

      {/* ── 3. KPI cards ── */}
      <KpiRow metrics={KPI_DEFS} comparison={comparison} />

      <div className="cq-body">

        {/* ── 4 + 5. Trend chart card with trimmed metric selector ── */}
        <div className="cq-card">
          <div className="cq-card-header">
            <span className="cq-card-title">Trend Analysis</span>
            <span className="cq-card-meta">Updates with: peer group · time period</span>
          </div>

          {/* 4. Metric chip selector — 4 primary + "More metrics" dropdown */}
          <MetricSelector activeMetric={activeMetric} onSelect={setActiveMetric} />

          {/* 5. Trend chart — leave exactly as-is */}
          <div className="cq-card-body">
            <PeerBandChart
              metric={activeMetric}
              charterNumber={charterNumber}
              period={period}
              peerGroup={customCharters?.length ? 'CUSTOM' : peerGroup}
              nPeriods={nPeriods}
              token={token}
              customCharters={customCharters}
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
            <span className="cq-card-meta">Updates with peer group</span>
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
            peerGroup={customCharters?.length ? 'CUSTOM' : peerGroup}
            peerGroupLabel={peerLabel}
            peerCount={comparison?.peer_count}
            token={token}
            customCharters={customCharters}
            onCustomCharters={setCustomCharters}
          />
        </div>

      </div>
    </div>
  );
}
