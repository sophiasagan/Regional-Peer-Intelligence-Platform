"""POST /insights/chart-narrative — narrate an already-computed chart.

IMPORTANT: This endpoint does NOT query the database, does NOT call
build_peer_group, calculate_market_share, compute_ratios, or any metric-
resolution logic. Its only job is to take numbers the frontend already has
and produce a short natural-language insight from them.
"""

from __future__ import annotations

import os
from typing import Optional

import anthropic
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

_SYSTEM_PROMPT = """\
You are a credit union financial analyst writing a concise dashboard annotation.

Rules — follow exactly:
1. Only reference numbers explicitly provided in the user message. \
Never invent, estimate, or interpolate figures not given.
2. Write 2–4 sentences of plain prose. No headers, no bullet points, no lists.
3. State the institution's current position relative to peers \
(above/below median, decile standing) using the exact values given.
4. If a trend direction is provided, describe it in one sentence.
5. Do not recommend specific business actions or strategic changes unless \
the data explicitly shows a threshold breach — in that case you may state \
the breach factually in one short sentence.
6. Tone: direct and professional — like a dashboard callout box, not a report.
7. Do not add disclaimers or caveats about data completeness.
"""


def _fmt(v: Optional[float], unit: str) -> str:
    if v is None:
        return "N/A"
    if unit == "%":
        return f"{v * 100:.3f}%"
    if unit == "x":
        return f"{v:.3f}x"
    if unit == "$":
        return f"${v / 1e9:.2f}B" if abs(v) >= 1e9 else f"${v / 1e6:.1f}M"
    if unit == "count":
        return f"{round(v):,}"
    return str(round(v, 4))


class TrendPoint(BaseModel):
    period: str
    institution_value: Optional[float] = None
    peer_median: Optional[float] = None


class ChartNarrativeRequest(BaseModel):
    metric_name:       str
    metric_label:      str
    unit:              str             # '%' | 'x' | '$' | 'count'
    institution_value: Optional[float] = None
    peer_median:       Optional[float] = None
    top_decile:        Optional[float] = None
    bottom_decile:     Optional[float] = None
    percentile_rank:   Optional[float] = None  # 0–100, higher = better (polarity adjusted)
    trend_series:      list[TrendPoint] = []
    peer_group_label:  str
    period:            str
    is_adverse:        bool = False


class ChartNarrativeResponse(BaseModel):
    narrative: str


@router.post("/chart-narrative", response_model=ChartNarrativeResponse)
async def chart_narrative(req: ChartNarrativeRequest):
    """Return a 2–4 sentence insight from pre-computed chart data. No DB access."""
    u = req.unit

    # Trend direction from the provided series
    inst_pts = [p for p in req.trend_series if p.institution_value is not None]
    trend_line = ""
    if len(inst_pts) >= 3:
        first, last = inst_pts[0], inst_pts[-1]
        direction   = (
            "increasing" if last.institution_value > first.institution_value
            else "decreasing" if last.institution_value < first.institution_value
            else "flat"
        )
        trend_line = (
            f"Trend ({first.period}–{last.period}): {direction} "
            f"({_fmt(first.institution_value, u)} → {_fmt(last.institution_value, u)})"
        )

    polarity = "adverse (lower is better)" if req.is_adverse else "positive (higher is better)"

    user_msg = (
        f"Metric: {req.metric_label}\n"
        f"Polarity: {polarity}\n"
        f"Period: {req.period}\n"
        f"Peer group: {req.peer_group_label}\n"
        f"\n"
        f"Current period:\n"
        f"  Institution:     {_fmt(req.institution_value, u)}\n"
        f"  Peer median:     {_fmt(req.peer_median, u)}\n"
        f"  Top decile:      {_fmt(req.top_decile, u)}\n"
        f"  Bottom decile:   {_fmt(req.bottom_decile, u)}\n"
        f"  Percentile rank: "
        f"{f'{req.percentile_rank:.0f}th (polarity-adjusted, higher = better)' if req.percentile_rank is not None else 'N/A'}\n"
    )
    if trend_line:
        user_msg += f"\n{trend_line}\n"
    user_msg += "\nWrite a concise 2–4 sentence insight using only the data above."

    client  = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=256,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    return ChartNarrativeResponse(narrative=message.content[0].text.strip())
