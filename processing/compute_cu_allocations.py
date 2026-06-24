"""Compute credit union county-level deposit allocations.

NCUA 5300 data is institution-level (no branch breakdown). This script
allocates each CU's total deposits to their HQ county using three strategies
in priority order:

  1. county_name is a 5-digit numeric FIPS → use directly
  2. county_name is a 1-3 digit numeric code → prepend state FIPS prefix
     (NCUA FOICU.txt COUNTY_CODE field stores the 3-digit county sub-code)
  3. county_name is a text name → fuzzy-match via FDIC county name→FIPS lookup

Falls back to state-level proportional allocation (FDIC county weights within
the state) for any CU that can't be resolved by the above.

Confidence: "modeled" for county-matched rows, "estimated" for state-allocated.

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

# Census state FIPS codes by 2-char abbreviation
_STATE_FIPS: dict[str, str] = {
    'AL': '01', 'AK': '02', 'AZ': '04', 'AR': '05', 'CA': '06', 'CO': '08',
    'CT': '09', 'DE': '10', 'DC': '11', 'FL': '12', 'GA': '13', 'HI': '15',
    'ID': '16', 'IL': '17', 'IN': '18', 'IA': '19', 'KS': '20', 'KY': '21',
    'LA': '22', 'ME': '23', 'MD': '24', 'MA': '25', 'MI': '26', 'MN': '27',
    'MS': '28', 'MO': '29', 'MT': '30', 'NE': '31', 'NV': '32', 'NH': '33',
    'NJ': '34', 'NM': '35', 'NY': '36', 'NC': '37', 'ND': '38', 'OH': '39',
    'OK': '40', 'OR': '41', 'PA': '42', 'RI': '44', 'SC': '45', 'SD': '46',
    'TN': '47', 'TX': '48', 'UT': '49', 'VT': '50', 'VA': '51', 'WA': '53',
    'WV': '54', 'WI': '55', 'WY': '56', 'PR': '72', 'VI': '78', 'GU': '66',
    'AS': '60', 'MP': '69',
}


# ── County name normalizer ────────────────────────────────────────────────────

def _norm(name: str | None) -> str:
    """Lowercase, strip whitespace and common suffixes for name-based matching."""
    if not name:
        return ""
    return (
        name.lower()
        .strip()
        .removesuffix(" county")
        .removesuffix(" parish")
        .removesuffix(" borough")
        .removesuffix(" census area")
        .strip()
    )


# ── Multi-strategy FIPS resolution ────────────────────────────────────────────

def _resolve_fips(
    state_code: str,
    county_raw: str | None,
    name_lookup: dict[tuple[str, str], str],
) -> str | None:
    """Resolve a single CU's county FIPS using three strategies.

    Strategy 1 — 5-digit numeric: NCUA stored the full FIPS directly.
    Strategy 2 — 1-3 digit numeric: NCUA COUNTY_CODE (3-digit sub-code);
                 prepend the state FIPS prefix.
    Strategy 3 — text name: normalize and look up in FDIC county name→FIPS map.
    """
    val = (county_raw or "").strip()
    if not val:
        return None

    # Strategy 1: direct 5-digit FIPS
    if val.isdigit() and len(val) == 5:
        return val

    # Strategy 2: 3-digit (or shorter) county sub-code → prepend state FIPS
    if val.isdigit() and len(val) <= 3:
        state_fips = _STATE_FIPS.get(state_code, "")
        if state_fips:
            return state_fips + val.zfill(3)

    # Strategy 3: text county name via FDIC lookup
    normalized = _norm(val)
    if normalized:
        return name_lookup.get((state_code, normalized))

    return None


# ── FIPS lookup builder (name-based, strategy 3) ─────────────────────────────

def _build_name_lookup(year: int, engine) -> dict[tuple[str, str], str]:
    """Build (state_code, normalized_county_name) → county_fips from FDIC data."""
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
        if key and key not in lookup:
            lookup[key] = row["county_fips"]

    logger.info("Built name→FIPS lookup: %d entries from FDIC %d", len(lookup), year)
    return lookup


# ── State-level proportional fallback ────────────────────────────────────────

def _build_state_weights(fdic_year: int, engine) -> dict[str, list[tuple[str, float]]]:
    """Build {state_code: [(county_fips, weight), ...]} from FDIC deposit data.

    Used as fallback for CUs whose county can't be identified — their deposits
    get distributed across all counties in their state proportionally to FDIC
    bank deposit shares within that state.
    """
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT state_code, county_fips, SUM(deposits) AS state_county_deposits "
                "FROM fdic_deposits "
                "WHERE year = :year AND county_fips IS NOT NULL "
                "GROUP BY state_code, county_fips"
            ),
            {"year": fdic_year},
        ).mappings().all()

    from collections import defaultdict
    raw: dict[str, list] = defaultdict(list)
    for row in rows:
        raw[row["state_code"]].append((row["county_fips"], float(row["state_county_deposits"] or 0)))

    weights: dict[str, list[tuple[str, float]]] = {}
    for state, pairs in raw.items():
        total = sum(d for _, d in pairs)
        if total > 0:
            weights[state] = [(fips, dep / total) for fips, dep in pairs]

    logger.info("Built state-level weights for %d states (fallback allocation)", len(weights))
    return weights


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
                institutions_quarterly.c.acct_018,
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

    # ── Get FDIC year (fall back if current year not ingested yet) ─────────────
    fdic_year = year
    name_lookup: dict[tuple[str, str], str] = {}
    for try_year in [year, year - 1, year - 2]:
        name_lookup = _build_name_lookup(try_year, engine)
        if name_lookup:
            fdic_year = try_year
            break

    if not name_lookup:
        logger.error(
            "No FDIC data found for %d, %d, or %d — ingest FDIC data first: "
            "python -m ingestion.fdic_ingester --year %d",
            year, year - 1, year - 2, year - 1,
        )
        return 0

    state_weights = _build_state_weights(fdic_year, engine)

    # ── Resolve each CU to county FIPS ────────────────────────────────────────
    alloc_rows: list[dict] = []
    n_exact   = 0
    n_fallback = 0
    n_failed  = 0

    for _, cu in cu_df.iterrows():
        state      = cu["state_code"]
        county_raw = cu.get("county_name")
        if pd.isna(county_raw):
            county_raw = None
        deposits   = int(cu["acct_018"])

        fips = _resolve_fips(state, county_raw, name_lookup)

        if fips:
            # Strategies 1-3 succeeded: single-county HQ allocation
            alloc_rows.append({
                "charter_number":     int(cu["charter_number"]),
                "period":             period,
                "county_fips":        fips,
                "institution_name":   cu["institution_name"],
                "allocated_deposits": deposits,
                "confidence_level":   "modeled",
                "weight_method":      "hq_county",
            })
            n_exact += 1
        else:
            # Fallback: proportional state allocation using FDIC county weights
            state_counties = state_weights.get(state, [])
            if not state_counties:
                n_failed += 1
                continue
            for county_fips, weight in state_counties:
                alloc_rows.append({
                    "charter_number":     int(cu["charter_number"]),
                    "period":             period,
                    "county_fips":        county_fips,
                    "institution_name":   cu["institution_name"],
                    "allocated_deposits": int(deposits * weight),
                    "confidence_level":   "estimated",
                    "weight_method":      "state_fdic_proxy",
                })
            n_fallback += 1

    logger.info(
        "Period %s: %d exact-county, %d state-allocated, %d failed (no state data)",
        period, n_exact, n_fallback, n_failed,
    )

    if not alloc_rows:
        return 0

    # ── Upsert ────────────────────────────────────────────────────────────────
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
