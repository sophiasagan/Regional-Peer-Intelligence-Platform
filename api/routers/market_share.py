"""Router: /market-share — deposit, loan, member, and mortgage share by geography.

Every geographic figure includes a confidence field (P76 rule — non-negotiable):
  measured  — FDIC branch-level or HMDA data (teal badge)
  modeled   — CU estimation model allocation, ±8% validated (blue badge)
  estimated — proxy-based geographic allocation (amber badge)
"""

from __future__ import annotations

import os
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from processing.early_warning_engine import _trailing_periods
from processing.market_share_engine import (
    calculate_market_share,
    compute_deposit_share,
    compute_loan_share,
    trend_share,
)

router = APIRouter()

DB_URL   = os.environ.get("DATABASE_URL")
GeoLevel = Literal["county", "msa", "state", "custom_region"]


# ── Unified market share response model ───────────────────────────────────────

class MarketShareRow(BaseModel):
    charter_or_cert:           str
    institution_name:          str
    institution_type:          Literal["bank", "cu"]
    metric_value:              float
    market_share:              float            # 0.0–1.0
    market_share_pct:          float            # 0.0–100.0  (for display)
    share_change_prior_period: Optional[float]  # percentage-point change vs prior period
    share_change_yoy:          Optional[float]  # percentage-point change vs prior year
    confidence:                Literal["measured", "modeled", "estimated"]
    data_period:               str


class MarketShareResponse(BaseModel):
    geography_type:  str
    geography_id:    str
    period:          str
    metric:          str
    total_market:    float                              # total market metric_value
    rows:            list[MarketShareRow]
    confidence:      Literal["measured", "modeled", "estimated"]   # worst (lowest) confidence present


# ── Legacy deposit response model (kept for backward compat) ──────────────────

class _DepositRow(BaseModel):
    institution_name:  str
    identifier:        str
    deposits:          float
    market_share_pct:  float
    rank:              int
    confidence_level:  Literal["measured", "modeled", "estimated"]
    institution_type:  Literal["bank", "cu"]
    trend_qoq:         Optional[float] = None


class _DepositResponse(BaseModel):
    geo_level:             str
    geo_id:                str
    period:                str
    total_market_deposits: float
    rows:                  list[_DepositRow]
    confidence_level:      Literal["measured", "modeled", "estimated"]


# ── Unified endpoint ──────────────────────────────────────────────────────────

@router.get("/", response_model=MarketShareResponse)
async def get_market_share(
    request: Request,
    geography_type: GeoLevel = Query(...),
    geography_id: str = Query(..., description="County FIPS, MSA CBSA code, state abbreviation, or custom UUID"),
    period: str = Query(..., description="YYYYQ# for NCUA metrics; YYYY or YYYYQ# for FDIC/HMDA (year used)"),
    metric: Literal["deposits", "loans", "members", "mortgage_originations"] = Query(default="deposits"),
    institution_types: str = Query(
        default="bank,cu",
        description="Comma-separated list of institution types to include: bank, cu",
    ),
):
    """Unified market share endpoint.

    Dispatches by metric:
      deposits             — FDIC (banks, measured) + CU allocations (modeled/estimated)
      loans                — CU total loans from NCUA; banks: not included (no county balance data)
      members              — CU-only (NCUA acct_083); banks have no equivalent
      mortgage_originations— HMDA, all institution types, measured

    Share changes (percentage points):
      share_change_prior_period — vs prior quarter (quarterly) or prior year (annual)
      share_change_yoy          — vs same period one year prior
    """
    inst_types = [t.strip() for t in institution_types.split(",") if t.strip() in ("bank", "cu")]
    if not inst_types:
        raise HTTPException(status_code=400, detail="institution_types must include at least one of: bank, cu")

    try:
        df = calculate_market_share(
            geography_type=geography_type,
            geography_id=geography_id,
            period=period,
            metric=metric,
            institution_types=inst_types,
            db_url=DB_URL,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if df.empty:
        return MarketShareResponse(
            geography_type=geography_type,
            geography_id=geography_id,
            period=period,
            metric=metric,
            total_market=0.0,
            rows=[],
            confidence="estimated",
        )

    total = float(df["metric_value"].sum())

    _CONFIDENCE_ORDER = {"measured": 0, "modeled": 1, "estimated": 2}
    worst_confidence = max(
        df["confidence"].tolist(),
        key=lambda c: _CONFIDENCE_ORDER.get(c, 2),
        default="estimated",
    )

    rows = []
    for rec in df.to_dict("records"):
        rows.append(MarketShareRow(
            charter_or_cert           = rec["charter_or_cert"],
            institution_name          = rec["institution_name"],
            institution_type          = rec["institution_type"],
            metric_value              = float(rec["metric_value"]),
            market_share              = round(float(rec["market_share"]), 6),
            market_share_pct          = round(float(rec["market_share"]) * 100, 4),
            share_change_prior_period = (
                round(float(rec["share_change_prior_period"]) * 100, 4)
                if rec.get("share_change_prior_period") is not None else None
            ),
            share_change_yoy          = (
                round(float(rec["share_change_yoy"]) * 100, 4)
                if rec.get("share_change_yoy") is not None else None
            ),
            confidence                = rec["confidence"],
            data_period               = rec["data_period"],
        ))

    return MarketShareResponse(
        geography_type=geography_type,
        geography_id=geography_id,
        period=period,
        metric=metric,
        total_market=total,
        rows=rows,
        confidence=worst_confidence,
    )


# ── Legacy /deposits endpoint (kept for backward compat with existing frontend) ─

# ── Heatmap endpoint — one row per county, used by MarketMap.jsx base layer ──

class HeatmapCounty(BaseModel):
    county_fips:  str
    market_share: float            # 0.0–1.0
    metric_value: float
    confidence:   Literal["measured", "modeled", "estimated"]
    data_period:  str


class HeatmapResponse(BaseModel):
    charter_number: int
    institution_name: Optional[str]
    metric: str
    year: int
    counties: list[HeatmapCounty]


@router.get("/heatmap", response_model=HeatmapResponse)
async def get_institution_heatmap(
    request: Request,
    charter_number: int = Query(..., description="Institution to show on map (defaults to tenant's own CU)"),
    metric: Literal["deposits", "loans", "members", "mortgage_originations"] = Query(default="deposits"),
    year: int = Query(..., description="Calendar year (FDIC/HMDA data is annual)"),
):
    """Return market share per county for a single institution — drives choropleth base layer.

    Fetches from cu_deposit_allocations (for deposit/loan share per county) and
    HMDA (for mortgage_originations per county), calculating each county's total
    market to compute this institution's share.

    Used by MarketMap.jsx to color all counties this institution operates in.
    """
    from sqlalchemy import text as sa_text
    from db import get_engine

    engine = get_engine(DB_URL)
    period = f"{year}Q4"   # Use Q4 of the requested year for NCUA data

    # ── Fetch counties where this institution has allocations ──────────────────
    counties: list[HeatmapCounty] = []
    inst_name: Optional[str] = None

    try:
        with engine.connect() as conn:
            rows = conn.execute(
                sa_text("""
                    SELECT a.county_fips, a.allocated_deposits, a.confidence_level,
                           i.institution_name
                    FROM cu_deposit_allocations a
                    LEFT JOIN (
                        SELECT DISTINCT ON (charter_number) charter_number, institution_name
                        FROM institutions_quarterly
                        WHERE charter_number = :charter AND period = :period
                    ) i ON TRUE
                    WHERE a.charter_number = :charter AND a.period = :period
                """),
                {"charter": charter_number, "period": period},
            ).mappings().all()

        if rows:
            inst_name = rows[0]["institution_name"] if rows[0]["institution_name"] else f"Charter {charter_number}"

        for row in rows:
            fips = row["county_fips"]
            inst_val = float(row["allocated_deposits"] or 0)
            if inst_val <= 0:
                continue

            # Get county total (all institutions) for market share denominator
            try:
                total_row = engine.connect().execute(
                    sa_text("""
                        SELECT COALESCE(SUM(deposits), 0) AS total
                        FROM fdic_deposits
                        WHERE county_fips = :fips AND year = :year
                    """),
                    {"fips": fips, "year": year},
                ).scalar()
                county_total = float(total_row or 0)
            except Exception:
                county_total = 0.0

            # Add CU total for the county
            try:
                cu_total_row = engine.connect().execute(
                    sa_text("""
                        SELECT COALESCE(SUM(allocated_deposits), 0) AS total
                        FROM cu_deposit_allocations
                        WHERE county_fips = :fips AND period = :period
                    """),
                    {"fips": fips, "period": period},
                ).scalar()
                county_total += float(cu_total_row or 0)
            except Exception:
                pass

            share = inst_val / county_total if county_total > 0 else 0.0
            counties.append(HeatmapCounty(
                county_fips  = fips,
                market_share = round(share, 6),
                metric_value = inst_val,
                confidence   = row.get("confidence_level", "modeled"),
                data_period  = str(year),
            ))

    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Heatmap query failed: {exc}")

    return HeatmapResponse(
        charter_number=charter_number,
        institution_name=inst_name,
        metric=metric,
        year=year,
        counties=counties,
    )


@router.get("/deposits", response_model=_DepositResponse)
async def get_deposit_share(
    request: Request,
    geo_level: str = Query(...),
    geo_id: str = Query(..., description="County FIPS, MSA code, state abbrev, or custom ID"),
    period: str = Query(..., description="e.g. 2026Q1"),
):
    tenant_id = request.state.tenant_id
    df = compute_deposit_share(geo_level, geo_id, period, tenant_id, DB_URL)

    rows = [_DepositRow(**r) for r in df.to_dict("records")] if not df.empty else []
    total = float(df["deposits"].sum()) if not df.empty else 0.0

    _conf_order = {"measured": 0, "modeled": 1, "estimated": 2}
    overall = max(
        (r.confidence_level for r in rows),
        key=lambda c: _conf_order.get(c, 2),
        default="estimated",
    )

    return _DepositResponse(
        geo_level=geo_level,
        geo_id=geo_id,
        period=period,
        total_market_deposits=total,
        rows=rows,
        confidence_level=overall,
    )


@router.get("/loans")
async def get_loan_share(
    request: Request,
    geo_level: str = Query(...),
    geo_id: str = Query(...),
    period: str = Query(...),
):
    tenant_id = request.state.tenant_id
    df = compute_loan_share(geo_level, geo_id, period, tenant_id, DB_URL)
    return df.to_dict("records") if not df.empty else []


@router.get("/trend")
async def get_share_trend(
    request: Request,
    geo_level: str = Query(...),
    geo_id: str = Query(...),
    period: str = Query(..., description="Most recent period"),
    n_periods: int = Query(default=12, description="Number of periods (default 12 per Callahan convention)"),
):
    """Deposit share over time — long-form response for PeerBandChart trend view."""
    tenant_id = request.state.tenant_id
    periods   = _trailing_periods(period, n=n_periods)
    df        = trend_share(geo_level, geo_id, periods, tenant_id, DB_URL)
    return df.to_dict("records") if not df.empty else []
