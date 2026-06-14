/**
 * ConfidenceBadge — required on EVERY geographic figure (CLAUDE.md rule).
 *
 *   measured  — FDIC branch-level data, highest confidence (teal)
 *   modeled   — estimation model, ±8% validated (blue)
 *   estimated — proxy-based, flag for user attention (amber)
 */

import React from 'react';

const CONFIG = {
  measured: {
    label: 'Measured',
    description: 'FDIC branch-level data — highest confidence',
    className: 'badge-teal',
  },
  modeled: {
    label: 'Modeled',
    description: 'Estimation model allocation, ±8% validated',
    className: 'badge-blue',
  },
  estimated: {
    label: 'Estimated',
    description: 'Proxy-based — review with caution',
    className: 'badge-amber',
  },
};

export default function ConfidenceBadge({ level }) {
  const config = CONFIG[level];
  if (!config) return null;

  return (
    <span
      className={`confidence-badge ${config.className}`}
      title={config.description}
      aria-label={`Data confidence: ${config.label} — ${config.description}`}
    >
      {config.label}
    </span>
  );
}
