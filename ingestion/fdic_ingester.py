"""FDIC Summary of Deposits ingester — annual.

Uses the FDIC BankFind Suite API to retrieve branch-level deposit data,
geocodes branches missing county FIPS, and upserts into fdic_deposits.

FDIC SOD covers banks and thrifts only. Credit union branch deposits are
estimated separately by estimation_model.py.

Usage:
    python -m ingestion.fdic_ingester --year 2023
"""

from __future__ import annotations

import argparse
import logging
import time
from typing import Iterator

import pandas as pd
import requests
from sqlalchemy.dialects.postgresql import insert as pg_insert

from db import fdic_deposits, get_engine

logger = logging.getLogger(__name__)

FDIC_API_BASE = "https://banks.data.fdic.gov/api"
# SOD data is keyed by calendar year (June 30 snapshot; use YEAR filter, not REPDTE)
_PAGE_SIZE = 10_000
_REQUEST_DELAY = 0.1  # seconds between paginated requests

FDIC_FIELD_MAP: dict[str, str] = {
    "CERT": "fdic_cert",
    "INSTNAME": "institution_name",
    "NAMEBR": "branch_name",
    "ADDRESBR": "branch_address",
    "CITYBR": "branch_city",
    "STALPBR": "state_code",
    "ZIPBR": "branch_zip",
    "CNTYNAMB": "county_name",
    "STCNTYBR": "county_fips",
    "SIMS_LATITUDE": "latitude",
    "SIMS_LONGITUDE": "longitude",
    "DEPSUMBR": "deposits",
}

_API_FIELDS = ",".join(FDIC_FIELD_MAP.keys())


def _get_page(year: int, offset: int) -> list[dict]:
    """Fetch one page of SOD data from FDIC BankFind Suite API."""
    resp = requests.get(
        f"{FDIC_API_BASE}/sod",
        params={
            "filters": f"YEAR:{year}",
            "fields": _API_FIELDS,
            "limit": _PAGE_SIZE,
            "offset": offset,
            "sort_by": "CERT",
            "sort_order": "ASC",
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    return [row["data"] for row in data.get("data", [])]


def fetch_sod_csv(year: int, dest_dir: str = "data/raw") -> pd.DataFrame:
    """Page through FDIC BankFind API and return all branch rows for the year."""
    from pathlib import Path

    cache_path = Path(dest_dir) / f"fdic_sod_{year}.csv"
    if cache_path.exists():
        logger.info("Using cached FDIC SOD %d", year)
        return pd.read_csv(cache_path, dtype=str)

    logger.info("Fetching FDIC SOD %d from BankFind API", year)
    rows: list[dict] = []
    offset = 0
    while True:
        page = _get_page(year, offset)
        if not page:
            break
        rows.extend(page)
        logger.debug("Fetched %d rows (total so far: %d)", len(page), len(rows))
        if len(page) < _PAGE_SIZE:
            break
        offset += _PAGE_SIZE
        time.sleep(_REQUEST_DELAY)

    df = pd.DataFrame(rows)
    Path(dest_dir).mkdir(parents=True, exist_ok=True)
    df.to_csv(cache_path, index=False)
    logger.info("Fetched %d branch rows for %d", len(df), year)
    return df


def parse_csv(df: pd.DataFrame) -> pd.DataFrame:
    """Rename FDIC API field names to internal names; add year column."""
    df = df.rename(columns={k: v for k, v in FDIC_FIELD_MAP.items() if k in df.columns})
    # county_fips from FDIC is a 5-digit FIPS: first 2 = state, last 3 = county
    if "county_fips" in df.columns:
        df["county_fips"] = df["county_fips"].astype(str).str.zfill(5)
    for col in ("deposits", "latitude", "longitude"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df["fdic_cert"] = pd.to_numeric(df.get("fdic_cert"), errors="coerce").astype("Int64")
    return df


def enrich_county_fips(df: pd.DataFrame) -> pd.DataFrame:
    """Geocode branches where county_fips is missing."""
    missing = df["county_fips"].isna() | (df["county_fips"] == "")
    if not missing.any():
        return df

    n_missing = missing.sum()
    logger.info("Geocoding %d branches missing county_fips", n_missing)

    from processing.geocoder import geocode_address

    def _fill(row: pd.Series) -> str | None:
        result = geocode_address(
            street=row.get("branch_address", ""),
            city=row.get("branch_city", ""),
            state=row.get("state_code", ""),
            zip_code=str(row.get("branch_zip", "")),
        )
        return result["county_fips"] if result else None

    df.loc[missing, "county_fips"] = df[missing].apply(_fill, axis=1)
    still_missing = df["county_fips"].isna().sum()
    logger.info("Geocoding complete — %d branches still missing county_fips", still_missing)
    return df


def upsert(df: pd.DataFrame, year: int, db_url: str | None = None) -> int:
    """Upsert branch rows into fdic_deposits."""
    engine = get_engine(db_url)
    df = df.copy()
    df["year"] = year

    table_cols = {c.name for c in fdic_deposits.c}
    store_df = df[[c for c in df.columns if c in table_cols]].copy()
    records = store_df.where(pd.notna(store_df), other=None).to_dict("records")

    update_cols = [c for c in table_cols if c not in ("fdic_cert", "year", "branch_name", "ingested_at")]

    total = 0
    with engine.begin() as conn:
        for i in range(0, len(records), 500):
            batch = records[i : i + 500]
            stmt = pg_insert(fdic_deposits).values(batch)
            stmt = stmt.on_conflict_do_update(
                constraint="uq_fdic_branch_year",
                set_={col: stmt.excluded[col] for col in update_cols},
            )
            total += conn.execute(stmt).rowcount

    return total


def ingest(year: int, db_url: str | None = None) -> None:
    logger.info("Ingesting FDIC SOD %d", year)
    df = fetch_sod_csv(year)
    df = parse_csv(df)
    df = enrich_county_fips(df)
    n = upsert(df, year, db_url)
    logger.info("Upserted %d FDIC branch rows for %d", n, year)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--db-url", default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ingest(args.year, args.db_url)
