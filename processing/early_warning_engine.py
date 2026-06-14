"""Early warning engine: acceleration, peer divergence, threshold projection.

Three checks, run per metric, returning the worst-case metric per check type
so the frontend can show exactly three signal cards.

Spec-exact algorithms:
  Acceleration:  avg(last 2 QoQ changes) vs avg(prior 6 QoQ changes) — need ≥9 periods
  Divergence:    cumulative (inst_change − peer_change) over 4 quarters — need ≥5 periods
  Projection:    linear slope of last 4 quarters extrapolated to threshold — need ≥4 periods
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import numpy as np
import pandas as pd
from sqlalchemy import select

from db import get_engine, institutions_quarterly
from processing.delinquency_engine import ADVERSE_METRICS, DEFAULT_ALERT_THRESHOLDS, compute_ratios

logger = logging.getLogger(__name__)


# ── Alert levels ──────────────────────────────────────────────────────────────

class AlertLevel(str, Enum):
    NONE   = "none"
    WATCH  = "watch"    # amber  — Worth monitoring
    ALERT  = "alert"    # orange — Requires attention
    URGENT = "urgent"   # red    — Immediate action needed
    # Legacy aliases (kept for backward compat with old AlertRow model)
    GREEN  = "green"
    YELLOW = "yellow"
    RED    = "red"


_LEVEL_ORDER: dict[str, int] = {
    "urgent": 0, "red": 0,
    "alert":  1, "orange": 1,
    "watch":  2, "yellow": 2,
    "none":   3, "green": 3,
}


# ── Legacy dataclass (kept for backward compat with alerts.py AlertRow) ───────

@dataclass
class EarlyWarning:
    metric: str
    alert_level: AlertLevel
    institution_value: float
    peer_median: float
    qoq_change: Optional[float]
    quarters_to_breach: Optional[float]
    signal_type: str   # "acceleration" | "divergence" | "threshold_projection"
    message: str


# ── Callahan metric labels ────────────────────────────────────────────────────

_CALLAHAN_LABELS: dict[str, str] = {
    "delinq_rate_total":               "Total Delinquency Ratio",
    "delinq_rate_90plus":              "90+ Day Delinquency",
    "chargeoff_rate_total_annualized": "Net Charge-Off Ratio",
    "alll_coverage":                   "ALLL Coverage Ratio",
    "alll_to_loans":                   "ALLL to Total Loans",
}

# Threshold used for projection card when not in DEFAULT_ALERT_THRESHOLDS
_DEFAULT_PROJECTION_THRESHOLDS: dict[str, float] = {
    "delinq_rate_total":               0.015,   # 1.5%
    "chargeoff_rate_total_annualized": 0.005,   # 0.5% annualized
    "alll_coverage":                   1.0,     # 1.0x minimum
}


# ── DB helpers ────────────────────────────────────────────────────────────────

def _load_history(charter_number: int, periods: list[str], db_url: str | None) -> pd.DataFrame:
    engine = get_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.charter_number == charter_number,
                institutions_quarterly.c.period.in_(periods),
            )
        )
        df = pd.DataFrame(result.mappings().all())
    if df.empty:
        return df
    df = compute_ratios(df)
    return df.sort_values("period").reset_index(drop=True)


def _load_peer_history(peer_charters: list[int], periods: list[str], db_url: str | None) -> pd.DataFrame:
    if not peer_charters:
        return pd.DataFrame()
    engine = get_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.charter_number.in_(peer_charters),
                institutions_quarterly.c.period.in_(periods),
            )
        )
        df = pd.DataFrame(result.mappings().all())
    if df.empty:
        return df
    return compute_ratios(df)


def _trailing_periods(current: str, n: int = 8) -> list[str]:
    """Return n periods ending at current, e.g. ['2024Q1', ..., '2026Q1']."""
    year    = int(current[:4])
    quarter = int(current[5])
    result  = []
    for _ in range(n):
        result.insert(0, f"{year}Q{quarter}")
        quarter -= 1
        if quarter == 0:
            quarter = 4
            year -= 1
    return result


# ── Pure computation functions (no DB) ───────────────────────────────────────

def _detect_acceleration_from_values(
    values: list[float],
    is_adverse: bool,
) -> dict:
    """Spec: avg(last 2 QoQ changes) vs avg(prior 6 QoQ changes). Requires ≥9 values.

    Alert levels (ratio = abs(recent_avg) / abs(historical_avg)):
      < 1.25  → none
      1.25–2.0 → watch
      2.0–3.0  → alert
      ≥ 3.0    → urgent  (spec: > 2.0 triggers "alert"; ≥3.0 is "urgent" tier)
    """
    no_signal: dict = {
        "alert_level": "none",
        "recent_avg_change": None,
        "historical_avg_change": None,
        "acceleration_ratio": None,
    }

    if len(values) < 9:
        return no_signal

    vals    = values[-9:]                               # last 9 data points
    changes = [vals[i] - vals[i - 1] for i in range(1, 9)]  # 8 QoQ changes
    recent_2 = changes[6:]                             # last 2 changes
    prior_6  = changes[:6]                             # prior 6 changes

    recent_avg     = sum(recent_2) / 2
    historical_avg = sum(prior_6)  / 6

    # Direction check: are we worsening?
    adverse_direction = (is_adverse and recent_avg > 0) or (not is_adverse and recent_avg < 0)
    if not adverse_direction:
        return {**no_signal, "recent_avg_change": recent_avg, "historical_avg_change": historical_avg}

    # Ratio: how much faster than historical baseline?
    if abs(historical_avg) < 1e-9:
        # Flat historical + recent adverse movement = high acceleration
        acceleration_ratio = 3.5
    else:
        acceleration_ratio = abs(recent_avg) / abs(historical_avg)

    if acceleration_ratio < 1.25:
        level = "none"
    elif acceleration_ratio < 2.0:
        level = "watch"
    elif acceleration_ratio < 3.0:
        level = "alert"
    else:
        level = "urgent"

    return {
        "alert_level":          level,
        "recent_avg_change":    recent_avg,
        "historical_avg_change": historical_avg,
        "acceleration_ratio":   acceleration_ratio,
    }


def _detect_divergence_from_values(
    inst_values:   list[float],   # chronological, ≥5
    peer_medians:  list[float],   # parallel, same periods, ≥5
    is_adverse: bool,
) -> dict:
    """Spec: cumulative (inst_change − peer_change) over 4 quarters. Requires ≥5 aligned values.

    Alert levels (adverse divergence in pct points = |total_divergence| * 100):
      < 0.5 pct pts  → none
      0.5–1.0        → watch
      1.0–2.0        → alert
      ≥ 2.0          → urgent
    """
    no_signal: dict = {
        "alert_level": "none",
        "inst_cumulative_change": None,
        "peer_cumulative_change": None,
        "total_divergence": None,
    }

    n = min(len(inst_values), len(peer_medians))
    if n < 5:
        return no_signal

    inst5 = inst_values[-5:]
    peer5 = peer_medians[-5:]

    inst_changes = [inst5[i] - inst5[i - 1] for i in range(1, 5)]
    peer_changes = [peer5[i] - peer5[i - 1] for i in range(1, 5)]

    inst_cumulative = sum(inst_changes)
    peer_cumulative = sum(peer_changes)
    total_divergence = inst_cumulative - peer_cumulative

    # Is the divergence in the adverse direction?
    # ADVERSE metric: institution rising faster than peers → total_divergence > 0
    # POSITIVE metric: institution falling faster than peers → total_divergence < 0
    adverse = (is_adverse and total_divergence > 0) or (not is_adverse and total_divergence < 0)
    if not adverse:
        return {
            **no_signal,
            "inst_cumulative_change": inst_cumulative,
            "peer_cumulative_change": peer_cumulative,
            "total_divergence": total_divergence,
        }

    div_abs = abs(total_divergence)

    if div_abs < 0.005:     # < 0.5 pct pts
        level = "none"
    elif div_abs < 0.010:   # 0.5–1.0 pct pts
        level = "watch"
    elif div_abs < 0.020:   # 1.0–2.0 pct pts
        level = "alert"
    else:                   # ≥ 2.0 pct pts
        level = "urgent"

    return {
        "alert_level":           level,
        "inst_cumulative_change": inst_cumulative,
        "peer_cumulative_change": peer_cumulative,
        "total_divergence":      total_divergence,
    }


def _project_breach_from_values(
    values:     list[float],
    threshold:  float,
    is_adverse: bool,
) -> dict:
    """Spec: linear extrapolation of last 4-quarter trend. Only if heading toward threshold.

    Alert levels (quarters_to_threshold):
      ≥ 12   → watch
      4–12   → alert
      < 4    → urgent
      0      → urgent (already breached)
      None   → not heading toward threshold
    """
    no_signal: dict = {"alert_level": "none", "quarters_to_threshold": None}

    if len(values) < 4:
        return no_signal

    last4   = values[-4:]
    current = last4[-1]

    # Already breached?
    already = (is_adverse and current >= threshold) or (not is_adverse and current <= threshold)
    if already:
        return {"alert_level": "urgent", "quarters_to_threshold": 0, "already_breached": True}

    # Slope = mean of last 3 QoQ changes
    changes = [last4[i] - last4[i - 1] for i in range(1, 4)]
    slope   = sum(changes) / 3

    # Is slope heading toward threshold?
    heading = (is_adverse and slope > 0) or (not is_adverse and slope < 0)
    if not heading:
        return no_signal

    quarters = abs(threshold - current) / abs(slope)
    if quarters > 16:   # Don't project more than 4 years
        return no_signal

    if quarters >= 12:
        level = "watch"
    elif quarters >= 4:
        level = "alert"
    else:
        level = "urgent"

    return {
        "alert_level":         level,
        "quarters_to_threshold": round(float(quarters), 1),
        "already_breached":    False,
    }


# ── Orchestrator ──────────────────────────────────────────────────────────────

def compute_early_warning_cards(
    charter_number: int,
    peer_charters:  list[int],
    period:         str,
    tenant_thresholds: dict | None = None,
    db_url:         str | None = None,
) -> dict:
    """Run all three checks for monitored metrics; return worst-case card per check type.

    Always returns data for each card (using delinq_rate_total as fallback) so the
    frontend can render three cards regardless of alert state.

    Return shape:
      {
        has_active_alerts: bool,
        acceleration: { alert_level, metric, callahan_label, institution_value,
                        recent_avg_change, historical_avg_change, acceleration_ratio },
        divergence:   { alert_level, metric, callahan_label, institution_value,
                        peer_median_current, inst_cumulative_change,
                        peer_cumulative_change, total_divergence },
        projection:   { alert_level, metric, callahan_label, current_value,
                        threshold_value, quarters_to_threshold, already_breached? }
      }
    """
    thresholds = {**_DEFAULT_PROJECTION_THRESHOLDS, **(tenant_thresholds or {})}

    # Load 12 trailing periods (3 years) — enough for acceleration (needs 9+)
    hist_periods = _trailing_periods(period, n=12)

    inst_df = _load_history(charter_number, hist_periods, db_url)
    peer_df = _load_peer_history(peer_charters, hist_periods, db_url)

    # Peer medians by (metric, period) — computed once, reused across metrics
    peer_med_by_metric: dict[str, dict[str, float]] = {}
    if not peer_df.empty and "period" in peer_df.columns:
        for col in peer_df.select_dtypes(include="number").columns:
            if col == "charter_number":
                continue
            peer_med_by_metric[col] = peer_df.groupby("period")[col].median().to_dict()

    target_metrics = [
        "delinq_rate_total",
        "chargeoff_rate_total_annualized",
        "alll_coverage",
    ]

    best_acc:  dict | None = None
    best_div:  dict | None = None
    best_proj: dict | None = None

    for metric in target_metrics:
        if inst_df.empty or metric not in inst_df.columns:
            continue

        is_adverse     = metric in ADVERSE_METRICS
        callahan_label = _CALLAHAN_LABELS.get(metric, metric)

        # Institution values chronologically for this metric
        inst_series = inst_df.set_index("period")[metric].dropna()
        inst_vals   = [float(inst_series[p]) for p in hist_periods if p in inst_series.index]
        if not inst_vals:
            continue
        current_inst = inst_vals[-1]

        # ── Acceleration ───────────────────────────────────────────────
        acc = _detect_acceleration_from_values(inst_vals, is_adverse)
        acc_card = {
            **acc,
            "metric":            metric,
            "callahan_label":    callahan_label,
            "institution_value": current_inst,
        }
        if best_acc is None or _LEVEL_ORDER.get(acc["alert_level"], 99) < _LEVEL_ORDER.get(best_acc["alert_level"], 99):
            best_acc = acc_card

        # ── Divergence ─────────────────────────────────────────────────
        peer_medians_for_metric = peer_med_by_metric.get(metric, {})
        peer_vals = [float(peer_medians_for_metric[p]) for p in hist_periods if p in peer_medians_for_metric]
        n_align   = min(len(inst_vals), len(peer_vals))
        if n_align >= 5:
            div = _detect_divergence_from_values(inst_vals[-n_align:], peer_vals[-n_align:], is_adverse)
            div_card = {
                **div,
                "metric":              metric,
                "callahan_label":      callahan_label,
                "institution_value":   current_inst,
                "peer_median_current": peer_vals[-1],
            }
            if best_div is None or _LEVEL_ORDER.get(div["alert_level"], 99) < _LEVEL_ORDER.get(best_div["alert_level"], 99):
                best_div = div_card

        # ── Projection ─────────────────────────────────────────────────
        threshold = thresholds.get(metric)
        if threshold is not None:
            proj = _project_breach_from_values(inst_vals, threshold, is_adverse)
            proj_card = {
                **proj,
                "metric":          metric,
                "callahan_label":  callahan_label,
                "current_value":   current_inst,
                "threshold_value": threshold,
            }
            if best_proj is None or _LEVEL_ORDER.get(proj["alert_level"], 99) < _LEVEL_ORDER.get(best_proj["alert_level"], 99):
                best_proj = proj_card

    has_active = any([
        best_acc  and best_acc.get("alert_level",  "none") not in ("none", None),
        best_div  and best_div.get("alert_level",  "none") not in ("none", None),
        best_proj and best_proj.get("alert_level", "none") not in ("none", None),
    ])

    return {
        "has_active_alerts": has_active,
        "acceleration":      best_acc,
        "divergence":        best_div,
        "projection":        best_proj,
    }


# ── Legacy run_early_warning (backward compat with existing alerts endpoint) ──

def should_auto_expand_panel(warnings: list[EarlyWarning]) -> bool:
    return any(w.alert_level not in (AlertLevel.GREEN, AlertLevel.NONE) for w in warnings)


def run_early_warning(
    charter_number: int,
    peer_charters:  list[int],
    period:         str,
    periods:        list[str] | None = None,
    tenant_thresholds: Optional[dict] = None,
    db_url: str | None = None,
) -> list[EarlyWarning]:
    """Legacy flat-list output — kept for existing /alerts/{id} endpoint.

    The new /alerts/{id}/early-warning endpoint uses compute_early_warning_cards()
    which returns the structured three-card format.
    """
    if periods is None:
        periods = _trailing_periods(period, n=8)

    cards = compute_early_warning_cards(charter_number, peer_charters, period, tenant_thresholds, db_url)

    warnings: list[EarlyWarning] = []

    # Convert structured cards back to legacy flat rows
    if cards["acceleration"] and cards["acceleration"]["alert_level"] != "none":
        c = cards["acceleration"]
        warnings.append(EarlyWarning(
            metric=c["metric"],
            alert_level=AlertLevel(c["alert_level"]) if c["alert_level"] in ("red", "yellow", "green") else AlertLevel.YELLOW,
            institution_value=float(c.get("institution_value") or float("nan")),
            peer_median=float("nan"),
            qoq_change=c.get("recent_avg_change"),
            quarters_to_breach=None,
            signal_type="acceleration",
            message=f"{c['callahan_label']}: acceleration ratio {c.get('acceleration_ratio', 0):.1f}×",
        ))

    if cards["divergence"] and cards["divergence"]["alert_level"] != "none":
        c = cards["divergence"]
        warnings.append(EarlyWarning(
            metric=c["metric"],
            alert_level=AlertLevel(c["alert_level"]) if c["alert_level"] in ("red", "yellow", "green") else AlertLevel.YELLOW,
            institution_value=float(c.get("institution_value") or float("nan")),
            peer_median=float(c.get("peer_median_current") or float("nan")),
            qoq_change=None,
            quarters_to_breach=None,
            signal_type="divergence",
            message=f"{c['callahan_label']}: {abs(c.get('total_divergence', 0)) * 100:.2f} pct pts adverse divergence",
        ))

    if cards["projection"] and cards["projection"]["alert_level"] != "none":
        c = cards["projection"]
        qtb = c.get("quarters_to_threshold")
        warnings.append(EarlyWarning(
            metric=c["metric"],
            alert_level=AlertLevel.RED if (qtb is not None and qtb <= 2) else AlertLevel.YELLOW,
            institution_value=float(c.get("current_value") or float("nan")),
            peer_median=float("nan"),
            qoq_change=None,
            quarters_to_breach=qtb,
            signal_type="threshold_projection",
            message=f"{c['callahan_label']}: ~{qtb:.1f}q to threshold" if qtb else "Threshold breached",
        ))

    severity = {AlertLevel.RED: 0, AlertLevel.YELLOW: 1, AlertLevel.GREEN: 2, AlertLevel.URGENT: 0, AlertLevel.ALERT: 1, AlertLevel.WATCH: 2, AlertLevel.NONE: 3}
    warnings.sort(key=lambda w: severity.get(w.alert_level, 9))
    return warnings
