-- Migration: add per-product delinquency and loan composition columns
-- Run once against the production database.
-- Safe to re-run: each ADD COLUMN uses IF NOT EXISTS.

ALTER TABLE institutions_quarterly
  -- Loan composition (from FS220A)
  ADD COLUMN IF NOT EXISTS acct_396    BIGINT,   -- credit card loans
  ADD COLUMN IF NOT EXISTS acct_385    BIGINT,   -- new vehicle loans
  ADD COLUMN IF NOT EXISTS acct_370    BIGINT,   -- used vehicle loans
  ADD COLUMN IF NOT EXISTS "acct_703A" BIGINT,   -- 1st lien RE loans
  ADD COLUMN IF NOT EXISTS "acct_386A" BIGINT,   -- junior lien RE loans
  ADD COLUMN IF NOT EXISTS "acct_718A5" BIGINT,  -- commercial RE secured
  ADD COLUMN IF NOT EXISTS "acct_400P" BIGINT,   -- commercial not RE
  ADD COLUMN IF NOT EXISTS "acct_618A" BIGINT,   -- total indirect loans
  -- Per-product delinquency totals (60+ day balances)
  ADD COLUMN IF NOT EXISTS "acct_045B" BIGINT,   -- total delinquent credit card (FS220B)
  ADD COLUMN IF NOT EXISTS acct_752    BIGINT,   -- fixed rate 1st mortgage 60-179 day (FS220B)
  ADD COLUMN IF NOT EXISTS acct_753    BIGINT,   -- fixed rate 1st mortgage 180-359 day (FS220B)
  ADD COLUMN IF NOT EXISTS acct_754    BIGINT,   -- fixed rate 1st mortgage 360+ day (FS220B)
  ADD COLUMN IF NOT EXISTS "acct_041C1" BIGINT,  -- total delinquent new vehicle (FS220I)
  ADD COLUMN IF NOT EXISTS "acct_041C2" BIGINT,  -- total delinquent used vehicle (FS220I)
  ADD COLUMN IF NOT EXISTS "acct_041G1" BIGINT,  -- total delinquent member business RE (FS220I)
  ADD COLUMN IF NOT EXISTS "acct_041G2" BIGINT,  -- total delinquent member business non-RE (FS220I)
  ADD COLUMN IF NOT EXISTS "acct_041G3" BIGINT,  -- total delinquent member commercial RE (FS220L)
  ADD COLUMN IF NOT EXISTS "acct_041G4" BIGINT,  -- total delinquent member commercial non-RE (FS220L)
  ADD COLUMN IF NOT EXISTS "acct_041P1" BIGINT,  -- total delinquent nonmember business RE (FS220I)
  ADD COLUMN IF NOT EXISTS "acct_041P2" BIGINT,  -- total delinquent nonmember business non-RE (FS220I)
  ADD COLUMN IF NOT EXISTS "acct_041P3" BIGINT,  -- total delinquent nonmember commercial RE (FS220L)
  ADD COLUMN IF NOT EXISTS "acct_041P4" BIGINT,  -- total delinquent nonmember commercial non-RE (FS220L)
  -- TDR / loan modifications (FS220H)
  ADD COLUMN IF NOT EXISTS "acct_1001F" BIGINT;  -- total TDR / modifications outstanding
