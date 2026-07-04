"""Geo ingester: CBSA (MSA) → county crosswalk from Census Bureau.

Downloads the 2023 CBSA delineation file from Census.gov and populates
geo_cbsa_counties so MSA-level market share queries work.

Usage:
    python -m ingestion.geo_ingester
"""

from __future__ import annotations

import io
import logging

import pandas as pd
import requests
from sqlalchemy import text

from db import geo_cbsa_counties, get_engine, metadata

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# Census publishes updated delineation files periodically.
# This 2023 vintage covers the most current county assignments.
_CBSA_URL = (
    "https://www2.census.gov/programs-surveys/metro-micro/geographies/"
    "reference-files/2023/delineation-files/list1_2023.xlsx"
)


def _fetch_cbsa_df() -> pd.DataFrame:
    logger.info("Downloading CBSA delineation file from Census.gov...")
    r = requests.get(_CBSA_URL, timeout=120)
    r.raise_for_status()

    # The Census Excel file has 2 title/blank rows before the column header row.
    raw = pd.read_excel(io.BytesIO(r.content), header=2, dtype=str)
    raw.columns = [c.strip() for c in raw.columns]

    # Verify expected columns are present
    required = {"CBSA Code", "FIPS State Code", "FIPS County Code"}
    missing = required - set(raw.columns)
    if missing:
        raise ValueError(
            f"Unexpected Census file format — missing columns: {missing}. "
            f"Actual columns: {list(raw.columns)}"
        )
    return raw


def ingest(db_url: str | None = None) -> None:
    engine = get_engine(db_url)
    metadata.create_all(engine, tables=[geo_cbsa_counties], checkfirst=True)

    raw = _fetch_cbsa_df()

    rows = []
    for _, row in raw.iterrows():
        cbsa_code = str(row.get("CBSA Code", "")).strip()
        if not cbsa_code or cbsa_code.lower() == "nan":
            continue

        state_fips  = str(row.get("FIPS State Code",  "")).strip().zfill(2)
        county_part = str(row.get("FIPS County Code", "")).strip().zfill(3)
        county_fips = state_fips + county_part

        if len(county_fips) != 5 or county_fips in ("00000", "0000n"):
            continue

        geo_type = str(row.get("Metropolitan/Micropolitan Statistical Area", "")).strip()
        is_metro = geo_type.lower().startswith("metropolitan statistical")

        rows.append({
            "cbsa_code":   cbsa_code,
            "county_fips": county_fips,
            "cbsa_title":  str(row.get("CBSA Title", "")).strip(),
            "county_name": str(row.get("County/County Equivalent", "")).strip(),
            "state_fips":  state_fips,
            "is_metro":    is_metro,
        })

    logger.info("Parsed %d CBSA→county mappings", len(rows))
    if not rows:
        logger.error("No rows parsed — check Census file format")
        return

    with engine.begin() as conn:
        conn.execute(text("TRUNCATE geo_cbsa_counties"))
        conn.execute(geo_cbsa_counties.insert(), rows)

    logger.info("Done — loaded %d rows into geo_cbsa_counties", len(rows))


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Load CBSA→county crosswalk from Census")
    p.add_argument("--db-url", default=None)
    args = p.parse_args()
    ingest(db_url=args.db_url)
