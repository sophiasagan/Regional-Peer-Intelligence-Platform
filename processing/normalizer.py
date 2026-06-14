"""Normalize schemas and link NCUA–FDIC institution identifiers.

Resolves the identity gap between NCUA charter numbers and FDIC cert numbers
using the NCUA/FDIC crosswalk. Standardises column names, data types,
and period formats across all ingested sources.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd
import requests

logger = logging.getLogger(__name__)

# NCUA publishes a crosswalk mapping charter numbers to FDIC cert numbers.
# Downloaded on demand and cached locally.
CROSSWALK_URL = (
    "https://www.ncua.gov/analysis/credit-union-corporate-call-report-data/"
    "credit-union-data-definition/crosswalk.csv"
)
_CROSSWALK_CACHE: dict[int, int] = {}


def load_crosswalk(path: str | None = None, force_download: bool = False) -> dict[int, int]:
    """Return {charter_number: fdic_cert} mapping.

    Downloads from NCUA if path is not provided or if file doesn't exist.
    """
    if _CROSSWALK_CACHE and not force_download:
        return _CROSSWALK_CACHE

    cache_path = Path(path or "data/raw/ncua_fdic_crosswalk.csv")

    if force_download or not cache_path.exists():
        logger.info("Downloading NCUA–FDIC crosswalk")
        resp = requests.get(CROSSWALK_URL, timeout=60)
        resp.raise_for_status()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(resp.content)

    df = pd.read_csv(cache_path, dtype=str)

    # Column names vary; normalise to lowercase
    df.columns = [c.lower().strip() for c in df.columns]
    cu_col = next((c for c in df.columns if "charter" in c or "cu_number" in c), None)
    fdic_col = next((c for c in df.columns if "cert" in c or "fdic" in c), None)

    if cu_col is None or fdic_col is None:
        raise ValueError(f"Cannot find charter/cert columns in crosswalk: {df.columns.tolist()}")

    _CROSSWALK_CACHE.clear()
    _CROSSWALK_CACHE.update(
        {
            int(r[cu_col]): int(r[fdic_col])
            for _, r in df.iterrows()
            if pd.notna(r[cu_col]) and pd.notna(r[fdic_col])
        }
    )
    logger.info("Loaded crosswalk with %d entries", len(_CROSSWALK_CACHE))
    return _CROSSWALK_CACHE


def link_identifiers(ncua_df: pd.DataFrame, fdic_df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Add fdic_cert to NCUA rows and charter_number to FDIC rows where a match exists."""
    crosswalk = load_crosswalk()
    reverse = {v: k for k, v in crosswalk.items()}

    if "charter_number" in ncua_df.columns:
        ncua_df = ncua_df.copy()
        ncua_df["fdic_cert"] = ncua_df["charter_number"].map(crosswalk)

    if "fdic_cert" in fdic_df.columns:
        fdic_df = fdic_df.copy()
        fdic_df["charter_number"] = fdic_df["fdic_cert"].map(reverse)

    return ncua_df, fdic_df


def standardize_period(df: pd.DataFrame, col: str = "period") -> pd.DataFrame:
    """Normalise period column to 'YYYY-QN' string (e.g. '2026Q1' → '2026Q1').

    Handles: '2026Q1', '2026-Q1', 'Q1 2026', datetime objects.
    """
    if col not in df.columns:
        return df

    df = df.copy()

    def _normalise(val: str) -> str | None:
        if pd.isna(val):
            return None
        val = str(val).strip().replace("-", "").replace(" ", "")
        # Already in YYYYQN format
        if len(val) == 6 and val[:4].isdigit() and val[4] == "Q" and val[5] in "1234":
            return val
        # Try parsing as date
        try:
            dt = pd.to_datetime(val)
            q = (dt.month - 1) // 3 + 1
            return f"{dt.year}Q{q}"
        except Exception:
            return None

    df[col] = df[col].map(_normalise)
    return df


def standardize_dtypes(df: pd.DataFrame) -> pd.DataFrame:
    """Cast monetary columns to Int64, ratios to float64, codes to str."""
    df = df.copy()
    for col in df.columns:
        lower = col.lower()
        if any(kw in lower for kw in ("acct_", "deposit", "loan", "asset", "income", "expense")):
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
        elif any(kw in lower for kw in ("rate", "ratio", "pct", "latitude", "longitude")):
            df[col] = pd.to_numeric(df[col], errors="coerce").astype(float)
        elif any(kw in lower for kw in ("fips", "code", "number", "name")):
            df[col] = df[col].astype(str).where(df[col].notna(), other=None)
    return df
