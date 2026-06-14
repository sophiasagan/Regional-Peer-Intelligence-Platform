"""HMDA loan origination data ingester — annual.

Downloads HMDA LAR (Loan Application Register) from CFPB's S3 snapshot,
filters to credit unions (agency_code=7), aggregates originations by
(county_fips, loan_purpose), and upserts into hmda_originations.

Usage:
    python -m ingestion.hmda_ingester --year 2023
"""

from __future__ import annotations

import argparse
import logging
import zipfile
from pathlib import Path

import pandas as pd
import requests
from sqlalchemy.dialects.postgresql import insert as pg_insert

from db import get_engine, hmda_originations

logger = logging.getLogger(__name__)

# CFPB HMDA bulk snapshot — nationwide combined file
HMDA_LAR_URL_TEMPLATE = (
    "https://s3.amazonaws.com/cfpb-hmda-public/prod/snapshot-data/"
    "{year}/nationwide/combined_msa-md.zip"
)

# action_taken = 1 means loan originated
ACTION_ORIGINATED = 1

# agency_code = 7 means NCUA-regulated credit union
AGENCY_NCUA = 7

HMDA_FIELD_MAP: dict[str, str] = {
    "activity_year": "year",
    "respondent_id": "respondent_id",
    "agency_code": "agency_code",
    "action_taken": "action_taken",
    "loan_purpose": "loan_purpose",
    "loan_amount": "loan_amount",
    "state_code": "state_code",
    "county_code": "county_fips",
}

# Loan purpose codes (HMDA 2017 and earlier; post-2018 codes differ)
LOAN_PURPOSE = {1: "purchase", 2: "improvement", 3: "refinancing", 4: "other"}


def fetch_lar(year: int, dest_dir: str = "data/raw") -> str:
    """Download HMDA LAR ZIP, extract, return path to the LAR CSV."""
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    url = HMDA_LAR_URL_TEMPLATE.format(year=year)
    zip_name = f"hmda_lar_{year}.zip"
    zip_path = dest / zip_name

    if not zip_path.exists():
        logger.info("Downloading HMDA LAR %d from %s", year, url)
        with requests.get(url, stream=True, timeout=600) as resp:
            resp.raise_for_status()
            with open(zip_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    f.write(chunk)
        logger.info("Saved %.1f MB → %s", zip_path.stat().st_size / 1e6, zip_path)
    else:
        logger.info("Using cached %s", zip_path)

    extract_dir = dest / f"hmda_lar_{year}"
    extract_dir.mkdir(exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        candidates = [m for m in zf.infolist() if m.filename.lower().endswith((".txt", ".csv"))]
        target = max(candidates, key=lambda m: m.file_size)
        zf.extract(target, extract_dir)
        return str(extract_dir / target.filename)


def parse_lar(path: str) -> pd.DataFrame:
    """Read LAR, rename columns, keep only fields we need."""
    logger.info("Parsing HMDA LAR from %s", path)
    cols_needed = list(HMDA_FIELD_MAP.keys())

    # HMDA files are pipe-delimited in some years, comma in others
    for sep in ("|", ",", "\t"):
        try:
            df = pd.read_csv(
                path,
                sep=sep,
                usecols=lambda c: c in cols_needed,
                dtype=str,
                encoding="latin-1",
                low_memory=False,
                on_bad_lines="warn",
            )
            if len(df.columns) > 3:
                break
        except Exception:
            continue

    df = df.rename(columns={k: v for k, v in HMDA_FIELD_MAP.items() if k in df.columns})

    # Coerce numeric fields
    for col in ("year", "agency_code", "action_taken", "loan_purpose", "loan_amount"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    # Normalise county FIPS to 5-char string (state 2 + county 3)
    if "state_code" in df.columns and "county_fips" in df.columns:
        sc = df["state_code"].astype(str).str.zfill(2)
        co = df["county_fips"].astype(str).str.zfill(3)
        df["county_fips"] = sc + co

    logger.info("Parsed %d LAR rows", len(df))
    return df


def filter_credit_unions(df: pd.DataFrame) -> pd.DataFrame:
    """Keep only originated loans from NCUA-regulated credit unions."""
    mask = (df["agency_code"] == AGENCY_NCUA) & (df["action_taken"] == ACTION_ORIGINATED)
    filtered = df[mask].copy()
    logger.info("Filtered to %d CU originations (from %d total)", len(filtered), len(df))
    return filtered


def aggregate_by_county(df: pd.DataFrame) -> pd.DataFrame:
    """Summarise origination count and volume by county_fips × loan_purpose."""
    agg = (
        df.groupby(["respondent_id", "state_code", "county_fips", "loan_purpose"], dropna=False)
        .agg(
            origination_count=("loan_amount", "count"),
            origination_volume=("loan_amount", "sum"),
        )
        .reset_index()
    )
    agg["origination_volume"] = agg["origination_volume"].astype("Int64")
    return agg


def upsert(df: pd.DataFrame, year: int, db_url: str | None = None) -> int:
    """Upsert aggregated originations into hmda_originations."""
    engine = get_engine(db_url)
    df = df.copy()
    df["year"] = year

    table_cols = {c.name for c in hmda_originations.c}
    store_df = df[[c for c in df.columns if c in table_cols]].copy()
    records = store_df.where(pd.notna(store_df), other=None).to_dict("records")

    pk_cols = {"year", "respondent_id", "county_fips", "loan_purpose"}
    update_cols = [c for c in table_cols if c not in pk_cols and c != "ingested_at"]

    total = 0
    with engine.begin() as conn:
        for i in range(0, len(records), 500):
            batch = records[i : i + 500]
            stmt = pg_insert(hmda_originations).values(batch)
            stmt = stmt.on_conflict_do_update(
                index_elements=list(pk_cols),
                set_={col: stmt.excluded[col] for col in update_cols},
            )
            total += conn.execute(stmt).rowcount

    return total


def ingest(year: int, db_url: str | None = None) -> None:
    logger.info("Ingesting HMDA LAR %d", year)
    path = fetch_lar(year)
    df = parse_lar(path)
    df = filter_credit_unions(df)
    df = aggregate_by_county(df)
    n = upsert(df, year, db_url)
    logger.info("Upserted %d HMDA origination rows for %d", n, year)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--db-url", default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ingest(args.year, args.db_url)
