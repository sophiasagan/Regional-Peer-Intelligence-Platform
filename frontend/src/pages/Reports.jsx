/**
 * Reports — saved insights and automated report downloads.
 */

import React, { useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? '';

function useReportGenerator(token) {
  const [generating, setGenerating] = useState(null);
  const [lastReport, setLastReport] = useState(null);
  const [error, setError] = useState(null);

  async function generate(type, charterNumber, period, peerGroup) {
    const endpoint = type === 'quarterly'
      ? `/reports/quarterly/${charterNumber}`
      : `/reports/credit-quality/${charterNumber}`;
    setGenerating(type);
    setError(null);
    try {
      const res = await fetch(
        `${API}${endpoint}?period=${period}&peer_group=${peerGroup}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLastReport(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(null);
    }
  }

  return { generate, generating, lastReport, error };
}

export default function Reports({ charterNumber, token }) {
  const [period, setPeriod] = useState('2026Q1');
  const [peerGroup, setPeerGroup] = useState('REGIONAL');
  const { generate, generating, lastReport, error } = useReportGenerator(token);

  function handleDownload(report) {
    window.open(`${API}${report.download_url}`, '_blank');
  }

  return (
    <div className="reports-page">
      <h1>Reports</h1>

      <div className="report-controls">
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

      <div className="report-buttons">
        <div className="report-card">
          <h2>Quarterly Board Report</h2>
          <p>Market position, peer comparison, credit quality summary, competitor movements.</p>
          <button
            onClick={() => generate('quarterly', charterNumber, period, peerGroup)}
            disabled={!!generating}
          >
            {generating === 'quarterly' ? 'Generating…' : 'Generate (.docx)'}
          </button>
        </div>

        <div className="report-card">
          <h2>Risk Committee Memo</h2>
          <p>Delinquency analysis, charge-off trends, ALLL adequacy, early warnings, board summary.</p>
          <button
            onClick={() => generate('credit_quality', charterNumber, period, peerGroup)}
            disabled={!!generating}
          >
            {generating === 'credit_quality' ? 'Generating…' : 'Generate (.docx)'}
          </button>
        </div>
      </div>

      {error && <p className="error">Error: {error}</p>}

      {lastReport && (
        <div className="last-report">
          <p>
            Report ready: <strong>{lastReport.filename}</strong>
            {' '}({lastReport.period}, {lastReport.peer_group_type ?? ''})
          </p>
          <button onClick={() => handleDownload(lastReport)} className="download-btn">
            Download
          </button>
        </div>
      )}
    </div>
  );
}
