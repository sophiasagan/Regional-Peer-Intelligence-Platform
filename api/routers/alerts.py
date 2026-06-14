"""Router: /alerts — market movements, delinquency threshold alerts, and signal separation."""

from __future__ import annotations

import os
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from processing.delinquency_engine import DEFAULT_ALERT_THRESHOLDS
from processing.early_warning_engine import (
    EarlyWarning,
    _trailing_periods,
    run_early_warning,
    compute_early_warning_cards,
)
from processing.peer_engine import PeerEngine, PeerGroupType, build_peer_group

router = APIRouter()

DB_URL = os.environ.get("DATABASE_URL")


class AlertRow(BaseModel):
    metric: str
    alert_level: Literal["green", "yellow", "red"]
    institution_value: Optional[float]
    peer_median: Optional[float]
    qoq_change: Optional[float]
    quarters_to_breach: Optional[float]
    signal_type: str
    message: str


class AlertsResponse(BaseModel):
    charter_number: int
    period: str
    peer_group_type: str
    peer_count: int
    alerts: list[AlertRow]
    has_red_alerts: bool
    has_yellow_alerts: bool


@router.get("/{charter_number}", response_model=AlertsResponse)
async def get_alerts(
    request: Request,
    charter_number: int,
    period: str = Query(...),
    peer_group: Literal["REGIONAL", "STATE", "ASSET_SIZE"] = Query(default="REGIONAL"),
    n_periods: int = Query(default=8, description="Trailing quarters for trend detection"),
):
    tenant_id = request.state.tenant_id
    group_type = PeerGroupType(peer_group)
    peer_charters = build_peer_group(charter_number, period, group_type, tenant_id, db_url=DB_URL)

    if not peer_charters:
        raise HTTPException(status_code=404, detail=f"Charter {charter_number} not found or no peers for {period}")

    periods = _trailing_periods(period, n=n_periods)
    warnings = run_early_warning(charter_number, peer_charters, period, periods, db_url=DB_URL)

    def _to_row(w: EarlyWarning) -> AlertRow:
        inst_val = w.institution_value if w.institution_value == w.institution_value else None  # NaN check
        peer_med = w.peer_median if w.peer_median == w.peer_median else None
        return AlertRow(
            metric=w.metric,
            alert_level=w.alert_level.value,
            institution_value=inst_val,
            peer_median=peer_med,
            qoq_change=w.qoq_change,
            quarters_to_breach=w.quarters_to_breach,
            signal_type=w.signal_type,
            message=w.message,
        )

    alert_rows = [_to_row(w) for w in warnings]

    return AlertsResponse(
        charter_number=charter_number,
        period=period,
        peer_group_type=peer_group,
        peer_count=len(peer_charters),
        alerts=alert_rows,
        has_red_alerts=any(a.alert_level == "red" for a in alert_rows),
        has_yellow_alerts=any(a.alert_level == "yellow" for a in alert_rows),
    )


@router.get("/{charter_number}/thresholds")
async def get_thresholds(request: Request, charter_number: int):
    """Return current alert thresholds for this institution (tenant-configurable defaults)."""
    # TODO: load tenant overrides from a tenant_thresholds table
    return DEFAULT_ALERT_THRESHOLDS


@router.put("/{charter_number}/thresholds")
async def update_thresholds(request: Request, charter_number: int, thresholds: dict):
    """Persist tenant-specific threshold overrides."""
    valid_keys = set(DEFAULT_ALERT_THRESHOLDS.keys())
    invalid = {k for k in thresholds if k not in valid_keys}
    if invalid:
        raise HTTPException(status_code=422, detail=f"Unknown threshold keys: {sorted(invalid)}")
    # TODO: upsert to tenant_thresholds table
    return {"updated": list(thresholds.keys())}


class SignalResponse(BaseModel):
    signal_type: str   # regional_pressure | institution_specific | outperforming_market | no_signal | no_data
    institution_value: Optional[float]
    regional_median: Optional[float]
    national_median: Optional[float]
    interpretation_text: str
    metric: str
    regional_group_label: Optional[str] = None
    regional_peer_count: Optional[int] = None
    # Number of regional peers whose metric value crosses the national median
    # in the "stressed" direction (above for ADVERSE, below for POSITIVE).
    # Drives the "N of M institutions show similar trends" copy in SignalSeparator.
    peers_above_national_median: Optional[int] = None


# ── Early warning detail endpoint (three-card format) ────────────────────────

class AccelerationCard(BaseModel):
    alert_level: Literal["none", "watch", "alert", "urgent"]
    metric: str
    callahan_label: str
    institution_value: Optional[float]
    recent_avg_change: Optional[float]
    historical_avg_change: Optional[float]
    acceleration_ratio: Optional[float]


class DivergenceCard(BaseModel):
    alert_level: Literal["none", "watch", "alert", "urgent"]
    metric: str
    callahan_label: str
    institution_value: Optional[float]
    peer_median_current: Optional[float]
    inst_cumulative_change: Optional[float]
    peer_cumulative_change: Optional[float]
    total_divergence: Optional[float]


class ProjectionCard(BaseModel):
    alert_level: Literal["none", "watch", "alert", "urgent"]
    metric: str
    callahan_label: str
    current_value: Optional[float]
    threshold_value: Optional[float]
    quarters_to_threshold: Optional[float]
    already_breached: Optional[bool] = None


class EarlyWarningDetailResponse(BaseModel):
    has_active_alerts: bool
    acceleration: Optional[AccelerationCard] = None
    divergence: Optional[DivergenceCard] = None
    projection: Optional[ProjectionCard] = None


@router.get("/{charter_number}/early-warning", response_model=EarlyWarningDetailResponse)
async def get_early_warning_cards(
    request: Request,
    charter_number: int,
    period: str = Query(...),
    peer_group: Literal["REGIONAL", "STATE", "ASSET_SIZE"] = Query(default="REGIONAL"),
):
    """Three structured early-warning cards used by EarlyWarningPanel.jsx.

    Cards:
      acceleration  — rate-of-change vs historical baseline
      divergence    — cumulative institution vs peer divergence
      projection    — linear extrapolation to examiner threshold
    """
    tenant_id   = request.state.tenant_id
    group_type  = PeerGroupType(peer_group)
    peer_charters = build_peer_group(charter_number, period, group_type, tenant_id, db_url=DB_URL)

    if not peer_charters:
        raise HTTPException(status_code=404, detail=f"Charter {charter_number} not found or no peers for {period}")

    cards = compute_early_warning_cards(
        charter_number=charter_number,
        peer_charters=peer_charters,
        period=period,
        db_url=DB_URL,
    )

    def _coerce_card(data: dict | None, model):
        if data is None:
            return None
        # Ensure alert_level maps to the Literal values we expose
        lvl = data.get("alert_level", "none")
        if lvl in ("red",):
            lvl = "urgent"
        elif lvl in ("yellow",):
            lvl = "watch"
        elif lvl in ("orange",):
            lvl = "alert"
        return model(**{**data, "alert_level": lvl})

    return EarlyWarningDetailResponse(
        has_active_alerts=cards["has_active_alerts"],
        acceleration=_coerce_card(cards["acceleration"], AccelerationCard),
        divergence=_coerce_card(cards["divergence"], DivergenceCard),
        projection=_coerce_card(cards["projection"], ProjectionCard),
    )


@router.get("/{charter_number}/signal", response_model=SignalResponse)
async def get_signal_separation(
    request: Request,
    charter_number: int,
    metric: str = Query(..., description="e.g. delinq_rate_total"),
    period: str = Query(...),
    geography_type: Literal["state", "county", "msa"] = Query(default="state"),
    geography_id: str = Query(..., description="State abbrev, county FIPS, or MSA code"),
):
    """Separate institution-specific signal from regional market trend.

    Answers: 'Is this a you-problem or a market-problem?'

    Returns signal_type:
      regional_pressure     — both institution and regional peers elevated vs national
      institution_specific  — institution elevated; regional peers are in line with national
      outperforming_market  — regional peers stressed; institution is handling it well
      no_signal             — no significant deviation detected
    """
    engine = PeerEngine(DB_URL)
    result = engine.separate_market_vs_institution_signal(
        charter_number=str(charter_number),
        metric=metric,
        period=period,
        geography_id=geography_id,
        geography_type=geography_type,
    )
    return SignalResponse(**result)
