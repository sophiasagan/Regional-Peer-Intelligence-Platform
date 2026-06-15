"""NCUA 5300 Call Report ingester — quarterly.

Downloads bulk CSV from NCUA's public data site, maps fields using
NCUA_FIELD_MAP, validates against the 5300 Version 2025.1 data dictionary,
and upserts into institutions_quarterly keyed on (charter_number, period).

After each upsert, triggers compute_peer_distributions for the period.

Usage:
    python -m ingestion.ncua_ingester --year 2024 --quarter 4

FIELD MAPPING NOTE: NCUA column names change between form versions.
Always verify against the data dictionary at ncua.gov before each release.
Reference: NCUA 5300 Version 2025.1 (current as of Q1 2026 Dort Financial filing)
"""

from __future__ import annotations

import argparse
import logging
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from sqlalchemy.dialects.postgresql import insert as pg_insert

from db import get_engine, institutions_quarterly

logger = logging.getLogger(__name__)

# NCUA 5300 Version 2025.1 — verify column names against NCUA data dictionary
# before each quarterly release; update version tag when form changes.
NCUA_FIELD_MAP: dict[str, str] = {
    # identity
    "CU_NUMBER": "charter_number",
    "CU_NAME": "institution_name",
    "CYCLE_DATE": "period",
    "STATE": "state_code",
    "COUNTY": "county_name",
    "COUNTY_CODE": "county_name",   # alternate in newer FOICU.txt
    # balance sheet — standard ACCT_ prefix (works in both old and new format)
    "ACCT_010": "acct_010",
    "ACCT_018": "acct_018",
    "ACCT_025B": "acct_025B",
    "ACCT_797": "acct_797",
    "ACCT_997": "acct_797",         # some versions use 997 for net worth
    "ACCT_998": "acct_998",
    # members
    "ACCT_083": "acct_083",
    # delinquency buckets
    "ACCT_020B": "acct_020B",
    "ACCT_DL0141": "acct_DL0141",
    "DL0141": "acct_DL0141",        # bare code (no ACCT_ prefix) in 2024+ format
    "ACCT_021B": "acct_021B",
    "ACCT_022B": "acct_022B",
    "ACCT_023B": "acct_023B",
    "ACCT_041B": "acct_041B",
    "ACCT_041A": "acct_041A",
    # non-accrual
    "ACCT_DL0145": "acct_DL0145",
    "DL0145": "acct_DL0145",
    "ACCT_DL0146": "acct_DL0146",
    "DL0146": "acct_DL0146",
    # charge-offs (YTD)
    "ACCT_550": "acct_550",
    "ACCT_551": "acct_551",
    "ACCT_680": "acct_680",
    "ACCT_550C1": "acct_550C1",
    "550C1": "acct_550C1",
    "ACCT_550C2": "acct_550C2",
    "550C2": "acct_550C2",
    # allowances — CECL (AS0048) and pre-CECL (719)
    "ACCT_AS0048": "acct_AS0048",
    "AS0048": "acct_AS0048",        # bare code in 2024+ format
    "ACCT_719": "acct_719",
    # income statement
    "ACCT_115": "acct_115",
    "ACCT_IS0010": "acct_IS0010",
    "IS0010": "acct_IS0010",        # bare code in 2024+ format
    "ACCT_IS0017": "acct_IS0017",
    "IS0017": "acct_IS0017",
    "ACCT_117": "acct_117",
    "ACCT_671": "acct_671",
    "ACCT_661A": "acct_661A",
    "661A": "acct_661A",            # bare code in 2024+ format
    "ACCT_661": "acct_661A",        # some versions drop the A suffix
    # capital
    "ACCT_RB0172": "acct_RB0172",
    "RB0172": "acct_RB0172",        # bare code in 2024+ format
}

# Delinquency sub-mapping: raw CSV names that differ from ACCT_XXX convention.
# NCUA 5300 Version 2025.1. Verify column names against data dictionary each release.
# Alternate column names from older single-file NCUA format (pre-2024).
# In the 2024+ multi-file format these fields appear as ACCT_XXX or bare codes
# in the relevant schedule files, so these alternates are mainly legacy coverage.
NCUA_DELINQUENCY_FIELD_MAP: dict[str, str] = {
    "DLNQ60": "acct_DL0141",      # 60-89 days total (old format)
    "DLNQ90": "acct_021B",        # 90-179 days total
    "DLNQ180": "acct_022B",       # 180-359 days total
    "DLNQ360": "acct_023B",       # 360+ days total
    "DELINQTOTAL": "acct_041B",   # total 60+ day delinquent balance
    "NCLNS": "acct_550",          # total gross charge-offs
    "NCRECOV": "acct_551",        # total recoveries
    "NCCC": "acct_680",           # credit card charge-offs
    "NCAUTO1": "acct_550C1",      # new vehicle charge-offs
    "NCAUTO2": "acct_550C2",      # used vehicle charge-offs
}

# NCUA changed URL format from call-report-data-{year}-Q{quarter}.zip
# to call-report-data-{year}-{month:02d}.zip (month = quarter * 3)
NCUA_BULK_URL_TEMPLATE = (
    "https://www.ncua.gov/files/publications/analysis/"
    "call-report-data-{year}-{month:02d}.zip"
)

_BIGINT_COLS = [
    "acct_010", "acct_018", "acct_025B", "acct_797",
    "acct_020B", "acct_DL0141", "acct_021B", "acct_022B", "acct_023B",
    "acct_041B", "acct_041A", "acct_DL0145", "acct_DL0146",
    "acct_550", "acct_551", "acct_680", "acct_550C1", "acct_550C2",
    "acct_AS0048", "acct_719",
    "acct_115", "acct_IS0010", "acct_IS0017", "acct_117", "acct_671", "acct_661A",
    "acct_083",
]
_FLOAT_COLS = ["acct_998", "acct_RB0172"]


def build_download_url(year: int, quarter: int) -> str:
    month = quarter * 3
    return NCUA_BULK_URL_TEMPLATE.format(year=year, month=month)


def download_bulk_zip(url: str, dest_dir: str) -> str:
    """Download ZIP to dest_dir (skip if cached), extract, return path to primary CSV."""
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    zip_name = url.split("/")[-1]
    zip_path = dest / zip_name

    if not zip_path.exists():
        logger.info("Downloading %s", url)
        with requests.get(url, stream=True, timeout=300) as resp:
            if resp.status_code == 404:
                raise FileNotFoundError(
                    f"NCUA has not published data at {url}. "
                    "Verify the current download URL at "
                    "https://www.ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data"
                )
            resp.raise_for_status()
            with open(zip_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                    f.write(chunk)
        logger.info("Saved %.1f MB → %s", zip_path.stat().st_size / 1e6, zip_path)
    else:
        logger.info("Using cached %s", zip_path)

    return _extract_main_csv(zip_path, dest)


def _read_schedule(zf, member, extract_dir: Path) -> pd.DataFrame | None:
    """Extract one schedule file from the ZIP and read it as a DataFrame."""
    try:
        zf.extract(member, extract_dir)
        path = extract_dir / member.filename
        for sep in (",", "\t", "|"):
            try:
                df = pd.read_csv(path, sep=sep, dtype=str, encoding="latin-1",
                                 low_memory=False, on_bad_lines="warn")
                if len(df.columns) > 2:
                    df.columns = [c.strip() for c in df.columns]
                    logger.info("Read %s: %d rows × %d cols (sep=%r)",
                                member.filename, len(df), len(df.columns), sep)
                    return df
            except Exception:
                pass
    except Exception as exc:
        logger.warning("Could not read %s: %s", member.filename, exc)
    return None


def _extract_main_csv(zip_path: Path, dest: Path) -> str:
    """Extract and join the relevant NCUA schedule files into a single combined CSV.

    NCUA changed from a single CallReportData file to per-schedule files in 2024+:
      FOICU.txt  — institution identity (CU_NUMBER, CU_NAME, STATE, COUNTY, CYCLE_DATE)
      FS220.txt  — main balance sheet and income (ACCT_010, ACCT_025B, ACCT_797, …)
      FS220D.txt — delinquency schedule (ACCT_041B, buckets, charge-offs)

    We join all three on (CU_NUMBER, CYCLE_DATE) and write a combined CSV.
    Falls back to the old single-file approach if FOICU.txt is not present.
    """
    extract_dir = dest / zip_path.stem
    extract_dir.mkdir(exist_ok=True)

    combined_path = extract_dir / "_combined.csv"
    if combined_path.exists():
        logger.info("Using cached combined CSV %s", combined_path)
        return str(combined_path)

    # Files to join, in priority order. FOICU = identity, FS220 = main financials,
    # FS220D = delinquency. Additional schedules joined if present.
    WANTED = ["FOICU.txt", "FS220.txt", "FS220D.txt", "FS220A.txt", "FS220G.txt"]
    JOIN_ON = ["CU_NUMBER", "CYCLE_DATE"]

    with zipfile.ZipFile(zip_path) as zf:
        by_name = {m.filename: m for m in zf.infolist()}
        logger.info("ZIP contents: %s", list(by_name.keys()))

        frames: list[pd.DataFrame] = []
        for fname in WANTED:
            member = by_name.get(fname)
            if member is None:
                continue
            df = _read_schedule(zf, member, extract_dir)
            if df is not None:
                frames.append(df)

        if not frames:
            # Legacy format: single large file (old pre-2024 format)
            candidates = [
                m for m in zf.infolist()
                if m.filename.lower().endswith((".txt", ".csv"))
                and not m.filename.startswith("__MACOSX")
                and "branch" not in m.filename.lower()
                and "atm" not in m.filename.lower()
                and "readme" not in m.filename.lower()
                and "tradename" not in m.filename.lower()
                and "acctdesc" not in m.filename.lower()
            ]
            if not candidates:
                raise ValueError(f"No usable data file in {zip_path.name}")
            target = max(candidates, key=lambda m: m.file_size)
            df = _read_schedule(zf, target, extract_dir)
            if df is None:
                raise ValueError(f"Could not read {target.filename}")
            df.to_csv(combined_path, index=False)
            return str(combined_path)

    # Join all frames on CU_NUMBER + CYCLE_DATE
    result = frames[0]
    for df in frames[1:]:
        pk_present = [c for c in JOIN_ON if c in df.columns and c in result.columns]
        if not pk_present:
            logger.warning("Skipping join — no common key columns")
            continue
        new_cols = [c for c in df.columns if c not in result.columns]
        if not new_cols:
            continue
        result = result.merge(df[pk_present + new_cols], on=pk_present, how="left")
        logger.info("Joined %d new columns; result now %d cols", len(new_cols), len(result.columns))

    result.to_csv(combined_path, index=False)
    logger.info("Combined CSV: %d rows × %d cols → %s", len(result), len(result.columns), combined_path)
    return str(combined_path)


def _period_from_cycle_date(series: pd.Series) -> pd.Series:
    """Convert '3/31/2026' or '2026-03-31' → '2026Q1'."""
    dt = pd.to_datetime(series, errors="coerce")
    quarter = ((dt.dt.month - 1) // 3 + 1).astype("Int64")
    return dt.dt.year.astype("Int64").astype("string") + "Q" + quarter.astype("string")


def parse_csv(csv_path: str) -> pd.DataFrame:
    """Read raw NCUA CSV, rename columns, normalise period to 'YYYY-QN'."""
    df = None
    for sep in (",", "\t", "|"):
        try:
            candidate = pd.read_csv(
                csv_path,
                sep=sep,
                dtype=str,
                encoding="latin-1",
                low_memory=False,
                on_bad_lines="warn",
            )
            if len(candidate.columns) > 10:
                df = candidate
                logger.info("Parsed with sep=%r: %d rows × %d cols", sep, len(df), len(df.columns))
                break
        except Exception as exc:
            logger.debug("sep=%r failed: %s", sep, exc)

    if df is None:
        raise ValueError(f"Could not parse {csv_path} with any delimiter")

    df.columns = [c.strip() for c in df.columns]

    combined_map = {**NCUA_FIELD_MAP, **NCUA_DELINQUENCY_FIELD_MAP}
    mapped = {k for k in combined_map if k in df.columns}
    unmapped = {k for k in combined_map if k not in df.columns}
    logger.info("Field map: %d/%d source fields matched. Missing: %s",
                len(mapped), len(combined_map), sorted(unmapped))
    df = df.rename(columns={k: v for k, v in combined_map.items() if k in df.columns})

    # Convert CYCLE_DATE → "2026Q1" format
    if "period" in df.columns:
        df["period"] = _period_from_cycle_date(df["period"])

    # Drop columns we don't need
    keep = set(combined_map.values()) | {"charter_number", "institution_name", "period", "state_code", "county_name"}
    df = df[[c for c in df.columns if c in keep]].copy()
    logger.info("Kept columns after filter: %s", sorted(df.columns.tolist()))

    return df


def validate(df: pd.DataFrame) -> pd.DataFrame:
    """Drop rows with missing PKs; coerce numeric columns."""
    before = len(df)
    df = df.dropna(subset=["charter_number", "period"])
    if (dropped := before - len(df)):
        logger.warning("Dropped %d rows with null charter_number or period", dropped)

    df["charter_number"] = pd.to_numeric(df["charter_number"], errors="coerce").astype("Int64")
    df = df.dropna(subset=["charter_number"])

    for col in _BIGINT_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in _FLOAT_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    return df.reset_index(drop=True)


def compute_derived_ratios(df: pd.DataFrame) -> pd.DataFrame:
    """Add computed ratio columns per CLAUDE.md. Never stored — computed here for batch peer work."""
    loans = df.get("acct_025B", pd.Series(dtype=float, index=df.index)).replace(0, np.nan)
    delinq = df.get("acct_041B", pd.Series(dtype=float, index=df.index)).replace(0, np.nan)
    assets = df.get("acct_010", pd.Series(dtype=float, index=df.index)).replace(0, np.nan)

    df["delinq_rate_total"] = df.get("acct_041B", np.nan) / loans

    co_gross = df.get("acct_550", pd.Series(dtype=float, index=df.index))
    co_recov = df.get("acct_551", pd.Series(dtype=float, index=df.index))
    df["chargeoff_rate_total_annualized"] = (co_gross - co_recov) / loans * 4

    # Use ACL (CECL) where populated; fall back to ALLL (pre-CECL)
    allowance = df.get("acct_AS0048", pd.Series(dtype=float, index=df.index))
    if "acct_719" in df.columns:
        allowance = allowance.fillna(df["acct_719"])
    df["alll_coverage"] = allowance / delinq
    df["alll_to_loans"] = allowance / loans

    # Net worth ratio: CLAUDE.md specifies acct_997/acct_010; NCUA account 797 = net worth
    nw = df.get("acct_797", pd.Series(dtype=float, index=df.index))
    df["nwratio"] = nw / assets

    return df


def upsert(df: pd.DataFrame, db_url: str | None = None) -> int:
    """Upsert into institutions_quarterly. ON CONFLICT (charter_number, period) DO UPDATE."""
    engine = get_engine(db_url)
    table_cols = {c.name for c in institutions_quarterly.c}
    store_df = df[[c for c in df.columns if c in table_cols]].copy()

    # NCUA bulk CSV can contain duplicate (charter_number, period) rows.
    # PostgreSQL ON CONFLICT DO UPDATE rejects batches with intra-batch duplicates.
    before = len(store_df)
    store_df = store_df.drop_duplicates(subset=["charter_number", "period"], keep="last")
    if (dropped := before - len(store_df)):
        logger.warning("Dropped %d duplicate NCUA rows", dropped)

    records = store_df.where(pd.notna(store_df), other=None).to_dict("records")

    pk_cols = {"charter_number", "period"}
    update_cols = [c for c in table_cols if c not in pk_cols and c != "ingested_at"]

    total = 0
    with engine.begin() as conn:
        for i in range(0, len(records), 500):
            batch = records[i : i + 500]
            stmt = pg_insert(institutions_quarterly).values(batch)
            stmt = stmt.on_conflict_do_update(
                index_elements=list(pk_cols),
                set_={col: stmt.excluded[col] for col in update_cols},
            )
            total += conn.execute(stmt).rowcount

    return total


def ingest_ncua_quarter(year: int, quarter: int, db_url: str | None = None) -> pd.DataFrame:
    """Download NCUA 5300 for a quarter, transform, upsert, trigger peer distributions.

    Steps:
      1. Download and extract ZIP from NCUA bulk URL
      2. Select all columns needed for institutions_quarterly
      3. Add computed columns: delinq_rate_total, chargeoff_rate_total_annualized,
         alll_coverage, nwratio
      4. Upsert to institutions_quarterly (ON CONFLICT DO UPDATE)
      5. Trigger compute_peer_distributions for this period
    """
    logger.info("Ingesting NCUA 5300 %dQ%d", year, quarter)
    url = build_download_url(year, quarter)
    csv_path = download_bulk_zip(url, dest_dir="data/raw")
    df = parse_csv(csv_path)
    df = validate(df)
    df = compute_derived_ratios(df)
    n = upsert(df, db_url)
    logger.info("Upserted %d rows for %dQ%d", n, year, quarter)

    _trigger_peer_distributions(f"{year}Q{quarter}", db_url)
    return df


def _trigger_peer_distributions(period: str, db_url: str | None) -> None:
    from processing.compute_peer_distributions import run as run_distributions
    run_distributions(period, db_url)


# Legacy alias kept for scheduler compatibility
ingest = ingest_ncua_quarter


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, required=True)
    parser.add_argument("--quarter", type=int, required=True, choices=[1, 2, 3, 4])
    parser.add_argument("--db-url", default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ingest_ncua_quarter(args.year, args.quarter, args.db_url)
