"""Shared SQLAlchemy table definitions and engine factory.

All layers (ingestion, processing, API) import from here.
Set DATABASE_URL to a PostgreSQL connection string before running.
"""

from __future__ import annotations

import os

from sqlalchemy import (
    ARRAY, BigInteger, Boolean, Column, DateTime, Float, Integer, MetaData,
    String, Table, Text, UniqueConstraint, create_engine, func,
)
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.engine import Engine

metadata = MetaData()

institutions_quarterly = Table(
    "institutions_quarterly",
    metadata,
    Column("charter_number", Integer, primary_key=True),
    Column("period", String(8), primary_key=True),   # "2026Q1"
    Column("institution_name", String(255)),
    Column("state_code", String(2)),
    Column("county_name", String(100)),
    # Balance sheet
    Column("acct_010", BigInteger),     # total assets
    Column("acct_018", BigInteger),     # total shares and deposits
    Column("acct_025B", BigInteger),    # total loans and leases
    Column("acct_797", BigInteger),     # total net worth
    Column("acct_998", Float),          # net worth ratio (NCUA-supplied)
    # Members
    Column("acct_083", Integer),        # number of current members
    # Delinquency buckets
    Column("acct_020B", BigInteger),    # 30-59 day delinquent
    Column("acct_DL0141", BigInteger),  # 60-89 day delinquent
    Column("acct_021B", BigInteger),    # 90-179 day delinquent
    Column("acct_022B", BigInteger),    # 180-359 day delinquent
    Column("acct_023B", BigInteger),    # 360+ day delinquent
    Column("acct_041B", BigInteger),    # total 60+ day delinquent balance
    Column("acct_041A", Integer),       # total 60+ day delinquent count
    Column("acct_041D", BigInteger),    # 60+ day delinquent fixed-rate 1st mortgage (FS220A)
    Column("acct_041E", BigInteger),    # 60+ day delinquent ARM 1st mortgage (FS220A)
    Column("acct_041F", BigInteger),    # 60+ day delinquent other 1st mortgage (FS220A)
    # Non-accrual
    Column("acct_DL0145", BigInteger),  # non-commercial non-accrual
    Column("acct_DL0146", BigInteger),  # commercial non-accrual
    # Charge-offs (YTD)
    Column("acct_550", BigInteger),     # total gross charge-offs
    Column("acct_551", BigInteger),     # total recoveries
    Column("acct_680", BigInteger),     # credit card charge-offs
    Column("acct_550C1", BigInteger),   # new vehicle charge-offs
    Column("acct_550C2", BigInteger),   # used vehicle charge-offs
    # Allowances
    Column("acct_AS0048", BigInteger),  # ACL on loans (CECL institutions)
    Column("acct_719", BigInteger),     # ALLL (pre-CECL institutions)
    # Income statement
    Column("acct_115", BigInteger),     # total interest income
    Column("acct_IS0010", BigInteger),  # net interest income
    Column("acct_IS0017", BigInteger),  # total credit loss expense (CECL)
    Column("acct_117", BigInteger),     # total non-interest income
    Column("acct_671", BigInteger),     # total non-interest expense
    Column("acct_661A", BigInteger),    # net income
    # Capital
    Column("acct_RB0172", Float),       # risk-based capital ratio
    # TDR / loan modifications (FS220H)
    Column("acct_1001F", BigInteger),   # total TDR / modifications outstanding
    # Loan composition (from FS220A)
    Column("acct_396", BigInteger),     # credit card loans
    Column("acct_385", BigInteger),     # new vehicle loans
    Column("acct_370", BigInteger),     # used vehicle loans
    Column("acct_703A", BigInteger),    # 1st lien RE loans
    Column("acct_386A", BigInteger),    # junior lien RE loans
    Column("acct_718A5", BigInteger),   # commercial RE secured
    Column("acct_400P", BigInteger),    # commercial not RE
    Column("acct_618A", BigInteger),    # total indirect loans
    Column("acct_002", BigInteger),     # leases receivable balance (FS220A Sched A Sec1 Row7 confirmed)
    # Per-product delinquency totals (60+ day balances) — confirmed from Dort Q1 2026 Schedule A Sec2:
    # acct_041D=leases (Row7), acct_041E=junior lien RE (Row10), acct_DL0062=1st lien RE (Row9)
    Column("acct_DL0062", BigInteger),  # 1st lien RE 60+ day delinquent (Sched A Sec2 Row 9)
    Column("acct_041I", BigInteger),    # total delinquent indirect loans (FS220B)
    Column("acct_045B", BigInteger),    # total delinquent credit card loans (FS220B)
    Column("acct_752", BigInteger),     # fixed rate 1st mortgage 60-179 day delinq (FS220B)
    Column("acct_753", BigInteger),     # fixed rate 1st mortgage 180-359 day delinq (FS220B)
    Column("acct_754", BigInteger),     # fixed rate 1st mortgage 360+ day delinq (FS220B)
    Column("acct_041C1", BigInteger),   # total delinquent new vehicle loans (FS220I)
    Column("acct_041C2", BigInteger),   # total delinquent used vehicle loans (FS220I)
    Column("acct_041G1", BigInteger),   # total delinquent member business RE loans (FS220I)
    Column("acct_041G2", BigInteger),   # total delinquent member business non-RE loans (FS220I)
    Column("acct_041G3", BigInteger),   # total delinquent member commercial RE loans (FS220L)
    Column("acct_041G4", BigInteger),   # total delinquent member commercial non-RE loans (FS220L)
    Column("acct_041P1", BigInteger),   # total delinquent nonmember business RE loans (FS220I)
    Column("acct_041P2", BigInteger),   # total delinquent nonmember business non-RE loans (FS220I)
    Column("acct_041P3", BigInteger),   # total delinquent nonmember commercial RE loans (FS220L)
    Column("acct_041P4", BigInteger),   # total delinquent nonmember commercial non-RE loans (FS220L)
    Column("ingested_at", DateTime, server_default=func.now()),
)

fdic_deposits = Table(
    "fdic_deposits",
    metadata,
    Column("fdic_cert", Integer, nullable=False),
    Column("year", Integer, nullable=False),
    Column("branch_name", String(255)),
    Column("institution_name", String(255)),
    Column("branch_address", String(255)),
    Column("branch_city", String(100)),
    Column("state_code", String(2)),
    Column("branch_zip", String(10)),
    Column("county_name", String(100)),
    Column("county_fips", String(5)),
    Column("latitude", Float),
    Column("longitude", Float),
    Column("deposits", BigInteger),
    Column("ingested_at", DateTime, server_default=func.now()),
    UniqueConstraint("fdic_cert", "year", "branch_name", name="uq_fdic_branch_year"),
)

hmda_originations = Table(
    "hmda_originations",
    metadata,
    Column("year", Integer, primary_key=True),
    Column("respondent_id", String(20), primary_key=True),
    Column("county_fips", String(5), primary_key=True),
    Column("loan_purpose", Integer, primary_key=True),
    Column("state_code", String(2)),
    Column("origination_count", Integer),
    Column("origination_volume", BigInteger),
    Column("ingested_at", DateTime, server_default=func.now()),
)

census_demographics = Table(
    "census_demographics",
    metadata,
    Column("county_fips", String(5), primary_key=True),
    Column("year", Integer, primary_key=True),
    Column("county_name", String(100)),
    Column("state_code", String(2)),
    Column("total_population", Integer),
    Column("median_household_income", Integer),
    Column("total_housing_units", Integer),
    Column("median_age", Float),
    Column("labor_force", Integer),
    Column("unemployed", Integer),
    Column("ingested_at", DateTime, server_default=func.now()),
)

peer_groups = Table(
    "peer_groups",
    metadata,
    Column("id", String(36), primary_key=True),   # UUID stored as text
    Column("tenant_id", String(36)),
    Column("group_name", Text),
    Column("group_type", String(50)),              # callahan_national | regional | custom
    Column("asset_tier", String(50)),
    Column("geography_type", String(20)),          # state | county | msa | national
    Column("institution_ids", ARRAY(Text)),
    Column("is_default", Boolean, server_default="false"),
    Column("created_at", DateTime, server_default=func.now()),
)

peer_distributions = Table(
    "peer_distributions",
    metadata,
    Column("metric", String(100), primary_key=True),
    Column("peer_group_type", String(20), primary_key=True),
    Column("period", String(8), primary_key=True),
    Column("p10", Float),
    Column("p25", Float),
    Column("p50", Float),
    Column("p75", Float),
    Column("p90", Float),
    Column("institution_count", Integer),
    Column("computed_at", DateTime, server_default=func.now()),
)


cu_deposit_allocations = Table(
    "cu_deposit_allocations",
    metadata,
    Column("charter_number", Integer, nullable=False),
    Column("period", String(8), nullable=False),        # YYYYQ#
    Column("county_fips", String(5), nullable=False),
    Column("institution_name", String(255)),
    Column("allocated_deposits", BigInteger),
    Column("confidence_level", String(20), server_default="'modeled'"),
    Column("weight_method", String(20)),                # 'hq_county' | 'fdic_proxy' | 'equal'
    Column("computed_at", DateTime, server_default=func.now()),
    UniqueConstraint("charter_number", "period", "county_fips", name="uq_cu_alloc"),
)


hmda_respondents = Table(
    "hmda_respondents",
    metadata,
    Column("respondent_id", String(20), primary_key=True),  # LEI (post-2018)
    Column("respondent_name", Text),
    Column("institution_type", String(10)),   # "bank" | "cu" | "nonbank"
    Column("respondent_city", String(100)),
    Column("respondent_state", String(2)),
    Column("fetched_at", DateTime, server_default=func.now()),
)


def get_engine(db_url: str | None = None) -> Engine:
    url = db_url or os.environ.get("DATABASE_URL")
    if not url:
        raise ValueError("DATABASE_URL environment variable not set")
    return create_engine(url, pool_pre_ping=True)


def create_all_tables(db_url: str | None = None) -> None:
    """Create all tables if they don't exist. Run once on first deploy."""
    engine = get_engine(db_url)
    metadata.create_all(engine)
