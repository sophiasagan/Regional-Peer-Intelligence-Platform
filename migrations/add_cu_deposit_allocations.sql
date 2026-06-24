-- Migration: add cu_deposit_allocations table
-- Run once: python -c "
--   import os, psycopg2
--   conn = psycopg2.connect(os.environ['DATABASE_URL'])
--   cur = conn.cursor()
--   cur.execute(open('migrations/add_cu_deposit_allocations.sql').read())
--   conn.commit(); conn.close()
-- "

CREATE TABLE IF NOT EXISTS cu_deposit_allocations (
    charter_number   INTEGER      NOT NULL,
    period           VARCHAR(8)   NOT NULL,   -- YYYYQ# e.g. 2026Q1
    county_fips      VARCHAR(5)   NOT NULL,
    institution_name VARCHAR(255),
    allocated_deposits BIGINT,
    confidence_level VARCHAR(20)  DEFAULT 'modeled',
    weight_method    VARCHAR(20),             -- hq_county | fdic_proxy | equal
    computed_at      TIMESTAMP    DEFAULT NOW(),
    PRIMARY KEY (charter_number, period, county_fips)
);

CREATE INDEX IF NOT EXISTS idx_cu_alloc_county_period
    ON cu_deposit_allocations (county_fips, period);

CREATE INDEX IF NOT EXISTS idx_cu_alloc_charter_period
    ON cu_deposit_allocations (charter_number, period);
