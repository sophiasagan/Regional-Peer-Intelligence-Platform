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
import io
import logging
import shutil
import zipfile
import zlib
from pathlib import Path

import numpy as np
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


# ── Extraction helpers ────────────────────────────────────────────────────────

_ZIP_MAGIC = b"PK\x03\x04"


class _DeflateStream(io.RawIOBase):
    """Wrap a raw-DEFLATE compressed source as a readable byte stream.

    Used when a ZIP was created in streaming mode (data-descriptor bit set) and
    was never finalized with a central directory, so Python's zipfile raises
    BadZipFile.  We skip the local file header manually and decompress on the fly.
    """

    def __init__(self, source: io.IOBase) -> None:
        self._src  = source
        self._dec  = zlib.decompressobj(wbits=-15)  # raw DEFLATE
        self._buf  = b""
        self._done = False

    def readable(self) -> bool:
        return True

    def readinto(self, b: bytearray) -> int:
        while not self._buf and not self._done:
            raw = self._src.read(1 << 20)  # 1 MB chunks
            if not raw:
                self._done = True
                break
            try:
                self._buf += self._dec.decompress(raw)
            except zlib.error:
                # DEFLATE stream ended; data descriptor may follow — stop here
                try:
                    self._buf += self._dec.flush()
                except zlib.error:
                    pass
                self._done = True
        n = min(len(b), len(self._buf))
        b[:n] = self._buf[:n]
        self._buf = self._buf[n:]
        return n


def _open_streaming_zip(zip_path: Path) -> io.TextIOWrapper:
    """Return a text stream over the first DEFLATE entry in a no-EOCD ZIP.

    Opens the file, reads the local file header, and returns a latin-1 text
    wrapper over the decompressed byte stream WITHOUT writing to disk.
    """
    fh = open(zip_path, "rb")
    sig = fh.read(4)
    if sig != _ZIP_MAGIC:
        fh.close()
        raise RuntimeError(f"Not a ZIP local header: {sig!r}")

    fh.read(2)  # version needed
    fh.read(2)  # flags
    method = int.from_bytes(fh.read(2), "little")
    fh.read(4)  # mod time + date
    fh.read(4)  # crc32
    fh.read(4)  # compressed size  (0 / 0xFFFFFFFF in streaming zips)
    fh.read(4)  # uncompressed size
    fname_len = int.from_bytes(fh.read(2), "little")
    extra_len = int.from_bytes(fh.read(2), "little")
    fname = fh.read(fname_len).decode("utf-8", errors="replace")
    fh.read(extra_len)

    logger.info(
        "Streaming ZIP64 (no EOCD): entry=%s  method=%d  data_start=%d",
        fname, method, fh.tell(),
    )
    if method != 8:
        fh.close()
        raise RuntimeError(f"Expected DEFLATE (8), got method {method}")

    raw   = _DeflateStream(fh)
    buf   = io.BufferedReader(raw, buffer_size=1 << 20)
    return io.TextIOWrapper(buf, encoding="latin-1", errors="replace")


def _extract_csv(zip_path: Path, extract_dir: Path, max_depth: int = 3) -> Path:
    """Extract the largest member from a zip, recursing if it is itself a zip.

    Checks magic bytes (PK\\x03\\x04) rather than file extension so that
    zip-in-zip structures (CFPB sometimes ships outer.zip → inner.zip → data.csv)
    are fully unwrapped regardless of what the extracted file is named.
    """
    # Verify it's actually a zip before opening
    try:
        with open(zip_path, "rb") as f:
            magic = f.read(4)
    except OSError as exc:
        raise RuntimeError(f"Cannot read {zip_path}: {exc}") from exc

    if magic != _ZIP_MAGIC:
        logger.info("Not a zip (magic=%r) — using as-is: %s", magic, zip_path)
        return zip_path

    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        # If magic is PK\x03\x04 the file IS a ZIP but has no central directory
        # (streaming ZIP64 created without finalizing EOCD).  Signal the caller
        # to use _open_streaming_zip instead — return a sentinel value None.
        logger.info(
            "BadZipFile on a file with ZIP magic — streaming ZIP64 (no EOCD): %s", zip_path
        )
        return None  # sentinel: caller must use _open_streaming_zip

    with zf:
        members = zf.infolist()
        logger.info("zip %s: %d entries", zip_path.name, len(members))
        for m in members[:10]:
            logger.info(
                "  %-50s  compress=%d  uncompressed=%d  method=%d",
                m.filename, m.compress_size, m.file_size, m.compress_type,
            )

        # Largest by compress_size — correct even for ZIP64 streaming archives
        # because Python reads sizes from the central directory, not local headers.
        target = max(members, key=lambda m: m.compress_size)
        logger.info("Selected: %s (%.1f MB compressed)", target.filename, target.compress_size / 1e6)

        out_path = extract_dir / Path(target.filename).name   # flatten subdirectory
        out_path.unlink(missing_ok=True)                      # remove any stale file
        with zf.open(target) as src, open(out_path, "wb") as dst:
            shutil.copyfileobj(src, dst)

    out_size = out_path.stat().st_size
    logger.info("Extracted → %s (%.1f MB)", out_path.name, out_size / 1e6)

    # Peek at the extracted file — if it's another zip, recurse
    with open(out_path, "rb") as f:
        inner_magic = f.read(4)

    if inner_magic == _ZIP_MAGIC:
        if max_depth <= 1:
            raise RuntimeError(
                f"Nested zip too deep (max_depth reached) at {out_path}. "
                "Inspect the file manually."
            )
        logger.info("Extracted file is itself a zip — recursing: %s", out_path.name)
        return _extract_csv(out_path, extract_dir, max_depth=max_depth - 1)

    return out_path


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

    extract_dir = dest / f"hmda_lar_{year}"
    extract_dir.mkdir(exist_ok=True)

    # Recursively extract until we reach actual CSV/text content.
    # CFPB sometimes ships zip-in-zip (outer zip → inner zip → CSV).
    csv_path = _extract_csv(zip_path, extract_dir, max_depth=3)

    if csv_path is None:
        # Streaming ZIP64 with no central directory — cannot use zipfile.
        # Signal ingest() to use _open_streaming_zip for on-the-fly DEFLATE.
        logger.info("Streaming ZIP64 (no EOCD) — will parse on-the-fly: %s", zip_path)
        return "__streaming__:" + str(zip_path)

    size_mb = csv_path.stat().st_size / 1e6
    logger.info("Final file: %s (%.1f MB)", csv_path, size_mb)
    if size_mb < 1:
        raise RuntimeError(
            f"Extracted file is suspiciously small ({size_mb:.1f} MB): {csv_path}. "
            "The zip may be corrupted or the wrong member was selected."
        )
    return str(csv_path)


# ── Parse ─────────────────────────────────────────────────────────────────────

def parse_lar(path_or_stream: "str | io.TextIOWrapper", year: int) -> pd.DataFrame:
    """Read LAR, auto-detect schema, return cleaned DataFrame.

    Accepts either a file path (str) or a TextIOWrapper already positioned at
    the first byte of a streaming ZIP64 that has been opened with
    _open_streaming_zip().  For streams the header line is consumed here and
    then pd.read_csv is called with explicit column names so it reads the
    remaining data rows without trying to seek back to the start.
    """
    is_stream = not isinstance(path_or_stream, str)

    if is_stream:
        logger.info("Parsing HMDA LAR from streaming ZIP64 source")
        header_line = path_or_stream.readline()
        read_source = path_or_stream          # stream is now at first data row
    else:
        logger.info("Parsing HMDA LAR from %s", path_or_stream)
        with open(path_or_stream, "r", encoding="latin-1", errors="replace") as fh:
            header_line = fh.readline()
        read_source = path_or_stream          # re-read from start for pd.read_csv

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

    csv_kwargs: dict = dict(
        sep=sep,
        dtype=str,
        engine="python",    # C parser overflows on some HMDA rows
        on_bad_lines="warn",
        chunksize=500_000,  # process 500k rows at a time — avoids OOM on ~7 GB CSV
    )

    # Only load the ~7 columns we need from the 90+ in the file (~13× memory reduction)
    field_map_lower = {k.lower(): v for k, v in field_map.items()}
    usecols_names = [col for col in header_cols if col in field_map_lower]
    csv_kwargs["usecols"] = usecols_names

    if is_stream:
        # Header already consumed — provide column names explicitly so pandas
        # reads the stream as data-only (no header row to skip / seek back for).
        csv_kwargs["names"]  = header_cols
        csv_kwargs["header"] = None
    else:
        csv_kwargs["encoding"]    = "latin-1"
        csv_kwargs["compression"] = None   # file may have .zip ext but be CSV

    # Read in 500k-row chunks and filter each chunk immediately so we never hold
    # the full ~7 GB decompressed dataset in memory at once.
    filtered_chunks: list[pd.DataFrame] = []
    total_read = 0

    for chunk in pd.read_csv(read_source, **csv_kwargs):
        total_read += len(chunk)

        chunk.columns = [c.strip().lower() for c in chunk.columns]
        chunk = chunk.rename(columns=field_map_lower)

        for col in ("year", "action_taken", "loan_purpose", "loan_amount"):
            if col in chunk.columns:
                chunk[col] = pd.to_numeric(chunk[col], errors="coerce")
        if "agency_code" in chunk.columns:
            chunk["agency_code"] = pd.to_numeric(chunk["agency_code"], errors="coerce")

        # Normalise county FIPS to 5-char string
        # Post-2018: state_code="26", county_code="049" → "26049"
        # Pre-2018:  state_code="MI", county_code="049" → "26049" (after FIPS lookup — kept as-is here)
        if "state_code" in chunk.columns and "county_fips" in chunk.columns:
            sc = chunk["state_code"].astype(str).str.strip().str.zfill(2)
            co = chunk["county_fips"].astype(str).str.strip()
            already_five = co.str.len() == 5
            chunk.loc[~already_five, "county_fips"] = (
                sc[~already_five] + co[~already_five].str.zfill(3)
            )

        # Filter to originated mortgage loans (typically ~15% of rows)
        mask = chunk["action_taken"] == ACTION_ORIGINATED
        if is_post2018:
            mask &= chunk["loan_purpose"].isin(MORTGAGE_PURPOSES_POST2018)
        else:
            mask &= chunk["loan_purpose"].isin(MORTGAGE_PURPOSES_PRE2018)

        chunk = chunk[mask].copy()

        # Convert to int now that NaNs are gone — avoids float64 reaching the DB
        for col in ("action_taken", "loan_purpose"):
            if col in chunk.columns:
                chunk[col] = chunk[col].astype(int)

        if "county_fips" in chunk.columns:
            chunk = chunk[chunk["county_fips"].astype(str).str.len() == 5]
            chunk = chunk[chunk["county_fips"].astype(str).str.isdigit()]

        if not chunk.empty:
            filtered_chunks.append(chunk)

        if total_read % (500_000 * 10) == 0:
            kept = sum(len(c) for c in filtered_chunks)
            logger.info(
                "Progress: %d rows read, %d originated mortgage rows kept",
                total_read, kept,
            )

    logger.info("Total rows processed: %d", total_read)

    if not filtered_chunks:
        logger.warning("No originated mortgage rows found in HMDA data")
        return pd.DataFrame()

    df = pd.concat(filtered_chunks, ignore_index=True)
    logger.info("Kept %d originated mortgage rows after filter", len(df))
    return df


# ── Aggregate ─────────────────────────────────────────────────────────────────

def aggregate_by_county(df: pd.DataFrame) -> pd.DataFrame:
    """Summarise origination count and volume by respondent_id × county_fips × loan_purpose.

    state_code is intentionally excluded from the groupby key: it is NOT part of
    the DB primary key (year, respondent_id, county_fips, loan_purpose), and
    including it causes CardinalityViolation when the same (respondent, county,
    purpose) appears with different state_code values in the same batch.
    """
    group_cols = [c for c in ["respondent_id", "county_fips", "loan_purpose"]
                  if c in df.columns]

    agg_spec: dict = dict(
        origination_count=("loan_amount", "count"),
        origination_volume=("loan_amount", "sum"),
    )
    if "state_code" in df.columns:
        agg_spec["state_code"] = ("state_code", "first")

    agg = (
        df.groupby(group_cols, dropna=False)
        .agg(**agg_spec)
        .reset_index()
    )
    agg["origination_count"]  = agg["origination_count"].fillna(0).astype(int)
    agg["origination_volume"] = pd.to_numeric(agg["origination_volume"], errors="coerce").fillna(0).astype(int)
    return agg


# ── Upsert ────────────────────────────────────────────────────────────────────

def upsert(df: pd.DataFrame, year: int, db_url: str | None = None) -> int:
    engine = get_engine(db_url)
    df = df.copy()
    df["year"] = year

    table_cols = {c.name for c in hmda_originations.c}
    store_df   = df[[c for c in df.columns if c in table_cols]].copy()

    def _pyval(v: object) -> object:
        """Convert numpy/pandas scalars to Python natives for psycopg2.

        psycopg2 cannot adapt numpy.int64, numpy.float64, or pd.NA directly.
        Whole-number floats (e.g. loan_purpose=31.0) must become Python int
        so PostgreSQL integer columns don't reject them.
        """
        if v is None or v is pd.NA:
            return None
        if isinstance(v, float) and v != v:  # NaN
            return None
        if isinstance(v, (np.integer, int)):
            return int(v)
        if isinstance(v, (np.floating, float)):
            int_v = int(v)
            return int_v if v == int_v else float(v)
        return v

    records = [
        {k: _pyval(v) for k, v in row.items()}
        for row in store_df.where(pd.notna(store_df), other=None).to_dict("records")
    ]

    pk_cols    = {"year", "respondent_id", "county_fips", "loan_purpose"}
    update_cols = [c for c in table_cols if c not in pk_cols and c != "ingested_at"]

    total = 0
    with engine.begin() as conn:
        for i in range(0, len(records), 500):
            batch = records[i : i + 500]
            stmt  = pg_insert(hmda_originations).values(batch)
            stmt  = stmt.on_conflict_do_update(
                index_elements=sorted(pk_cols),  # sorted for deterministic order
                set_={col: stmt.excluded[col] for col in update_cols},
            )
            try:
                total += conn.execute(stmt).rowcount
            except Exception as exc:
                # Log the raw DBAPI message before SQLAlchemy buries it under params
                raw = getattr(exc, "orig", exc)
                logger.error("Upsert batch %d-%d failed — %s: %s",
                             i, i + len(batch), type(raw).__name__, raw)
                raise

    logger.info("Upserted %d HMDA origination rows for %d", total, year)
    return total


# ── Entry point ───────────────────────────────────────────────────────────────

def ingest(year: int, db_url: str | None = None, local_file: str | None = None) -> None:
    path = fetch_lar(year, local_file=local_file)
    if path.startswith("__streaming__:"):
        # ZIP64 with no central directory — decompress on the fly via raw DEFLATE
        actual_zip = Path(path[len("__streaming__:"):])
        logger.info("Streaming DEFLATE decompression: %s", actual_zip)
        stream = _open_streaming_zip(actual_zip)
        df = parse_lar(stream, year)
    else:
        df = parse_lar(path, year)
    df = aggregate_by_county(df)
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
