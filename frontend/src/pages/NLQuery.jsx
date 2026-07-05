/**
 * NLQuery — natural language competitive intelligence Q&A.
 *
 * Renders Claude's markdown response: tables, headers, bullets, bold, blockquotes.
 * Metric match shown as a confirmation pill. Peer group + period controls in top bar.
 */

import React, { useState, useRef } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

const EXAMPLE_QUESTIONS = [
  'How does our net charge-off ratio compare to regional peers?',
  'What is our total delinquency ratio vs the peer median?',
  'Is our allowance coverage ratio above the peer group?',
  'How does our efficiency ratio compare to state peers?',
  'What is our deposit market share in Genesee County?',
];

// ── Simple markdown renderer ──────────────────────────────────────────────────
// Handles: ## headers, **bold**, *italic*, tables, --- hr, - bullets, > blockquote

function inlineMarkdown(text) {
  // bold+italic: ***text***
  text = text.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // bold: **text**
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // italic: *text*
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // inline code: `text`
  text = text.replace(/`([^`]+)`/g, '<code class="nl-inline-code">$1</code>');
  return text;
}

function MarkdownBlock({ source }) {
  if (!source) return null;
  const lines  = source.split('\n');
  const nodes  = [];
  let i        = 0;
  let listBuf  = [];

  function flushList() {
    if (!listBuf.length) return;
    nodes.push(
      <ul key={`ul-${i}`} className="nl-list">
        {listBuf.map((item, j) => (
          <li key={j} dangerouslySetInnerHTML={{ __html: inlineMarkdown(item) }} />
        ))}
      </ul>
    );
    listBuf = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) { flushList(); i++; continue; }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) {
      flushList();
      nodes.push(<hr key={`hr-${i}`} className="nl-hr" />);
      i++; continue;
    }

    // H2
    if (line.startsWith('## ')) {
      flushList();
      nodes.push(
        <h2 key={`h2-${i}`} className="nl-h2"
          dangerouslySetInnerHTML={{ __html: inlineMarkdown(line.slice(3)) }} />
      );
      i++; continue;
    }

    // H3
    if (line.startsWith('### ')) {
      flushList();
      nodes.push(
        <h3 key={`h3-${i}`} className="nl-h3"
          dangerouslySetInnerHTML={{ __html: inlineMarkdown(line.slice(4)) }} />
      );
      i++; continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList();
      nodes.push(
        <blockquote key={`bq-${i}`} className="nl-blockquote"
          dangerouslySetInnerHTML={{ __html: inlineMarkdown(line.slice(2)) }} />
      );
      i++; continue;
    }

    // Table: collect consecutive | lines
    if (line.startsWith('|')) {
      flushList();
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      // Parse: first row = header, second row = separator, rest = body
      const rows    = tableLines.filter(l => !/^\|[-: |]+\|$/.test(l.trim()));
      const parseRow = r => r.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      const headers = parseRow(rows[0] || '');
      const body    = rows.slice(1);
      nodes.push(
        <div key={`tbl-${i}`} className="nl-table-wrap">
          <table className="nl-table">
            <thead>
              <tr>{headers.map((h, j) => (
                <th key={j} dangerouslySetInnerHTML={{ __html: inlineMarkdown(h.trim()) }} />
              ))}</tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>
                  {parseRow(row).map((cell, ci) => (
                    <td key={ci} dangerouslySetInnerHTML={{ __html: inlineMarkdown(cell.trim()) }} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Bullet list item
    if (/^[-*] /.test(line)) {
      listBuf.push(line.slice(2).trim());
      i++; continue;
    }

    // Regular paragraph
    flushList();
    nodes.push(
      <p key={`p-${i}`} className="nl-para"
        dangerouslySetInnerHTML={{ __html: inlineMarkdown(line) }} />
    );
    i++;
  }

  flushList();
  return <>{nodes}</>;
}

// ── Metric display helpers ────────────────────────────────────────────────────

// Metrics stored as ratios/coverage multiples — NOT percentages
const RATIO_METRICS = new Set(['alll_coverage']);

function fmtMetric(v, metricKey) {
  if (v == null) return '—';
  if (RATIO_METRICS.has(metricKey)) return `${v.toFixed(3)}x`;
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
          <h1 className="nl-title">Ask Intelligence</h1>
          <p className="nl-subtitle">Ask questions in plain language using Callahan metric names.</p>
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
              <input
                type="text"
                className="nl-period-input"
                value={period}
                onChange={e => setPeriod(e.target.value)}
              />
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
