"""Router: /peer-comparison — line-by-line NCUA schedule comparison.

Star scale (Callahan convention):
  1 star = bottom <10%
  5 stars = top 90%+

Color coding:
  Top decile (90th+) = green badge
  Bottom decile (<10th) = red badge

Peer group label must appear in every response (P76 rule).
"""

from __future__ import annotations

import math
import os
from typing import Literal, Optional

import pandas as pd
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import select, text

from db import get_engine, institutions_quarterly
from processing.delinquency_engine import (
    ADVERSE_METRICS,
    GROWTH_METRICS,
    assign_stars,
    compute_growth,
    compute_peer_distribution,
    compute_ratios,
    rank_institution,
    _prior_year_period,
)
from processing.early_warning_engine import _trailing_periods
from processing.peer_engine import PeerGroupType, build_peer_group, peer_group_label

router = APIRouter()

DB_URL = os.environ.get("DATABASE_URL")

# Six-tier asset ladder — ordered smallest → largest.
# Used for peer-list tier expansion (±N tiers).
_ASSET_TIERS: list[tuple[str, str, float, float]] = [
    ("under_100m", "Under $100M",     0,                 100_000_000),
    ("100m_250m",  "$100M – $250M",   100_000_000,       250_000_000),
    ("250m_500m",  "$250M – $500M",   250_000_000,       500_000_000),
    ("500m_1b",    "$500M – $1B",     500_000_000,     1_000_000_000),
    ("1b_5b",      "$1B – $5B",     1_000_000_000,     5_000_000_000),
    ("5b_plus",    "$5B+",          5_000_000_000, 999_000_000_000_000),
]


def _tier_index(assets: float) -> int:
    for i, (_, _, lo, hi) in enumerate(_ASSET_TIERS):
        if lo <= assets < hi:
            return i
    return len(_ASSET_TIERS) - 1

# Callahan display names for internal metric names
METRIC_LABELS: dict[str, tuple[str, str]] = {
    # (callahan_label, unit) — order controls display order in comparison table
    # Asset Quality
    "delinq_rate_total":               ("Total Delinquency Ratio",        "%"),
    "delinq_rate_90plus":              ("90+ Day Delinquency",            "%"),
    "chargeoff_rate_total_annualized": ("Net Charge-Off Ratio",           "%"),
    "alll_coverage":                   ("Allowance Coverage Ratio",       "x"),
    "alll_to_loans":                   ("ALLL to Total Loans",            "%"),
    "non_accrual_rate":                ("Non-Accrual Rate",               "%"),
    "tdr_to_loans":                    ("TDR / Modifications",            "%"),
    # Delinquency by Product
    "delinq_rate_cc":                  ("Credit Card Delinquency",        "%"),
    "delinq_rate_auto":                ("Auto Delinquency",               "%"),
    "delinq_rate_1st_mortgage":        ("1st Mortgage Delinquency",       "%"),
    "delinq_rate_nonfarm_nonre":       ("Non-Farm Non-RE Delinquency",    "%"),
    "delinq_rate_commercial_re":       ("Commercial RE Delinquency",      "%"),
    # Capital
    "net_worth_ratio":                 ("Net Worth Ratio",                "%"),
    "rbc_ratio":                       ("Risk-Based Capital Ratio",       "%"),
    # Earnings
    "roa_annualized":                  ("Return on Assets",               "%"),
    "nim":                             ("Net Interest Margin",            "%"),
    "efficiency_ratio":                ("Efficiency Ratio",               "%"),
    # Lending / Balance Sheet
    "loan_to_share":                   ("Loan-to-Share Ratio",            "%"),
    "acct_010":                        ("Total Assets",                   "$"),
    "acct_025B":                       ("Total Loans and Leases",         "$"),
    "acct_018":                        ("Total Shares and Deposits",      "$"),
    "acct_083":                        ("Members",                        "count"),
    # Growth (YoY — computed from prior-year same quarter)
    "loan_growth_rate":                ("Loan Growth Rate",               "%"),
    "share_growth_rate":               ("Share Growth Rate",              "%"),
    "asset_growth_rate":               ("Asset Growth Rate",              "%"),
    "member_growth_rate":              ("Member Growth Rate",             "%"),
}

DISPLAY_METRICS = list(METRIC_LABELS.keys())


class MetricRow(BaseModel):
    metric_name: str
    callahan_label: str
    institution_value: Optional[float]
    peer_median: Optional[float]
    peer_p10: Optional[float]
    peer_p90: Optional[float]
    percentile_rank: Optional[float]
    stars: Optional[int]
    is_adverse: bool
    unit: str


class PeerComparisonResponse(BaseModel):
    charter_number: int
    institution_name: str
    period: str
    peer_group_type: str
    peer_group_label: str
    peer_count: int
    metrics: list[MetricRow]


class InstitutionDetail(BaseModel):
    charter_number: int
    institution_name: str
    state_abbrev: Optional[str]
    county_name: Optional[str]
    period: str
    total_assets: Optional[int]


@router.get("/institution/{charter_number}", response_model=InstitutionDetail)
async def get_institution_detail(
    request: Request,
    charter_number: int,
    period: str = Query(...),
):
    """Lightweight institution metadata — used by the frontend to resolve the institution's state."""
    engine = get_engine(DB_URL)
    with engine.connect() as conn:
        result = conn.execute(
            select(
                institutions_quarterly.c.charter_number,
                institutions_quarterly.c.institution_name,
                institutions_quarterly.c.state_code,
                institutions_quarterly.c.county_name,
                institutions_quarterly.c.period,
                institutions_quarterly.c.acct_010,
            ).where(
                institutions_quarterly.c.charter_number == charter_number,
                institutions_quarterly.c.period == period,
            )
        )
        row = result.mappings().first()

    if not row:
        raise HTTPException(status_code=404, detail=f"Charter {charter_number} not found for {period}")

    return InstitutionDetail(
        charter_number=row["charter_number"],
        institution_name=row["institution_name"] or f"Charter {charter_number}",
        state_abbrev=row["state_code"],
        county_name=row["county_name"],
        period=row["period"],
        total_assets=row["acct_010"],
    )


@router.get("/{charter_number}/peer-list")
async def get_peer_list(
    request: Request,
    charter_number: int,
    period: str = Query(...),
    peer_group: Literal["REGIONAL", "STATE", "ASSET_SIZE"] = Query(default="REGIONAL"),
    expand_below: int = Query(default=0, ge=0, le=5),
    expand_above: int = Query(default=0, ge=0, le=5),
):
    """Return institutions in the peer group with names, assets, and tier labels.

    expand_below / expand_above extend the asset range by N tiers in each direction
    (e.g. expand_below=1 adds the next-smaller tier).  New-tier institutions are
    flagged so the UI can start them unchecked.
    """
    tenant_id = request.state.tenant_id
    engine = get_engine(DB_URL)

    # ── 1. Resolve base peer group ────────────────────────────────────────────
    group_type    = PeerGroupType(peer_group)
    base_charters = build_peer_group(charter_number, period, group_type, tenant_id, db_url=DB_URL)
    label         = peer_group_label(group_type, charter_number, period, DB_URL)
    base_set      = set(base_charters)

    # ── 2. Get institution's own assets + state ───────────────────────────────
    with engine.connect() as conn:
        inst_row = conn.execute(
            text("SELECT acct_010, state_code FROM institutions_quarterly "
                 "WHERE charter_number = :c AND period = :p LIMIT 1"),
            {"c": charter_number, "p": period},
        ).mappings().first()

    inst_assets = float(inst_row["acct_010"]) if inst_row and inst_row["acct_010"] else 0
    inst_state  = inst_row["state_code"] if inst_row else None
    base_idx    = _tier_index(inst_assets)

    # ── 3. Determine expanded asset range ─────────────────────────────────────
    lo_idx = max(0,                      base_idx - expand_below)
    hi_idx = min(len(_ASSET_TIERS) - 1,  base_idx + expand_above)
    asset_lo = _ASSET_TIERS[lo_idx][2]
    asset_hi = _ASSET_TIERS[hi_idx][3]

    # ── 4. Fetch all qualifying institutions ──────────────────────────────────
    if expand_below == 0 and expand_above == 0:
        # Fast path: just look up base charters
        query_sql = text("""
            SELECT DISTINCT ON (charter_number)
                charter_number, institution_name, state_code, acct_010
            FROM institutions_quarterly
            WHERE charter_number = ANY(:charters) AND period = :period
            ORDER BY charter_number, acct_010 DESC NULLS LAST
        """)
        params = {"charters": list(base_set), "period": period}
    else:
        # Expanded path: same geographic filter + wider asset band
        if peer_group == "REGIONAL" and inst_state:
            query_sql = text("""
                SELECT DISTINCT ON (charter_number)
                    charter_number, institution_name, state_code, acct_010
                FROM institutions_quarterly
                WHERE period = :period
                  AND state_code = :state
                  AND acct_010 BETWEEN :lo AND :hi
                ORDER BY charter_number, acct_010 DESC NULLS LAST
            """)
            params = {"period": period, "state": inst_state, "lo": asset_lo, "hi": asset_hi}
        else:
            query_sql = text("""
                SELECT DISTINCT ON (charter_number)
                    charter_number, institution_name, state_code, acct_010
                FROM institutions_quarterly
                WHERE period = :period
                  AND acct_010 BETWEEN :lo AND :hi
                ORDER BY charter_number, acct_010 DESC NULLS LAST
            """)
            params = {"period": period, "lo": asset_lo, "hi": asset_hi}

    with engine.connect() as conn:
        rows = conn.execute(query_sql, params).fetchall()

    # ── 5. Annotate each institution with its tier ────────────────────────────
    institutions = []
    for r in rows:
        assets    = int(r[3]) if r[3] else None
        tier_idx  = _tier_index(float(assets)) if assets else base_idx
        _, tier_label, _, _ = _ASSET_TIERS[tier_idx]
        institutions.append({
            "charter_number":   int(r[0]),
            "institution_name": r[1] or f"Charter {r[0]}",
            "state":            r[2],
            "total_assets":     assets,
            "tier_label":       tier_label,
            "is_base_tier":     (tier_idx == base_idx),
            "in_base_group":    (int(r[0]) in base_set),
        })

    institutions.sort(key=lambda x: (
        0 if x["in_base_group"] else 1,        # base group first
        -_tier_index(x["total_assets"] or 0),  # then largest tier first
        -(x["total_assets"] or 0),
    ))

    # Tiers available for expansion (for UI button state)
    available_below = base_idx > 0
    available_above = base_idx < len(_ASSET_TIERS) - 1
    base_tier_label = _ASSET_TIERS[base_idx][1]
    below_tier_label = _ASSET_TIERS[base_idx - 1][1] if base_idx > 0 else None
    above_tier_label = _ASSET_TIERS[base_idx + 1][1] if base_idx < len(_ASSET_TIERS) - 1 else None

    return {
        "charter_number":    charter_number,
        "period":            period,
        "peer_group_type":   peer_group,
        "peer_group_label":  label,
        "base_tier_label":   base_tier_label,
        "below_tier_label":  below_tier_label,
        "above_tier_label":  above_tier_label,
        "available_below":   available_below,
        "available_above":   available_above,
        "institutions":      institutions,
    }


@router.get("/{charter_number}", response_model=PeerComparisonResponse)
async def get_peer_comparison(
    request: Request,
    charter_number: int,
    period: str = Query(...),
    peer_group: Literal["REGIONAL", "STATE", "ASSET_SIZE", "CUSTOM"] = Query(default="REGIONAL"),
    custom_group_name: Optional[str] = Query(default=None),
    custom_charters: Optional[str] = Query(
        default=None,
        description="Comma-separated charter numbers — overrides peer_group when provided",
    ),
):
    tenant_id = request.state.tenant_id
    engine = get_engine(DB_URL)

    # Load institution financials
    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.charter_number == charter_number,
                institutions_quarterly.c.period == period,
            )
        )
        rows = result.mappings().all()

    if not rows:
        raise HTTPException(status_code=404, detail=f"Charter {charter_number} not found for period {period}")

    inst_df = compute_ratios(pd.DataFrame([dict(r) for r in rows]))

    # Load prior-year period for YoY growth rates
    prior_period = _prior_year_period(period)
    if prior_period:
        with engine.connect() as conn:
            prior_result = conn.execute(
                select(institutions_quarterly).where(
                    institutions_quarterly.c.charter_number == charter_number,
                    institutions_quarterly.c.period == prior_period,
                )
            )
            prior_rows = prior_result.mappings().all()
        prior_df = pd.DataFrame([dict(r) for r in prior_rows]) if prior_rows else None
    else:
        prior_df = None

    inst_df  = compute_growth(inst_df, prior_df)
    inst_row = inst_df.iloc[0]
    institution_name = str(inst_row.get("institution_name", f"Charter {charter_number}"))

    # Build peer group — custom_charters overrides peer_group when provided
    if custom_charters:
        peer_charters = [int(c.strip()) for c in custom_charters.split(",") if c.strip().isdigit()]
        label = f"Custom selection ({len(peer_charters)} institutions)"
    else:
        group_type = PeerGroupType(peer_group)
        peer_charters = build_peer_group(charter_number, period, group_type, tenant_id, custom_group_name, DB_URL)
        label = peer_group_label(group_type, charter_number, period, DB_URL)

    # Build metric rows
    metric_rows = []
    for metric, (callahan_label, unit) in METRIC_LABELS.items():
        inst_val = inst_row.get(metric)
        dist = compute_peer_distribution(metric, peer_charters, period, DB_URL, prior_period=prior_period)

        if dist["n"] == 0 or inst_val is None or __import__("math").isnan(float(inst_val if inst_val is not None else float("nan"))):
            metric_rows.append(MetricRow(
                metric_name=metric,
                callahan_label=callahan_label,
                institution_value=None,
                peer_median=dist.get("p50"),
                peer_p10=dist.get("p10"),
                peer_p90=dist.get("p90"),
                percentile_rank=None,
                stars=None,
                is_adverse=metric in ADVERSE_METRICS,
                unit=unit,
            ))
            continue

        pct_rank = rank_institution(float(inst_val), dist, metric)
        metric_rows.append(MetricRow(
            metric_name=metric,
            callahan_label=callahan_label,
            institution_value=float(inst_val),
            peer_median=dist.get("p50"),
            peer_p10=dist.get("p10"),
            peer_p90=dist.get("p90"),
            percentile_rank=round(pct_rank, 1),
            stars=assign_stars(pct_rank),
            is_adverse=metric in ADVERSE_METRICS,
            unit=unit,
        ))

    return PeerComparisonResponse(
        charter_number=charter_number,
        institution_name=institution_name,
        period=period,
        peer_group_type=peer_group,
        peer_group_label=label,
        peer_count=len(peer_charters),
        metrics=metric_rows,
    )


class LoanTypeRow(BaseModel):
    loan_type: str
    label: str
    institution_rate: Optional[float]     # delinquency rate — null until NCUA loan-type fields ingested
    peer_median_rate: Optional[float]
    institution_balance: Optional[int]    # balance in dollars
    pct_of_total_loans: Optional[float]   # composition share


class LoanTypeBreakdownResponse(BaseModel):
    charter_number: int
    period: str
    peer_group_label: str
    peer_count: int
    has_granular_delinquency: bool        # False until per-product delinquency fields are added to ingester
    loan_types: list[LoanTypeRow]


# (loan_type_key, display_label, balance_cols, computed_ratio_name_or_None)
# computed_ratio_name references a column produced by compute_ratios() — not a raw acct code.
_LOAN_TYPE_DEFS: list[tuple[str, str, list[str], Optional[str]]] = [
    ("real_estate",      "Real Estate",       ["acct_703A", "acct_386A", "acct_718A5"],  None),
    ("first_mortgage",   "1st Mortgage",      ["acct_703A"],                             "delinq_rate_1st_mortgage"),
    ("auto_total",       "Auto (Total)",      ["acct_385", "acct_370"],                  "delinq_rate_auto"),
    ("auto_new",         "New Auto",          ["acct_385"],                              None),
    ("auto_used",        "Used Auto",         ["acct_370"],                              None),
    ("credit_card",      "Credit Card",       ["acct_396"],                              "delinq_rate_cc"),
    ("commercial_re",    "Commercial RE",     ["acct_718A5"],                            "delinq_rate_commercial_re"),
    ("nonfarm_nonre",    "Non-Farm Non-RE",   ["acct_400P"],                             "delinq_rate_nonfarm_nonre"),
    ("indirect",         "Indirect",          ["acct_618A"],                             None),
]


@router.get("/{charter_number}/loan-type-breakdown", response_model=LoanTypeBreakdownResponse)
async def get_loan_type_breakdown(
    request: Request,
    charter_number: int,
    period: str = Query(...),
    peer_group: Literal["REGIONAL", "STATE", "ASSET_SIZE"] = Query(default="REGIONAL"),
):
    """Return delinquency rate and portfolio share by loan type for PeerBandChart cross-section.

    institution_rate and peer_median_rate are null until per-product NCUA delinquency
    fields are added to the ingester (verify field names against NCUA 5300 data dictionary).
    """
    tenant_id = request.state.tenant_id
    engine = get_engine(DB_URL)

    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.charter_number == charter_number,
                institutions_quarterly.c.period == period,
            )
        )
        rows = result.mappings().all()

    if not rows:
        raise HTTPException(status_code=404, detail=f"Charter {charter_number} not found for {period}")

    inst_df = compute_ratios(pd.DataFrame([dict(r) for r in rows]))
    inst = inst_df.iloc[0]
    total_loans = float(inst.get("acct_025B") or 0) or None

    group_type = PeerGroupType(peer_group)
    peer_charters = build_peer_group(charter_number, period, group_type, tenant_id, db_url=DB_URL)
    label = peer_group_label(group_type, charter_number, period, DB_URL)

    # Pre-fetch peer medians for all metrics that have a delinq_col
    peer_medians: dict[str, Optional[float]] = {}
    for _, _, _, delinq_col in _LOAN_TYPE_DEFS:
        if delinq_col and delinq_col not in peer_medians:
            dist = compute_peer_distribution(delinq_col, peer_charters, period, DB_URL)
            p50 = dist.get("p50")
            peer_medians[delinq_col] = float(p50) if p50 is not None and not math.isnan(float(p50)) else None

    loan_rows = []
    has_any_delinq = False
    for loan_type, display_label, balance_cols, delinq_col in _LOAN_TYPE_DEFS:
        inst_bal = sum(float(inst.get(col) or 0) for col in balance_cols)
        pct = (inst_bal / total_loans) if (total_loans and inst_bal) else None

        inst_rate = None
        if delinq_col:
            raw = inst.get(delinq_col)
            if raw is not None and not (isinstance(raw, float) and math.isnan(raw)):
                inst_rate = float(raw)
                has_any_delinq = True

        loan_rows.append(LoanTypeRow(
            loan_type=loan_type,
            label=display_label,
            institution_rate=inst_rate,
            peer_median_rate=peer_medians.get(delinq_col) if delinq_col else None,
            institution_balance=int(inst_bal) if inst_bal else None,
            pct_of_total_loans=round(pct, 4) if pct is not None else None,
        ))

    return LoanTypeBreakdownResponse(
        charter_number=charter_number,
        period=period,
        peer_group_label=label,
        peer_count=len(peer_charters),
        has_granular_delinquency=has_any_delinq,
        loan_types=loan_rows,
    )


# ── Schedule-based FPR endpoint ───────────────────────────────────────────────
#
# Reads from peer_distributions (precomputed) when peer_group_id is known.
# Falls back to on-the-fly compute_peer_distribution() when the table has no row.
#
# Callahan color conventions (non-negotiable):
#   Top decile (adjusted rank ≥ 90) → green    — "good"
#   Bottom decile (adjusted rank ≤ 10) → red   — "bad"
#   Polarity is handled: for ADVERSE metrics, lower value = higher adjusted rank.

# Merged ADVERSE set: engine names + spec names + raw dollar delinquency codes
# (higher raw dollar balance always means more stressed asset quality).
_SCHEDULE_ADVERSE: frozenset[str] = ADVERSE_METRICS | frozenset({
    # Spec aliases
    "delinq_rate_auto", "delinq_90plus_rate", "chargeoff_rate_total",
    "chargeoff_rate_auto", "chargeoff_rate_credit_card",
    "delinq_rate_commercial", "delinq_rate_real_estate",
    # Per-product rate names used in schedule rows
    "delinq_rate_auto_total", "delinq_rate_first_mortgage",
    "delinq_rate_commercial_re", "delinq_rate_credit_card",
    # Raw dollar delinquency balances (higher balance = worse)
    "acct_041B", "acct_020B", "acct_DL0141",
    "acct_021B", "acct_022B", "acct_023B",
    "acct_550",   # gross charge-offs YTD
    "acct_798A",  # OREO total
})

# Schedule definitions: (line_item, account_code, is_adverse, display_format)
# account_code = raw NCUA code (acct_*) OR computed ratio name from compute_ratios()
_SCHEDULE_DEFS: dict[str, list[tuple[str, str, bool, str]]] = {
    "schedule_a_delinquency": [
        ("Total 60+ Day Delinquent Loans",    "acct_041B",                        True,  "dollar"),
        ("Total Delinquency Ratio",           "delinq_rate_total",                True,  "percent"),
        ("90+ Day Delinquency",               "delinq_rate_90plus",               True,  "percent"),
        ("30-59 Day Delinquent Loans",        "acct_020B",                        True,  "dollar"),
        ("60-89 Day Delinquent Loans",        "acct_DL0141",                      True,  "dollar"),
        ("90-179 Day Delinquent Loans",       "acct_021B",                        True,  "dollar"),
        ("180-359 Day Delinquent Loans",      "acct_022B",                        True,  "dollar"),
        ("360+ Day Delinquent Loans",         "acct_023B",                        True,  "dollar"),
        ("Gross Charge-Offs YTD",             "acct_550",                         True,  "dollar"),
        ("Total Recoveries YTD",              "acct_551",                         False, "dollar"),
        ("Net Charge-Off Ratio (Annualized)", "chargeoff_rate_total_annualized",  True,  "percent"),
        ("ACL / ALLL on Loans",               "acct_AS0048",                      False, "dollar"),
        ("Allowance Coverage Ratio",          "alll_coverage",                    False, "ratio"),
        ("ALLL to Total Loans",               "alll_to_loans",                    False, "percent"),
    ],
    "capital": [
        ("Total Net Worth",           "acct_997",        False, "dollar"),
        ("Net Worth Ratio",           "net_worth_ratio", False, "percent"),
        ("Risk-Based Capital Ratio",  "acct_RB0172",     False, "percent"),
    ],
    "earnings": [
        ("Net Income",                      "acct_661A",        False, "dollar"),
        ("Return on Assets (Annualized)",   "roa_annualized",   False, "percent"),
        ("Net Interest Income",             "acct_IS0010",      False, "dollar"),
        ("Total Non-Interest Expense",      "acct_671",         True,  "dollar"),
        ("Efficiency Ratio",                "efficiency_ratio", True,  "percent"),
    ],
    "balance_sheet": [
        ("Total Assets",             "acct_010",  False, "dollar"),
        ("Total Loans and Leases",   "acct_025B", False, "dollar"),
        ("Total Shares and Deposits","acct_018",  False, "dollar"),
        ("Members",                  "acct_083",  False, "count"),
    ],
}

# Peer group type → peer_groups.group_type column value
_GROUP_TYPE_MAP: dict[str, str] = {
    "REGIONAL":   "regional",
    "STATE":      "state",
    "ASSET_SIZE": "callahan_national",
    "CUSTOM":     "custom",
}


def _fetch_peer_dist_from_table(
    metric_key: str,
    period: str,
    peer_group_id: str,
    engine,
) -> dict | None:
    """Read precomputed distribution from peer_distributions. Returns None if not found."""
    with engine.connect() as conn:
        row = conn.execute(
            text("""
                SELECT p10, p25, median AS p50, p75, p90, n_peers
                FROM peer_distributions
                WHERE metric_key   = :metric_key
                  AND period       = :period
                  AND peer_group_id = :pgid
                LIMIT 1
            """),
            {"metric_key": metric_key, "period": period, "pgid": peer_group_id},
        ).mappings().first()

    if not row:
        return None

    def _f(v) -> float | None:
        return float(v) if v is not None else None

    return {
        "p10": _f(row["p10"]),
        "p25": _f(row["p25"]),
        "p50": _f(row["p50"]),
        "p75": _f(row["p75"]),
        "p90": _f(row["p90"]),
        "n":   int(row["n_peers"]) if row["n_peers"] is not None else 0,
    }


def _resolve_peer_group_id(
    charter_number: int,
    group_type_str: str,   # "REGIONAL" | "STATE" | "ASSET_SIZE"
    tenant_id,
    engine,
) -> str | None:
    """Look up the UUID of a precomputed peer group for this institution.

    Searches peer_groups where institution_ids contains this charter number,
    preferring tenant-specific groups, then defaults.
    """
    db_group_type = _GROUP_TYPE_MAP.get(group_type_str, group_type_str.lower())
    charter_str   = str(charter_number)
    tenant_str    = str(tenant_id) if tenant_id else None

    with engine.connect() as conn:
        row = conn.execute(
            text("""
                SELECT id FROM peer_groups
                WHERE group_type = :group_type
                  AND :charter = ANY(institution_ids)
                  AND (tenant_id = :tenant_id OR is_default = TRUE)
                ORDER BY
                  CASE WHEN tenant_id = :tenant_id THEN 0 ELSE 1 END,
                  is_default DESC,
                  created_at DESC
                LIMIT 1
            """),
            {"group_type": db_group_type, "charter": charter_str, "tenant_id": tenant_str},
        ).mappings().first()

    return str(row["id"]) if row else None


def _color_flag_from_adjusted_rank(adjusted_rank: float) -> str:
    """Callahan convention: top decile = green, bottom decile = red.

    adjusted_rank is already polarity-corrected (higher always = better).
    """
    if adjusted_rank >= 90:
        return "green"
    if adjusted_rank <= 10:
        return "red"
    return "neutral"


class ScheduleLineItem(BaseModel):
    line_item: str
    account_code: str
    institution_value: Optional[float]
    peer_p10: Optional[float]
    peer_p25: Optional[float]
    peer_median: Optional[float]
    peer_p75: Optional[float]
    peer_p90: Optional[float]
    peer_count: int
    percentile_rank: Optional[float]   # polarity-adjusted: 0=worst, 100=best
    color_flag: Optional[str]          # "green" | "neutral" | "red"
    stars: Optional[int]               # 1–5, Callahan scale
    is_adverse: bool
    display_format: str                # "dollar" | "percent" | "count" | "ratio"


class ScheduleResponse(BaseModel):
    charter_number: int
    institution_name: str
    period: str
    schedule: str
    peer_group_type: str
    peer_group_label: str
    peer_group_id: Optional[str]        # UUID if precomputed group found; null = on-the-fly
    peer_count: int
    source: str                         # "precomputed" | "on_the_fly"
    rows: list[ScheduleLineItem]


@router.get("/{charter_number}/schedule", response_model=ScheduleResponse)
async def get_schedule_comparison(
    request: Request,
    charter_number: int,
    period: str = Query(...),
    schedule: str = Query(default="schedule_a_delinquency"),
    peer_group: Literal["REGIONAL", "STATE", "ASSET_SIZE"] = Query(default="REGIONAL"),
    peer_group_id: Optional[str] = Query(
        default=None,
        description="UUID from peer_groups table. When provided, distributions are read from "
                    "peer_distributions (fast). When omitted, the endpoint resolves the default "
                    "peer group for this institution, then falls back to on-the-fly computation.",
    ),
):
    """Line-by-line NCUA schedule comparison using precomputed peer distributions.

    For each account code / computed ratio in the requested schedule:
      1. Fetch institution value from institutions_quarterly (compute_ratios for derived metrics)
      2. Fetch peer distribution from peer_distributions (precomputed) — falls back to
         on-the-fly compute_peer_distribution() when the precomputed row is missing
      3. Compute polarity-adjusted percentile rank
      4. Assign color_flag (green / neutral / red) per Callahan top/bottom-decile convention
      5. Assign stars (1–5 Callahan scale)

    Returns every row regardless of data availability; institution_value / percentile_rank are
    null when data is missing for a given period.
    """
    line_defs = _SCHEDULE_DEFS.get(schedule)
    if line_defs is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown schedule '{schedule}'. Available: {sorted(_SCHEDULE_DEFS)}",
        )

    tenant_id = request.state.tenant_id
    engine    = get_engine(DB_URL)

    # ── Load institution row ───────────────────────────────────────────────────
    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.charter_number == charter_number,
                institutions_quarterly.c.period == period,
            )
        )
        db_rows = result.mappings().all()

    if not db_rows:
        raise HTTPException(status_code=404, detail=f"Charter {charter_number} not found for {period}")

    inst_df   = compute_ratios(pd.DataFrame([dict(r) for r in db_rows]))
    inst_row  = inst_df.iloc[0]
    inst_name = str(inst_row.get("institution_name") or f"Charter {charter_number}")

    # ── Resolve peer group ─────────────────────────────────────────────────────
    resolved_id = peer_group_id

    if resolved_id is None:
        resolved_id = _resolve_peer_group_id(charter_number, peer_group, tenant_id, engine)

    # On-the-fly fallback: load actual peer charters
    group_type    = PeerGroupType(peer_group)
    peer_charters: list[int] = []
    if resolved_id is None:
        peer_charters = build_peer_group(charter_number, period, group_type, tenant_id, db_url=DB_URL)

    group_label = peer_group_label(group_type, charter_number, period, DB_URL)
    source      = "precomputed" if resolved_id else "on_the_fly"

    # ── Build schedule rows ────────────────────────────────────────────────────
    rows: list[ScheduleLineItem] = []

    for line_item, account_code, is_adverse, display_format in line_defs:
        # Institution value — try column directly, then from inst_row by name
        raw_val = inst_row.get(account_code)
        inst_val: float | None = None
        if raw_val is not None:
            try:
                f = float(raw_val)
                inst_val = None if math.isnan(f) or math.isinf(f) else f
            except (TypeError, ValueError):
                inst_val = None

        # Peer distribution — precomputed table first, then on-the-fly
        dist: dict | None = None
        if resolved_id:
            dist = _fetch_peer_dist_from_table(account_code, period, resolved_id, engine)

        if dist is None:
            # Fall back: compute on the fly (handles both "no precomputed row" and
            # "peer_group_id not resolved" paths)
            if not peer_charters:
                peer_charters = build_peer_group(charter_number, period, group_type, tenant_id, db_url=DB_URL)
            dist = compute_peer_distribution(account_code, peer_charters, period, DB_URL)
            if source == "precomputed":
                source = "on_the_fly"   # downgrade if any metric needed on-the-fly fallback

        n_peers = dist.get("n", 0)

        if inst_val is None or n_peers == 0 or dist.get("p10") is None:
            rows.append(ScheduleLineItem(
                line_item=line_item,
                account_code=account_code,
                institution_value=inst_val,
                peer_p10=dist.get("p10"),
                peer_p25=dist.get("p25"),
                peer_median=dist.get("p50"),
                peer_p75=dist.get("p75"),
                peer_p90=dist.get("p90"),
                peer_count=n_peers,
                percentile_rank=None,
                color_flag=None,
                stars=None,
                is_adverse=is_adverse,
                display_format=display_format,
            ))
            continue

        # Use the combined adverse set (engine ADVERSE_METRICS + spec names + raw codes)
        effective_adverse = account_code in _SCHEDULE_ADVERSE

        # rank_institution uses ADVERSE_METRICS from delinquency_engine for inversion.
        # For codes not in that set but in _SCHEDULE_ADVERSE, invert manually.
        if effective_adverse and account_code not in ADVERSE_METRICS:
            # Temporarily treat as positive to get raw_rank, then invert
            raw_rank = rank_institution(inst_val, dist, "__positive_placeholder__")
            adj_rank = round(100.0 - raw_rank, 1)
        else:
            adj_rank = round(rank_institution(inst_val, dist, account_code), 1)

        rows.append(ScheduleLineItem(
            line_item=line_item,
            account_code=account_code,
            institution_value=inst_val,
            peer_p10=dist.get("p10"),
            peer_p25=dist.get("p25"),
            peer_median=dist.get("p50"),
            peer_p75=dist.get("p75"),
            peer_p90=dist.get("p90"),
            peer_count=n_peers,
            percentile_rank=adj_rank,
            color_flag=_color_flag_from_adjusted_rank(adj_rank),
            stars=assign_stars(adj_rank),
            is_adverse=effective_adverse,
            display_format=display_format,
        ))

    actual_peer_count = (
        peer_charters.__len__() if peer_charters
        else (rows[0].peer_count if rows else 0)
    )

    return ScheduleResponse(
        charter_number=charter_number,
        institution_name=inst_name,
        period=period,
        schedule=schedule,
        peer_group_type=peer_group,
        peer_group_label=group_label,
        peer_group_id=resolved_id,
        peer_count=actual_peer_count,
        source=source,
        rows=rows,
    )


@router.get("/{charter_number}/metric/{metric_name}")
async def get_single_metric_trend(
    request: Request,
    charter_number: int,
    metric_name: str,
    period: str = Query(...),
    peer_group: str = Query(default="REGIONAL"),
    n_periods: int = Query(default=12),
):
    """Return peer band data for PeerBandChart: institution + p10/p50/p90 over time."""
    tenant_id = request.state.tenant_id
    periods = _trailing_periods(period, n=n_periods)

    group_type = PeerGroupType(peer_group)
    peer_charters = build_peer_group(charter_number, period, group_type, tenant_id, db_url=DB_URL)
    label = peer_group_label(group_type, charter_number, period, DB_URL)

    engine = get_engine(DB_URL)
    result_rows = []

    is_growth = metric_name in GROWTH_METRICS

    for p in periods:
        prior_p = _prior_year_period(p)

        with engine.connect() as conn:
            inst_result = conn.execute(
                select(institutions_quarterly).where(
                    institutions_quarterly.c.charter_number == charter_number,
                    institutions_quarterly.c.period == p,
                )
            )
            inst_rows = inst_result.mappings().all()

        if not inst_rows:
            inst_val = None
        else:
            inst_df = compute_ratios(pd.DataFrame([dict(r) for r in inst_rows]))
            if is_growth and prior_p:
                with engine.connect() as conn:
                    prior_result = conn.execute(
                        select(institutions_quarterly).where(
                            institutions_quarterly.c.charter_number == charter_number,
                            institutions_quarterly.c.period == prior_p,
                        )
                    )
                    prior_rows = prior_result.mappings().all()
                prior_df = pd.DataFrame([dict(r) for r in prior_rows]) if prior_rows else None
                inst_df = compute_growth(inst_df, prior_df)
            inst_val = inst_df[metric_name].iloc[0] if metric_name in inst_df.columns else None

        dist = compute_peer_distribution(metric_name, peer_charters, p, DB_URL, prior_period=prior_p)
        result_rows.append({
            "period": p,
            "institution_value": float(inst_val) if (inst_val is not None and not pd.isna(inst_val)) else None,
            "peer_p10": dist.get("p10"),
            "peer_p25": dist.get("p25"),
            "peer_p50": dist.get("p50"),
            "peer_p75": dist.get("p75"),
            "peer_p90": dist.get("p90"),
            "peer_count": dist.get("n", 0),
        })

    return {
        "charter_number": charter_number,
        "metric": metric_name,
        "callahan_label": METRIC_LABELS.get(metric_name, (metric_name, ""))[0],
        "peer_group_type": peer_group,
        "peer_group_label": label,
        "data": result_rows,
    }
