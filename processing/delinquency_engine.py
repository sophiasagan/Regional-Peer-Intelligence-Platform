"""Delinquency engine: peer distributions, percentile ranks, credit risk composite.

All delinquency figures are institution-level (not branch-level).
Default peer group: REGIONAL (same state + geography) — not national asset-size.
Delinquency is ADVERSE: lower value = better = higher stars.

Computed ratios (never stored — always calculated from raw accounts):
  delinq_rate_total              = acct_041B / acct_025B
  chargeoff_rate_total_annualized = (acct_550 - acct_551) / acct_025B * 4
  alll_coverage                  = acct_AS0048 / acct_041B  (acct_719 for pre-CECL)
  alll_to_loans                  = acct_AS0048 / acct_025B
"""

from __future__ import annotations

import logging
from typing import Optional

import numpy as np
import pandas as pd
from sqlalchemy import select

from db import get_engine, institutions_quarterly, peer_distributions

logger = logging.getLogger(__name__)

# Metrics where high value = worse outcome = lower stars
ADVERSE_METRICS: frozenset[str] = frozenset({
    "delinq_rate_total",
    "delinq_rate_90plus",
    "chargeoff_rate_total_annualized",
    "oreo_to_assets",
    "non_accrual_rate",
    "tdr_to_loans",
    "operating_expense_ratio",
    "credit_loss_expense_to_loans",
    "borrowings_to_assets",
    "efficiency_ratio",
})

# Default alert thresholds (configurable per tenant)
DEFAULT_ALERT_THRESHOLDS: dict[str, float] = {
    "delinq_rate_total": 0.015,
    "auto_delinq_rate": 0.020,
    "credit_card_delinq_rate": 0.035,
    "commercial_delinq_rate": 0.010,
    "alll_coverage_min": 1.0,
    "chargeoff_acceleration_qoq": 0.25,
}


def compute_ratios(df: pd.DataFrame) -> pd.DataFrame:
    """Add delinquency and charge-off ratio columns to a financials DataFrame."""
    df = df.copy()
    loans = df.get("acct_025B", pd.Series(dtype=float, index=df.index)).replace(0, np.nan)
    delinq = df.get("acct_041B", pd.Series(dtype=float, index=df.index)).replace(0, np.nan)
    assets = df.get("acct_010", pd.Series(dtype=float, index=df.index)).replace(0, np.nan)

    df["delinq_rate_total"] = df.get("acct_041B", np.nan) / loans

    # 90+ day delinquency = (90-179d + 180-359d + 360+d) / total loans
    dlnq_90plus = (
        df.get("acct_021B", pd.Series(0, index=df.index, dtype=float)).fillna(0)
        + df.get("acct_022B", pd.Series(0, index=df.index, dtype=float)).fillna(0)
        + df.get("acct_023B", pd.Series(0, index=df.index, dtype=float)).fillna(0)
    )
    df["delinq_rate_90plus"] = dlnq_90plus / loans

    co = df.get("acct_550", pd.Series(dtype=float, index=df.index))
    rec = df.get("acct_551", pd.Series(dtype=float, index=df.index))
    df["chargeoff_rate_total_annualized"] = (co - rec) / loans * 4

    allowance = pd.to_numeric(df.get("acct_AS0048", pd.Series(dtype=float, index=df.index)), errors="coerce")
    if "acct_719" in df.columns:
        allowance = allowance.combine_first(pd.to_numeric(df["acct_719"], errors="coerce"))
    df["alll_coverage"] = allowance / delinq
    df["alll_to_loans"] = allowance / loans

    nw = df.get("acct_997", pd.Series(dtype=float, index=df.index))
    df["net_worth_ratio"] = nw / assets

    inc = df.get("acct_661A", pd.Series(dtype=float, index=df.index))
    df["roa_annualized"] = inc / assets * 4

    ni_exp = df.get("acct_671", pd.Series(dtype=float, index=df.index))
    ni_inc = df.get("acct_IS0010", pd.Series(dtype=float, index=df.index))
    nonint_inc = df.get("acct_117", pd.Series(dtype=float, index=df.index))
    df["efficiency_ratio"] = ni_exp / (ni_inc + nonint_inc).replace(0, np.nan)

    return df


def _load_peer_values(metric: str, peer_charters: list[int], period: str, db_url: str | None) -> pd.Series:
    """Pull a single metric's values for all peer institutions in a period."""
    engine = get_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.period == period,
                institutions_quarterly.c.charter_number.in_(peer_charters),
            )
        )
        df = pd.DataFrame(result.mappings().all())

    if df.empty:
        return pd.Series(dtype=float)

    df = compute_ratios(df)
    return df[metric].dropna() if metric in df.columns else pd.Series(dtype=float)


def compute_peer_distribution(
    metric: str,
    peer_charters: list[int],
    period: str,
    db_url: str | None = None,
) -> dict:
    """Return percentile distribution for a metric across the peer group."""
    values = _load_peer_values(metric, peer_charters, period, db_url)
    if values.empty:
        return {"n": 0, "p10": None, "p25": None, "p50": None, "p75": None, "p90": None}

    return {
        "n": len(values),
        "p10": float(values.quantile(0.10)),
        "p25": float(values.quantile(0.25)),
        "p50": float(values.quantile(0.50)),
        "p75": float(values.quantile(0.75)),
        "p90": float(values.quantile(0.90)),
    }


def rank_institution(value: float, distribution: dict, metric: str) -> float:
    """Return adjusted percentile rank (0–100), inverted for ADVERSE metrics.

    For ADVERSE metrics, a lower raw value = higher rank (better).
    For POSITIVE metrics, a higher raw value = higher rank (better).
    """
    p10 = distribution.get("p10")
    p90 = distribution.get("p90")
    if p10 is None or p90 is None or p10 == p90:
        return 50.0

    # Linear interpolation between p10 and p90
    raw_rank = (value - p10) / (p90 - p10) * 80 + 10  # maps [p10,p90] → [10,90]
    raw_rank = max(0.0, min(100.0, raw_rank))

    if metric in ADVERSE_METRICS:
        return 100.0 - raw_rank
    return raw_rank


def assign_stars(percentile_rank: float) -> int:
    """Convert percentile rank to 1–5 Callahan star rating.

    1 star = bottom <10%
    5 stars = top 90%+
    """
    if percentile_rank < 10:
        return 1
    if percentile_rank < 30:
        return 2
    if percentile_rank < 70:
        return 3
    if percentile_rank < 90:
        return 4
    return 5


def credit_risk_composite(
    charter_number: int,
    period: str,
    peer_charters: list[int],
    db_url: str | None = None,
) -> dict:
    """Return credit quality composite: per-metric ranks + weighted composite score."""
    engine = get_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.charter_number == charter_number,
                institutions_quarterly.c.period == period,
            )
        )
        rows = result.mappings().all()

    if not rows:
        return {}

    inst_df = compute_ratios(pd.DataFrame(rows))
    metrics = ["delinq_rate_total", "chargeoff_rate_total_annualized", "alll_coverage", "alll_to_loans"]

    breakdown = {}
    for metric in metrics:
        if metric not in inst_df.columns:
            continue
        value = inst_df[metric].iloc[0]
        if pd.isna(value):
            continue
        dist = compute_peer_distribution(metric, peer_charters, period, db_url)
        rank = rank_institution(float(value), dist, metric)
        breakdown[metric] = {
            "value": float(value),
            "percentile_rank": round(rank, 1),
            "stars": assign_stars(rank),
            "peer_distribution": dist,
        }

    composite_ranks = [v["percentile_rank"] for v in breakdown.values()]
    composite = sum(composite_ranks) / len(composite_ranks) if composite_ranks else 0.0

    return {
        "charter_number": charter_number,
        "period": period,
        "composite_percentile": round(composite, 1),
        "composite_stars": assign_stars(composite),
        "metrics": breakdown,
    }


def peer_distributions_batch(
    period: str,
    peer_group_type: str = "REGIONAL",
    db_url: str | None = None,
) -> pd.DataFrame:
    """Compute distributions for all metrics × all institutions for a period."""
    from processing.peer_engine import PeerGroupType, build_peer_group

    engine = get_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly.c.charter_number).where(
                institutions_quarterly.c.period == period
            )
        )
        charters = [r[0] for r in result.fetchall()]

    metrics = [
        "delinq_rate_total", "chargeoff_rate_total_annualized",
        "alll_coverage", "alll_to_loans", "net_worth_ratio",
        "roa_annualized", "efficiency_ratio",
    ]

    rows = []
    for charter in charters:
        try:
            peers = build_peer_group(charter, period, PeerGroupType(peer_group_type), "system", db_url=db_url)
        except Exception:
            continue
        for metric in metrics:
            dist = compute_peer_distribution(metric, peers, period, db_url)
            if dist["n"] > 0:
                rows.append({
                    "metric": metric,
                    "peer_group_type": peer_group_type,
                    "period": period,
                    **dist,
                })

    return pd.DataFrame(rows).drop_duplicates(subset=["metric", "peer_group_type", "period"])
