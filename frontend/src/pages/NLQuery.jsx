/**
 * NLQuery — natural language competitive intelligence Q&A.
 *
 * Renders Claude's markdown response: tables, headers, bullets, bold, blockquotes.
 * Metric match shown as a confirmation pill. Peer group + period controls in top bar.
 */

import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import PeerBandChart from '../components/PeerBandChart';

const API = import.meta.env.VITE_API_URL ?? '';

const PERIOD_OPTIONS = [
  '2026Q1', '2025Q4', '2025Q3', '2025Q2', '2025Q1',
  '2024Q4', '2024Q3', '2024Q2', '2024Q1', '2023Q4',
];

// Metrics that are coverage ratios (1.2x), not percentages
const RATIO_UNIT_METRICS = new Set(['alll_coverage']);

const EXAMPLE_QUESTIONS = [
  'How does our net charge-off ratio compare to regional peers?',
  'What is our total delinquency ratio vs the peer median?',
  'Is our allowance coverage ratio above the peer group?',
  'How does our efficiency ratio compare to state peers?',
  'What is our deposit market share in Genesee County?',
];

// ── Markdown renderer ─────────────────────────────────────────────────────────
// react-markdown + remark-gfm (tables, strikethrough) + rehype-sanitize (XSS).
// Custom components preserve the existing nl-* CSS classes.

const MD_COMPONENTS = {
  h2:         ({ children })            => <h2 className="nl-h2">{children}</h2>,
  h3:         ({ children })            => <h3 className="nl-h3">{children}</h3>,
  ul:         ({ children })            => <ul className="nl-list">{children}</ul>,
  blockquote: ({ children })            => <blockquote className="nl-blockquote">{children}</blockquote>,
  hr:         ()                        => <hr className="nl-hr" />,
  p:          ({ children })            => <p className="nl-para">{children}</p>,
  code:       ({ className, children }) => {
    // Fenced code blocks get a language-* className; inline code does not.
    return /^language-/.test(className ?? '')
      ? <code className={className}>{children}</code>
      : <code className="nl-inline-code">{children}</code>;
  },
  table: ({ children }) => (
    <div className="nl-table-wrap"><table className="nl-table">{children}</table></div>
  ),
};

function MarkdownBlock({ source }) {
  if (!source) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={MD_COMPONENTS}
    >
      {source}
    </ReactMarkdown>
  );
}

// ── Metric display helpers ────────────────────────────────────────────────────

function fmtMetric(v, metricKey) {
  if (v == null) return '—';
  if (RATIO_UNIT_METRICS.has(metricKey)) return `${v.toFixed(3)}x`;
  // Rate/ratio metrics are stored as decimals (0.012 = 1.2%)
  if (Math.abs(v) < 10) return `${(v * 100).toFixed(3)}%`;
  // Assume large values are raw dollar amounts
  return v >= 1_000_000
    ? `$${(v / 1_000_000).toFixed(2)}M`
    : v.toLocaleString();
}

function DataItem({ label, value }) {
  return (
    <div className="nl-data-item">
      <span className="nl-data-label">{label}</span>
      <span className="nl-data-value">{value}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NLQuery({ charterNumber, token, defaultPeriod = '2026Q1' }) {
  const [question,  setQuestion]  = useState('');
  const [period,    setPeriod]    = useState(defaultPeriod);
  const [peerGroup, setPeerGroup] = useState('REGIONAL');
  const [response,  setResponse]  = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const textareaRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch(`${API}/ask/`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ question, charter_number: charterNumber, period, peer_group: peerGroup }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResponse(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleExample(q) {
    setQuestion(q);
    textareaRef.current?.focus();
  }

  const PEER_LABELS = { REGIONAL: 'Regional peers', STATE: 'State peers', ASSET_SIZE: 'National peers' };

  return (
    <div className="nl-page">

      {/* ── Header ── */}
      <div className="nl-header">
        <div className="nl-header-left">
          <h1 className="nl-title">Ask Magnus</h1>
          <p className="nl-subtitle">Ask questions in plain language about your institution and peer group.</p>
        </div>
      </div>

      {/* ── Example chips ── */}
      <div className="nl-examples">
        {EXAMPLE_QUESTIONS.map(q => (
          <button key={q} className="nl-chip" onClick={() => handleExample(q)}>{q}</button>
        ))}
      </div>

      {/* ── Query form ── */}
      <form onSubmit={handleSubmit} className="nl-form">
        <textarea
          ref={textareaRef}
          className="nl-textarea"
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="e.g. How does our net charge-off ratio compare to regional peers?"
          rows={3}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(e); }}
        />

        <div className="nl-form-row">
          <div className="nl-form-controls">
            <label className="nl-label">
              Period
              <select className="nl-select" value={period} onChange={e => setPeriod(e.target.value)}>
                {PERIOD_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="nl-label">
              Peer group
              <select className="nl-select" value={peerGroup} onChange={e => setPeerGroup(e.target.value)}>
                <option value="REGIONAL">Regional peers</option>
                <option value="STATE">State peers</option>
                <option value="ASSET_SIZE">National peers</option>
              </select>
            </label>
          </div>
          <button type="submit" className="nl-submit" disabled={loading || !question.trim()}>
            {loading ? (
              <><span className="nl-spinner" /> Thinking…</>
            ) : 'Ask'}
          </button>
        </div>
      </form>

      {error && (
        <div className="nl-error">
          <span className="nl-error-icon">⚠</span> {error}
        </div>
      )}

      {/* ── Response card ── */}
      {response && (
        <div className="nl-response-card">

          {/* Metric confirmation pill */}
          {response.confirmation_text && (
            <div className="nl-confirmation">
              <span className="nl-confirmation-icon">✓</span>
              {response.confirmation_text}
              {response.matched_metric && (
                <code className="nl-metric-code">{response.matched_metric}</code>
              )}
            </div>
          )}

          {/* Peer band chart — shown when metric is identified */}
          {response.matched_metric && (
            <div className="nl-chart-wrap">
              <PeerBandChart
                metric={response.matched_metric}
                charterNumber={charterNumber}
                period={period}
                peerGroup={peerGroup}
                token={token}
                nPeriods={12}
                unit={RATIO_UNIT_METRICS.has(response.matched_metric) ? 'x' : '%'}
              />
            </div>
          )}

          {/* Answer body */}
          <div className="nl-answer">
            <MarkdownBlock source={response.answer} />
          </div>

          {/* Supporting data collapsible */}
          {response.data && (
            <details className="nl-data-details">
              <summary className="nl-data-summary">Supporting data</summary>
              <div className="nl-data-grid">
                {response.data.institution_value != null && (
                  <DataItem label="Your value"
                    value={fmtMetric(response.data.institution_value, response.matched_metric)} />
                )}
                {response.data.peer_distribution?.p50 != null && (
                  <DataItem label="Peer median"
                    value={fmtMetric(response.data.peer_distribution.p50, response.matched_metric)} />
                )}
                {response.data.peer_distribution?.p10 != null && (
                  <DataItem label="Peer P10"
                    value={fmtMetric(response.data.peer_distribution.p10, response.matched_metric)} />
                )}
                {response.data.peer_distribution?.p90 != null && (
                  <DataItem label="Peer P90"
                    value={fmtMetric(response.data.peer_distribution.p90, response.matched_metric)} />
                )}
                {response.data.percentile_rank != null && (
                  <DataItem label="Percentile" value={`${response.data.percentile_rank.toFixed(1)}th`} />
                )}
                {response.data.stars != null && (
                  <DataItem label="Stars"
                    value={'★'.repeat(response.data.stars) + '☆'.repeat(5 - response.data.stars)} />
                )}
                {response.data.peer_distribution?.n != null && (
                  <DataItem label="Peer count" value={response.data.peer_distribution.n} />
                )}
              </div>
            </details>
          )}

          {/* Sources */}
          {response.sources?.length > 0 && (
            <div className="nl-sources">
              Sources: {response.sources.join(' · ')}
              {' · '}{PEER_LABELS[peerGroup] ?? peerGroup}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
