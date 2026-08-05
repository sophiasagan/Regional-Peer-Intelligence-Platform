/**
 * Reports — generate and preview board-ready documents.
 *
 * Two report types: Quarterly Board Report + Risk Committee Memo.
 * Preview panel: real live components per section (no blurred placeholders).
 * Section toggles: checkboxes in both the ReportCard list and the preview TOC.
 * Generation produces a .docx download via the API (unchanged — always full template).
 */

import React, { useState, useEffect, useCallback } from 'react';
import PeerComparisonTable from '../components/PeerComparisonTable';
import PeerBandChart from '../components/PeerBandChart';
import EarlyWarningPanel from '../components/EarlyWarningPanel';
import CompetitorTable from '../components/CompetitorTable';
import { CQ_PEER_METRIC_KEYS } from '../utils/metricCategories.js';

const API = import.meta.env.VITE_API_URL ?? '';

// ── Constants ─────────────────────────────────────────────────────────────────

const PERIOD_OPTIONS = [
  '2026Q1', '2025Q4', '2025Q3', '2025Q2', '2025Q1',
  '2024Q4', '2024Q3', '2024Q2', '2024Q1',
];

const PEER_GROUPS = [
  { key: 'REGIONAL',   label: 'Regional peers' },
  { key: 'STATE',      label: 'State peers'    },
  { key: 'ASSET_SIZE', label: 'National peers' },
];

const REPORT_DEFS = [
  {
    id:             'quarterly',
    icon:           '📊',
    title:          'Quarterly Board Report',
    subtitle:       'Strategic market intelligence for board presentations',
    sections:       [
      'Executive Summary',
      'Market Position & Deposit Share',
      'Peer Comparison',
      'Credit Quality Overview',
      'Competitor Movements',
      'Early Warning Signals',
      'Growth Metrics',
    ],
    estimatedPages: 12,
    color:          '#1565C0',
    endpoint:       n => `/reports/quarterly/${n}`,
  },
  {
    id:             'credit_quality',
    icon:           '⚠️',
    title:          'Risk Committee Memo',
    subtitle:       'Delinquency and credit risk analysis for the risk committee',
    sections:       [
      'Risk Executive Summary',
      'Delinquency by Loan Type',
      'Charge-off Trends',
      'ALLL / ACL Adequacy',
      'Early Warning Signals',
      '90+ Day Bucket Detail',
      'Recommendations',
    ],
    estimatedPages: 8,
    color:          '#6A1B9A',
    endpoint:       n => `/reports/credit-quality/${n}`,
  },
];

// Sections with no matching live component yet — honest "not available" placeholder
const PREVIEW_NOT_AVAILABLE = new Set([
  'Executive Summary', 'Risk Executive Summary', 'Competitor Movements', 'Recommendations',
]);

// Map section name → PeerBandChart metric key
const SECTION_CHART_METRIC = {
  'Growth Metrics':           'asset_growth_rate',
  'Delinquency by Loan Type': 'delinq_rate_total',
  'Charge-off Trends':        'chargeoff_rate_total_annualized',
  'ALLL / ACL Adequacy':      'alll_coverage',
  '90+ Day Bucket Detail':    'delinq_rate_90plus',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPct(v)  { return v != null ? `${(v * 100).toFixed(3)}%` : '—'; }
function fmtDollar(v) {
  if (v == null) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString()}`;
}

// Returns true when section is enabled (null set = all enabled by default)
function isEnabled(enabledSet, section) {
  return enabledSet == null || enabledSet.has(section);
}

const STAR_COLORS = ['', '#C62828', '#E64A19', '#F9A825', '#43A047', '#2E7D32'];

function StarRow({ stars }) {
  if (stars == null) return null;
  return (
    <span className="rp-star-row" title={`${stars}/5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ color: i < stars ? STAR_COLORS[stars] : '#D1D5DB', fontSize: 14 }}>★</span>
      ))}
    </span>
  );
}

// ── Data hooks ────────────────────────────────────────────────────────────────

function usePreviewData(charterNumber, period, peerGroup, token, enabled) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !charterNumber) return;
    setLoading(true);
    setData(null);
    const params = new URLSearchParams({ period, peer_group: peerGroup });
    fetch(`${API}/peer-comparison/${charterNumber}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [charterNumber, period, peerGroup, token, enabled]);

  return { data, loading };
}

function useInstitutionDetail(charterNumber, period, token) {
  const [detail, setDetail] = useState(null);
  useEffect(() => {
    if (!charterNumber) return;
    fetch(`${API}/peer-comparison/institution/${charterNumber}?period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setDetail(d))
      .catch(() => {});
  }, [charterNumber, period, token]);
  return detail;
}

// ── Section icons ─────────────────────────────────────────────────────────────

const SECTION_ICONS = {
  'Executive Summary':              '📌',
  'Risk Executive Summary':         '📌',
  'Market Position & Deposit Share':'🗺',
  'Peer Comparison':                '⚖️',
  'Credit Quality Overview':        '📈',
  'Competitor Movements':           '🏦',
  'Early Warning Signals':          '🚨',
  'Growth Metrics':                 '📊',
  'Delinquency by Loan Type':       '⚠️',
  'Charge-off Trends':              '📉',
  'ALLL / ACL Adequacy':            '🛡️',
  '90+ Day Bucket Detail':          '🔍',
  'Recommendations':                '💡',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function MetricPreviewRow({ label, value, stars, peerMedian }) {
  if (value == null) return null;
  const pct    = value < 10 ? fmtPct(value) : fmtDollar(value);
  const medPct = peerMedian != null && peerMedian < 10 ? fmtPct(peerMedian) : null;
  return (
    <div className="rp-preview-metric-row">
      <span className="rp-preview-metric-label">{label}</span>
      <span className="rp-preview-metric-value">{pct}</span>
      {medPct && <span className="rp-preview-metric-median">peer median {medPct}</span>}
      <StarRow stars={stars} />
    </div>
  );
}

function NotAvailable() {
  return (
    <div className="rp-not-available">
      <span className="rp-na-icon">📋</span>
      <div>
        <div className="rp-na-title">Not yet available in preview</div>
        <div className="rp-na-sub">This section is included in the generated .docx document.</div>
      </div>
    </div>
  );
}

// Renders live content for each section, or NotAvailable for sections without
// a matching component. Receives all context from PreviewPanel — no independent
// data fetching (EarlyWarningPanel + CompetitorTable + PeerBandChart are
// self-fetching; the peer comparison tables reuse the parent's metrics array).
function SectionContent({ section, metrics, charterNumber, period, peerGroup, peerGroupLabel, peerCount, token, instDetail }) {
  if (PREVIEW_NOT_AVAILABLE.has(section)) return <NotAvailable />;

  // Market Position — state-level CompetitorTable for institution's home state
  if (section === 'Market Position & Deposit Share') {
    if (!instDetail?.state_abbrev) {
      return <NotAvailable />;
    }
    return (
      <CompetitorTable
        geoType="state"
        geoId={instDetail.state_abbrev}
        period={period}
        charterNumber={charterNumber}
        token={token}
      />
    );
  }

  // Peer Comparison — full metric table, same data as Peer Comparison page
  if (section === 'Peer Comparison') {
    return (
      <PeerComparisonTable
        metrics={metrics}
        charterNumber={charterNumber}
        period={period}
        peerGroup={peerGroup}
        peerGroupLabel={peerGroupLabel}
        peerCount={peerCount}
        token={token}
      />
    );
  }

  // Credit Quality Overview — asset quality + capital adequacy only (same scope as CreditQuality page)
  if (section === 'Credit Quality Overview') {
    const cqMetrics = metrics.filter(m => CQ_PEER_METRIC_KEYS.has(m.metric_name));
    return (
      <PeerComparisonTable
        metrics={cqMetrics}
        charterNumber={charterNumber}
        period={period}
        peerGroup={peerGroup}
        peerGroupLabel={peerGroupLabel}
        peerCount={peerCount}
        token={token}
      />
    );
  }

  // Early Warning Signals — self-fetching EarlyWarningPanel (non-managed = collapsible)
  if (section === 'Early Warning Signals') {
    return (
      <div className="rp-section-ew">
        <EarlyWarningPanel
          charterNumber={charterNumber}
          period={period}
          peerGroup={peerGroup}
          token={token}
        />
      </div>
    );
  }

  // PeerBandChart sections — one metric each
  const chartMetricKey = SECTION_CHART_METRIC[section];
  if (chartMetricKey) {
    const metricData = metrics.find(m => m.metric_name === chartMetricKey);
    const unit = metricData?.unit ?? '%';
    return (
      <div className="rp-section-chart">
        <PeerBandChart
          metric={chartMetricKey}
          charterNumber={charterNumber}
          period={period}
          peerGroup={peerGroup}
          token={token}
          nPeriods={12}
          unit={unit}
        />
      </div>
    );
  }

  return <NotAvailable />;
}

// ── Preview panel ─────────────────────────────────────────────────────────────

function PreviewPanel({
  report, charterNumber, period, peerGroup, token,
  onClose, onGenerate, generating,
  enabledSections, onToggleSection,
}) {
  const { data, loading } = usePreviewData(charterNumber, period, peerGroup, token, true);
  const instDetail = useInstitutionDetail(charterNumber, period, token);

  const instName  = data?.institution_name ?? `Charter #${charterNumber}`;
  const peerLabel = data?.peer_group_label ?? peerGroup;
  const peerCount = data?.peer_count;
  const metrics   = data?.metrics ?? [];

  function findMetric(key) { return metrics.find(m => m.metric_name === key); }

  const KEY_METRICS = report.id === 'quarterly'
    ? [findMetric('net_worth_ratio'), findMetric('roa_annualized'), findMetric('efficiency_ratio'), findMetric('delinq_rate_total')].filter(Boolean)
    : [findMetric('delinq_rate_total'), findMetric('chargeoff_rate_total_annualized'), findMetric('alll_coverage'), findMetric('net_worth_ratio')].filter(Boolean);

  const activeSections = report.sections.filter(s => isEnabled(enabledSections, s));
  const toggledOffCount = report.sections.length - activeSections.length;

  return (
    <div className="rp-preview-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="rp-preview-panel">

        {/* Header */}
        <div className="rp-preview-header" style={{ borderTop: `4px solid ${report.color}` }}>
          <div>
            <div className="rp-preview-header-title">
              <span>{report.icon}</span>
              <span>{report.title} — Preview</span>
              {toggledOffCount > 0 && (
                <span className="rp-preview-toggle-badge">{toggledOffCount} section{toggledOffCount > 1 ? 's' : ''} hidden</span>
              )}
            </div>
            <div className="rp-preview-header-sub">
              {instName} · {period} · {peerLabel}
              {peerCount && <span className="rp-preview-header-peers"> ({peerCount} peers)</span>}
            </div>
          </div>
          <button className="rp-preview-close" onClick={onClose} aria-label="Close preview">✕</button>
        </div>

        {/* Body */}
        <div className="rp-preview-body">

          {/* Document title block */}
          <div className="rp-doc-title-block" style={{ borderLeft: `4px solid ${report.color}` }}>
            <div className="rp-doc-title">{report.title.toUpperCase()}</div>
            <div className="rp-doc-period">{period}</div>
            <div className="rp-doc-inst">{instName}</div>
            <div className="rp-doc-meta">
              Peer group: {peerLabel}{peerCount ? ` · ${peerCount} peer institutions` : ''}
            </div>
            <div className="rp-doc-pages">Estimated {report.estimatedPages} pages</div>
          </div>

          {/* Table of contents with section toggles */}
          <div className="rp-preview-section">
            <div className="rp-preview-section-title">Table of Contents — toggle sections to include in preview</div>
            <div className="rp-toc">
              {report.sections.map((s, i) => {
                const on = isEnabled(enabledSections, s);
                return (
                  <div key={s} className={`rp-toc-row ${on ? '' : 'rp-toc-row--off'}`}>
                    <label className="rp-toc-toggle" title={on ? 'Remove from preview' : 'Include in preview'}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => onToggleSection(s)}
                        className="rp-toc-check"
                      />
                    </label>
                    <span className="rp-toc-num">{i + 1}.</span>
                    <span className="rp-toc-icon">{SECTION_ICONS[s] ?? '▸'}</span>
                    <span className="rp-toc-label">{s}</span>
                    <span className="rp-toc-dots" />
                    <span className="rp-toc-page">{on ? i + 2 : '—'}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Key metrics — always shown */}
          <div className="rp-preview-section">
            <div className="rp-preview-section-title">
              Key Metrics vs {peerLabel}
              {loading && <span className="rp-loading-dot"> loading…</span>}
            </div>
            {loading && (
              <div className="rp-skeleton-stack">
                {[1,2,3,4].map(i => <div key={i} className="rp-skeleton-row" />)}
              </div>
            )}
            {!loading && KEY_METRICS.length > 0 && (
              <div className="rp-preview-metrics">
                {KEY_METRICS.map(m => (
                  <MetricPreviewRow
                    key={m.metric_name}
                    label={m.metric_label ?? m.metric_name}
                    value={m.institution_value}
                    stars={m.stars}
                    peerMedian={m.peer_median}
                  />
                ))}
              </div>
            )}
            {!loading && KEY_METRICS.length === 0 && (
              <p className="rp-preview-no-data">Connect the database to see live metrics in preview.</p>
            )}
          </div>

          {/* Section content — only active (enabled) sections rendered */}
          {activeSections.map((s, idx) => (
            <div key={s} className="rp-preview-section rp-preview-section--embed">
              <div className="rp-preview-section-embed-title">
                <span>{SECTION_ICONS[s] ?? '▸'}</span>
                <span>{idx + 1}. {s}</span>
                <button
                  className="rp-section-hide-btn"
                  onClick={() => onToggleSection(s)}
                  title="Hide this section from preview"
                >
                  Hide
                </button>
              </div>
              <SectionContent
                section={s}
                metrics={metrics}
                charterNumber={charterNumber}
                period={period}
                peerGroup={peerGroup}
                peerGroupLabel={peerLabel}
                peerCount={peerCount}
                token={token}
                instDetail={instDetail}
              />
            </div>
          ))}

          {/* Tombstone for toggled-off sections so user knows what's missing */}
          {report.sections.filter(s => !isEnabled(enabledSections, s)).length > 0 && (
            <div className="rp-hidden-sections-bar">
              <span className="rp-hidden-label">Hidden from preview:</span>
              {report.sections.filter(s => !isEnabled(enabledSections, s)).map(s => (
                <button
                  key={s}
                  className="rp-hidden-chip"
                  onClick={() => onToggleSection(s)}
                  title="Add back to preview"
                >
                  {SECTION_ICONS[s] ?? '▸'} {s}
                </button>
              ))}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="rp-preview-footer">
          <div className="rp-footer-left">
            <span className="rp-preview-format-note">Output: Word document (.docx), ready for board distribution</span>
            <span className="rp-generate-note">
              The generated document currently includes all standard sections regardless of your preview selection above — customizable export coming soon.
            </span>
          </div>
          <button
            className="rp-generate-btn rp-generate-btn--primary"
            style={{ background: report.color }}
            onClick={() => onGenerate(report)}
            disabled={!!generating}
          >
            {generating === report.id
              ? <><span className="rp-spinner" /> Generating…</>
              : <>{report.icon} Generate {report.title}</>
            }
          </button>
        </div>

      </div>
    </div>
  );
}

// ── Report card ───────────────────────────────────────────────────────────────

function ReportCard({ report, onPreview, onGenerate, generating, lastReport, enabledSections, onToggleSection }) {
  const done = lastReport?.report_type === report.id;
  return (
    <div className={`rp-card ${done ? 'rp-card--done' : ''}`}>

      <div className="rp-card-header" style={{ background: report.color }}>
        <span className="rp-card-icon">{report.icon}</span>
        <div>
          <div className="rp-card-title">{report.title}</div>
          <div className="rp-card-subtitle">{report.subtitle}</div>
        </div>
      </div>

      <div className="rp-card-body">
        <div className="rp-card-sections-label">
          Includes
          <span className="rp-card-toggle-hint"> — check/uncheck to include in preview</span>
        </div>
        <ul className="rp-card-sections">
          {report.sections.map(s => {
            const on = isEnabled(enabledSections, s);
            return (
              <li key={s} className={`rp-card-section-item ${on ? '' : 'rp-card-section-item--off'}`}>
                <label className="rp-card-section-label">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onToggleSection(s)}
                    className="rp-card-section-check"
                  />
                  <span className="rp-card-section-icon">{SECTION_ICONS[s] ?? '▸'}</span>
                  {s}
                </label>
              </li>
            );
          })}
        </ul>

        <div className="rp-card-meta">
          <span className="rp-card-pages">~{report.estimatedPages} pages</span>
          <span className="rp-card-format">Word .docx</span>
        </div>

        {done && lastReport && (
          <div className="rp-card-done-banner">
            ✓ Ready — <strong>{lastReport.filename}</strong>
          </div>
        )}
      </div>

      <div className="rp-card-footer">
        <button className="rp-preview-trigger" onClick={() => onPreview(report)}>
          Preview
        </button>
        {done && lastReport ? (
          <a
            className="rp-generate-btn rp-generate-btn--primary"
            style={{ background: report.color }}
            href={`${API}${lastReport.download_url}`}
            target="_blank"
            rel="noreferrer"
          >
            Download .docx
          </a>
        ) : (
          <button
            className="rp-generate-btn rp-generate-btn--primary"
            style={{ background: report.color }}
            onClick={() => onGenerate(report)}
            disabled={!!generating}
          >
            {generating === report.id
              ? <><span className="rp-spinner" /> Generating…</>
              : 'Generate .docx'
            }
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Reports({ charterNumber, token }) {
  const [period,         setPeriod]         = useState('2026Q1');
  const [peerGroup,      setPeerGroup]      = useState('REGIONAL');
  const [generating,     setGenerating]     = useState(null);
  const [reports,        setReports]        = useState({});
  const [error,          setError]          = useState(null);
  const [previewing,     setPreviewing]     = useState(null);
  // sectionToggles: { [reportId]: Set<sectionName> } — null key = all enabled
  const [sectionToggles, setSectionToggles] = useState({});

  function toggleSection(reportId, section) {
    setSectionToggles(prev => {
      const allSections = REPORT_DEFS.find(r => r.id === reportId).sections;
      const current = prev[reportId] ?? new Set(allSections);
      const next = new Set(current);
      next.has(section) ? next.delete(section) : next.add(section);
      return { ...prev, [reportId]: next };
    });
  }

  async function handleGenerate(report) {
    setGenerating(report.id);
    setError(null);
    try {
      const res = await fetch(
        `${API}${report.endpoint(charterNumber)}?period=${period}&peer_group=${peerGroup}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReports(prev => ({ ...prev, [report.id]: { ...data, report_type: report.id } }));
      if (data.download_url) window.open(`${API}${data.download_url}`, '_blank');
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(null);
    }
  }

  return (
    <div className="rp-page">

      <div className="rp-header">
        <div>
          <h1 className="rp-title">Reports</h1>
          <p className="rp-subtitle">Generate board-ready documents with live peer benchmarks.</p>
        </div>
      </div>

      <div className="rp-controls">
        <label className="rp-control-label">
          Period
          <select className="rp-select" value={period} onChange={e => setPeriod(e.target.value)}>
            {PERIOD_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <div className="rp-control-group">
          <span className="rp-control-label-text">Peer group</span>
          <div className="rp-peer-toggle">
            {PEER_GROUPS.map(({ key, label }) => (
              <button
                key={key}
                className={`rp-peer-btn ${peerGroup === key ? 'active' : ''}`}
                onClick={() => setPeerGroup(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="rp-error">
          <span>⚠</span> {error}
        </div>
      )}

      <div className="rp-card-grid">
        {REPORT_DEFS.map(report => (
          <ReportCard
            key={report.id}
            report={report}
            onPreview={setPreviewing}
            onGenerate={handleGenerate}
            generating={generating}
            lastReport={reports[report.id] ?? null}
            enabledSections={sectionToggles[report.id] ?? null}
            onToggleSection={section => toggleSection(report.id, section)}
          />
        ))}
      </div>

      {previewing && (
        <PreviewPanel
          report={previewing}
          charterNumber={charterNumber}
          period={period}
          peerGroup={peerGroup}
          token={token}
          onClose={() => setPreviewing(null)}
          onGenerate={handleGenerate}
          generating={generating}
          enabledSections={sectionToggles[previewing.id] ?? null}
          onToggleSection={section => toggleSection(previewing.id, section)}
        />
      )}
    </div>
  );
}
