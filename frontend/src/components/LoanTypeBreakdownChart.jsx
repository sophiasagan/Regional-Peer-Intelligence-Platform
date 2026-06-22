/**
 * LoanTypeBreakdownChart — "Delinquency by Product" grouped bar chart.
 * Matches Callahan's delinquency-by-product view.
 *
 * Each group: institution bar (green if ≤ peer, coral if > peer) + peer median bar (gray).
 * Rows without a separate NCUA delinquency code (Auto Lease) show as N/A stubs.
 *
 * When has_granular_delinquency is false (pending NCUA per-product ingestion),
 * falls back to loan portfolio composition bars with a notice.
 *
 * Loan types: Real Estate | 1st Mortgage | Auto (Total) | New Auto | Used Auto |
 *             Credit Card | Commercial | Indirect | Auto Lease
 *
 * Excel/CSV download on every chart — non-negotiable (P76 / Callahan rule).
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Cell, LabelList,
} from 'recharts';

const API = import.meta.env.VITE_API_URL ?? '';

// Loan types that have no separate NCUA delinquency code — show N/A stubs
// (currently none — auto_lease uses acct_041D confirmed from Schedule A Sec2 Row 7)
const NO_DELINQ_TRACKING = new Set([]);

function downloadCsv(data, charterNumber, period, peerGroupLabel) {
  if (!data?.length) return;
  const headers = ['Loan Type', 'Your Delinquency Rate %', 'Peer Median Rate %', 'Your Balance ($)', '% of Total Loans'].join(',');
  const rows = data.map(d => [
    `"${d.label}"`,
    d.institution_rate != null ? (d.institution_rate * 100).toFixed(3) : 'N/A',
    d.peer_median_rate  != null ? (d.peer_median_rate  * 100).toFixed(3) : 'N/A',
    d.institution_balance ?? '',
    d.pct_of_total_loans != null ? (d.pct_of_total_loans * 100).toFixed(2) : '',
  ].join(','));
  const meta = `Peer Group: ${peerGroupLabel},Charter: ${charterNumber},Period: ${period}`;
  const blob = new Blob([[meta, '', headers, ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `delinquency_by_product_${charterNumber}_${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const isNA = payload[0]?.payload?.is_na;
  return (
    <div className="chart-tooltip">
      <p className="tooltip-label">{label}</p>
      {isNA ? (
        <p style={{ color: '#9E9E9E', fontStyle: 'italic', fontSize: 11 }}>
          No separate NCUA delinquency code — balance shown in portfolio view
        </p>
      ) : payload.map(p => (
        <p key={p.dataKey} style={{ color: p.fill ?? p.color }}>
          {p.name}: {p.value != null ? `${p.value.toFixed(3)}%` : 'N/A'}
        </p>
      ))}
    </div>
  );
};

// Custom label renderer for bar tops — shows "N/A" for no-tracking rows, value% for others
function makeLabel(displayData) {
  return function LabelContent(props) {
    const entry = displayData[props.index];
    if (!entry) return null;
    if (entry.is_na) {
      return (
        <text
          x={props.x + props.width / 2}
          y={(props.y ?? 0) - 4}
          textAnchor="middle"
          fontSize={9}
          fill="#9E9E9E"
          fontStyle="italic"
        >
          N/A
        </text>
      );
    }
    const v = props.value;
    if (v == null) return null;
    return (
      <text
        x={props.x + props.width / 2}
        y={(props.y ?? 0) - 4}
        textAnchor="middle"
        fontSize={10}
        fill="#333"
        fontWeight={600}
      >
        {`${Number(v).toFixed(2)}%`}
      </text>
    );
  };
}

export default function LoanTypeBreakdownChart({ charterNumber, period, peerGroup, token }) {
  const [result, setResult]   = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!charterNumber || !period) return;
    setLoading(true);
    fetch(
      `${API}/peer-comparison/${charterNumber}/loan-type-breakdown?period=${period}&peer_group=${peerGroup}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
      .then(r => r.ok ? r.json() : null)
      .then(data => data && setResult(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [charterNumber, period, peerGroup, token]);

  const handleDownload = useCallback(
    () => downloadCsv(result?.loan_types, charterNumber, period, result?.peer_group_label ?? ''),
    [result, charterNumber, period],
  );

  const hasDelinq = result?.has_granular_delinquency;
  const rows      = result?.loan_types ?? [];

  // Build chart data — include all rows that have a portfolio balance
  const chartData = rows
    .filter(d => d.pct_of_total_loans != null || d.institution_rate != null)
    .map(d => {
      const isNA = NO_DELINQ_TRACKING.has(d.loan_type) || (d.institution_rate == null && d.peer_median_rate == null && hasDelinq);
      return {
        name:       d.label,
        loan_type:  d.loan_type,
        is_na:      isNA,
        has_rate:   d.institution_rate != null,
        // Use 0 for N/A rows so minPointSize renders a visible stub
        inst_pct:   hasDelinq ? (d.institution_rate != null ? +(d.institution_rate * 100).toFixed(3) : (isNA ? 0 : null)) : null,
        peer_pct:   hasDelinq && d.peer_median_rate != null ? +(d.peer_median_rate * 100).toFixed(3) : (isNA ? 0 : null),
        comp_pct:   d.pct_of_total_loans != null ? +(d.pct_of_total_loans * 100).toFixed(2) : null,
        above_peer: !isNA && d.institution_rate != null && d.peer_median_rate != null
                      && d.institution_rate > d.peer_median_rate,
      };
    });

  // Delinquency chart: include rows with rates + N/A stubs (exclude rows with no balance at all)
  const delinqData = hasDelinq
    ? chartData.filter(d => d.has_rate || d.is_na)
    : [];

  const peerLabel = result?.peer_group_label ?? peerGroup;

  const InstLabel  = makeLabel(delinqData);
  const PeerLabelC = (props) => {
    const entry = delinqData[props.index];
    if (!entry || entry.is_na) return null;
    const v = props.value;
    if (v == null) return null;
    return (
      <text x={props.x + props.width / 2} y={(props.y ?? 0) - 4} textAnchor="middle" fontSize={10} fill="#666">
        {`${Number(v).toFixed(2)}%`}
      </text>
    );
  };

  return (
    <div className="loan-breakdown-wrapper">
      <div className="chart-header">
        <div className="chart-title-group">
          <h3>Delinquency by Product</h3>
          <span className="peer-group-pill">{peerLabel}</span>
        </div>
        <button
          className="download-btn"
          onClick={handleDownload}
          disabled={!rows.length}
          title="Download CSV"
        >
          Download CSV
        </button>
      </div>

      {!hasDelinq && result && (
        <div className="chart-notice">
          Per-product delinquency rates pending NCUA field ingestion —
          showing loan portfolio composition instead.
        </div>
      )}

      {loading && <div className="chart-loading">Loading…</div>}

      {!loading && !rows.length && (
        <div className="chart-empty">
          No loan breakdown data available for {period}.
        </div>
      )}

      {!loading && delinqData.length > 0 && hasDelinq && (
        <>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={delinqData}
              margin={{ top: 24, right: 24, left: 8, bottom: 64 }}
              barCategoryGap="30%"
              barGap={4}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#E8E8E8" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: '#555' }}
                angle={-30}
                textAnchor="end"
                interval={0}
                tickLine={false}
              />
              <YAxis
                tickFormatter={v => `${v.toFixed(2)}%`}
                tick={{ fontSize: 11, fill: '#555' }}
                tickLine={false}
                axisLine={false}
                width={58}
                domain={[0, dataMax => Math.max(dataMax * 1.3, 0.1)]}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                verticalAlign="top"
                height={32}
                iconType="square"
                wrapperStyle={{ fontSize: 12 }}
              />

              <Bar dataKey="inst_pct" name="Your institution" maxBarSize={36} minPointSize={8} radius={[3,3,0,0]}>
                {delinqData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.is_na ? '#E0E0E0' : entry.above_peer ? '#E53935' : '#43A047'}
                    fillOpacity={entry.is_na ? 0.6 : 1}
                  />
                ))}
                <LabelList content={<InstLabel />} />
              </Bar>

              <Bar dataKey="peer_pct" name={peerLabel} maxBarSize={36} minPointSize={3} radius={[3,3,0,0]}>
                {delinqData.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={entry.is_na ? '#F5F5F5' : '#90A4AE'}
                    fillOpacity={entry.is_na ? 0.4 : 1}
                  />
                ))}
                <LabelList content={<PeerLabelC />} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          {delinqData.some(d => d.is_na) && (
            <p style={{ fontSize: 11, color: '#9E9E9E', margin: '4px 8px 0', fontStyle: 'italic' }}>
              * N/A — no separate NCUA 5300 delinquency code; balance included in related auto totals
            </p>
          )}
        </>
      )}

      {!loading && rows.length > 0 && !hasDelinq && (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData} margin={{ top: 16, right: 24, left: 8, bottom: 64 }} barCategoryGap="35%">
            <CartesianGrid strokeDasharray="3 3" stroke="#E8E8E8" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: '#555' }}
              angle={-30}
              textAnchor="end"
              interval={0}
              tickLine={false}
            />
            <YAxis
              tickFormatter={v => `${v.toFixed(0)}%`}
              tick={{ fontSize: 11, fill: '#555' }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip formatter={v => `${v?.toFixed(1)}% of loans`} />
            <Bar dataKey="comp_pct" name="Portfolio share %" fill="#64B5F6" maxBarSize={44} radius={[3,3,0,0]}>
              <LabelList
                dataKey="comp_pct"
                position="top"
                formatter={v => v != null ? `${v.toFixed(1)}%` : ''}
                style={{ fontSize: 10, fill: '#333' }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
