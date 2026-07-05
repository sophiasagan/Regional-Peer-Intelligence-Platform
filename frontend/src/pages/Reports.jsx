/**
 * Reports — generate and preview board-ready documents.
 *
 * Two report types: Quarterly Board Report + Risk Committee Memo.
 * Preview panel fetches live metrics and renders a document-style outline.
 * Generation produces a .docx download via the API.
 */

import React, { useState, useEffect, useCallback } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v)  { return v != null ? `${(v * 100).toFixed(3)}%` : '—'; }
function fmtDollar(v) {
  if (v == null) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString()}`;
}

const STAR_COLORS = ['', '#C62828', '#E64A19', '#F9A825', '#43A047', '#2E7D32'];

function StarRow({ stars, label }) {
  if (stars == null) return null;
  return (
    <span className="rp-star-row" title={`${stars}/5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} style={{ color: i < stars ? STAR_COLORS[stars] : '#D1D5DB', fontSize: 14 }}>★</span>
      ))}
    </span>
  );
}

// ── Live preview data hook ───────────────────────────────────────────────────

function usePreviewData(charterNumber, period, peerGroup, token, enabled) {
  const [data, setData]       = useState(null);
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

// ── Preview panel ─────────────────────────────────────────────────────────────

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

function MetricPreviewRow({ label, value, stars, peerMedian, isAdverse }) {
  if (value == null) return null;
  const pct = value < 10 ? fmtPct(value) : fmtDollar(value);
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

function PreviewPanel({ report, charterNumber, period, peerGroup, token, onClose, onGenerate, generating }) {
  const { data, loading } = usePreviewData(charterNumber, period, peerGroup, token, true);

  const instName   = data?.institution_name ?? `Charter #${charterNumber}`;
  const peerLabel  = data?.peer_group_label ?? peerGroup;
  const peerCount  = data?.peer_count;
  const metrics    = data?.metrics ?? [];

  // Pull key metrics for preview
  function findMetric(key) { return metrics.find(m => m.metric_key === key); }

  const delinq     = findMetric('delinq_rate_total');
  const chargeoff  = findMetric('chargeoff_rate_total_annualized');
  const nw         = findMetric('net_worth_ratio');
  const roa        = findMetric('roa_annualized');
  const efficiency = findMetric('efficiency_ratio');
  const alll       = findMetric('alll_coverage');

  const KEY_METRICS = report.id === 'quarterly'
    ? [nw, roa, efficiency, delinq].filter(Boolean)
    : [delinq, chargeoff, alll, nw].filter(Boolean);

  return (
    <div className="rp-preview-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="rp-preview-panel">

        {/* Panel header */}
        <div className="rp-preview-header" style={{ borderTop: `4px solid ${report.color}` }}>
          <div>
            <div className="rp-preview-header-title">
              <span>{report.icon}</span>
              <span>{report.title} — Preview</span>
            </div>
            <div className="rp-preview-header-sub">
              {instName} · {period} · {peerLabel}
              {peerCount && <span className="rp-preview-header-peers"> ({peerCount} peers)</span>}
            </div>
          </div>
          <button className="rp-preview-close" onClick={onClose} aria-label="Close preview">✕</button>
        </div>

        {/* Panel body — scrollable */}
        <div className="rp-preview-body">

          {/* Document title page simulation */}
          <div className="rp-doc-title-block" style={{ borderLeft: `4px solid ${report.color}` }}>
            <div className="rp-doc-title">{report.title.toUpperCase()}</div>
            <div className="rp-doc-period">{period}</div>
            <div className="rp-doc-inst">{instName}</div>
            <div className="rp-doc-meta">
              Peer group: {peerLabel}{peerCount ? ` · ${peerCount} peer institutions` : ''}
            </div>
            <div className="rp-doc-pages">Estimated {report.estimatedPages} pages</div>
          </div>

          {/* Table of contents */}
          <div className="rp-preview-section">
            <div className="rp-preview-section-title">Table of Contents</div>
            <div className="rp-toc">
              {report.sections.map((s, i) => (
                <div key={s} className="rp-toc-row">
                  <span className="rp-toc-num">{i + 1}.</span>
                  <span className="rp-toc-icon">{SECTION_ICONS[s] ?? '▸'}</span>
                  <span className="rp-toc-label">{s}</span>
                  <span className="rp-toc-dots" />
                  <span className="rp-toc-page">{i + 2}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Live metrics preview */}
          <div className="rp-preview-section">
            <div className="rp-preview-section-title">
              Key Metrics vs {peerLabel}
              {loading && <span className="rp-loading-dot"> loading…</span>}
            </div>
            {loading && <div className="rp-skeleton-stack">{[1,2,3,4].map(i => <div key={i} className="rp-skeleton-row"/>)}</div>}
            {!loading && KEY_METRICS.length > 0 && (
              <div className="rp-preview-metrics">
                {KEY_METRICS.map(m => (
                  <MetricPreviewRow
                    key={m.metric_key}
                    label={m.callahan_label ?? m.metric_key}
                    value={m.institution_value}
                    stars={m.stars}
                    peerMedian={m.peer_distribution?.p50}
                    isAdverse={m.is_adverse}
                  />
                ))}
              </div>
            )}
            {!loading && KEY_METRICS.length === 0 && (
              <p className="rp-preview-no-data">
                Connect the database to see live metrics in preview.
              </p>
            )}
          </div>

          {/* Section previews */}
          {report.sections.map((s, i) => (
            <div key={s} className="rp-preview-section rp-preview-section--blurred">
              <div className="rp-preview-section-title">
                {SECTION_ICONS[s] ?? '▸'} {i + 1}. {s}
              </div>
              <div className="rp-section-placeholder">
                <div className="rp-placeholder-line rp-placeholder-line--wide"/>
                <div className="rp-placeholder-line rp-placeholder-line--medium"/>
                <div className="rp-placeholder-line rp-placeholder-line--narrow"/>
                <div className="rp-placeholder-chart"/>
                <div className="rp-placeholder-line rp-placeholder-line--medium"/>
              </div>
              <div className="rp-section-generate-cta">
                Generate the full report to see complete {s.toLowerCase()} with charts and peer comparisons.
              </div>
            </div>
          ))}
        </div>

        {/* Panel footer */}
        <div className="rp-preview-footer">
          <span className="rp-preview-format-note">Output: Word document (.docx), ready for board distribution</span>
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

function ReportCard({ report, onPreview, onGenerate, generating, lastReport }) {
  const done = lastReport?.report_type === report.id;
  return (
    <div className={`rp-card ${done ? 'rp-card--done' : ''}`}>

      {/* Card header */}
      <div className="rp-card-header" style={{ background: report.color }}>
        <span className="rp-card-icon">{report.icon}</span>
        <div>
          <div className="rp-card-title">{report.title}</div>
          <div className="rp-card-subtitle">{report.subtitle}</div>
        </div>
      </div>

      {/* Sections list */}
      <div className="rp-card-body">
        <div className="rp-card-sections-label">Includes</div>
        <ul className="rp-card-sections">
          {report.sections.map(s => (
            <li key={s} className="rp-card-section-item">
              <span className="rp-card-section-icon">{SECTION_ICONS[s] ?? '▸'}</span>
              {s}
            </li>
          ))}
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

      {/* Card footer buttons */}
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
  const [period,      setPeriod]      = useState('2026Q1');
  const [peerGroup,   setPeerGroup]   = useState('REGIONAL');
  const [generating,  setGenerating]  = useState(null);
  const [reports,     setReports]     = useState({});   // id → lastReport
  const [error,       setError]       = useState(null);
  const [previewing,  setPreviewing]  = useState(null); // report def

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

      {/* ── Page header ── */}
      <div className="rp-header">
        <div>
          <h1 className="rp-title">Reports</h1>
          <p className="rp-subtitle">Generate board-ready documents with live peer benchmarks.</p>
        </div>
      </div>

      {/* ── Controls bar ── */}
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

      {/* ── Report cards ── */}
      <div className="rp-card-grid">
        {REPORT_DEFS.map(report => (
          <ReportCard
            key={report.id}
            report={report}
            onPreview={setPreviewing}
            onGenerate={handleGenerate}
            generating={generating}
            lastReport={reports[report.id] ?? null}
          />
        ))}
      </div>

      {/* ── Preview panel ── */}
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
        />
      )}
    </div>
  );
}
