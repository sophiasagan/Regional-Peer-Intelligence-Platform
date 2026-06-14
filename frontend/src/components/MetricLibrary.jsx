/**
 * MetricLibrary — left-nav metric browser.
 * Uses Callahan's exact metric names and folder structure in all user-facing text.
 *
 * Special items (FPR Reports, Advanced Analysis, Data Dictionary) fire onSpecialView
 * instead of onMetricSelect so the parent can switch to the appropriate view.
 */

import React, { useState } from 'react';

// Callahan metric hierarchy — exact label names required (CLAUDE.md rule)
const METRIC_TREE = [
  {
    category: 'Asset Quality',
    defaultOpen: true,
    items: [
      { label: 'Delinquency Breakdown',         name: 'delinq_rate_total',               adverse: true,  unit: '%' },
      { label: 'Total Delinquency (90+)',        name: 'delinq_rate_90plus',              adverse: true,  unit: '%' },
      { label: 'ALLL / Delinquency',             name: 'alll_coverage',                  adverse: false, unit: 'x' },
      { label: 'Credit Card Delinquency',        name: 'delinq_rate_credit_card',         adverse: true,  unit: '%' },
      { label: 'Total Auto Delinquency',         name: 'delinq_rate_auto_total',          adverse: true,  unit: '%' },
      { label: '1st Mortgage Delinquency',       name: 'delinq_rate_first_mortgage',      adverse: true,  unit: '%' },
      { label: 'Non-Farm Non-RE Delinquency',    name: 'delinq_rate_commercial',          adverse: true,  unit: '%' },
      { label: 'Commercial Delinquency',         name: 'delinq_rate_commercial_re',       adverse: true,  unit: '%' },
      { label: 'Delinquency by Product',         name: '__delinq_by_product__',           adverse: true,  unit: '%', special: 'loan_breakdown' },
    ],
  },
  {
    category: 'Credit Quality',
    defaultOpen: false,
    items: [
      { label: 'Total Delinquency Ratio',        name: 'delinq_rate_total',               adverse: true,  unit: '%' },
      { label: 'Net Charge-Off Ratio',           name: 'chargeoff_rate_total_annualized', adverse: true,  unit: '%' },
      { label: 'Allowance Coverage Ratio',       name: 'alll_coverage',                  adverse: false, unit: 'x' },
      { label: 'ALLL to Total Loans',            name: 'alll_to_loans',                  adverse: false, unit: '%' },
      { label: 'Non-Accrual Rate',               name: 'non_accrual_rate',               adverse: true,  unit: '%' },
      { label: 'TDR / Modifications',            name: 'tdr_to_loans',                   adverse: true,  unit: '%' },
    ],
  },
  {
    category: 'Capital',
    defaultOpen: false,
    items: [
      { label: 'Net Worth Ratio',                name: 'net_worth_ratio',                adverse: false, unit: '%' },
      { label: 'Risk-Based Capital Ratio',       name: 'rbc_ratio',                      adverse: false, unit: '%' },
    ],
  },
  {
    category: 'Earnings',
    defaultOpen: false,
    items: [
      { label: 'Return on Assets',               name: 'roa_annualized',                 adverse: false, unit: '%' },
      { label: 'Net Interest Margin',            name: 'nim',                            adverse: false, unit: '%' },
      { label: 'Efficiency Ratio',               name: 'efficiency_ratio',               adverse: true,  unit: '%' },
    ],
  },
  {
    category: 'Lending',
    defaultOpen: false,
    items: [
      { label: 'Total Loans and Leases',         name: 'acct_025B',                      adverse: false, unit: '$' },
      { label: 'Loan Growth',                    name: 'loan_growth_rate',               adverse: false, unit: '%' },
      { label: 'Loan-to-Share Ratio',            name: 'loan_to_share',                  adverse: false, unit: '%' },
      { label: 'Credit Card Loans',              name: 'acct_396',                       adverse: false, unit: '$' },
      { label: 'Auto Loans (New)',               name: 'acct_385',                       adverse: false, unit: '$' },
      { label: 'Auto Loans (Used)',              name: 'acct_370',                       adverse: false, unit: '$' },
      { label: '1st Mortgage',                   name: 'acct_703A',                      adverse: false, unit: '$' },
      { label: 'Commercial Loans',               name: 'acct_400P',                      adverse: false, unit: '$' },
      { label: 'Indirect Loans',                 name: 'acct_618A',                      adverse: false, unit: '$' },
    ],
  },
  {
    category: 'Growth',
    defaultOpen: false,
    items: [
      { label: 'Member Growth',                  name: 'member_growth_rate',             adverse: false, unit: '%' },
      { label: 'Loan Growth',                    name: 'loan_growth_rate',               adverse: false, unit: '%' },
      { label: 'Share Growth',                   name: 'share_growth_rate',              adverse: false, unit: '%' },
      { label: 'Asset Growth',                   name: 'asset_growth_rate',              adverse: false, unit: '%' },
    ],
  },
  {
    category: 'Balance Sheet',
    defaultOpen: false,
    items: [
      { label: 'Total Assets',                   name: 'acct_010',                       adverse: false, unit: '$' },
      { label: 'Total Loans and Leases',         name: 'acct_025B',                      adverse: false, unit: '$' },
      { label: 'Total Shares and Deposits',      name: 'acct_018',                       adverse: false, unit: '$' },
      { label: 'Total Net Worth',                name: 'acct_797',                       adverse: false, unit: '$' },
      { label: 'Members',                        name: 'acct_083',                       adverse: false, unit: 'count' },
    ],
  },
  {
    category: 'Market Share',
    defaultOpen: false,
    items: [
      { label: 'Deposit Market Share',           name: 'deposit_market_share_pct',       adverse: false, unit: '%' },
      { label: 'Loan Market Share',              name: 'loan_market_share_pct',          adverse: false, unit: '%' },
    ],
  },
  {
    category: 'FPR Reports',
    defaultOpen: false,
    items: [
      { label: 'Asset Quality',   name: '__fpr_asset_quality__',  special: 'fpr', fprSection: 'asset_quality' },
      { label: 'Earnings',        name: '__fpr_earnings__',       special: 'fpr', fprSection: 'earnings' },
      { label: 'Capital',         name: '__fpr_capital__',        special: 'fpr', fprSection: 'capital' },
      { label: 'Liquidity',       name: '__fpr_liquidity__',      special: 'fpr', fprSection: 'liquidity' },
    ],
  },
  {
    category: 'Advanced Analysis',
    defaultOpen: false,
    items: [
      { label: 'CUPP Overview',         name: '__cupp_overview__',      special: 'cupp' },
      { label: 'Trendwatch',            name: '__trendwatch__',         special: 'trendwatch' },
      { label: 'Delinquency by Product',name: '__delinq_by_product__',  special: 'loan_breakdown' },
    ],
  },
  {
    category: 'Data Dictionary',
    defaultOpen: false,
    items: [
      { label: 'Open Data Dictionary', name: '__data_dict__', special: 'data_dict' },
    ],
  },
];

export default function MetricLibrary({ activeMetric, onMetricSelect, onSpecialView }) {
  const [expanded, setExpanded] = useState(
    () => new Set(METRIC_TREE.filter(c => c.defaultOpen).map(c => c.category)),
  );

  function toggleCategory(cat) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  function handleItemClick(item) {
    if (item.special) {
      onSpecialView?.(item.special, item);
    } else {
      onMetricSelect?.(item.name);
    }
  }

  return (
    <nav className="metric-library" aria-label="Metric Library">
      <div className="library-header">Metrics</div>
      {METRIC_TREE.map(({ category, items }) => (
        <div key={category} className="metric-category">
          <button
            className={`category-toggle ${expanded.has(category) ? 'open' : ''}`}
            onClick={() => toggleCategory(category)}
            aria-expanded={expanded.has(category)}
          >
            <span className="category-arrow">{expanded.has(category) ? '▼' : '▶'}</span>
            {category}
          </button>

          {expanded.has(category) && (
            <ul className="metric-list">
              {items.map(item => (
                <li key={item.name}>
                  <button
                    className={[
                      'metric-item',
                      activeMetric === item.name ? 'active' : '',
                      item.adverse ? 'adverse' : item.special ? 'special-item' : 'positive',
                    ].filter(Boolean).join(' ')}
                    onClick={() => handleItemClick(item)}
                    title={
                      item.special
                        ? item.label
                        : item.adverse
                          ? 'Adverse metric — lower is better'
                          : 'Positive metric — higher is better'
                    }
                  >
                    {!item.special && (
                      <span className="metric-polarity" aria-hidden>
                        {item.adverse ? '↓' : '↑'}
                      </span>
                    )}
                    {item.special && (
                      <span className="metric-polarity" aria-hidden>→</span>
                    )}
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </nav>
  );
}
