"""Census ACS 5-year estimates ingester — annual (county level).

Pulls ACS 5-year estimates from the Census Bureau API for all US counties:
population, median household income, housing units, age, labor force.

Usage:
    python -m ingestion.census_ingester --year 2023

Set CENSUS_API_KEY environment variable (free at api.census.gov/data/key_signup.html).
Requests work without a key but are rate-limited more aggressively.
"""

from __future__ import annotations

import argparse
import logging
import os
import time
from pathlib import Path

import pandas as pd
import requests
from sqlalchemy.dialects.postgresql import insert as pg_insert

from db import census_demographics, get_engine

logger = logging.getLogger(__name__)

CENSUS_API_BASE = "https://api.census.gov/data"

# ACS 5-year estimate variable codes
ACS_VARIABLES: dict[str, str] = {
    "B01003_001E": "total_population",
    "B19013_001E": "median_household_income",
    "B25001_001E": "total_housing_units",
    "B01002_001E": "median_age",
    "B23025_002E": "labor_force",
    "B23025_005E": "unemployed",
    "NAME": "_name",  # "County, State" — parsed for county_name / state_code
}

_NUMERIC_COLS = [
    "total_population", "median_household_income", "total_housing_units",
    "median_age", "labor_force", "unemployed",
]


def _build_url(year: int) -> str:
    variables = ",".join(ACS_VARIABLES.keys())
    return f"{CENSUS_API_BASE}/{year}/acs/acs5?get={variables}&for=county:*"


def fetch_county_data(year: int, api_key: str = "") -> pd.DataFrame:
    """Fetch ACS 5-year estimates for all US counties."""
    cache_path = Path("data/raw") / f"census_acs_{year}.parquet"
    if cache_path.exists():
        logger.info("Using cached Census ACS %d", year)
        return pd.read_parquet(cache_path)

    url = _build_url(year)
    params = {"key": api_key} if api_key else {}
    logger.info("Fetching Census ACS %d", year)

    resp = requests.get(url, params=params, timeout=120)
    if resp.status_code == 429:
        logger.warning("Rate limited by Census API — sleeping 10s")
        time.sleep(10)
        resp = requests.get(url, params=params, timeout=120)
    resp.raise_for_status()

    raw = resp.json()
    headers = raw[0]
    rows = raw[1:]
    df = pd.DataFrame(rows, columns=headers)

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(cache_path, index=False)
    logger.info("Fetched %d county rows for ACS %d", len(df), year)
    return df


def parse_response(df: pd.DataFrame) -> pd.DataFrame:
    """Rename ACS columns, compute county_fips, parse county/state name."""
    df = df.rename(columns={k: v for k, v in ACS_VARIABLES.items() if k in df.columns})

    # Build 5-digit county FIPS from state + county codes
    df["county_fips"] = df["state"].str.zfill(2) + df["county"].str.zfill(3)

    # Parse "County Name, State Abbrev" from the NAME field
    if "_name" in df.columns:
        split = df["_name"].str.split(", ", n=1, expand=True)
        df["county_name"] = split[0].str.replace(" County", "", regex=False).str.strip()
        # Map full state name to abbreviation using a lookup
        df["state_code"] = split[1].map(_STATE_ABBREV) if len(split.columns) > 1 else None
        df = df.drop(columns=["_name"])

    # Coerce numeric columns; Census API returns strings; sentinel -666666666 = missing
    for col in _NUMERIC_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
            df.loc[df[col] < -600_000_000, col] = None

    return df.drop(columns=["state", "county"], errors="ignore")


def upsert(df: pd.DataFrame, year: int, db_url: str | None = None) -> int:
    """Upsert county demographics into census_demographics."""
    engine = get_engine(db_url)
    df = df.copy()
    df["year"] = year

    table_cols = {c.name for c in census_demographics.c}
    store_df = df[[c for c in df.columns if c in table_cols]].copy()
    records = store_df.where(pd.notna(store_df), other=None).to_dict("records")

    pk_cols = {"county_fips", "year"}
    update_cols = [c for c in table_cols if c not in pk_cols and c != "ingested_at"]

    total = 0
    with engine.begin() as conn:
        for i in range(0, len(records), 500):
            batch = records[i : i + 500]
            stmt = pg_insert(census_demographics).values(batch)
            stmt = stmt.on_conflict_do_update(
                index_elements=list(pk_cols),
                set_={col: stmt.excluded[col] for col in update_cols},
            )
            total += conn.execute(stmt).rowcount

    return total


def ingest(year: int, db_url: str | None = None, api_key: str | None = None) -> None:
    api_key = api_key or os.environ.get("CENSUS_API_KEY", "")
    logger.info("Ingesting Census ACS %d", year)
    df = fetch_county_data(year, api_key)
    df = parse_response(df)
    n = upsert(df, year, db_url)
    logger.info("Upserted %d census rows for %d", n, year)


# Full US state abbreviation lookup (used to parse Census NAME field)
_STATE_ABBREV: dict[str, str] = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
    "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID",
    "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
    "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
    "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
    "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
    "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
    "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
    "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV",
    "Wisconsin": "WI", "Wyoming": "WY", "District of Columbia": "DC",
    "Puerto Rico": "PR",
}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--db-url", default=None)
    parser.add_argument("--api-key", default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ingest(args.year, args.db_url, args.api_key)
