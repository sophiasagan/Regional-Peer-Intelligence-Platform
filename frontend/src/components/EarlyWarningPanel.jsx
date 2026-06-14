/**
 * EarlyWarningPanel — P76 exclusive.
 * Position: auto-expands ABOVE all charts if any alert is active.
 * Label: "Know before your examiner does"
 *
 * Self-fetching: calls GET /alerts/{charterNumber}/early-warning
 *
 * Three signal cards:
 *   AccelerationCard  — rate of change vs historical baseline
 *   DivergenceCard    — cumulative institution vs peer divergence
 *   ProjectionCard    — linear extrapolation to examiner threshold
 */

import React, { useState, useEffect } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

// Alert level colors (spec: watch=amber, alert=orange, urgent=red)
const LEVEL_CONFIG = {
  none:   { color: '#6B7280', bg: '#F9FAFB', border: '#D1D5DB', label: 'Normal' },
  watch:  { color: '#D97706', bg: '#FFFBEB', border: '#F59E0B', label: 'Watch'  },
  alert:  { color: '#EA580C', bg: '#FFF7ED', border: '#FB923C', label: 'Alert'  },
  urgent: { color: '#D32F2F', bg: '#FEF2F2', border: '#EF4444', label: 'Urgent' },
};

function fmtPct(v) {
  if (v == null || isNaN(v)) return '—';
  return `${(v * 100).toFixed(2)}%`;
}
function fmtPts(v) {
  if (v == null || isNaN(v)) return '—';
  return `${(v * 100).toFixed(2)} pts`;
}
function fmtRatio(v) {
  if (v == null || isNaN(v)) return '—';
  return `${v.toFixed(1)}×`;
}

// ── Alert level badge ─────────────────────────────────────────────────────────

function LevelBadge({ level }) {
  const cfg = LEVEL_CONFIG[level] ?? LEVEL_CONFIG.none;
  return (
    <span
      className="ew-level-badge"
      style={{ color: cfg.color, backgroundColor: cfg.bg, border: `1px solid ${cfg.border}` }}
    >
      {cfg.label}
    </span>
  );
}

// ── Card 1 — Trend Acceleration ───────────────────────────────────────────────

function AccelerationCard({ card }) {
  const cfg = LEVEL_CONFIG[card.alert_level] ?? LEVEL_CONFIG.none;
  const hasAlert = card.alert_level !== 'none';

  return (
    <div
      className="ew-card"
      style={{ borderLeft: `4px solid ${cfg.border}`, backgroundColor: cfg.bg }}
    >
      <div className="ew-card-header">
        <span className="ew-card-title">Trend Acceleration</span>
        <LevelBadge level={card.alert_level} />
      </div>

      {hasAlert && card.recent_avg_change != null ? (
        <p className="ew-card-body">
          Your <strong>{card.callahan_label}</strong> has risen{' '}
          <strong>{fmtPts(card.recent_avg_change)}</strong> over 2 quarters vs an avg of{' '}
          <strong>{fmtPts(card.historical_avg_change)}</strong> per quarter over the prior 6.
          Rate of increase is <strong>{fmtRatio(card.acceleration_ratio)}</strong> the historical average.
        </p>
      ) : (
        <p className="ew-card-body ew-card-body--muted">
          <strong>{card.callahan_label}</strong> acceleration is within normal historical range.
        </p>
      )}

      <div className="ew-card-stats">
        <div className="ew-stat">
          <span className="ew-stat-label">Current</span>
          <span className="ew-stat-value">{fmtPct(card.institution_value)}</span>
        </div>
        <div className="ew-stat">
          <span className="ew-stat-label">Recent avg change (2Q)</span>
          <span className="ew-stat-value" style={{ color: hasAlert ? cfg.color : undefined }}>
            {fmtPts(card.recent_avg_change)}
          </span>
        </div>
        <div className="ew-stat">
          <span className="ew-stat-label">Historical avg change (6Q)</span>
          <span className="ew-stat-value">{fmtPts(card.historical_avg_change)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Card 2 — Peer Divergence ──────────────────────────────────────────────────

function DivergenceCard({ card }) {
  const cfg = LEVEL_CONFIG[card.alert_level] ?? LEVEL_CONFIG.none;
  const hasAlert = card.alert_level !== 'none';

  return (
    <div
      className="ew-card"
      style={{ borderLeft: `4px solid ${cfg.border}`, backgroundColor: cfg.bg }}
    >
      <div className="ew-card-header">
        <span className="ew-card-title">Peer Divergence</span>
        <LevelBadge level={card.alert_level} />
      </div>

      {hasAlert && card.inst_cumulative_change != null ? (
        <p className="ew-card-body">
          Your <strong>{card.callahan_label}</strong> rose{' '}
          <strong>{fmtPts(card.inst_cumulative_change)}</strong> over 4 quarters while peers rose{' '}
          <strong>{fmtPts(card.peer_cumulative_change)}</strong>. You have accumulated{' '}
          <strong>{fmtPts(card.total_divergence)}</strong> of adverse divergence from your peer group.
        </p>
      ) : (
        <p className="ew-card-body ew-card-body--muted">
          <strong>{card.callahan_label}</strong> is tracking in line with peer movement over the last 4 quarters.
        </p>
      )}

      <div className="ew-card-stats">
        <div className="ew-stat">
          <span className="ew-stat-label">Your institution</span>
          <span className="ew-stat-value">{fmtPct(card.institution_value)}</span>
        </div>
        <div className="ew-stat">
          <span className="ew-stat-label">Peer median</span>
          <span className="ew-stat-value">{fmtPct(card.peer_median_current)}</span>
        </div>
        <div className="ew-stat">
          <span className="ew-stat-label">4Q divergence</span>
          <span className="ew-stat-value" style={{ color: hasAlert ? cfg.color : undefined }}>
            {fmtPts(card.total_divergence)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Card 3 — Threshold Projection ────────────────────────────────────────────

function ProjectionCard({ card }) {
  const cfg        = LEVEL_CONFIG[card.alert_level] ?? LEVEL_CONFIG.none;
  const hasAlert   = card.alert_level !== 'none';
  const isBreached = card.already_breached === true;
  const qtrs       = card.quarters_to_threshold;

  return (
    <div
      className="ew-card"
      style={{ borderLeft: `4px solid ${cfg.border}`, backgroundColor: cfg.bg }}
    >
      <div className="ew-card-header">
        <span className="ew-card-title">Threshold Projection</span>
        <LevelBadge level={card.alert_level} />
      </div>

      {/* P76 exclusive tagline */}
      <p className="ew-card-tagline">Know before your examiner does</p>

      {isBreached ? (
        <p className="ew-card-body">
          Your <strong>{card.callahan_label}</strong> has already reached the{' '}
          <strong>{fmtPct(card.threshold_value)}</strong> examiner threshold.{' '}
          <strong>Review with your risk committee before this occurs.</strong>
        </p>
      ) : hasAlert && qtrs != null ? (
        <p className="ew-card-body">
          At your current trajectory, your <strong>{card.callahan_label}</strong> would reach
          the <strong>{fmtPct(card.threshold_value)} examiner threshold</strong> in approximately{' '}
          <strong>{Math.round(qtrs)} quarter{Math.round(qtrs) !== 1 ? 's' : ''}</strong>. This is a
          linear projection.{' '}
          <strong>Review with your risk committee before this occurs.</strong>
        </p>
      ) : (
        <p className="ew-card-body ew-card-body--muted">
          <strong>{card.callahan_label}</strong> is not on a trajectory toward the{' '}
          {card.threshold_value != null ? fmtPct(card.threshold_value) : 'regulatory'} threshold
          based on the current 4-quarter trend.
        </p>
      )}

      <div className="ew-card-stats">
        <div className="ew-stat">
          <span className="ew-stat-label">Current rate</span>
          <span className="ew-stat-value">{fmtPct(card.current_value)}</span>
        </div>
        <div className="ew-stat">
          <span className="ew-stat-label">Threshold</span>
          <span className="ew-stat-value">{fmtPct(card.threshold_value)}</span>
        </div>
        {hasAlert && (
          <div className="ew-stat">
            <span className="ew-stat-label">Est. quarters to threshold</span>
            <span className="ew-stat-value" style={{ color: cfg.color }}>
              {isBreached ? 'Breached' : qtrs != null ? `~${Math.round(qtrs)}Q` : '—'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function EarlyWarningPanel({
  charterNumber,
  period,
  peerGroup = 'REGIONAL',
  token,
  // Optional: pre-fetched legacy alerts from parent — used only to expand before
  // our own fetch resolves, not for rendering the cards themselves.
  alerts,
}) {
  const [data,     setData]     = useState(null);
  const [loading,  setLoading]  = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Auto-expand early if parent already has active legacy alerts
  useEffect(() => {
    if (alerts && Array.isArray(alerts) && alerts.length > 0) {
      setExpanded(true);
    }
  }, [alerts]);

  useEffect(() => {
    if (!charterNumber || !period) return;
    setLoading(true);

    const params = new URLSearchParams({ period, peer_group: peerGroup });
    fetch(`${API}/alerts/${charterNumber}/early-warning?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          setData(d);
          if (d.has_active_alerts) setExpanded(true);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [charterNumber, period, peerGroup, token]);

  if (!data && !loading) return null;

  const hasActive = data?.has_active_alerts ?? false;
  const activeCount = data
    ? [data.acceleration, data.divergence, data.projection]
        .filter(c => c && c.alert_level !== 'none').length
    : 0;

  return (
    <div className={`ew-panel ${hasActive ? 'ew-panel--active' : 'ew-panel--quiet'}`}>
      {/* ── Collapsible header ── */}
      <button
        className="ew-panel-toggle"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        type="button"
      >
        <span className="ew-panel-icon" aria-hidden>
          {hasActive ? '⚠' : '✓'}
        </span>
        <span className="ew-panel-heading">Early Warning Signals</span>
        {hasActive && activeCount > 0 && (
          <span className="ew-panel-active-badge">
            {activeCount} active
          </span>
        )}
        <span className="ew-panel-chevron" aria-hidden>
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* ── Card grid ── */}
      {expanded && (
        <div className="ew-cards-grid">
          {loading && !data && (
            <div className="ew-loading">Analyzing trends…</div>
          )}
          {data?.acceleration && (
            <AccelerationCard card={data.acceleration} />
          )}
          {data?.divergence && (
            <DivergenceCard card={data.divergence} />
          )}
          {data?.projection && (
            <ProjectionCard card={data.projection} />
          )}
        </div>
      )}
    </div>
  );
}
