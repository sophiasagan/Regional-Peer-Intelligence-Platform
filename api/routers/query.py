"""Router: /ask — natural language competitive intelligence query.

Accepts standard credit union metric vocabulary and plain-language questions.
Maps metric names to internal Magnus metric keys via INDUSTRY_METRIC_MAP.
Always confirms which metric was matched: "Using: Total Delinquency Ratio".
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Optional

import anthropic
import pandas as pd
from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from api.entitlements import require_entitlement
from db import get_engine, institutions_quarterly
from processing.delinquency_engine import compute_peer_distribution, compute_ratios, rank_institution, assign_stars
from processing.market_share_engine import calculate_market_share
from processing.peer_engine import PeerGroupType, build_peer_group

router = APIRouter()
logger = logging.getLogger(__name__)

DB_URL            = os.environ.get("DATABASE_URL")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# ── Standard industry vocabulary → Magnus internal metric names ───────────────
#
# Keys are lowercase; longest-match wins in resolve_metric().
# Magnus metric names on the right MUST match what compute_ratios() produces.

INDUSTRY_METRIC_MAP: dict[str, str] = {
    # ── Delinquency ──
    "delinquency ratio":                             "delinq_rate_total",
    "delinquency rate":                              "delinq_rate_total",
    "total delinquency":                             "delinq_rate_total",
    "total delinquency ratio":                       "delinq_rate_total",
    "total delinquency rate":                        "delinq_rate_total",
    "total delinquency 90+ days":                    "delinq_rate_90plus",
    "90+ day delinquency":                           "delinq_rate_90plus",
    "90 day delinquency":                            "delinq_rate_90plus",
    "total auto loan delinquency":                   "delinq_rate_auto_total",
    "auto loan delinquency":                         "delinq_rate_auto_total",
    "auto delinquency":                              "delinq_rate_auto_total",
    "new auto loan delinquency":                     "delinq_rate_new_auto",
    "used auto loan delinquency":                    "delinq_rate_used_auto",
    "credit card loan delinquency":                  "delinq_rate_credit_card",
    "credit card delinquency":                       "delinq_rate_credit_card",
    "real estate delinquency":                       "delinq_rate_real_estate",
    "real estate loan delinquency":                  "delinq_rate_real_estate",
    "1st mortgage delinquency":                      "delinq_rate_first_mortgage",
    "first mortgage delinquency":                    "delinq_rate_first_mortgage",
    "commercial loan delinquency":                   "delinq_rate_commercial",
    "commercial delinquency":                        "delinq_rate_commercial",
    "indirect loan delinquency":                     "delinq_rate_indirect",
    "indirect delinquency":                          "delinq_rate_indirect",
    "delinquent loans to assets":                    "delinq_to_assets",
    "delinquent loans to net worth":                 "delinq_to_net_worth",
    # ── Charge-offs ──
    "net charge-off ratio":                          "chargeoff_rate_total_annualized",
    "net charge-off rate":                           "chargeoff_rate_total_annualized",
    "net charge-offs":                               "chargeoff_rate_total_annualized",
    "net charge-offs to average loans":              "chargeoff_rate_total_annualized",
    "charge-off ratio":                              "chargeoff_rate_total_annualized",
    "charge off ratio":                              "chargeoff_rate_total_annualized",
    "net charge-offs to prior year delinquency":     "nco_to_prior_delinquency",
    # ── Allowance / ALLL ──
    "allowance coverage ratio":                      "alll_coverage",
    "alll coverage":                                 "alll_coverage",
    "alll coverage ratio":                           "alll_coverage",
    "acl coverage ratio":                            "alll_coverage",
    "allowance for loan losses to delinquent loans": "alll_coverage",
    "alll to total loans":                           "alll_to_loans",
    "acl to total loans":                            "alll_to_loans",
    "allowance for loan losses to total loans":      "alll_to_loans",
    # ── Capital ──
    "net worth ratio":                               "net_worth_ratio",
    "capital ratio":                                 "net_worth_ratio",
    "risk-based capital ratio":                      "rbc_ratio",
    "risk based capital ratio":                      "rbc_ratio",
    # ── Income / efficiency ──
    "return on assets":                              "roa_annualized",
    "roa":                                           "roa_annualized",
    "net interest margin":                           "nim",
    "nim":                                           "nim",
    "efficiency ratio":                              "efficiency_ratio",
    # ── Growth ──
    "member growth":                                 "member_growth_rate",
    "member growth rate":                            "member_growth_rate",
    "loan growth":                                   "loan_growth_rate",
    "loan growth rate":                              "loan_growth_rate",
    "share growth":                                  "share_growth_rate",
    "deposit growth":                                "share_growth_rate",
    # ── Market share ──
    "deposit market share":                          "deposit_market_share_pct",
    "loan market share":                             "loan_market_share_pct",
    "market share":                                  "deposit_market_share_pct",
}

# Backward-compat alias — onboarding.py imports by old name
CALLAHAN_TO_P76_METRIC_MAP = INDUSTRY_METRIC_MAP

# Reverse map: Magnus metric key → display label shown to users.
_METRIC_DISPLAY_NAMES: dict[str, str] = {
    "delinq_rate_total":               "Total Delinquency Ratio",
    "delinq_rate_90plus":              "90+ Day Delinquency",
    "delinq_rate_auto_total":          "Total Auto Loan Delinquency",
    "delinq_rate_new_auto":            "New Auto Loan Delinquency",
    "delinq_rate_used_auto":           "Used Auto Loan Delinquency",
    "delinq_rate_credit_card":         "Credit Card Loan Delinquency",
    "delinq_rate_real_estate":         "Real Estate Delinquency",
    "delinq_rate_first_mortgage":      "1st Mortgage Delinquency",
    "delinq_rate_commercial":          "Commercial Loan Delinquency",
    "delinq_rate_indirect":            "Indirect Loan Delinquency",
    "delinq_to_assets":                "Delinquent Loans to Assets",
    "delinq_to_net_worth":             "Delinquent Loans to Net Worth",
    "chargeoff_rate_total_annualized": "Net Charge-Off Ratio",
    "nco_to_prior_delinquency":        "Net Charge-Offs to Prior Year Delinquency",
    "alll_coverage":                   "Allowance Coverage Ratio",
    "alll_to_loans":                   "ALLL to Total Loans",
    "net_worth_ratio":                 "Net Worth Ratio",
    "rbc_ratio":                       "Risk-Based Capital Ratio",
    "roa_annualized":                  "Return on Assets",
    "nim":                             "Net Interest Margin",
    "efficiency_ratio":                "Efficiency Ratio",
    "member_growth_rate":              "Member Growth Rate",
    "loan_growth_rate":                "Loan Growth Rate",
    "share_growth_rate":               "Share/Deposit Growth Rate",
    "deposit_market_share_pct":        "Deposit Market Share",
    "loan_market_share_pct":           "Loan Market Share",
}

# Market share metrics: routed through calculate_market_share(), not compute_ratios().
# Maps p76 metric key → (market_share_engine metric, institution_types)
_SHARE_METRICS: set[str] = {"deposit_market_share_pct", "loan_market_share_pct"}
_SHARE_METRIC_PARAMS: dict[str, tuple[str, list[str]]] = {
    "deposit_market_share_pct": ("deposits", ["bank", "cu"]),
    # loans: CU-only — banks don't report total loan balances to FDIC SOD
    "loan_market_share_pct":    ("loans",    ["cu"]),
}

# ── VOCABULARY_INSTRUCTION ────────────────────────────────────────────────────

VOCABULARY_INSTRUCTION = """\
You understand standard credit union metric names used across the NCUA 5300 Call Report.
When a user asks about a metric, identify the correct metric and confirm which one you used:
'Using: Total Delinquency Ratio'

The user's institution is: {tenant_cu_name} in {tenant_state}.
Their primary markets: {tenant_counties}.
Default peer group: regional ({tenant_state} CUs with branch presence in same markets).
"""
VOCABULARY_INSTRUCTION = VOCABULARY_INSTRUCTION  # backward-compat alias


# ── Tenant context ────────────────────────────────────────────────────────────

@dataclass
class TenantContext:
    cu_name:    str
    state:      str
    counties:   str
    peer_label: str


def _load_tenant_context(charter_number: Optional[int], period: Optional[str]) -> TenantContext:
    if not charter_number or not period:
        return TenantContext(
            cu_name="your credit union",
            state="your state",
            counties="your primary markets",
            peer_label="regional CUs with branch presence in the same markets",
        )

    try:
        engine = get_engine(DB_URL)
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    institutions_quarterly.c.institution_name,
                    institutions_quarterly.c.state_code,
                    institutions_quarterly.c.county_name,
                ).where(
                    institutions_quarterly.c.charter_number == charter_number,
                    institutions_quarterly.c.period == period,
                )
            )
            row = result.mappings().first()

        if not row:
            raise ValueError("not found")

        state      = row["state_code"] or "your state"
        cu_name    = row["institution_name"] or f"Charter {charter_number}"
        county     = row["county_name"] or "your primary markets"
        peer_label = f"regional {state} CUs with branch presence in {county}"
        return TenantContext(cu_name=cu_name, state=state, counties=county, peer_label=peer_label)

    except Exception:
        return TenantContext(
            cu_name=f"Charter {charter_number}",
            state="your state",
            counties="your primary markets",
            peer_label="regional CUs with branch presence in the same markets",
        )


# ── Metric resolution ─────────────────────────────────────────────────────────

def resolve_metric(question: str) -> tuple[Optional[str], Optional[str]]:
    """Return (p76_metric_name, matched_term). Longest-match wins."""
    lower_q = question.lower()
    for matched_term in sorted(INDUSTRY_METRIC_MAP, key=len, reverse=True):
        if matched_term in lower_q:
            return INDUSTRY_METRIC_MAP[matched_term], matched_term
    return None, None


def _confirmation_text(p76_metric: str, matched_term: str) -> str:
    display = _METRIC_DISPLAY_NAMES.get(p76_metric, p76_metric.replace("_", " ").title())
    return f"Using: {display}"


# ── System prompt ─────────────────────────────────────────────────────────────

def _build_system_prompt(tenant: TenantContext) -> str:
    vocabulary = VOCABULARY_INSTRUCTION.format(
        tenant_cu_name=tenant.cu_name,
        tenant_state=tenant.state,
        tenant_counties=tenant.counties,
        tenant_peer_label=tenant.peer_label,
    )
    base = (
        "You are a credit union competitive intelligence analyst. "
        "Answer questions concisely using NCUA 5300 call report data. "
        "Always state which metric you are discussing using standard credit union metric names. "
        "When comparing to peers, specify the peer group (Regional, State, or National Asset-Size). "
        "Be precise with numbers — include both dollar amounts and rates where relevant. "
        "Format percentages to three decimal places (e.g. 1.234%). "
        "IMPORTANT: When ACTUAL DATA FROM DATABASE is provided, always use those exact figures "
        "to answer the question. Never say data is unavailable if numbers are provided."
    )
    return f"{base}\n\n{vocabulary}"


# ── Request / response models ─────────────────────────────────────────────────

class QueryRequest(BaseModel):
    question:       str
    charter_number: Optional[int] = None
    geo_id:         Optional[str] = None   # county FIPS, state abbrev, or MSA CBSA code
    period:         Optional[str] = None
    peer_group:     str = "REGIONAL"


class QueryResponse(BaseModel):
    answer:              str
    matched_metric:      Optional[str] = None
    matched_term:        Optional[str] = None
    confirmation_text:   Optional[str] = None
    data:                Optional[Any] = None
    sources:             list[str] = []


# ── Market share data path ────────────────────────────────────────────────────

def _compute_share_metric_data(
    p76_metric:     str,
    charter_number: int,
    period:         str,
    tenant:         TenantContext,
    geo_id:         Optional[str],
) -> tuple[dict, list[str]]:
    """
    Call calculate_market_share() and return (data_dict, sources_list).

    Geography resolution:
      - If geo_id is provided (county FIPS = 5 digits, state abbrev = 2 alpha,
        MSA CBSA = 5 digits starting with non-zero, else treated as opaque UUID):
        use it directly with the appropriate geography_type.
      - If no geo_id: fall back to geography_type="state", geography_id=tenant.state.
        This is always well-populated from NCUA data and is explicitly labeled in
        the response so the user knows what scope was used.
    """
    engine_metric, inst_types = _SHARE_METRIC_PARAMS[p76_metric]

    # Resolve geography
    if geo_id:
        if len(geo_id) == 5 and geo_id.isdigit():
            geo_type  = "county"
            geo_label = f"county FIPS {geo_id}"
        elif len(geo_id) == 2 and geo_id.isalpha():
            geo_type  = "state"
            geo_label = geo_id
        else:
            geo_type  = "state"   # opaque / UUID — pass through as-is
            geo_label = geo_id
        resolved_geo_id = geo_id
    else:
        # No geo provided: use institution's home state from NCUA
        geo_type        = "state"
        resolved_geo_id = tenant.state
        geo_label       = (
            f"{tenant.state} statewide "
            f"(default — no specific geography provided; specify a county FIPS for county-level results)"
        )

    df = calculate_market_share(
        geography_type=geo_type,
        geography_id=resolved_geo_id,
        period=period,
        metric=engine_metric,
        institution_types=inst_types,
        db_url=DB_URL,
    )

    if df.empty:
        return {
            "market_data_unavailable": True,
            "geography_label":         geo_label,
            "geography_type":          geo_type,
            # peer_distribution key kept so frontend data panel doesn't crash
            "peer_distribution":       {"n": 0},
        }, []

    df = df.reset_index(drop=True)
    inst_key  = f"ncua:{charter_number}"
    inst_rows = df[df["charter_or_cert"] == inst_key]

    if inst_rows.empty:
        return {
            "market_data_unavailable":   False,
            "institution_not_in_market": True,
            "geography_label":           geo_label,
            "geography_type":            geo_type,
            "market_n":                  len(df),
            "peer_distribution":         {"n": len(df)},
        }, []

    inst_idx   = int(inst_rows.index[0])         # position in descending-share sorted df
    inst_share = float(inst_rows.iloc[0]["market_share"])
    inst_rank  = inst_idx + 1                     # 1-based overall rank
    confidence = str(inst_rows.iloc[0].get("confidence", ""))
    data_period = str(inst_rows.iloc[0].get("data_period", period))
    yoy_raw    = inst_rows.iloc[0].get("share_change_yoy")
    yoy_change = float(yoy_raw) if yoy_raw is not None and not pd.isna(yoy_raw) else None

    n_total   = len(df)
    cu_df     = df[df["institution_type"] == "cu"].reset_index(drop=True)
    cu_inst   = cu_df[cu_df["charter_or_cert"] == inst_key]
    cu_rank   = int(cu_inst.index[0]) + 1 if not cu_inst.empty else None
    n_cu      = len(cu_df)

    market_total = float(df["metric_value"].sum())

    # Top 10 by share — used in the user message sent to Claude
    top_rows = df.head(10)[
        ["institution_name", "institution_type", "market_share", "charter_or_cert"]
    ].to_dict("records")

    # Sources
    if engine_metric == "deposits":
        sources = [
            f"FDIC Summary of Deposits ({data_period})",
            "CU deposit allocations (modeled/estimated)",
        ]
    else:
        sources = [f"NCUA 5300 ({period}) — CU-only loan data"]

    data = {
        "institution_value":    inst_share,       # 0.0–1.0
        "market_rank":          inst_rank,
        "market_n":             n_total,
        "cu_rank":              cu_rank,
        "market_n_cu":          n_cu,
        "confidence":           confidence,
        "data_period":          data_period,
        "geography_type":       geo_type,
        "geography_label":      geo_label,
        "market_total":         market_total,
        "share_change_yoy":     yoy_change,
        "top_competitors":      top_rows,
        # Keep peer_distribution + percentile_rank for frontend backward compat
        # (supporting data panel reads these keys).
        # n = total institutions in market; p-values are N/A for this metric type.
        "peer_distribution":    {"n": n_total, "p50": None, "p10": None, "p90": None},
        "percentile_rank":      None,
        "stars":                None,
    }
    return data, sources


# ── Core query handler ────────────────────────────────────────────────────────

async def run_nl_query(query_req: QueryRequest, tenant_id: str) -> QueryResponse:
    p76_metric, matched_term = resolve_metric(query_req.question)
    confirmation              = _confirmation_text(p76_metric, matched_term) if p76_metric else None
    tenant                    = _load_tenant_context(query_req.charter_number, query_req.period)

    data:    dict | None = None
    sources: list[str]  = []

    if p76_metric and query_req.charter_number and query_req.period:
        try:
            if p76_metric in _SHARE_METRICS:
                # ── Geography-aware market share path ──────────────────────────
                # Calls calculate_market_share() — the same engine used by Market Map
                # and Competitive Breakdown. No acct_018-ratio fallback.
                share_data, share_sources = _compute_share_metric_data(
                    p76_metric,
                    query_req.charter_number,
                    query_req.period,
                    tenant,
                    query_req.geo_id,
                )
                data = {**share_data, "confirmation": confirmation}
                sources.extend(share_sources)

            else:
                # ── Standard NCUA ratio path ───────────────────────────────────
                engine = get_engine(DB_URL)
                with engine.connect() as conn:
                    result = conn.execute(
                        select(institutions_quarterly).where(
                            institutions_quarterly.c.charter_number == query_req.charter_number,
                            institutions_quarterly.c.period == query_req.period,
                        )
                    )
                    rows = result.mappings().all()

                if rows:
                    inst_df   = compute_ratios(pd.DataFrame([dict(r) for r in rows]))
                    inst_val  = inst_df[p76_metric].iloc[0] if p76_metric in inst_df.columns else None

                    peer_charters = build_peer_group(
                        query_req.charter_number, query_req.period,
                        PeerGroupType(query_req.peer_group), tenant_id, db_url=DB_URL,
                    )
                    dist = compute_peer_distribution(p76_metric, peer_charters, query_req.period, DB_URL)

                    pct_rank = (
                        rank_institution(float(inst_val), dist, p76_metric)
                        if inst_val is not None and dist["n"] > 0
                        else None
                    )

                    data = {
                        "institution_value": float(inst_val) if inst_val is not None else None,
                        "peer_distribution": dist,
                        "percentile_rank":   round(pct_rank, 1) if pct_rank is not None else None,
                        "stars":             assign_stars(pct_rank) if pct_rank is not None else None,
                        "confirmation":      confirmation,
                    }
                    sources.append(f"NCUA 5300 {query_req.period}")

        except Exception as exc:
            logger.warning("NL query data fetch failed: %s", exc)

    # ── Build user message ─────────────────────────────────────────────────────
    context_parts = []
    if query_req.charter_number:
        context_parts.append(f"Institution: {tenant.cu_name} (Charter #{query_req.charter_number})")
    if query_req.period:
        context_parts.append(f"Period: {query_req.period}")
    if p76_metric:
        context_parts.append(f"Resolved metric: {p76_metric}")
    if confirmation:
        context_parts.append(confirmation)
    if query_req.peer_group:
        context_parts.append(f"Peer group: {query_req.peer_group}")

    user_msg = "\n".join(context_parts) + f"\n\nQuestion: {query_req.question}"

    if data:
        label = _METRIC_DISPLAY_NAMES.get(p76_metric, p76_metric)

        if p76_metric in _SHARE_METRICS:
            # ── Market share data block ────────────────────────────────────────
            if data.get("market_data_unavailable"):
                user_msg += (
                    f"\n\nNOTE: No {label} data found for {data.get('geography_label', 'the requested geography')}. "
                    f"FDIC/CU allocation data may not be ingested for this market yet. "
                    f"Tell the user the data is not available for this geography and suggest "
                    f"they check the Market Map page or contact support."
                )
            elif data.get("institution_not_in_market"):
                user_msg += (
                    f"\n\nNOTE: {tenant.cu_name} was not found in the {label} data for "
                    f"{data.get('geography_label')} ({data.get('market_n', '?')} total institutions in market). "
                    f"The institution may have no branch or deposit presence in this market. "
                    f"Tell the user the institution does not appear in this market's data."
                )
            else:
                iv          = data["institution_value"]
                rank        = data["market_rank"]
                n           = data["market_n"]
                cu_rank     = data.get("cu_rank")
                n_cu        = data.get("market_n_cu", 0)
                confidence  = data.get("confidence", "")
                dp          = data.get("data_period", "")
                geo_label   = data.get("geography_label", "")
                yoy         = data.get("share_change_yoy")
                mkt_total   = data.get("market_total", 0)
                top_rows    = data.get("top_competitors", [])
                metric_noun = "deposits" if p76_metric == "deposit_market_share_pct" else "loans"

                yoy_str    = f"{yoy * 100:+.2f} pp" if yoy is not None else "N/A"
                cu_str     = f" / #{cu_rank} of {n_cu} CUs" if cu_rank is not None else ""

                # Build top-institutions list; mark requesting institution
                top_lines = []
                inst_in_top = False
                for i, row in enumerate(top_rows[:10], 1):
                    is_inst = row["charter_or_cert"] == f"ncua:{query_req.charter_number}"
                    if is_inst:
                        inst_in_top = True
                    marker = "  ← THIS INSTITUTION" if is_inst else ""
                    top_lines.append(
                        f"  {i}. {row['institution_name']} ({row['institution_type']}): "
                        f"{row['market_share'] * 100:.3f}%{marker}"
                    )
                if not inst_in_top:
                    top_lines.append(
                        f"  ...\n  {rank}. {tenant.cu_name}: {iv * 100:.3f}% (ranked #{rank})"
                    )

                top_block = "\n".join(top_lines)

                user_msg += (
                    f"\n\nACTUAL MARKET SHARE DATA FROM DATABASE (use these exact figures):\n"
                    f"  Metric: {label}\n"
                    f"  Geography: {geo_label}\n"
                    f"  Data source: {'FDIC Summary of Deposits + CU allocations' if metric_noun == 'deposits' else 'NCUA 5300 (CU-only loan balances)'}"
                    f" — as of {dp}\n"
                    f"  {tenant.cu_name} {metric_noun} share: {iv * 100:.3f}%\n"
                    f"  Market rank: #{rank} of {n} institutions{cu_str}\n"
                    f"  Share change (YoY): {yoy_str}\n"
                    f"  Confidence: {confidence}\n"
                    f"  Total market {metric_noun}: ${mkt_total:,.0f}\n"
                    f"\nTop institutions by {metric_noun} share:\n{top_block}\n"
                    f"\nCONSTRAINT: Present only the factual competitive position data above. "
                    f"Do NOT generate an 'Analyst Takeaway' section, strategic business "
                    f"recommendations, or actionable advice. State the share, rank, and geography "
                    f"used; if the user asked about a specific county/geography that differs from "
                    f"the geography shown above, note that the data shown is {geo_label}."
                )

        else:
            # ── Standard NCUA ratio data block ────────────────────────────────
            iv      = data["institution_value"]
            p50     = data["peer_distribution"].get("p50")
            p10     = data["peer_distribution"].get("p10")
            p90     = data["peer_distribution"].get("p90")
            pct_str = f"{data['percentile_rank']:.1f}th percentile" if data["percentile_rank"] is not None else "N/A"
            user_msg += (
                f"\n\nACTUAL DATA FROM DATABASE (use these exact figures in your answer):\n"
                f"  Metric: {label}\n"
                f"  Institution value (raw): {iv}\n"
                f"  Peer median (raw):       {p50}\n"
                f"  Peer P10 (raw):          {p10}\n"
                f"  Peer P90 (raw):          {p90}\n"
                f"  Percentile rank:         {pct_str}\n"
                f"  Stars:                   {data['stars'] or '—'} / 5\n"
                f"  Peer count:              {data['peer_distribution']['n']}\n"
                f"Note: rate metrics are decimals (0.012 = 1.2%); dollar metrics are raw dollars."
            )

    # ── Call Claude ────────────────────────────────────────────────────────────
    client  = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        system=_build_system_prompt(tenant),
        messages=[{"role": "user", "content": user_msg}],
    )
    answer = message.content[0].text

    return QueryResponse(
        answer=answer,
        matched_metric=p76_metric,
        matched_term=matched_term,
        confirmation_text=confirmation,
        data=data,
        sources=sources,
    )


@router.post("/", response_model=QueryResponse)
async def ask(request_body: QueryRequest, request: Request):
    tenant_id = request.state.tenant_id
    if request_body.charter_number is not None:
        require_entitlement(tenant_id, request_body.charter_number)
    return await run_nl_query(request_body, tenant_id)
