"""Router: /ask — natural language competitive intelligence query.

Accepts Callahan metric vocabulary and plain-language questions.
Maps Callahan names to internal P76 metric names via CALLAHAN_TO_P76_METRIC_MAP.
Always confirms which metric was matched: "Using: Total Delinquency Ratio (same as Callahan Delinquency Ratio)".
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

import anthropic
import pandas as pd
from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from db import get_engine, institutions_quarterly
from processing.delinquency_engine import compute_peer_distribution, compute_ratios, rank_institution, assign_stars
from processing.peer_engine import PeerGroupType, build_peer_group

router = APIRouter()

DB_URL           = os.environ.get("DATABASE_URL")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# ── Callahan vocabulary → P76 internal metric names ───────────────────────────
#
# Keys are lowercase; longest-match wins in resolve_metric().
# P76 metric names on the right MUST match what compute_ratios() produces.
# Spec aliases that differ from canonical names are normalized here.

CALLAHAN_TO_P76_METRIC_MAP: dict[str, str] = {
    # ── Delinquency (spec entries, normalized to compute_ratios() names) ──
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

# Reverse map: P76 metric → Callahan display name (for "Using: X" confirmation).
# Only covers the most common metrics; others fall back to metric_name.
_P76_TO_CALLAHAN_DISPLAY: dict[str, str] = {
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

# ── CALLAHAN_VOCABULARY_INSTRUCTION — injected into every Claude system prompt ─
#
# Template variables (hydrated at call time):
#   {tenant_cu_name}  — credit union name
#   {tenant_state}    — state abbreviation
#   {tenant_counties} — comma-separated primary market counties
#   {tenant_peer_label} — default peer group description
CALLAHAN_VOCABULARY_INSTRUCTION = """\
You understand both P76 metric names and Callahan Associates metric names.
When a user asks about a metric using Callahan's terminology, map it using \
CALLAHAN_TO_P76_METRIC_MAP. Always confirm which metric you used:
'Using: Total Delinquency Ratio (same as Callahan Delinquency Ratio)'

The user's institution is: {tenant_cu_name} in {tenant_state}.
Their primary markets: {tenant_counties}.
Default peer group: regional ({tenant_state} CUs with branch presence in same markets).
"""


# ── Tenant context ────────────────────────────────────────────────────────────

@dataclass
class TenantContext:
    cu_name:    str
    state:      str
    counties:   str
    peer_label: str


def _load_tenant_context(charter_number: Optional[int], period: Optional[str]) -> TenantContext:
    """Fetch institution name + state from institutions_quarterly for prompt hydration.

    Falls back to generic placeholders when charter_number / period are unknown.
    """
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
    """Return (p76_metric_name, matched_callahan_term). Longest-match wins."""
    lower_q = question.lower()
    for callahan_term in sorted(CALLAHAN_TO_P76_METRIC_MAP, key=len, reverse=True):
        if callahan_term in lower_q:
            return CALLAHAN_TO_P76_METRIC_MAP[callahan_term], callahan_term
    return None, None


def _confirmation_text(p76_metric: str, callahan_term: str) -> str:
    """Build the standard "Using: X (same as Callahan Y)" confirmation string."""
    callahan_display = _P76_TO_CALLAHAN_DISPLAY.get(p76_metric, p76_metric.replace("_", " ").title())
    # Callahan display from the matched term — title-case it
    matched_display = callahan_term.title()
    if callahan_display.lower() == matched_display.lower():
        return f"Using: {callahan_display}"
    return f"Using: {callahan_display} (same as Callahan {matched_display})"


# ── System prompt ─────────────────────────────────────────────────────────────

def _build_system_prompt(tenant: TenantContext) -> str:
    vocabulary = CALLAHAN_VOCABULARY_INSTRUCTION.format(
        tenant_cu_name=tenant.cu_name,
        tenant_state=tenant.state,
        tenant_counties=tenant.counties,
        tenant_peer_label=tenant.peer_label,
    )
    base = (
        "You are a credit union competitive intelligence analyst. "
        "Answer questions concisely using NCUA 5300 call report data. "
        "Always state which metric you are discussing using Callahan's exact metric names. "
        "When comparing to peers, specify the peer group (Regional, State, or National Asset-Size). "
        "Be precise with numbers — include both dollar amounts and rates where relevant. "
        "Format percentages to three decimal places (e.g. 1.234%)."
    )
    return f"{base}\n\n{vocabulary}"


# ── Request / response models ─────────────────────────────────────────────────

class QueryRequest(BaseModel):
    question:       str
    charter_number: Optional[int] = None
    geo_id:         Optional[str] = None
    period:         Optional[str] = None
    peer_group:     str = "REGIONAL"


class QueryResponse(BaseModel):
    answer:              str
    matched_metric:      Optional[str] = None
    callahan_term_used:  Optional[str] = None
    confirmation_text:   Optional[str] = None   # "Using: Total Delinquency Ratio (same as Callahan ...)"
    data:                Optional[Any] = None
    sources:             list[str] = []


# ── Core query handler ────────────────────────────────────────────────────────

async def run_nl_query(query_req: QueryRequest, tenant_id: str) -> QueryResponse:
    p76_metric, callahan_term = resolve_metric(query_req.question)
    confirmation              = _confirmation_text(p76_metric, callahan_term) if p76_metric else None
    tenant                    = _load_tenant_context(query_req.charter_number, query_req.period)

    # ── Pull supporting data when metric + charter + period are all known ──
    data:    dict | None = None
    sources: list[str]  = []

    if p76_metric and query_req.charter_number and query_req.period:
        try:
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
                inst_df  = compute_ratios(pd.DataFrame([dict(r) for r in rows]))
                inst_val = inst_df[p76_metric].iloc[0] if p76_metric in inst_df.columns else None

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
        except Exception:
            pass

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
        inst_fmt = f"{data['institution_value'] * 100:.3f}%" if data["institution_value"] is not None else "N/A"
        med_fmt  = (
            f"{data['peer_distribution']['p50'] * 100:.3f}%"
            if data["peer_distribution"].get("p50") is not None
            else "N/A"
        )
        pct_str  = f"{data['percentile_rank']:.1f}th percentile" if data["percentile_rank"] is not None else "N/A"
        user_msg += (
            f"\n\nData:\n"
            f"  Institution {_P76_TO_CALLAHAN_DISPLAY.get(p76_metric, p76_metric)}: {inst_fmt}\n"
            f"  Peer median: {med_fmt}\n"
            f"  Percentile rank: {pct_str} ({data['stars'] or '—'} stars)\n"
            f"  Peer count: {data['peer_distribution']['n']}"
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
        callahan_term_used=callahan_term,
        confirmation_text=confirmation,
        data=data,
        sources=sources,
    )


@router.post("/", response_model=QueryResponse)
async def ask(request_body: QueryRequest, request: Request):
    tenant_id = request.state.tenant_id
    return await run_nl_query(request_body, tenant_id)
