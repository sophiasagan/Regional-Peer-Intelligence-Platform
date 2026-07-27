# cu_market_intelligence — Codex Context
# P76: Regional Market Intelligence Platform
# Version 2.0 — Consolidated from all spec documents
 
## What this project is
Multi-tenant SaaS: NCUA 5300 + FDIC Summary of Deposits + HMDA + Census ACS
→ market share by county/MSA/state + portfolio quality peer comparison
+ regional peer intelligence + AI-native query interface + automated reports.
 
Reference institution: Dort Financial Credit Union, Charter 68708
Q1 2026 5300 filing (period ending March 31, 2026, certified 4/27/2026)
Total assets: $2,461,726,014 | Members: 121,009 | Net worth ratio: 10.22%
 
## Commands
- Ingest NCUA:    python -m ingestion.ncua_ingester --year 2024 --quarter 4
- Ingest FDIC:    python -m ingestion.fdic_ingester --year 2023
- Ingest HMDA:    python -m ingestion.hmda_ingester --year 2023
- Peer dists:     python -m processing.compute_peer_distributions --period 2026Q1
- Run API:        uvicorn api.main:app --reload
- Run frontend:   cd frontend && npm run dev
- Run scheduler:  python -m ingestion.scheduler
 
## Callahan UX parity rules — NEVER violate
- Use Callahan's exact metric names in all user-facing text
- Top decile = green badge, Bottom decile = red badge (exact Callahan convention)
- Percentile stars: 1 star = bottom <10%, 5 stars = top 90%+ (Callahan scale)
- Period default: 3 years / 12 quarters
- Every chart has an Excel/CSV download button — non-negotiable
- Always show peer group label on every chart
 
## P76 exclusive features — always available, clearly labeled
- Regional peer group toggle: always visible in peer group selector
- Signal separator: shows below every delinquency/charge-off chart
  Label: "Is this a you-problem or a market-problem?"
- Early warning panel: auto-expands above charts if any alert level detected
  Label: "Know before your examiner does"
- PeerBandChart: the ONLY chart type — replaces all others
  Regional peer line = purple dashed (labeled "Regional peers")
- Callahan migration flow: accessible from onboarding and settings
 
## Multi-tenancy
Every API endpoint filters by tenant_id from JWT.
Never cross-contaminate tenant data.
Tenants only see institutions in their subscribed geographies.
 
## Confidence levels (display on EVERY geographic figure)
measured:  FDIC branch-level data — highest confidence — teal badge
modeled:   estimation model allocation, ±8% validated — blue badge
estimated: proxy-based — amber badge — flag for user attention
 
## Delinquency data rules
- All delinquency figures are institution-level (not branch-level)
- Confidence for delinquency: always "measured" — no geographic allocation needed
- Default peer group: REGIONAL (same state + geography) — not national asset-size
- Always display BOTH dollar balance AND computed rate
- Delinquency is ADVERSE: lower value = better = higher stars
 
## Computed ratios — calculated on the fly, never stored
delinq_rate_total = acct_041B / acct_025B
chargeoff_rate_total_annualized = (acct_550 - acct_551) / acct_025B * 4
alll_coverage = acct_AS0048 / acct_041B
alll_to_loans = acct_AS0048 / acct_025B
nwratio = acct_997 / acct_010
efficiency_ratio = acct_671 / (acct_IS0010 + acct_117)
roa_annualized = acct_661A / acct_010 * 4
 
## Metric polarity (critical for color coding and star assignment)
ADVERSE (high = worse = lower stars = red if top pctile):
  delinq_rate_*, chargeoff_rate_*, efficiency_ratio,
  oreo_to_assets, non_accrual_rate, tdr_to_loans, operating_expense_ratio,
  credit_loss_expense_to_loans, borrowings_to_assets
 
POSITIVE (high = better = higher stars = green if top pctile):
  ROA, ROE, NIM, net_worth_ratio, rbc_ratio, alll_coverage_ratio,
  member_growth_rate, fee_income_to_assets
 
## Key NCUA account codes (NCUA 5300 Version 2025.1)
010    = TOTAL ASSETS
025B   = TOTAL LOANS AND LEASES
AS0048 = ACL on loans (CECL institutions — replaces 719)
719    = ALLL (pre-CECL institutions)
041B   = Total 60+ day delinquent loans (balance)
041A   = Total 60+ day delinquent loans (count)
020B   = 30-59 day delinquent total
DL0141 = 60-89 day delinquent total
021B   = 90-179 day delinquent total
022B   = 180-359 day delinquent total
023B   = 360+ day delinquent total
550    = Total gross charge-offs YTD
551    = Total recoveries YTD
797    = Total net worth
998    = Net worth ratio
RB0172 = Risk-based capital ratio
115    = Total interest income
IS0010 = Net interest income
IS0017 = Total credit loss expense (CECL)
117    = Total non-interest income
671    = Total non-interest expense
661A   = Net income
083    = Number of current members
018    = Total shares and deposits
 
## Alert thresholds (configurable per tenant, defaults)
total_delinq_rate: 1.5%
auto_delinq_rate: 2.0%
credit_card_delinq_rate: 3.5%
commercial_delinq_rate: 1.0%
alll_coverage_min: 1.0x (below = red alert)
charge_off_acceleration: >25% QoQ increase = alert
 
## NCUA field names may change between form versions
Always verify current column names against the NCUA data dictionary before ingestion.
Field mapping maintained in ingestion/ncua_ingester.py NCUA_FIELD_MAP dict.
NCUA 5300 Version 2025.1 (current as of the Dort Financial Q1 2026 reference filing)
 
## NL query vocabulary
When a user uses Callahan metric names, map using CALLAHAN_TO_P76_METRIC_MAP
in api/routers/query.py. Always confirm which metric was used in the response.

## Database Schema
-- Core institution data: one row per institution per quarter
CREATE TABLE institutions_quarterly (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  charter_number TEXT NOT NULL,
  period TEXT NOT NULL,           -- YYYYQ# format
  -- Identity
  institution_name TEXT, state TEXT, asset_tier TEXT,
  -- Balance sheet (raw account codes)
  acct_010 DECIMAL,               -- TOTAL ASSETS
  acct_025B DECIMAL,              -- TOTAL LOANS AND LEASES
  acct_AS0048 DECIMAL,            -- ACL on loans (CECL)
  acct_018 DECIMAL,               -- TOTAL SHARES AND DEPOSITS
  acct_013 DECIMAL,               -- Member shares
  acct_997 DECIMAL,               -- TOTAL NET WORTH
  acct_998 DECIMAL,               -- Net worth ratio
  acct_RB0172 DECIMAL,            -- Risk-based capital ratio
  acct_798A DECIMAL,              -- OREO total
  acct_083 INTEGER,               -- Member count
  -- Income statement
  acct_115 DECIMAL,               -- Total interest income
  acct_IS0010 DECIMAL,            -- Net interest income
  acct_IS0017 DECIMAL,            -- Total credit loss expense (CECL)
  acct_117 DECIMAL,               -- Total non-interest income
  acct_671 DECIMAL,               -- Total non-interest expense
  acct_661A DECIMAL,              -- Net income
  -- Delinquency (Schedule A Section 2 — all buckets, all types)
  acct_041B DECIMAL,              -- Total 60+ day delinquent loans
  acct_020B DECIMAL,              -- 30-59 day total
  acct_DL0141 DECIMAL,            -- 60-89 day total
  acct_021B DECIMAL,              -- 90-179 day total
  acct_022B DECIMAL,              -- 180-359 day total
  acct_023B DECIMAL,              -- 360+ day total
  acct_DL0145 DECIMAL,            -- Non-commercial non-accrual
  acct_DL0146 DECIMAL,            -- Commercial non-accrual
  acct_1001F DECIMAL,             -- TDR / Modifications balance
  -- Charge-offs (Schedule A Section 3)
  acct_550 DECIMAL,               -- Total gross charge-offs YTD
  acct_551 DECIMAL,               -- Total recoveries YTD
  acct_680 DECIMAL,               -- CC charge-offs
  acct_550C1 DECIMAL,             -- New vehicle charge-offs
  acct_550C2 DECIMAL,             -- Used vehicle charge-offs
  -- Loan composition (Schedule A Section 1)
  acct_396 DECIMAL,               -- Credit card loans
  acct_385 DECIMAL,               -- New vehicle loans
  acct_370 DECIMAL,               -- Used vehicle loans
  acct_703A DECIMAL,              -- 1st lien RE
  acct_386A DECIMAL,              -- Junior lien RE
  acct_718A5 DECIMAL,             -- Commercial RE secured
  acct_400P DECIMAL,              -- Commercial not RE
  acct_618A DECIMAL,              -- Total indirect loans
  -- Share composition (Schedule D)
  acct_902 DECIMAL,               -- Share drafts
  acct_657 DECIMAL,               -- Regular shares
  acct_911 DECIMAL,               -- Money market
  acct_908C DECIMAL,              -- Share certificates
  -- Store ALL other account codes as JSONB for completeness
  all_accounts JSONB,
  ingested_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (charter_number, period)
);
 
-- Peer distributions: precomputed quarterly, used for all comparison views
CREATE TABLE peer_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key TEXT NOT NULL,       -- account code or computed ratio name
  is_computed BOOLEAN DEFAULT FALSE,
  formula TEXT,                   -- SQL expression for computed ratios
  period TEXT NOT NULL,
  peer_group_id UUID,
  n_peers INTEGER,
  p10 DECIMAL, p25 DECIMAL, median DECIMAL, p75 DECIMAL, p90 DECIMAL,
  mean DECIMAL, std_dev DECIMAL,
  computed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (metric_key, period, peer_group_id)
);
 
-- Geographic peer groups (Callahan-style and regional)
CREATE TABLE peer_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  group_name TEXT, group_type TEXT,  -- callahan_national | regional | custom
  asset_tier TEXT,
  geography_type TEXT,               -- state | county | msa | national
  geography_ids TEXT[], institution_ids TEXT[],
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
 
-- Early warning signals (computed quarterly)
CREATE TABLE early_warning_signals (
  charter_number TEXT, period TEXT, metric TEXT,
  acceleration_ratio DECIMAL, trend_status TEXT,
  peer_divergence_score DECIMAL, divergence_pattern TEXT,
  alert_level TEXT,   -- watch | alert | urgent | none
  quarters_to_threshold INTEGER, threshold_value DECIMAL,
  computed_at TIMESTAMP DEFAULT NOW()
);

