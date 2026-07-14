/**
 * Home — post-setup landing page and feature selector.
 * Shows institution identity + cards for each major section.
 */

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL ?? '';

const FEATURES = [
  {
    to: '/credit-quality',
    icon: '📊',
    title: 'Credit Quality',
    color: '#1565C0',
    bg: '#E3F2FD',
    desc: 'Delinquency trends, charge-off analysis, ALLL/ACL adequacy vs regional peers.',
  },
  {
    to: '/market-map',
    icon: '🗺',
    title: 'Market Map',
    color: '#2E7D32',
    bg: '#E8F5E9',
    desc: 'Deposit market share by county, MSA, and state with confidence badges.',
  },
  {
    to: '/peer-comparison',
    icon: '⚖️',
    title: 'Peer Comparison',
    color: '#6A1B9A',
    bg: '#F3E5F5',
    desc: 'PeerBand charts across 12 quarters — delinquency, ROA, NIM, efficiency.',
  },
  {
    to: '/query',
    icon: '💬',
    title: 'Ask Intelligence',
    color: '#00696E',
    bg: '#E0F2F1',
    desc: 'Natural language queries using Callahan metric names. Charts auto-generated.',
  },
  {
    to: '/reports',
    icon: '📄',
    title: 'Reports',
    color: '#E65100',
    bg: '#FFF3E0',
    desc: 'One-click board reports and risk committee memos with AI narratives.',
  },
  {
    to: '/onboarding/callahan',
    icon: '🔀',
    title: 'Peer Group Setup',
    color: '#37474F',
    bg: '#ECEFF1',
    desc: 'Migrate Callahan peer groups or configure regional benchmarks.',
  },
];

export default function Home({ charterNumber, token, onReset }) {
  const navigate = useNavigate();
  const [institution, setInstitution] = useState(null);

  useEffect(() => {
    if (!charterNumber) return;
    fetch(`${API}/institutions/${charterNumber}?period=2026Q1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setInstitution(d); })
      .catch(() => {});
  }, [charterNumber, token]);

  return (
    <div className="home-page">

      {/* Institution header */}
      <div className="home-header">
        <div className="home-header-left">
          <div className="home-inst-badge">Charter {charterNumber}</div>
          <h1 className="home-inst-name">
            {institution?.institution_name ?? `Charter ${charterNumber}`}
          </h1>
          {institution && (
            <p className="home-inst-meta">
              {[
                institution.state_code,
                institution.total_assets && `$${(institution.total_assets / 1e9).toFixed(2)}B assets`,
                institution.member_count && `${Number(institution.member_count).toLocaleString()} members`,
              ].filter(Boolean).join('  ·  ')}
            </p>
          )}
        </div>
        <button className="home-change-btn" onClick={onReset}>
          Change institution
        </button>
      </div>

      {/* Section label */}
      <p className="home-section-label">Choose a section to explore</p>

      {/* Feature cards grid */}
      <div className="home-grid">
        {FEATURES.map(f => (
          <button
            key={f.to}
            className="home-card"
            onClick={() => navigate(f.to)}
            style={{ '--card-color': f.color, '--card-bg': f.bg }}
          >
            <div className="home-card-icon" style={{ background: f.bg, color: f.color }}>
              {f.icon}
            </div>
            <div className="home-card-body">
              <div className="home-card-title" style={{ color: f.color }}>{f.title}</div>
              <div className="home-card-desc">{f.desc}</div>
            </div>
            <span className="home-card-arrow">→</span>
          </button>
        ))}
      </div>

    </div>
  );
}
