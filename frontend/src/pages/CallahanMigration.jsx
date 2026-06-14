/**
 * CallahanMigration — 3-step onboarding wizard for Callahan Analytics users.
 *
 * Step 1: Build an equivalent Callahan peer group (asset tier + state + FOM).
 *         Preview shows the same metrics Callahan reports — numbers should match exactly.
 *
 * Step 2: Upload a Callahan Excel/CSV export to verify our numbers match theirs.
 *         Side-by-side comparison table with match / close / mismatch indicators.
 *
 * Step 3: Layer the regional peer line (purple) over the Callahan national view.
 *         Signal separator: "Is your delinquency a you-problem or a Michigan-problem?"
 *         Frame: P76 shows everything Callahan shows — plus the regional picture.
 *         Never: "switching from" or "replacing" Callahan.
 *
 * CLAUDE.md rules enforced:
 *   - Every chart has a peer group label
 *   - Regional peer line = purple dashed (labeled "Regional peers")
 *   - Signal separator label shown below delinquency charts
 *   - PeerBandChart is the only chart type
 */

import React, { useState, useCallback, useRef } from 'react';
import PeerBandChart from '../components/PeerBandChart';
import ConfidenceBadge from '../components/ConfidenceBadge';

const API = import.meta.env.VITE_API_URL ?? '';

// ── Static data ───────────────────────────────────────────────────────────────

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

const STATE_FULL_NAME = Object.fromEntries(US_STATES);

// ── Formatters ────────────────────────────────────────────────────────────────

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

function fmtDelta(delta, format) {
  if (delta == null) return null;
  const sign = delta >= 0 ? '+' : '';
  if (format === 'percent') return `${sign}${(delta * 100).toFixed(3)} pp`;
  if (format === 'ratio')   return `${sign}${delta.toFixed(4)}x`;
  return `${sign}${delta.toFixed(4)}`;
}

// ── Step progress bar ─────────────────────────────────────────────────────────

function ProgressBar({ step }) {
  const steps = [
    { n: 1, label: 'Match Peer Group' },
    { n: 2, label: 'Verify Numbers' },
    { n: 3, label: 'See the Regional Picture' },
  ];
  return (
    <div className="cm-progress">
      {steps.map((s, i) => (
        <React.Fragment key={s.n}>
          <div className={`cm-step ${step === s.n ? 'cm-step--active' : step > s.n ? 'cm-step--done' : ''}`}>
            <div className="cm-step-circle">
              {step > s.n ? '✓' : s.n}
            </div>
            <span className="cm-step-label">{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`cm-step-line ${step > s.n ? 'cm-step-line--done' : ''}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ── Step 1: Peer group criteria ───────────────────────────────────────────────

function Step1({ charterNumber, period, token, onComplete }) {
  const [assetTier,       setAssetTier]       = useState('');
  const [selectedStates,  setSelectedStates]  = useState([]);
  const [fom,             setFom]             = useState('');
  const [loading,         setLoading]         = useState(false);
  const [result,          setResult]          = useState(null);
  const [error,           setError]           = useState(null);

  function toggleState(abbr) {
    setSelectedStates(prev =>
      prev.includes(abbr) ? prev.filter(s => s !== abbr) : [...prev, abbr]
    );
  }

  async function handleBuild() {
    if (!assetTier)            return setError('Select an asset tier.');
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
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            asset_tier:           assetTier,
            states:               selectedStates,
            field_of_membership:  fom || null,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const STAR_MAP = { 1: '★☆☆☆☆', 2: '★★☆☆☆', 3: '★★★☆☆', 4: '★★★★☆', 5: '★★★★★' };

  return (
    <div className="cm-step-content">
      <h2 className="cm-heading">Match Your Callahan Peer Group</h2>
      <p className="cm-subheading">
        Enter your Callahan peer group criteria and we'll replicate it.
        Your numbers will match Callahan exactly.
      </p>

      {/* Asset tier */}
      <fieldset className="cm-fieldset">
        <legend>Asset Tier</legend>
        <div className="cm-radio-grid">
          {ASSET_TIERS.map(t => (
            <label key={t.value} className={`cm-radio-label ${assetTier === t.value ? 'cm-radio-label--active' : ''}`}>
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
      <fieldset className="cm-fieldset">
        <legend>
          States{' '}
          <span className="cm-legend-note">
            ({selectedStates.length} selected)
            {selectedStates.length > 0 && (
              <button className="cm-link-btn" onClick={() => setSelectedStates([])}>
                Clear
              </button>
            )}
          </span>
        </legend>
        <div className="cm-state-grid">
          {US_STATES.map(([abbr, name]) => (
            <label key={abbr} className={`cm-state-label ${selectedStates.includes(abbr) ? 'cm-state-label--active' : ''}`}>
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

      {/* Field of membership (optional) */}
      <fieldset className="cm-fieldset">
        <legend>Field of Membership <span className="cm-legend-note">(optional)</span></legend>
        <div className="cm-radio-grid">
          {FOM_OPTIONS.map(o => (
            <label key={o.value} className={`cm-radio-label ${fom === o.value ? 'cm-radio-label--active' : ''}`}>
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

      {error && <div className="cm-error">{error}</div>}

      <button
        className="cm-btn cm-btn--primary"
        onClick={handleBuild}
        disabled={loading || !assetTier || !selectedStates.length}
      >
        {loading ? 'Building peer group…' : 'Build Peer Group'}
      </button>

      {/* Preview results */}
      {result && (
        <div className="cm-result-panel">
          <div className="cm-result-summary">
            <strong>{result.n_institutions.toLocaleString()}</strong> credit unions matched your criteria
            <span className="cm-result-group"> ({result.group_name})</span>
          </div>

          <p className="cm-result-note">
            These are the same institutions in your Callahan peer group. The numbers below should match what Callahan shows you.
          </p>

          <table className="cm-preview-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Your Value</th>
                <th>Peer Median</th>
                <th>P25 – P75</th>
                <th>Stars</th>
              </tr>
            </thead>
            <tbody>
              {result.preview_metrics.map(m => (
                <tr key={m.p76_metric}>
                  <td className="cm-metric-name">{m.callahan_name}</td>
                  <td className="numeric">{fmtValue(m.institution_value, m.display_format)}</td>
                  <td className="numeric">{fmtValue(m.peer_median,       m.display_format)}</td>
                  <td className="numeric muted">
                    {fmtValue(m.peer_p25, m.display_format)} – {fmtValue(m.peer_p75, m.display_format)}
                  </td>
                  <td className={`stars ${m.percentile_rank >= 90 ? 'stars--top' : m.percentile_rank < 10 ? 'stars--bottom' : ''}`}>
                    {STAR_MAP[m.stars] ?? '—'}
                    {m.percentile_rank != null && (
                      <span className="pctile-label"> {m.percentile_rank.toFixed(0)}th</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="cm-action-row">
            <button
              className="cm-btn cm-btn--primary"
              onClick={() => onComplete({ peerGroupId: result.peer_group_id, institutionState: result.institution_state })}
            >
              These look right — continue →
            </button>
            <button className="cm-btn cm-btn--ghost" onClick={() => setResult(null)}>
              Adjust criteria
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 2: Upload and verify ─────────────────────────────────────────────────

const MATCH_CONFIG = {
  exact:    { label: '✓ Exact match',       color: '#2E7D32', bg: '#E8F5E9' },
  close:    { label: '≈ Within rounding',   color: '#FF6F00', bg: '#FFF8E1' },
  mismatch: { label: '✗ Differs > 0.05 pp', color: '#C62828', bg: '#FFEBEE' },
  unmapped: { label: '— Not mapped',         color: '#757575', bg: '#FAFAFA' },
};

function Step2({ charterNumber, period, token, peerGroupId, onComplete, onBack }) {
  const [file,         setFile]         = useState(null);
  const [dragging,     setDragging]     = useState(false);
  const [loading,      setLoading]      = useState(false);
  const [result,       setResult]       = useState(null);
  const [error,        setError]        = useState(null);
  const fileInputRef = useRef(null);

  function handleDrop(e) {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  }

  async function handleVerify() {
    if (!file) return setError('Select a Callahan file to upload.');
    setLoading(true);
    setError(null);

    const form = new FormData();
    form.append('file', file);
    form.append('charter_number', String(charterNumber));
    form.append('period', period);
    form.append('peer_group_id', peerGroupId ?? '');

    try {
      const res = await fetch(`${API}/onboarding/verify-callahan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const summaryColor = result
    ? result.all_match
      ? '#2E7D32'
      : result.n_mismatch > 0 ? '#C62828' : '#FF6F00'
    : null;

  return (
    <div className="cm-step-content">
      <h2 className="cm-heading">Verify Our Numbers Match Yours</h2>
      <p className="cm-subheading">
        Upload your Callahan Excel or CSV export. We'll compare every metric side-by-side
        to confirm you're seeing the same data.
      </p>

      {/* Drop zone */}
      <div
        className={`cm-dropzone ${dragging ? 'cm-dropzone--active' : ''} ${file ? 'cm-dropzone--filled' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls"
          hidden
          onChange={e => setFile(e.target.files[0])}
        />
        {file ? (
          <div className="cm-dropzone-file">
            <span className="cm-dropzone-icon">📄</span>
            <strong>{file.name}</strong>
            <span className="cm-dropzone-size">({(file.size / 1024).toFixed(0)} KB)</span>
            <button
              className="cm-link-btn"
              onClick={e => { e.stopPropagation(); setFile(null); setResult(null); }}
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="cm-dropzone-prompt">
            <span className="cm-dropzone-icon">⬆</span>
            <p>Drag your Callahan export here or <strong>click to browse</strong></p>
            <p className="muted">Accepts .csv or .xlsx</p>
          </div>
        )}
      </div>

      {!result?.institution_row_found && result && (
        <div className="cm-warning">
          Could not find your institution's row by name — using the first data row. Results may not be accurate.
        </div>
      )}

      {error && <div className="cm-error">{error}</div>}

      <button
        className="cm-btn cm-btn--primary"
        onClick={handleVerify}
        disabled={loading || !file}
      >
        {loading ? 'Comparing…' : 'Verify Numbers'}
      </button>

      {/* Comparison result */}
      {result && (
        <div className="cm-result-panel">
          {/* Summary banner */}
          <div className="cm-match-banner" style={{ background: summaryColor + '18', borderColor: summaryColor, color: summaryColor }}>
            <strong>{result.note}</strong>
          </div>

          <div className="cm-match-counts">
            <span className="match-exact">{result.n_exact} exact</span>
            {result.n_close > 0 && <span className="match-close"> · {result.n_close} within rounding</span>}
            {result.n_mismatch > 0 && <span className="match-mismatch"> · {result.n_mismatch} mismatch</span>}
            {result.n_unmapped > 0 && <span className="match-unmapped"> · {result.n_unmapped} not mapped</span>}
          </div>

          <div className="cm-scroll-wrap">
            <table className="cm-compare-table">
              <thead>
                <tr>
                  <th>Callahan Metric</th>
                  <th>Callahan Value</th>
                  <th>P76 Value</th>
                  <th>Match</th>
                  <th>Delta</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.filter(r => r.match !== 'unmapped').map((row, i) => {
                  const cfg = MATCH_CONFIG[row.match] ?? MATCH_CONFIG.unmapped;
                  return (
                    <tr key={i} style={{ background: cfg.bg }}>
                      <td className="cm-metric-name">{row.callahan_name}</td>
                      <td className="numeric">{fmtValue(row.callahan_value, row.display_format)}</td>
                      <td className="numeric">{fmtValue(row.p76_value,      row.display_format)}</td>
                      <td style={{ color: cfg.color, fontWeight: 600 }}>{cfg.label}</td>
                      <td className="numeric muted">{fmtDelta(row.delta, row.display_format) ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="cm-action-row">
            <button
              className="cm-btn cm-btn--primary"
              onClick={() => onComplete()}
            >
              {result.all_match
                ? 'Perfect match — see what Callahan couldn\'t show you →'
                : 'Continue to regional view →'}
            </button>
            <button className="cm-btn cm-btn--ghost" onClick={onBack}>
              ← Back to peer group
            </button>
          </div>
        </div>
      )}

      {!result && (
        <button className="cm-btn cm-btn--ghost" onClick={onBack}>
          ← Back to peer group
        </button>
      )}
    </div>
  );
}

// ── Step 3: The regional picture ──────────────────────────────────────────────

function Step3({ charterNumber, period, token, peerGroupId, institutionState, onBack, onFinish }) {
  const stateName = STATE_FULL_NAME[institutionState] || 'your market';
  const [metric, setMetric] = useState('delinq_rate_total');

  const METRIC_OPTIONS = [
    { value: 'delinq_rate_total',              label: 'Total Delinquency Ratio' },
    { value: 'chargeoff_rate_total_annualized', label: 'Net Charge-Off Ratio' },
    { value: 'net_worth_ratio',                 label: 'Net Worth Ratio' },
    { value: 'roa_annualized',                  label: 'Return on Assets' },
    { value: 'efficiency_ratio',                label: 'Efficiency Ratio' },
  ];

  return (
    <div className="cm-step-content">
      <h2 className="cm-heading">Here's the View Callahan Couldn't Show You</h2>
      <p className="cm-subheading">
        You're seeing everything Callahan reports — using the same NCUA data.
        Now add the regional layer: how do you compare to credit unions{' '}
        <em>in your own market</em>?
      </p>

      {/* Metric selector */}
      <div className="cm-metric-tabs">
        {METRIC_OPTIONS.map(o => (
          <button
            key={o.value}
            className={`cm-tab ${metric === o.value ? 'cm-tab--active' : ''}`}
            onClick={() => setMetric(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {/* Peer group legend */}
      <div className="cm-legend-row">
        <span className="cm-legend-item cm-legend-item--national">
          <span className="cm-legend-swatch" /> National peers (Callahan-equivalent)
        </span>
        <span className="cm-legend-item cm-legend-item--regional">
          <span className="cm-legend-swatch cm-legend-swatch--regional" /> Regional peers
        </span>
      </div>

      {/* PeerBandChart — the only chart type per CLAUDE.md
          Shows national peer band (Callahan-equivalent) + purple regional line */}
      <div className="cm-chart-wrapper">
        <PeerBandChart
          charterNumber={charterNumber}
          metric={metric}
          period={period}
          nationalPeerGroupId={peerGroupId}
          showRegionalPeers
          peerGroupLabel={`National (Callahan-equivalent) + Regional peers — ${stateName}`}
          token={token}
        />
      </div>

      {/* Signal separator — CLAUDE.md: shown below every delinquency/charge-off chart */}
      <div className="cm-signal-separator">
        <div className="cm-signal-separator__label">
          Is your delinquency a you-problem or a {stateName}-problem?
        </div>
        <p className="cm-signal-separator__body">
          The blue band shows where you stand vs Callahan's national peer group.
          The <span className="cm-regional-label">purple line</span> shows your regional peers —
          credit unions in {stateName} operating in the same markets.
          When both lines move together, it's a market trend.
          When only your institution diverges, it's worth a closer look.
        </p>
      </div>

      {/* Value proposition — never frame as "switching" or "replacing" Callahan */}
      <div className="cm-value-prop">
        <h3 className="cm-value-prop__title">
          P76 shows you everything Callahan shows you — plus the regional picture.
        </h3>
        <ul className="cm-value-prop__list">
          <li>Same NCUA data, same metric formulas, same peer group criteria</li>
          <li>
            Plus: regional peer group automatically matched to your{' '}
            <strong>{stateName}</strong> market
          </li>
          <li>Plus: "Is this a you-problem or a market-problem?" — answered every quarter</li>
          <li>Plus: early warning signals before your examiner sees them</li>
        </ul>
      </div>

      <div className="cm-action-row">
        <button className="cm-btn cm-btn--primary cm-btn--large" onClick={onFinish}>
          Explore your full regional analysis →
        </button>
        <button className="cm-btn cm-btn--ghost" onClick={onBack}>
          ← Back
        </button>
      </div>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export default function CallahanMigration({
  charterNumber,
  period,
  token,
  onComplete,   // called when user finishes Step 3
}) {
  const [step,             setStep]             = useState(1);
  const [peerGroupId,      setPeerGroupId]      = useState(null);
  const [institutionState, setInstitutionState] = useState('');

  function handleStep1Done({ peerGroupId: pgId, institutionState: state }) {
    setPeerGroupId(pgId);
    setInstitutionState(state ?? '');
    setStep(2);
  }

  function handleStep2Done() {
    setStep(3);
  }

  function handleFinish() {
    if (onComplete) onComplete({ peerGroupId, institutionState });
  }

  return (
    <div className="callahan-migration">
      {/* Top context bar */}
      <div className="cm-context-bar">
        <span className="cm-context-institution">
          Charter {charterNumber} · {period}
        </span>
        <span className="cm-context-note">
          Migrating from Callahan Analytics
        </span>
      </div>

      <ProgressBar step={step} />

      <div className="cm-content">
        {step === 1 && (
          <Step1
            charterNumber={charterNumber}
            period={period}
            token={token}
            onComplete={handleStep1Done}
          />
        )}

        {step === 2 && (
          <Step2
            charterNumber={charterNumber}
            period={period}
            token={token}
            peerGroupId={peerGroupId}
            onComplete={handleStep2Done}
            onBack={() => setStep(1)}
          />
        )}

        {step === 3 && (
          <Step3
            charterNumber={charterNumber}
            period={period}
            token={token}
            peerGroupId={peerGroupId}
            institutionState={institutionState}
            onBack={() => setStep(2)}
            onFinish={handleFinish}
          />
        )}
      </div>
    </div>
  );
}
