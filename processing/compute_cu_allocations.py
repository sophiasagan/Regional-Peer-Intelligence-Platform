"""Compute credit union county-level deposit allocations.

NCUA 5300 data is institution-level (no branch breakdown). This script
allocates each CU's total deposits to their HQ county using the county_name
+ state_code stored during ingestion, resolved to a FIPS code via FDIC
branch data which carries both county_name and county_fips.

Confidence level: "modeled" — single-county HQ allocation is a valid
model for small CUs; multi-branch CUs will have modest geographic error
until NCUA branch-level location data is ingested.

Usage:
    python -m processing.compute_cu_allocations --period 2026Q1
    python -m processing.compute_cu_allocations --all-periods
"""

from __future__ import annotations

import argparse
import logging

import pandas as pd
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert

from db import (
    cu_deposit_allocations,
    fdic_deposits,
    get_engine,
    institutions_quarterly,
)

logger = logging.getLogger(__name__)


# ── County name normalizer ────────────────────────────────────────────────────

def _norm(name: str | None) -> str:
    """Lowercase, strip whitespace and common suffixes for fuzzy matching.

    'GENESEE'  → 'genesee'
    'Genesee County' → 'genesee'
    """
    if not name:
        return ""
    return (
        name.lower()
        .strip()
        .removesuffix(" county")
        .removesuffix(" parish")   # Louisiana
        .removesuffix(" borough")  # Alaska
        .removesuffix(" census area")
        .strip()
    )


# ── FIPS lookup builder ───────────────────────────────────────────────────────

def _build_fips_lookup(year: int, engine) -> dict[tuple[str, str], str]:
    """Build (state_code, normalized_county_name) → county_fips from FDIC data.

    FDIC branch data covers essentially every county in the US that has any
    bank branch, which is nearly universal. Counties with no FDIC data (very
    rural areas) won't appear in the lookup and those CUs will be skipped.
    """
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT DISTINCT state_code, county_name, county_fips "
                "FROM fdic_deposits "
                "WHERE year = :year AND county_fips IS NOT NULL AND county_name IS NOT NULL"
            ),
            {"year": year},
        ).mappings().all()

    lookup: dict[tuple[str, str], str] = {}
    for row in rows:
        key = (row["state_code"], _norm(row["county_name"]))
        if key not in lookup:
            lookup[key] = row["county_fips"]

    logger.info("Built FIPS lookup: %d county entries from FDIC %d data", len(lookup), year)
    return lookup


# ── Per-period allocation ─────────────────────────────────────────────────────

def allocate_for_period(period: str, db_url: str | None = None) -> int:
    """Compute and upsert CU deposit allocations for a single period.

    Returns number of rows written.
    """
    year = int(period[:4])
    engine = get_engine(db_url)

    # ── Fetch CU institutions ──────────────────────────────────────────────────
    with engine.connect() as conn:
        cu_rows = conn.execute(
            select(
                institutions_quarterly.c.charter_number,
                institutions_quarterly.c.institution_name,
                institutions_quarterly.c.state_code,
                institutions_quarterly.c.county_name,
                institutions_quarterly.c.acct_018,   # total shares + deposits
            ).where(
                institutions_quarterly.c.period == period,
                institutions_quarterly.c.acct_018.isnot(None),
                institutions_quarterly.c.acct_018 > 0,
                institutions_quarterly.c.state_code.isnot(None),
            )
        ).mappings().all()

    if not cu_rows:
        logger.warning("No CU institutions found for period %s", period)
        return 0

    cu_df = pd.DataFrame(cu_rows)
    logger.info("Loaded %d CU institutions for %s", len(cu_df), period)

    # ── Build county FIPS lookup ───────────────────────────────────────────────
    # Try the exact year first; fall back to the nearest year with FDIC data.
    fips_lookup = _build_fips_lookup(year, engine)
    if not fips_lookup:
        # Try prior year (FDIC SOD is annual, may not yet be ingested for current year)
        fips_lookup = _build_fips_lookup(year - 1, engine)
    if not fips_lookup:
        logger.error(
            "No FDIC data found for %d or %d — ingest FDIC data first: "
            "python -m ingestion.fdic_ingester --year %d",
            year, year - 1, year - 1,
        )
        return 0

    # ── Match CU counties to FIPS ──────────────────────────────────────────────
    alloc_rows: list[dict] = []
    unmatched = 0

    for _, cu in cu_df.iterrows():
        state    = cu["state_code"]
        raw_name = cu.get("county_name") or ""
        fips     = fips_lookup.get((state, _norm(raw_name)))

        if not fips:
            unmatched += 1
            logger.debug(
                "No FIPS match: charter %s, county '%s', state %s",
                cu["charter_number"], raw_name, state,
            )
            continue

        alloc_rows.append({
            "charter_number":     int(cu["charter_number"]),
            "period":             period,
            "county_fips":        fips,
            "institution_name":   cu["institution_name"],
            "allocated_deposits": int(cu["acct_018"]),
            "confidence_level":   "modeled",
            "weight_method":      "hq_county",
        })

    matched = len(alloc_rows)
    logger.info(
        "Period %s: matched %d/%d CUs to county FIPS (%d unmatched)",
        period, matched, len(cu_df), unmatched,
    )

    if not alloc_rows:
        return 0

    # ── Upsert into cu_deposit_allocations ────────────────────────────────────
    batch_size = 500
    total_written = 0
    for i in range(0, len(alloc_rows), batch_size):
        batch = alloc_rows[i : i + batch_size]
        stmt = pg_insert(cu_deposit_allocations).values(batch)
        stmt = stmt.on_conflict_do_update(
            index_elements=["charter_number", "period", "county_fips"],
            set_={
                "institution_name":   stmt.excluded.institution_name,
                "allocated_deposits": stmt.excluded.allocated_deposits,
                "confidence_level":   stmt.excluded.confidence_level,
                "weight_method":      stmt.excluded.weight_method,
                "computed_at":        text("NOW()"),
            },
        )
        with engine.begin() as conn:
            conn.execute(stmt)
        total_written += len(batch)

    logger.info("Upserted %d rows into cu_deposit_allocations for %s", total_written, period)
    return total_written


# ── All-periods mode ──────────────────────────────────────────────────────────

def _all_periods(db_url: str | None = None) -> list[str]:
    """Return all distinct periods present in institutions_quarterly."""
    engine = get_engine(db_url)
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT DISTINCT period FROM institutions_quarterly ORDER BY period")
        ).fetchall()
    return [r[0] for r in rows]


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Compute CU county deposit allocations")
    grp = parser.add_mutually_exclusive_group(required=True)
    grp.add_argument("--period", help="Single period, e.g. 2026Q1")
    grp.add_argument("--all-periods", action="store_true", help="Process all ingested periods")
    args = parser.parse_args()

    import os
    db_url = os.environ.get("DATABASE_URL")

    if args.all_periods:
        periods = _all_periods(db_url)
        logger.info("Processing %d periods: %s", len(periods), periods)
        total = sum(allocate_for_period(p, db_url) for p in periods)
        logger.info("Done. Total rows written: %d", total)
    else:
        n = allocate_for_period(args.period, db_url)
        logger.info("Done. Rows written: %d", n)


if __name__ == "__main__":
    main()
