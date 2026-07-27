/**
 * PeerGroupSetup — onboarding step 2.
 * User configures their national peer group criteria immediately after
 * entering their charter number. No external data import needed.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL ?? '';

const ASSET_TIERS = [
  { value: 'under_100m', label: 'Under $100M' },
  { value: '100m_250m',  label: '$100M – $250M' },
  { value: '250m_500m',  label: '$250M – $500M' },
  { value: '500m_1b',    label: '$500M – $1B' },
  { value: '1b_5b',      label: '$1B – $5B' },
  { value: '5b_plus',    label: '$5B+' },
];

const FOM_OPTIONS = [
  { value: '',          label: 'Any charter type' },
  { value: 'community', label: 'Community charter' },
  { value: 'seg',       label: 'SEG (Select Employer Group)' },
  { value: 'mcb',       label: 'Multiple Common Bond' },
];

const US_STATES = [
  ['AL','Alabama'],    ['AK','Alaska'],       ['AZ','Arizona'],    ['AR','Arkansas'],
  ['CA','California'], ['CO','Colorado'],     ['CT','Connecticut'],['DE','Delaware'],
  ['FL','Florida'],    ['GA','Georgia'],      ['HI','Hawaii'],     ['ID','Idaho'],
  ['IL','Illinois'],   ['IN','Indiana'],      ['IA','Iowa'],       ['KS','Kansas'],
  ['KY','Kentucky'],   ['LA','Louisiana'],    ['ME','Maine'],      ['MD','Maryland'],
  ['MA','Massachusetts'],['MI','Michigan'],   ['MN','Minnesota'],  ['MS','Mississippi'],
  ['MO','Missouri'],   ['MT','Montana'],      ['NE','Nebraska'],   ['NV','Nevada'],
  ['NH','New Hampshire'],['NJ','New Jersey'], ['NM','New Mexico'], ['NY','New York'],
  ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],     ['OK','Oklahoma'],
  ['OR','Oregon'],     ['PA','Pennsylvania'], ['RI','Rhode Island'],['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'],   ['TX','Texas'],      ['UT','Utah'],
  ['VT','Vermont'],    ['VA','Virginia'],     ['WA','Washington'], ['WV','West Virginia'],
  ['WI','Wisconsin'],  ['WY','Wyoming'],      ['DC','D.C.'],
];

const STAR_MAP = { 1: '★☆☆☆☆', 2: '★★☆☆☆', 3: '★★★☆☆', 4: '★★★★☆', 5: '★★★★★' };

function fmtValue(v, format) {
  if (v == null) return '—';
  if (format === 'percent') return `${(v * 100).toFixed(3)}%`;
  if (format === 'ratio')   return `${v.toFixed(2)}x`;
  if (format === 'dollar') {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v.toLocaleString()}`;
  }
  if (format === 'count') return v.toLocaleString();
  return String(v);
}

export default function PeerGroupSetup({ charterNumber, token, period = '2026Q1' }) {
  const navigate = useNavigate();

  const [assetTier,      setAssetTier]      = useState('');
  const [selectedStates, setSelectedStates] = useState([]);
  const [fom,            setFom]            = useState('');
  const [loading,        setLoading]        = useState(false);
  const [result,         setResult]         = useState(null);
  const [error,          setError]          = useState(null);

  function toggleState(abbr) {
    setSelectedStates(prev =>
      prev.includes(abbr) ? prev.filter(s => s !== abbr) : [...prev, abbr]
    );
  }

  async function handleBuild() {
    if (!assetTier)             return setError('Select an asset tier.');
    if (!selectedStates.length) return setError('Select at least one state.');
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API}/onboarding/callahan-peer-group?charter_number=${charterNumber}&period=${period}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            asset_tier:          assetTier,
            states:              selectedStates,
            field_of_membership: fom || null,
          }),
        }
      );
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const err = await res.json(); detail = err.detail || detail; } catch (_) {}
        throw new Error(detail);
      }
      setResult(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="pgs-page">

      {/* Header */}
      <div className="pgs-header">
        <div className="pgs-header-left">
          <div className="pgs-step-badge">Step 2 of 2</div>
          <h1 className="pgs-title">Set up your peer group</h1>
          <p className="pgs-subtitle">
            Define the credit unions you want to benchmark against.
            Magnus will compute your percentile ranking across every metric each quarter.
          </p>
        </div>
        <button className="pgs-skip-btn" onClick={() => navigate('/home')}>
          Skip for now
        </button>
      </div>

      {/* Criteria form */}
      <div className="pgs-card">

        {/* Asset tier */}
        <fieldset className="pgs-fieldset">
          <legend className="pgs-legend">Asset Tier</legend>
          <div className="pgs-radio-grid">
            {ASSET_TIERS.map(t => (
              <label
                key={t.value}
                className={`pgs-radio-label ${assetTier === t.value ? 'pgs-radio-label--active' : ''}`}
              >
                <input
                  type="radio"
                  name="asset_tier"
                  value={t.value}
                  checked={assetTier === t.value}
                  onChange={() => setAssetTier(t.value)}
                />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>

        {/* States */}
        <fieldset className="pgs-fieldset">
          <legend className="pgs-legend">
            States{' '}
            <span className="pgs-legend-note">
              ({selectedStates.length} selected)
              {selectedStates.length > 0 && (
                <button className="pgs-link-btn" onClick={() => setSelectedStates([])}>Clear</button>
              )}
            </span>
          </legend>
          <div className="pgs-state-grid">
            {US_STATES.map(([abbr]) => (
              <label
                key={abbr}
                className={`pgs-state-label ${selectedStates.includes(abbr) ? 'pgs-state-label--active' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selectedStates.includes(abbr)}
                  onChange={() => toggleState(abbr)}
                />
                {abbr}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Field of membership */}
        <fieldset className="pgs-fieldset">
          <legend className="pgs-legend">
            Field of Membership <span className="pgs-legend-note">(optional)</span>
          </legend>
          <div className="pgs-radio-grid">
            {FOM_OPTIONS.map(o => (
              <label
                key={o.value}
                className={`pgs-radio-label ${fom === o.value ? 'pgs-radio-label--active' : ''}`}
              >
                <input
                  type="radio"
                  name="fom"
                  value={o.value}
                  checked={fom === o.value}
                  onChange={() => setFom(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>

        {error && <div className="pgs-error">{error}</div>}

        <button
          className="pgs-build-btn"
          onClick={handleBuild}
          disabled={loading || !assetTier || !selectedStates.length}
        >
          {loading ? 'Building peer group…' : 'Preview peer group →'}
        </button>
      </div>

      {/* Results preview */}
      {result && (
        <div className="pgs-result-card">

          {/* Summary row */}
          <div className="pgs-result-header">
            <div className="pgs-result-count">
              <strong>{result.n_institutions?.toLocaleString()}</strong> credit unions matched
            </div>
            <div className="pgs-result-group">{result.group_name}</div>
          </div>

          {/* Matched institution list */}
          {result.institutions?.length > 0 && (
            <div className="pgs-inst-list">
              <div className="pgs-inst-list-label">Matched institutions</div>
              <div className="pgs-inst-grid">
                {result.institutions.map(inst => (
                  <div key={inst.charter_number} className="pgs-inst-card">
                    <div className="pgs-inst-name">{inst.institution_name}</div>
                    <div className="pgs-inst-meta">
                      {[
                        inst.state_code,
                        inst.total_assets && fmtValue(inst.total_assets, 'dollar') + ' assets',
                        `#${inst.charter_number}`,
                      ].filter(Boolean).join('  ·  ')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Metrics table */}
          <table className="pgs-preview-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Your value</th>
                <th>Peer median</th>
                <th>P25 – P75</th>
                <th>Ranking</th>
              </tr>
            </thead>
            <tbody>
              {result.preview_metrics?.map(m => (
                <tr key={m.p76_metric}>
                  <td className="pgs-metric-name">{m.callahan_name}</td>
                  <td className="numeric">{fmtValue(m.institution_value, m.display_format)}</td>
                  <td className="numeric">{fmtValue(m.peer_median, m.display_format)}</td>
                  <td className="numeric muted">
                    {fmtValue(m.peer_p25, m.display_format)} – {fmtValue(m.peer_p75, m.display_format)}
                  </td>
                  <td className={`pgs-stars ${m.percentile_rank >= 90 ? 'pgs-stars--top' : m.percentile_rank < 10 ? 'pgs-stars--bottom' : ''}`}>
                    {STAR_MAP[m.stars] ?? '—'}
                    {m.percentile_rank != null && (
                      <span className="pgs-pctile"> {m.percentile_rank.toFixed(0)}th</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pgs-result-actions">
            <button className="pgs-confirm-btn" onClick={() => navigate('/home')}>
              Looks good — start exploring →
            </button>
            <button className="pgs-adjust-btn" onClick={() => setResult(null)}>
              Adjust criteria
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
