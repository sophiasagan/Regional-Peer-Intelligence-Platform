/**
 * SignalSeparator — P76 exclusive feature.
 * Position: below every delinquency / charge-off chart.
 * Label: "Is this a you-problem or a market-problem?"
 *
 * Data source: GET /alerts/{charterNumber}/signal
 *   → PeerEngine.separate_market_vs_institution_signal()
 *
 * STATE 1 — regional_pressure    → amber-50,  badge "Market condition"
 * STATE 2 — institution_specific → coral-50,  badge "Institution signal"
 * STATE 3 — outperforming_market → teal-50,   badge "Outperforming market"
 * STATE 4 — no_signal            → gray-50,   no badge
 *
 * Re-fetches whenever metric, period, geographyType, or geographyId changes.
 */

import React, { useState, useEffect } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

// Callahan metric names for use in body copy
const CALLAHAN_LABELS = {
  delinq_rate_total:                'total delinquency ratio',
  delinq_rate_90plus:               '90+ day delinquency',
  chargeoff_rate_total_annualized:  'net charge-off rate',
  alll_coverage:                    'ALLL coverage ratio',
  alll_to_loans:                    'ALLL to total loans',
  non_accrual_rate:                 'non-accrual rate',
  tdr_to_loans:                     'TDR / modifications ratio',
  delinq_rate_credit_card:          'credit card delinquency',
  delinq_rate_auto_total:           'total auto delinquency',
  delinq_rate_first_mortgage:       '1st mortgage delinquency',
  delinq_rate_commercial:           'non-farm non-RE delinquency',
  delinq_rate_commercial_re:        'commercial real estate delinquency',
  efficiency_ratio:                 'efficiency ratio',
};

// Recommended portfolio area to review per metric (used in STATE 2 body copy)
const LOAN_TYPE_COPY = {
  delinq_rate_total:               'overall loan portfolio',
  chargeoff_rate_total_annualized: 'charge-off management practices',
  delinq_rate_credit_card:         'credit card',
  delinq_rate_auto_total:          'auto loan',
  delinq_rate_first_mortgage:      'mortgage',
  delinq_rate_commercial:          'commercial and business lending',
  delinq_rate_commercial_re:       'commercial real estate',
  alll_coverage:                   'allowance methodology',
  non_accrual_rate:                'non-accrual classification',
  tdr_to_loans:                    'loan modification',
};

// Visual config per signal type
const STATES = {
  regional_pressure: {
    badge:      'Market condition',
    badgeCls:   'badge-amber',
    wrapperCls: 'signal-regional-pressure',
    bgStyle:    { backgroundColor: '#FFFBEB', borderLeft: '4px solid #D97706' },
  },
  institution_specific: {
    badge:      'Institution signal',
    badgeCls:   'badge-coral',
    wrapperCls: 'signal-institution-specific',
    bgStyle:    { backgroundColor: '#FFF5F5', borderLeft: '4px solid #993C1D' },
  },
  outperforming_market: {
    badge:      'Outperforming market',
    badgeCls:   'badge-teal',
    wrapperCls: 'signal-outperforming-market',
    bgStyle:    { backgroundColor: '#F0FDFA', borderLeft: '4px solid #0F6E56' },
  },
  no_signal: {
    badge:      null,
    badgeCls:   '',
    wrapperCls: 'signal-no-signal',
    bgStyle:    { backgroundColor: '#F8F9FA', borderLeft: '4px solid #9E9E9E' },
  },
};

// ── Body copy builders ────────────────────────────────────────────────────────

function buildBodyCopy(signal, metric) {
  const metricLabel = CALLAHAN_LABELS[metric] ?? metric;
  const geo         = signal.regional_group_label ?? 'your region';
  const N           = signal.peers_above_national_median;
  const M           = signal.regional_peer_count;
  const loanType    = LOAN_TYPE_COPY[metric] ?? 'loan portfolio';

  switch (signal.signal_type) {
    case 'regional_pressure':
      return (
        <>
          Your <strong>{metricLabel}</strong> is above the national peer median,
          but so is the <strong>{geo}</strong> median. This pattern is consistent
          with regional economic pressure affecting all institutions in your market.
          {N != null && M != null && (
            <> <strong>{N} of {M}</strong> institutions in {geo} show similar trends.</>
          )}
        </>
      );

    case 'institution_specific':
      return (
        <>
          Your <strong>{metricLabel}</strong> is above both the national peer median{' '}
          <em>and</em> the regional median for <strong>{geo}</strong>. Institutions in
          your market are not seeing the same pattern. This warrants a review of{' '}
          <strong>{loanType}</strong> underwriting or portfolio mix.
        </>
      );

    case 'outperforming_market':
      return (
        <>
          Regional <strong>{metricLabel}</strong> is elevated above national peers,
          but your institution is below the regional median. Your portfolio is
          performing better than competitors in your market.
        </>
      );

    case 'no_signal':
      return (
        <>
          No significant signal detected — <strong>{metricLabel}</strong> is within
          normal ranges across institution, regional, and national comparisons.
        </>
      );

    default:
      return null;
  }
}

// ── Value formatting ──────────────────────────────────────────────────────────

function fmtSignalValue(v, metric) {
  if (v == null || isNaN(v)) return '—';
  // Coverage ratios display as Nx; everything else as %
  if (metric === 'alll_coverage') return `${v.toFixed(2)}x`;
  return `${(v * 100).toFixed(3)}%`;
}

// ── Stats row ─────────────────────────────────────────────────────────────────

function StatsRow({ signal, metric }) {
  const regionalLabel = signal.regional_group_label ?? 'Regional';
  const peerCount     = signal.regional_peer_count;
  return (
    <div className="signal-stats-row">
      <div className="signal-stat-cell">
        <span className="stat-label">Your institution</span>
        <span className="stat-value stat-institution">
          {fmtSignalValue(signal.institution_value, metric)}
        </span>
      </div>
      <div className="stat-divider" aria-hidden>›</div>
      <div className="signal-stat-cell">
        <span className="stat-label">
          {regionalLabel}
          {peerCount != null && (
            <span className="stat-peer-count"> ({peerCount} peers)</span>
          )}
        </span>
        <span className="stat-value stat-regional">
          {fmtSignalValue(signal.regional_median, metric)}
        </span>
      </div>
      <div className="stat-divider" aria-hidden>›</div>
      <div className="signal-stat-cell">
        <span className="stat-label">National peers</span>
        <span className="stat-value stat-national">
          {fmtSignalValue(signal.national_median, metric)}
        </span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SignalSeparator({
  charterNumber,
  metric,
  period,
  peerGroup,
  geographyType = 'state',
  geographyId,
  token,
}) {
  const [signal,  setSignal]  = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!charterNumber || !metric || !period || !geographyId) return;
    setLoading(true);
    setSignal(null);

    const params = new URLSearchParams({
      metric,
      period,
      geography_type: geographyType,
      geography_id:   geographyId,
    });

    fetch(`${API}/alerts/${charterNumber}/signal?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => data && setSignal(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [charterNumber, metric, period, geographyType, geographyId, token]);

  // Don't render the panel at all when data is unavailable
  if (!loading && (!signal || signal.signal_type === 'no_data')) return null;

  const state = STATES[signal?.signal_type ?? 'no_signal'] ?? STATES.no_signal;

  return (
    <div
      className={`signal-separator ${state.wrapperCls}`}
      style={state.bgStyle}
      role="region"
      aria-label="Signal separation analysis"
    >
      {/* ── Header row ── */}
      <div className="signal-header-row">
        <span className="signal-eyebrow">Is this a you-problem or a market-problem?</span>
        {loading
          ? <span className="signal-analyzing">Analyzing…</span>
          : state.badge && (
              <span className={`signal-badge ${state.badgeCls}`}>
                {state.badge}
              </span>
            )
        }
      </div>

      {/* ── Body copy ── */}
      {!loading && signal && (
        <p className="signal-body">
          {buildBodyCopy(signal, metric)}
        </p>
      )}

      {/* ── Stats bar ── */}
      {!loading && signal && signal.institution_value != null && (
        <StatsRow signal={signal} metric={metric} />
      )}
    </div>
  );
}
