/**
 * NLQuery — natural language competitive intelligence Q&A.
 *
 * Accepts Callahan metric vocabulary.
 * Always shows which metric was matched (Callahan term + P76 internal name).
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

export default function NLQuery({ charterNumber, token, defaultPeriod = '2026Q1' }) {
  const [question, setQuestion] = useState('');
  const [period, setPeriod] = useState(defaultPeriod);
  const [peerGroup, setPeerGroup] = useState('REGIONAL');
  const [response, setResponse] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const textareaRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch(`${API}/ask/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          question,
          charter_number: charterNumber,
          period,
          peer_group: peerGroup,
        }),
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

  return (
    <div className="nl-query-page">
      <h1>Ask a Question</h1>

      <div className="example-questions">
        <p className="examples-label">Try:</p>
        {EXAMPLE_QUESTIONS.map((q) => (
          <button key={q} className="example-chip" onClick={() => handleExample(q)}>
            {q}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="query-form">
        <textarea
          ref={textareaRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about metrics, peer comparisons, or market share…"
          rows={3}
        />
        <div className="query-options">
          <label>
            Period:
            <input type="text" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: 80 }} />
          </label>
          <label>
            Peer group:
            <select value={peerGroup} onChange={(e) => setPeerGroup(e.target.value)}>
              <option value="REGIONAL">Regional Peers</option>
              <option value="STATE">State</option>
              <option value="ASSET_SIZE">Asset Size</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={loading || !question.trim()} className="submit-btn">
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {error && <p className="error">Error: {error}</p>}

      {response && (
        <div className="query-response">
          {response.callahan_term_used && (
            <p className="metric-match">
              Matched: <strong>{response.callahan_term_used}</strong>
              {' → '}<code>{response.matched_metric}</code>
            </p>
          )}
          <div className="answer-text">
            {response.answer.split('\n').map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
          {response.data && (
            <details className="raw-data">
              <summary>Supporting data</summary>
              <pre>{JSON.stringify(response.data, null, 2)}</pre>
            </details>
          )}
          {response.sources?.length > 0 && (
            <p className="sources">Sources: {response.sources.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  );
}
