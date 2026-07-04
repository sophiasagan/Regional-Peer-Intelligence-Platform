"""Market share engine: deposit, loan, member, and mortgage share by geography and period.

Data sources:
  deposits:              FDIC Summary of Deposits (banks, measured) + CU allocations (modeled)
  loans:                 CU total loans from NCUA (state) or CU allocations (county/MSA)
                         + HMDA mortgage originations for cross-institution comparison
  members:               NCUA 5300 acct_083 — CU-only (banks have no equivalent)
  mortgage_originations: HMDA (all institution types, measured)

Confidence levels (displayed on EVERY geographic figure — P76 rule):
  measured  — FDIC branch-level or HMDA — teal badge
  modeled   — CU estimation model allocation, ±8% validated — blue badge
  estimated — proxy-based (ratio-allocated from institution total) — amber badge
"""

from __future__ import annotations

import logging
from typing import Literal, Optional

import pandas as pd
from sqlalchemy import select, text

from db import fdic_deposits, get_engine, hmda_originations, hmda_respondents, institutions_quarterly

logger = logging.getLogger(__name__)

GeoType = Literal["county", "msa", "state", "custom_region"]
Metric  = Literal["deposits", "loans", "members", "mortgage_originations"]


# ── Period helpers ────────────────────────────────────────────────────────────

def _period_to_fdic_year(period: str) -> int:
    """'2026Q1' or '2026' → 2026 (FDIC/HMDA data is annual)."""
    return int(period[:4])


def _prior_quarter(period: str) -> str:
    """'2026Q2' → '2026Q1', '2026Q1' → '2025Q4'."""
    year    = int(period[:4])
    quarter = int(period[5])
    quarter -= 1
    if quarter == 0:
        quarter = 4
        year   -= 1
    return f"{year}Q{quarter}"


def _prior_year_period(period: str) -> str:
    """'2026Q1' → '2025Q1', '2026' → '2025'."""
    if "Q" in period:
        return f"{int(period[:4]) - 1}{period[4:]}"
    return str(int(period) - 1)


def _is_quarterly(period: str) -> bool:
    return "Q" in period


# ── Geography resolution ──────────────────────────────────────────────────────

def _resolve_msa_counties(msa_cbsa: str, engine) -> list[str]:
    """Return list of county FIPS codes for a CBSA MSA code.

    Queries geo_cbsa_counties table; raises ValueError if table not found.
    """
    try:
        with engine.connect() as conn:
            result = conn.execute(
                text("SELECT county_fips FROM geo_cbsa_counties WHERE cbsa_code = :cbsa"),
                {"cbsa": msa_cbsa},
            )
            fips_list = [str(row[0]) for row in result]
        if not fips_list:
            raise ValueError(f"No counties found for MSA {msa_cbsa}")
        return fips_list
    except Exception as exc:
        raise ValueError(
            f"Cannot resolve MSA {msa_cbsa} to counties: {exc}. "
            "Ensure geo_cbsa_counties table is loaded (run ingestion/geo_ingester.py)."
        ) from exc


def _resolve_custom_region_counties(region_id: str, engine) -> list[str]:
    """Return county FIPS list for a custom region.

    Accepts two formats:
      - Comma-separated 5-digit FIPS: "26049,26157,26125" (from the frontend multi-picker)
      - UUID: looks up geography_ids in the peer_groups table
    """
    # Fast path: comma-separated FIPS sent directly from the multi-picker
    parts = [p.strip() for p in region_id.split(",") if p.strip()]
    if parts and all(len(p) == 5 and p.isdigit() for p in parts):
        return parts

    # UUID path: look up in peer_groups
    try:
        with engine.connect() as conn:
            result = conn.execute(
                text("SELECT geography_ids FROM peer_groups WHERE id = :id AND geography_type = 'county'"),
                {"id": region_id},
            )
            row = result.mappings().first()
        if row and row["geography_ids"]:
            return list(row["geography_ids"])
        raise ValueError(f"Custom region {region_id} not found or has no county FIPS list")
    except Exception as exc:
        raise ValueError(f"Cannot resolve custom region {region_id}: {exc}") from exc


# ── FDIC data loaders ─────────────────────────────────────────────────────────

def _fetch_fdic_deposits(
    geography_type: GeoType,
    geography_id: str,
    year: int,
    engine,
) -> pd.DataFrame:
    """Load bank/thrift deposit data from FDIC Summary of Deposits.

    FDIC SOD is an annual snapshot (as of June 30). When the requested year
    has no data yet (e.g. 2026 data requested but only 2024 ingested), falls
    back up to 2 prior years so recent quarterly periods still return data.

    Returns columns: charter_or_cert, institution_name, metric_value, confidence, data_period
    """
    def _query_county(fips: str, y: int) -> pd.DataFrame:
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    fdic_deposits.c.fdic_cert,
                    fdic_deposits.c.institution_name,
                    fdic_deposits.c.deposits,
                ).where(
                    fdic_deposits.c.county_fips == fips,
                    fdic_deposits.c.year == y,
                )
            )
            return pd.DataFrame(result.mappings().all())

    def _query_state(state_abbrev: str, y: int) -> pd.DataFrame:
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    fdic_deposits.c.fdic_cert,
                    fdic_deposits.c.institution_name,
                    fdic_deposits.c.deposits,
                ).where(
                    fdic_deposits.c.state_code == state_abbrev,
                    fdic_deposits.c.year == y,
                )
            )
            return pd.DataFrame(result.mappings().all())

    def _fetch_for_year(y: int) -> pd.DataFrame:
        if geography_type == "county":
            return _query_county(geography_id, y)
        elif geography_type == "state":
            return _query_state(geography_id, y)
        elif geography_type in ("msa", "custom_region"):
            counties = (
                _resolve_msa_counties(geography_id, engine)
                if geography_type == "msa"
                else _resolve_custom_region_counties(geography_id, engine)
            )
            frames = [_query_county(c, y) for c in counties]
            return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        else:
            raise ValueError(f"Unsupported geography_type: {geography_type}")

    # Try requested year then fall back — FDIC SOD lags by ~6 months
    actual_year = year
    raw = pd.DataFrame()
    for try_year in [year, year - 1, year - 2]:
        raw = _fetch_for_year(try_year)
        if not raw.empty:
            actual_year = try_year
            break

    if raw.empty:
        return raw

    # Aggregate (multiple branches per institution in multi-county pulls)
    agg = (
        raw.groupby(["fdic_cert", "institution_name"])["deposits"]
        .sum()
        .reset_index()
    )
    agg.columns = ["fdic_cert", "institution_name", "metric_value"]
    agg["charter_or_cert"] = "fdic:" + agg["fdic_cert"].astype(str)
    agg["institution_type"] = "bank"
    agg["confidence"]       = "measured"
    agg["data_period"]      = str(actual_year)
    return agg[["charter_or_cert", "institution_name", "institution_type",
                "metric_value", "confidence", "data_period"]]


# ── CU deposit allocation loaders ─────────────────────────────────────────────

def _fetch_cu_deposits_allocated(
    geography_type: GeoType,
    geography_id: str,
    period: str,
    engine,
) -> pd.DataFrame:
    """Load CU deposit allocations from cu_deposit_allocations table.

    For state level: falls back to institution-level NCUA totals (acct_018) filtered by state.
    Returns columns: charter_or_cert, institution_name, metric_value, confidence, data_period
    """
    def _alloc_for_county(fips: str) -> pd.DataFrame:
        try:
            with engine.connect() as conn:
                result = conn.execute(
                    text(
                        "SELECT charter_number, institution_name, allocated_deposits, confidence_level "
                        "FROM cu_deposit_allocations WHERE county_fips = :fips AND period = :period"
                    ),
                    {"fips": fips, "period": period},
                )
                return pd.DataFrame(result.mappings().all())
        except Exception:
            # Table doesn't exist yet (run migrations/add_cu_deposit_allocations.sql
            # then processing/compute_cu_allocations.py to populate)
            return pd.DataFrame()

    def _ncua_totals_by_state(state_abbrev: str) -> pd.DataFrame:
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    institutions_quarterly.c.charter_number,
                    institutions_quarterly.c.institution_name,
                    institutions_quarterly.c.acct_018,   # total shares and deposits
                ).where(
                    institutions_quarterly.c.state_code == state_abbrev,
                    institutions_quarterly.c.period == period,
                    institutions_quarterly.c.acct_018.isnot(None),
                )
            )
            df = pd.DataFrame(result.mappings().all())
        df = df.rename(columns={"acct_018": "allocated_deposits"})
        df["confidence_level"] = "measured"   # institution-level NCUA data is measured
        return df

    if geography_type == "state":
        raw = _ncua_totals_by_state(geography_id)
    elif geography_type == "county":
        raw = _alloc_for_county(geography_id)
    elif geography_type in ("msa", "custom_region"):
        counties = (
            _resolve_msa_counties(geography_id, engine)
            if geography_type == "msa"
            else _resolve_custom_region_counties(geography_id, engine)
        )
        frames = [_alloc_for_county(c) for c in counties]
        raw = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    else:
        raise ValueError(f"Unsupported geography_type: {geography_type}")

    if raw.empty:
        return raw

    agg = (
        raw.groupby(["charter_number", "institution_name"])
        .agg(
            metric_value=("allocated_deposits", "sum"),
            confidence=("confidence_level", "first"),
        )
        .reset_index()
    )
    agg["charter_or_cert"]  = "ncua:" + agg["charter_number"].astype(str)
    agg["institution_type"] = "cu"
    agg["data_period"]      = period
    return agg[["charter_or_cert", "institution_name", "institution_type",
                "metric_value", "confidence", "data_period"]]


# ── CU loans loader ───────────────────────────────────────────────────────────

def _fetch_cu_loans(
    geography_type: GeoType,
    geography_id: str,
    period: str,
    engine,
) -> pd.DataFrame:
    """Load CU total loan balances from NCUA institutions_quarterly.

    State level: direct from NCUA (measured).
    County/MSA: estimated by applying county deposit allocation ratio to institution total.
    Returns: charter_or_cert, institution_name, metric_value, confidence, data_period
    """
    if geography_type == "state":
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    institutions_quarterly.c.charter_number,
                    institutions_quarterly.c.institution_name,
                    institutions_quarterly.c.acct_025B,   # total loans and leases
                ).where(
                    institutions_quarterly.c.state_code == geography_id,
                    institutions_quarterly.c.period == period,
                    institutions_quarterly.c.acct_025B.isnot(None),
                )
            )
            df = pd.DataFrame(result.mappings().all())

        if df.empty:
            return df

        df = df.rename(columns={"acct_025B": "metric_value"})
        df["charter_or_cert"]  = "ncua:" + df["charter_number"].astype(str)
        df["institution_type"] = "cu"
        df["confidence"]       = "measured"
        df["data_period"]      = period
        return df[["charter_or_cert", "institution_name", "institution_type",
                   "metric_value", "confidence", "data_period"]]

    # county / msa: use deposit allocation ratio as a proxy for loan allocation
    cu_dep = _fetch_cu_deposits_allocated(geography_type, geography_id, period, engine)
    if cu_dep.empty:
        return cu_dep

    # Pull full institution loan totals for the same charters
    charter_nums = [int(c.split(":")[1]) for c in cu_dep["charter_or_cert"]]
    with engine.connect() as conn:
        result = conn.execute(
            select(
                institutions_quarterly.c.charter_number,
                institutions_quarterly.c.acct_018,    # total deposits (institution level)
                institutions_quarterly.c.acct_025B,   # total loans (institution level)
            ).where(
                institutions_quarterly.c.charter_number.in_(charter_nums),
                institutions_quarterly.c.period == period,
            )
        )
        totals_df = pd.DataFrame(result.mappings().all())

    if totals_df.empty:
        return pd.DataFrame()

    # Ratio: county_deposits / total_deposits → apply to total loans
    cu_dep["charter_number"] = cu_dep["charter_or_cert"].str.replace("ncua:", "").astype(int)
    merged = cu_dep.merge(
        totals_df.rename(columns={"acct_018": "inst_total_deposits", "acct_025B": "inst_total_loans"}),
        on="charter_number",
        how="inner",
    )

    # Allocation ratio = county_deposit_share / institution_total_deposits
    mask = merged["inst_total_deposits"] > 0
    merged.loc[mask, "metric_value"] = (
        merged.loc[mask, "metric_value"] / merged.loc[mask, "inst_total_deposits"]
        * merged.loc[mask, "inst_total_loans"]
    )
    merged = merged[mask]
    merged["confidence"] = "estimated"   # ratio allocation is estimated
    return merged[["charter_or_cert", "institution_name", "institution_type",
                   "metric_value", "confidence", "data_period"]]


# ── CU members loader ─────────────────────────────────────────────────────────

def _fetch_cu_members(
    geography_type: GeoType,
    geography_id: str,
    period: str,
    engine,
) -> pd.DataFrame:
    """Load CU member counts (NCUA acct_083). CU-only metric.

    State level: direct from NCUA (measured).
    County/MSA: estimated via deposit allocation ratio.
    """
    if geography_type == "state":
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    institutions_quarterly.c.charter_number,
                    institutions_quarterly.c.institution_name,
                    institutions_quarterly.c.acct_083,   # member count
                ).where(
                    institutions_quarterly.c.state_code == geography_id,
                    institutions_quarterly.c.period == period,
                    institutions_quarterly.c.acct_083.isnot(None),
                )
            )
            df = pd.DataFrame(result.mappings().all())

        if df.empty:
            return df
        df = df.rename(columns={"acct_083": "metric_value"})
        df["charter_or_cert"]  = "ncua:" + df["charter_number"].astype(str)
        df["institution_type"] = "cu"
        df["confidence"]       = "measured"
        df["data_period"]      = period
        return df[["charter_or_cert", "institution_name", "institution_type",
                   "metric_value", "confidence", "data_period"]]

    # County / MSA: estimated via deposit share ratio
    cu_dep = _fetch_cu_deposits_allocated(geography_type, geography_id, period, engine)
    if cu_dep.empty:
        return cu_dep

    charter_nums = [int(c.split(":")[1]) for c in cu_dep["charter_or_cert"]]
    with engine.connect() as conn:
        result = conn.execute(
            select(
                institutions_quarterly.c.charter_number,
                institutions_quarterly.c.acct_018,
                institutions_quarterly.c.acct_083,
            ).where(
                institutions_quarterly.c.charter_number.in_(charter_nums),
                institutions_quarterly.c.period == period,
            )
        )
        totals_df = pd.DataFrame(result.mappings().all())

    if totals_df.empty:
        return pd.DataFrame()

    cu_dep["charter_number"] = cu_dep["charter_or_cert"].str.replace("ncua:", "").astype(int)
    merged = cu_dep.merge(
        totals_df.rename(columns={"acct_018": "inst_total_deposits", "acct_083": "inst_members"}),
        on="charter_number",
        how="inner",
    )
    mask = merged["inst_total_deposits"] > 0
    merged.loc[mask, "metric_value"] = (
        merged.loc[mask, "metric_value"] / merged.loc[mask, "inst_total_deposits"]
        * merged.loc[mask, "inst_members"]
    ).round(0)
    merged = merged[mask]
    merged["confidence"] = "estimated"
    return merged[["charter_or_cert", "institution_name", "institution_type",
                   "metric_value", "confidence", "data_period"]]


# ── HMDA mortgage originations loader ────────────────────────────────────────

def _fetch_hmda_originations(
    geography_type: GeoType,
    geography_id: str,
    year: int,
    engine,
) -> pd.DataFrame:
    """Load HMDA mortgage origination volumes (all institution types, measured).

    HMDA data lags ~18 months — falls back up to 2 prior years when the
    requested year has no data yet.

    Returns: charter_or_cert, institution_name, metric_value, confidence, data_period
    """
    def _query_county(fips: str, y: int) -> pd.DataFrame:
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    hmda_originations.c.respondent_id,
                    hmda_originations.c.origination_count,
                    hmda_originations.c.origination_volume,
                ).where(
                    hmda_originations.c.county_fips == fips,
                    hmda_originations.c.year == y,
                )
            )
            return pd.DataFrame(result.mappings().all())

    def _query_state(state_abbrev: str, y: int) -> pd.DataFrame:
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    hmda_originations.c.respondent_id,
                    hmda_originations.c.origination_count,
                    hmda_originations.c.origination_volume,
                ).where(
                    hmda_originations.c.state_code == state_abbrev,
                    hmda_originations.c.year == y,
                )
            )
            return pd.DataFrame(result.mappings().all())

    def _fetch_for_year(y: int) -> pd.DataFrame:
        if geography_type == "county":
            return _query_county(geography_id, y)
        elif geography_type == "state":
            return _query_state(geography_id, y)
        elif geography_type in ("msa", "custom_region"):
            counties = (
                _resolve_msa_counties(geography_id, engine)
                if geography_type == "msa"
                else _resolve_custom_region_counties(geography_id, engine)
            )
            frames = [_query_county(c, y) for c in counties]
            return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        else:
            raise ValueError(f"Unsupported geography_type: {geography_type}")

    actual_year = year
    raw = pd.DataFrame()
    for try_year in [year, year - 1, year - 2]:
        raw = _fetch_for_year(try_year)
        if not raw.empty:
            actual_year = try_year
            break

    if raw.empty:
        return raw

    agg = (
        raw.groupby("respondent_id")
        .agg(
            origination_count=("origination_count", "sum"),
            origination_volume=("origination_volume", "sum"),
        )
        .reset_index()
    )
    # Prefer volume for market share; count available as supplementary
    agg["charter_or_cert"]  = "hmda:" + agg["respondent_id"].astype(str)
    agg["institution_name"] = agg["respondent_id"].astype(str)   # overridden if crosswalk exists
    agg["institution_type"] = "bank"    # HMDA respondent_id doesn't distinguish CU vs bank at this stage
    agg["metric_value"]     = agg["origination_volume"]
    agg["confidence"]       = "measured"
    agg["data_period"]      = str(actual_year)

    # Enrich institution names from HMDA respondent crosswalk if available
    try:
        with engine.connect() as conn:
            resp_ids = agg["respondent_id"].astype(str).tolist()
            result = conn.execute(
                select(
                    hmda_respondents.c.respondent_id,
                    hmda_respondents.c.respondent_name,
                    hmda_respondents.c.institution_type,
                ).where(hmda_respondents.c.respondent_id.in_(resp_ids))
            )
            crosswalk = pd.DataFrame(result.mappings().all())
        if not crosswalk.empty:
            agg = agg.merge(crosswalk, on="respondent_id", how="left", suffixes=("", "_cw"))
            agg["institution_name"] = agg["respondent_name"].fillna(agg["institution_name"])
            agg["institution_type"] = agg["institution_type_cw"].fillna("bank")
    except Exception as _exc:
        logger.debug("HMDA respondent crosswalk unavailable: %s", _exc)

    return agg[["charter_or_cert", "institution_name", "institution_type",
                "metric_value", "confidence", "data_period"]]


# ── Core data fetcher ─────────────────────────────────────────────────────────

def _fetch_metric_data(
    geography_type: GeoType,
    geography_id: str,
    period: str,
    metric: Metric,
    institution_types: list[str],
    engine,
) -> pd.DataFrame:
    """Load raw metric values for a geography/period.

    Returns DataFrame with columns:
      charter_or_cert, institution_name, institution_type,
      metric_value, confidence, data_period
    """
    frames: list[pd.DataFrame] = []
    year = _period_to_fdic_year(period)

    include_banks = "bank" in institution_types
    include_cus   = "cu"   in institution_types

    if metric == "deposits":
        if include_banks:
            df = _fetch_fdic_deposits(geography_type, geography_id, year, engine)
            if not df.empty:
                frames.append(df)
        if include_cus:
            df = _fetch_cu_deposits_allocated(geography_type, geography_id, period, engine)
            if not df.empty:
                frames.append(df)

    elif metric == "loans":
        if include_cus:
            df = _fetch_cu_loans(geography_type, geography_id, period, engine)
            if not df.empty:
                frames.append(df)
        # Banks: HMDA gives mortgage originations only, not total loan balances.
        # For cross-institution loan balance share, CU-only is the realistic use case.

    elif metric == "members":
        # Members is a CU-only metric; banks don't have an equivalent.
        if include_cus:
            df = _fetch_cu_members(geography_type, geography_id, period, engine)
            if not df.empty:
                frames.append(df)

    elif metric == "mortgage_originations":
        # HMDA covers all institution types
        df = _fetch_hmda_originations(geography_type, geography_id, year, engine)
        if not df.empty:
            # Filter by requested institution types
            if not (include_banks and include_cus):
                df = df[df["institution_type"].isin(institution_types)]
            frames.append(df)

    else:
        raise ValueError(f"Unknown metric: {metric!r}. Must be one of: deposits, loans, members, mortgage_originations")

    if not frames:
        return pd.DataFrame(columns=[
            "charter_or_cert", "institution_name", "institution_type",
            "metric_value", "confidence", "data_period",
        ])

    combined = pd.concat(frames, ignore_index=True)
    combined["metric_value"] = pd.to_numeric(combined["metric_value"], errors="coerce").fillna(0.0)
    return combined


# ── Share change helper ───────────────────────────────────────────────────────

def _build_share_map(df: pd.DataFrame) -> dict[str, float]:
    """Return {charter_or_cert: market_share} dict from a share-computed DataFrame."""
    if "market_share" not in df.columns or df.empty:
        return {}
    return dict(zip(df["charter_or_cert"], df["market_share"]))


# ── Main unified function (spec) ──────────────────────────────────────────────

def calculate_market_share(
    geography_type: str,
    geography_id: str,
    period: str,
    metric: str,
    institution_types: list[str],
    tenant_id: Optional[str] = None,
    db_url: Optional[str] = None,
) -> pd.DataFrame:
    """Return market share table for a geography/period/metric combination.

    Args:
        geography_type: "county" | "msa" | "state" | "custom_region"
        geography_id:   county FIPS, CBSA code, state abbreviation, or peer_groups UUID
        period:         "YYYYQ#" for NCUA-sourced metrics, "YYYY" for FDIC/HMDA annual.
                        When a quarterly period is given for annual metrics (deposits,
                        mortgage_originations), the calendar year is used.
        metric:         "deposits" | "loans" | "members" | "mortgage_originations"
        institution_types: subset of ["bank", "cu"] — filters which institution types appear

    Returns:
        DataFrame sorted by market_share descending with columns:
          charter_or_cert       — "ncua:68708" | "fdic:12345" | "hmda:respondent_id"
          institution_name      — display name
          institution_type      — "bank" | "cu"
          metric_value          — deposits in $, loans in $, member count, origination volume in $
          market_share          — 0.0–1.0 fraction of total market
          share_change_prior_period — change in market_share vs prior quarter/year (percentage points)
          share_change_yoy      — change vs same period prior year (percentage points)
          confidence            — "measured" | "modeled" | "estimated"
          data_period           — actual data period used (may differ from requested for annual sources)
    """
    if not institution_types:
        institution_types = ["bank", "cu"]

    engine = get_engine(db_url)

    # ── Current period data ────────────────────────────────────────────────────
    current = _fetch_metric_data(geography_type, geography_id, period, metric, institution_types, engine)

    if current.empty:
        return current.reindex(columns=[
            "charter_or_cert", "institution_name", "institution_type",
            "metric_value", "market_share", "share_change_prior_period",
            "share_change_yoy", "confidence", "data_period",
        ])

    total_current = current["metric_value"].sum()
    current["market_share"] = (
        current["metric_value"] / total_current if total_current > 0 else 0.0
    )

    # ── Prior period data (for QoQ / prior-period change) ─────────────────────
    prior_period = _prior_quarter(period) if _is_quarterly(period) else _prior_year_period(period)
    current_actual = current["data_period"].iloc[0] if not current.empty and "data_period" in current.columns else None
    try:
        prior_p = _fetch_metric_data(geography_type, geography_id, prior_period, metric, institution_types, engine)
        total_prior_p = prior_p["metric_value"].sum()
        if total_prior_p > 0:
            prior_p["market_share"] = prior_p["metric_value"] / total_prior_p
        prior_p_actual = prior_p["data_period"].iloc[0] if not prior_p.empty and "data_period" in prior_p.columns else None
        # If both fall back to the same actual data year (e.g. both use 2022 HMDA
        # because later years aren't ingested yet), the diff is 0 everywhere —
        # meaningless noise.  Return None so the UI shows "—" instead of "+0.00 pp".
        prior_p_map = {} if (current_actual and prior_p_actual and current_actual == prior_p_actual) \
                         else _build_share_map(prior_p)
    except Exception:
        prior_p_map = {}

    # ── Prior year data (for YoY change) ──────────────────────────────────────
    prior_year_period = _prior_year_period(period)
    prior_yoy_map: dict[str, float] = {}
    if prior_year_period != prior_period:   # avoid duplicate fetch for annual metrics
        try:
            prior_y = _fetch_metric_data(geography_type, geography_id, prior_year_period, metric, institution_types, engine)
            total_prior_y = prior_y["metric_value"].sum()
            if total_prior_y > 0:
                prior_y["market_share"] = prior_y["metric_value"] / total_prior_y
            prior_y_actual = prior_y["data_period"].iloc[0] if not prior_y.empty and "data_period" in prior_y.columns else None
            prior_yoy_map = {} if (current_actual and prior_y_actual and current_actual == prior_y_actual) \
                               else _build_share_map(prior_y)
        except Exception:
            prior_yoy_map = {}
    else:
        prior_yoy_map = prior_p_map   # annual: prior period IS prior year

    # ── Attach share changes ───────────────────────────────────────────────────
    share_now = current.set_index("charter_or_cert")["market_share"]
    current["share_change_prior_period"] = current["charter_or_cert"].map(
        lambda c: float(share_now[c]) - float(prior_p_map[c]) if c in prior_p_map else None
    )
    current["share_change_yoy"] = current["charter_or_cert"].map(
        lambda c: float(share_now[c]) - float(prior_yoy_map[c]) if c in prior_yoy_map else None
    )

    return (
        current[["charter_or_cert", "institution_name", "institution_type",
                 "metric_value", "market_share",
                 "share_change_prior_period", "share_change_yoy",
                 "confidence", "data_period"]]
        .sort_values("market_share", ascending=False)
        .reset_index(drop=True)
    )


# ── Legacy wrappers (backward compat with market_share.py router) ─────────────

def compute_deposit_share(
    geo_level: str,
    geo_id: str,
    period: str,
    tenant_id: str,
    db_url: Optional[str] = None,
) -> pd.DataFrame:
    """Legacy wrapper: returns deposit share with columns the router expects.

    Router uses: institution_name, identifier, deposits, market_share_pct,
                 rank, confidence_level, institution_type, trend_qoq
    """
    df = calculate_market_share(
        geography_type=geo_level,
        geography_id=geo_id,
        period=period,
        metric="deposits",
        institution_types=["bank", "cu"],
        db_url=db_url,
    )
    if df.empty:
        return df

    df = df.rename(columns={
        "charter_or_cert":          "identifier",
        "metric_value":             "deposits",
        "market_share":             "market_share_pct",
        "confidence":               "confidence_level",
        "share_change_prior_period":"trend_qoq",
    })
    df["market_share_pct"] = (df["market_share_pct"] * 100).round(4)
    df["rank"]             = range(1, len(df) + 1)
    return df


def compute_loan_share(
    geo_level: str,
    geo_id: str,
    period: str,
    tenant_id: str,
    db_url: Optional[str] = None,
) -> pd.DataFrame:
    """Legacy wrapper: mortgage origination share (HMDA, all institution types)."""
    df = calculate_market_share(
        geography_type=geo_level,
        geography_id=geo_id,
        period=period,
        metric="mortgage_originations",
        institution_types=["bank", "cu"],
        db_url=db_url,
    )
    if df.empty:
        return df

    df = df.rename(columns={
        "charter_or_cert": "respondent_id",
        "metric_value":    "origination_volume",
        "market_share":    "market_share_pct",
        "confidence":      "confidence_level",
    })
    df["market_share_pct"] = (df["market_share_pct"] * 100).round(4)
    df["rank"]             = range(1, len(df) + 1)
    return df


def trend_share(
    geo_level: str,
    geo_id: str,
    periods: list[str],
    tenant_id: str,
    db_url: Optional[str] = None,
) -> pd.DataFrame:
    """Legacy wrapper: deposit share over time — returns long-form DataFrame."""
    frames = []
    for period in periods:
        try:
            df = calculate_market_share(
                geography_type=geo_level,
                geography_id=geo_id,
                period=period,
                metric="deposits",
                institution_types=["bank", "cu"],
                db_url=db_url,
            )
        except Exception:
            continue
        if df.empty:
            continue
        df["period"]           = period
        df["market_share_pct"] = (df["market_share"] * 100).round(4)
        df["identifier"]       = df["charter_or_cert"]
        df["confidence_level"] = df["confidence"]
        frames.append(df[["period", "institution_name", "identifier",
                          "market_share_pct", "confidence_level"]])

    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
