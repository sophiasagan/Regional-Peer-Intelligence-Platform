/**
 * Single source of truth for metric categorization.
 * Consumed by:
 *   - PeerComparisonTable.jsx  → section grouping + CSV category column
 *   - CreditQuality.jsx        → filter for embedded peer table
 *
 * When METRIC_LABELS in api/routers/peer_comparison.py gains new keys,
 * add them here and they'll automatically appear on the correct page.
 */

export const METRIC_CATEGORIES = [
  {
    key: 'balance_sheet',
    label: 'Balance Sheet & Growth',
    metrics: [
      'acct_010',
      'acct_025B',
      'acct_018',
      'acct_083',
      'loan_growth_rate',
      'share_growth_rate',
      'asset_growth_rate',
      'member_growth_rate',
    ],
  },
  {
    key: 'asset_quality',
    label: 'Asset Quality',
    metrics: [
      'delinq_rate_total',
      'delinq_rate_90plus',
      'chargeoff_rate_total_annualized',
      'non_accrual_rate',
      'tdr_to_loans',
      'delinq_rate_cc',
      'delinq_rate_auto',
      'delinq_rate_1st_mortgage',
      'delinq_rate_nonfarm_nonre',
      'delinq_rate_commercial_re',
    ],
  },
  {
    key: 'capital_adequacy',
    label: 'Capital Adequacy',
    metrics: [
      'alll_coverage',
      'alll_to_loans',
      'net_worth_ratio',
      'rbc_ratio',
    ],
  },
  {
    key: 'earnings',
    label: 'Earnings & Efficiency',
    metrics: [
      'roa_annualized',
      'nim',
      'efficiency_ratio',
      'loan_to_share',
    ],
  },
];

// CreditQuality embedded table: Asset Quality + Capital Adequacy only.
// Derived here so it stays in sync with METRIC_CATEGORIES automatically.
export const CQ_PEER_METRIC_KEYS = new Set([
  ...METRIC_CATEGORIES.find(c => c.key === 'asset_quality').metrics,
  ...METRIC_CATEGORIES.find(c => c.key === 'capital_adequacy').metrics,
]);

// metric_name → category label — used in CSV export Category column
export const METRIC_TO_CATEGORY = Object.fromEntries(
  METRIC_CATEGORIES.flatMap(cat => cat.metrics.map(m => [m, cat.label])),
);
