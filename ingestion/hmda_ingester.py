"""HMDA loan origination data ingester — annual.

Downloads HMDA LAR (Loan Application Register) from CFPB/FFIEC snapshot,
filters to originated home-purchase and refinance loans, aggregates by
(respondent_id, county_fips, loan_purpose), and upserts into hmda_originations.

CFPB changed the HMDA schema in 2018 (Dodd-Frank / EGRRCPA update):
  Pre-2018 : respondent_id, agency_code (7=CU), county_code (3-digit)
  2018+    : lei (LEI identifier), no agency_code, county_code (3 or 5-digit)

This ingester auto-detects schema version from the file header and handles both.
All institution types are included so market share shows the full competitive set
(banks, CUs, non-bank lenders, etc.).

Usage:
    python -m ingestion.hmda_ingester --year 2023
    python -m ingestion.hmda_ingester --year 2022

If automatic download fails (CFPB moves their URLs periodically):
  1. Visit https://ffiec.cfpb.gov/data-publication/snapshot-national-loan-level-dataset/
  2. Download the {year} nationwide LAR zip
  3. Save it to data/raw/hmda_lar_{year}.zip
  4. Re-run — the ingester will skip the download and use the local file

Or pass the zip/csv directly:
    python -m ingestion.hmda_ingester --year 2023 --file /path/to/hmda_lar_2023.zip
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

# CFPB/FFIEC HMDA bulk snapshot URLs — tried in order until one returns 200.
# CFPB has moved these files several times; add new patterns at the top.
HMDA_URL_TEMPLATES = [
    # FFIEC S3 — current format (2020+): year-prefixed filename
    "https://s3.amazonaws.com/cfpb-hmda-public/prod/snapshot-data/"
    "{year}/nationwide/{year}_public_lar_csv.zip",
    # FFIEC S3 — alternate year-prefixed path
    "https://s3.amazonaws.com/cfpb-hmda-public/prod/snapshot-data/"
    "{year}/{year}_public_lar_csv.zip",
    # Legacy combined_msa-md path (pre-2020)
    "https://s3.amazonaws.com/cfpb-hmda-public/prod/snapshot-data/"
    "{year}/nationwide/combined_msa-md.zip",
    # FFIEC collections path
    "https://s3.amazonaws.com/cfpb-hmda-public/prod/collections/hmda/"
    "{year}/nationwide/combined_lar_{year}.zip",
]

MANUAL_DOWNLOAD_PAGE = (
    "https://ffiec.cfpb.gov/data-publication/snapshot-national-loan-level-dataset/"
)

ACTION_ORIGINATED = 1

# Post-2018 loan purposes relevant to mortgage market share
MORTGAGE_PURPOSES_POST2018 = {1, 31, 32}   # purchase, refinance, cash-out refi
# Pre-2018 loan purposes
MORTGAGE_PURPOSES_PRE2018  = {1, 3}        # purchase, refinancing

# ── Schema definitions ────────────────────────────────────────────────────────

# 2018+ schema: lei replaces respondent_id; agency_code removed; county_code
# may be 3-digit or 5-digit depending on file version.
_FIELDS_POST2018 = {
    "activity_year":  "year",
    "lei":            "respondent_id",
    "action_taken":   "action_taken",
    "loan_purpose":   "loan_purpose",
    "loan_amount":    "loan_amount",
    "state_code":     "state_code",
    "county_code":    "county_fips",
}

# Pre-2018 schema
_FIELDS_PRE2018 = {
    "activity_year":  "year",
    "respondent_id":  "respondent_id",
    "agency_code":    "agency_code",
    "action_taken":   "action_taken",
    "loan_purpose":   "loan_purpose",
    "loan_amount":    "loan_amount",
    "state_code":     "state_code",
    "county_code":    "county_fips",
}


def _detect_schema(header_cols: list[str]) -> tuple[dict, bool]:
    """Return (field_map, is_post2018) based on column headers."""
    cols = {c.lower() for c in header_cols}
    if "lei" in cols:
        return _FIELDS_POST2018, True
    return _FIELDS_PRE2018, False


# ── Download ──────────────────────────────────────────────────────────────────

def fetch_lar(year: int, dest_dir: str = "data/raw", local_file: str | None = None) -> str:
    """Download (or locate) HMDA LAR ZIP and extract; return path to the LAR CSV/TXT.

    If local_file is provided (--file CLI arg), skip download and use that path directly.
    If data/raw/hmda_lar_{year}.zip already exists, skip download (cached).
    """
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    # ── Locate zip ────────────────────────────────────────────────────────────
    if local_file:
        zip_path = Path(local_file)
        if not zip_path.exists():
            raise FileNotFoundError(f"--file path does not exist: {local_file}")
        logger.info("Using provided file: %s", zip_path)
        # If it's already a CSV/TXT (not a zip), skip extraction
        if zip_path.suffix.lower() in (".csv", ".txt"):
            return str(zip_path)
    else:
        zip_path = dest / f"hmda_lar_{year}.zip"

        if not zip_path.exists():
            downloaded = False
            for url_template in HMDA_URL_TEMPLATES:
                url = url_template.format(year=year)
                logger.info("Trying HMDA LAR %d from %s", year, url)
                try:
                    with requests.get(url, stream=True, timeout=600) as resp:
                        if resp.status_code == 200:
                            with open(zip_path, "wb") as f:
                                for chunk in resp.iter_content(chunk_size=1024 * 1024):
                                    f.write(chunk)
                            logger.info(
                                "Saved %.1f MB → %s", zip_path.stat().st_size / 1e6, zip_path
                            )
                            downloaded = True
                            break
                        logger.warning("HTTP %d from %s", resp.status_code, url)
                except Exception as exc:
                    logger.warning("Download failed from %s: %s", url, exc)

            if not downloaded:
                raise RuntimeError(
                    f"Could not download HMDA LAR for {year} from any known URL.\n"
                    f"Manual download instructions:\n"
                    f"  1. Visit {MANUAL_DOWNLOAD_PAGE}\n"
                    f"  2. Download the {year} nationwide LAR zip\n"
                    f"  3. Save it to {zip_path} OR pass with --file /path/to/file.zip\n"
                    f"  4. Re-run this command"
                )
        else:
            logger.info("Using cached %s", zip_path)

    # CFPB sometimes serves CSV content with a .zip extension — detect and handle
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        logger.info("File is not a zip archive — treating as plain CSV/TXT: %s", zip_path)
        return str(zip_path)

    with zf:
        candidates = [m for m in zf.infolist() if m.filename.lower().endswith((".txt", ".csv"))]
        if not candidates:
            raise RuntimeError(f"No CSV/TXT found inside {zip_path}")
        target = max(candidates, key=lambda m: m.file_size)
        extract_dir = dest / f"hmda_lar_{year}"
        extract_dir.mkdir(exist_ok=True)
        zf.extract(target, extract_dir)
        extracted = str(extract_dir / target.filename)
        logger.info("Extracted %s (%.1f MB)", target.filename, target.file_size / 1e6)
        return extracted


# ── Parse ─────────────────────────────────────────────────────────────────────

def parse_lar(path: str, year: int) -> pd.DataFrame:
    """Read LAR, auto-detect schema, return cleaned DataFrame."""
    logger.info("Parsing HMDA LAR from %s", path)

    # Peek at header to detect delimiter and schema
    with open(path, "r", encoding="latin-1", errors="replace") as fh:
        header_line = fh.readline()

    if "|" in header_line and header_line.count("|") > 5:
        sep = "|"
    elif "\t" in header_line:
        sep = "\t"
    else:
        sep = ","

    header_cols = [c.strip().lower() for c in header_line.split(sep)]
    field_map, is_post2018 = _detect_schema(header_cols)
    logger.info(
        "Detected %s HMDA schema; first 10 columns: %s",
        "post-2018" if is_post2018 else "pre-2018",
        header_cols[:10],
    )

    # Read ALL columns — usecols lambda can silently drop needed columns if the
    # file has BOM bytes, extra spaces, or unexpected casing in column names.
    df = pd.read_csv(
        path,
        sep=sep,
        dtype=str,
        encoding="latin-1",
        engine="python",    # C parser overflows on some HMDA rows
        on_bad_lines="warn",
        compression=None,   # file may have .zip extension but be plain CSV
    )
    # Normalise column names: strip whitespace + lowercase, then apply field map
    df.columns = [c.strip().lower() for c in df.columns]
    df = df.rename(columns={k.lower(): v for k, v in field_map.items()})
    logger.info("Columns after rename: %s", df.columns.tolist())

    # Keep only the columns we need; drop everything else to free memory
    keep = [v for v in field_map.values() if v in df.columns]
    df = df[keep]

    for col in ("year", "action_taken", "loan_purpose", "loan_amount"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    if "agency_code" in df.columns:
        df["agency_code"] = pd.to_numeric(df["agency_code"], errors="coerce")

    # ── Normalise county FIPS to 5-char string ────────────────────────────────
    # Post-2018: state_code is 2-digit numeric ("26"), county_code is 3-digit ("049")
    # Pre-2018: state_code is 2-char text ("MI"), county_code is 3-digit ("049")
    # Some post-2018 files already provide the full 5-digit FIPS in county_code.
    if "state_code" in df.columns and "county_fips" in df.columns:
        sc = df["state_code"].astype(str).str.strip().str.zfill(2)
        co = df["county_fips"].astype(str).str.strip()
        # If county_code already looks like 5-digit FIPS, use as-is
        already_five = co.str.len() == 5
        df.loc[~already_five, "county_fips"] = sc[~already_five] + co[~already_five].str.zfill(3)

    # ── Filter to originated mortgage loans ───────────────────────────────────
    mask = df["action_taken"] == ACTION_ORIGINATED
    if is_post2018:
        mask &= df["loan_purpose"].isin(MORTGAGE_PURPOSES_POST2018)
    else:
        mask &= df["loan_purpose"].isin(MORTGAGE_PURPOSES_PRE2018)
        # Pre-2018: optionally restrict to CU-only (agency_code=7) if desired;
        # we keep all institution types for competitive market share.

    df = df[mask].copy()
    df = df[df["county_fips"].str.len() == 5]          # drop bad FIPS
    df = df[df["county_fips"].str.isdigit()]           # drop non-numeric FIPS
    logger.info("Kept %d originated mortgage rows after filter", len(df))
    return df


# ── Aggregate ─────────────────────────────────────────────────────────────────

def aggregate_by_county(df: pd.DataFrame) -> pd.DataFrame:
    """Summarise origination count and volume by respondent_id × county_fips × loan_purpose."""
    group_cols = [c for c in ["respondent_id", "state_code", "county_fips", "loan_purpose"]
                  if c in df.columns]
    agg = (
        df.groupby(group_cols, dropna=False)
        .agg(
            origination_count=("loan_amount", "count"),
            origination_volume=("loan_amount", "sum"),
        )
        .reset_index()
    )
    agg["origination_volume"] = pd.to_numeric(agg["origination_volume"], errors="coerce").astype("Int64")
    return agg


# ── Upsert ────────────────────────────────────────────────────────────────────

def upsert(df: pd.DataFrame, year: int, db_url: str | None = None) -> int:
    engine = get_engine(db_url)
    df = df.copy()
    df["year"] = year

    table_cols = {c.name for c in hmda_originations.c}
    store_df   = df[[c for c in df.columns if c in table_cols]].copy()
    records    = store_df.where(pd.notna(store_df), other=None).to_dict("records")

    pk_cols    = {"year", "respondent_id", "county_fips", "loan_purpose"}
    update_cols = [c for c in table_cols if c not in pk_cols and c != "ingested_at"]

    total = 0
    with engine.begin() as conn:
        for i in range(0, len(records), 500):
            batch = records[i : i + 500]
            stmt  = pg_insert(hmda_originations).values(batch)
            stmt  = stmt.on_conflict_do_update(
                index_elements=list(pk_cols),
                set_={col: stmt.excluded[col] for col in update_cols},
            )
            total += conn.execute(stmt).rowcount

    logger.info("Upserted %d HMDA origination rows for %d", total, year)
    return total


# ── Entry point ───────────────────────────────────────────────────────────────

def ingest(year: int, db_url: str | None = None, local_file: str | None = None) -> None:
    path = fetch_lar(year, local_file=local_file)
    df   = parse_lar(path, year)
    df   = aggregate_by_county(df)
    upsert(df, year, db_url)


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest HMDA LAR originations")
    parser.add_argument("--year", type=int, required=True, help="e.g. 2023")
    parser.add_argument("--db-url", default=None)
    parser.add_argument(
        "--file",
        default=None,
        metavar="PATH",
        help=(
            "Path to a pre-downloaded HMDA LAR zip or CSV. "
            "Skips automatic download. "
            f"Download from: {MANUAL_DOWNLOAD_PAGE}"
        ),
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    ingest(args.year, args.db_url, local_file=args.file)


if __name__ == "__main__":
    main()
