/**
 * Setup — first-run charter number entry.
 * Shown when no institution is configured. No sidebar, full-screen.
 */

import React, { useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

export default function Setup({ onComplete }) {
  const [input,   setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [preview, setPreview] = useState(null); // { name, state, assets }

  async function lookup(raw) {
    const num = parseInt(raw, 10);
    if (!num || raw.length < 4) { setPreview(null); return; }
    try {
      const res = await fetch(`${API}/institutions/${num}?period=2026Q1`, {
        headers: { Authorization: 'Bearer demo' },
      });
      if (!res.ok) { setPreview(null); return; }
      const d = await res.json();
      setPreview(d);
    } catch {
      setPreview(null);
    }
  }

  function handleChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
    setInput(v);
    setError(null);
    lookup(v);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const num = parseInt(input, 10);
    if (!num) { setError('Please enter a valid charter number.'); return; }
    setLoading(true);
    setError(null);
    try {
      // Verify the institution exists
      const res = await fetch(`${API}/institutions/${num}?period=2026Q1`, {
        headers: { Authorization: 'Bearer demo' },
      });
      if (!res.ok) {
        setError(`Charter ${num} not found in the database. Check the number and try again.`);
        setLoading(false);
        return;
      }
      onComplete(num);
    } catch {
      // If API unavailable, allow the user to proceed anyway
      onComplete(num);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="setup-page">
      <div className="setup-card">

        <div className="setup-brand">
          <div className="setup-logo">P76</div>
          <div className="setup-brand-name">Regional Market Intelligence</div>
        </div>

        <h1 className="setup-title">Get started</h1>
        <p className="setup-subtitle">
          Enter your credit union's NCUA charter number to explore market data,
          peer benchmarks, and AI-powered insights.
        </p>

        <form onSubmit={handleSubmit} className="setup-form">
          <label className="setup-label">NCUA Charter Number</label>
          <input
            className={`setup-input${error ? ' setup-input--error' : ''}`}
            type="text"
            inputMode="numeric"
            placeholder="e.g. 68708"
            value={input}
            onChange={handleChange}
            autoFocus
            maxLength={6}
          />

          {preview && (
            <div className="setup-preview">
              <span className="setup-preview-name">{preview.institution_name}</span>
              {preview.state_code && (
                <span className="setup-preview-meta"> · {preview.state_code}</span>
              )}
              {preview.total_assets && (
                <span className="setup-preview-meta">
                  {' '}· ${(preview.total_assets / 1e9).toFixed(2)}B assets
                </span>
              )}
            </div>
          )}

          {error && <p className="setup-error">{error}</p>}

          <button
            type="submit"
            className="setup-btn"
            disabled={!input || loading}
          >
            {loading ? 'Verifying…' : 'Explore platform →'}
          </button>
        </form>

        <p className="setup-hint">
          Demo: use <button className="setup-demo-link" onClick={() => { setInput('68708'); lookup('68708'); }}>
            68708
          </button> (Dort Financial CU, MI)
        </p>

      </div>

      <div className="setup-bg-dots" aria-hidden="true" />
    </div>
  );
}
