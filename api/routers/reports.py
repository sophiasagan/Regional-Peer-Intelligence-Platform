"""Router: /reports — quarterly board report and risk committee memo generation."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

router = APIRouter()

DB_URL = os.environ.get("DATABASE_URL")
REPORTS_DIR = Path(os.environ.get("REPORTS_DIR", "data/reports"))


class ReportMetadata(BaseModel):
    report_id: str
    report_type: Literal["quarterly_board", "risk_committee"]
    charter_number: int
    period: str
    generated_at: str
    filename: str
    download_url: str


def _gather_data(charter_number: int, period: str, peer_group: str, tenant_id: str) -> dict:
    """Assemble all data needed for report generation."""
    from processing.delinquency_engine import compute_ratios, credit_risk_composite
    from processing.early_warning_engine import _trailing_periods, run_early_warning
    from processing.market_share_engine import compute_deposit_share
    from processing.peer_engine import PeerGroupType, build_peer_group, peer_group_label
    from sqlalchemy import select
    from db import get_engine, institutions_quarterly

    engine = get_engine(DB_URL)
    group_type = PeerGroupType(peer_group)
    peer_charters = build_peer_group(charter_number, period, group_type, tenant_id, db_url=DB_URL)
    label = peer_group_label(group_type, charter_number, period, DB_URL)

    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.charter_number == charter_number,
                institutions_quarterly.c.period == period,
            )
        )
        rows = result.mappings().all()

    import pandas as pd
    inst_df = compute_ratios(pd.DataFrame([dict(r) for r in rows])) if rows else pd.DataFrame()

    periods = _trailing_periods(period, n=8)
    warnings = run_early_warning(charter_number, peer_charters, period, periods, db_url=DB_URL)
    composite = credit_risk_composite(charter_number, period, peer_charters, DB_URL)

    return {
        "tenant_id": tenant_id,
        "charter_number": charter_number,
        "period": period,
        "peer_group_type": peer_group,
        "peer_group_label": label,
        "peer_count": len(peer_charters),
        "peer_charters": peer_charters,
        "institution_financials": inst_df.to_dict("records")[0] if not inst_df.empty else {},
        "credit_risk_composite": composite,
        "early_warnings": warnings,
    }


@router.post("/quarterly/{charter_number}", response_model=ReportMetadata)
async def generate_quarterly_report(
    request: Request,
    charter_number: int,
    period: str = Query(...),
    peer_group: str = Query(default="REGIONAL"),
):
    """Generate the quarterly competitive intelligence board report."""
    from reports.quarterly_template import build_report
    tenant_id = request.state.tenant_id

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_id = str(uuid.uuid4())
    data = _gather_data(charter_number, period, peer_group, tenant_id)
    output_path = build_report(charter_number, period, peer_group, str(REPORTS_DIR), data, db_url=DB_URL)

    return ReportMetadata(
        report_id=report_id,
        report_type="quarterly_board",
        charter_number=charter_number,
        period=period,
        generated_at=datetime.now(timezone.utc).isoformat(),
        filename=output_path.name,
        download_url=f"/reports/download/{output_path.name}",
    )


@router.post("/credit-quality/{charter_number}", response_model=ReportMetadata)
async def generate_credit_quality_report(
    request: Request,
    charter_number: int,
    period: str = Query(...),
    peer_group: str = Query(default="REGIONAL"),
):
    """Generate the risk committee memo + board credit quality section."""
    from reports.credit_quality_report import build_report
    tenant_id = request.state.tenant_id

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_id = str(uuid.uuid4())
    data = _gather_data(charter_number, period, peer_group, tenant_id)
    output_path = build_report(charter_number, period, peer_group, str(REPORTS_DIR), data, db_url=DB_URL)

    return ReportMetadata(
        report_id=report_id,
        report_type="risk_committee",
        charter_number=charter_number,
        period=period,
        generated_at=datetime.now(timezone.utc).isoformat(),
        filename=output_path.name,
        download_url=f"/reports/download/{output_path.name}",
    )


@router.get("/download/{filename:path}")
async def download_report(request: Request, filename: str):
    # Strip directory components to prevent path traversal
    safe_name = Path(filename).name
    target = REPORTS_DIR / safe_name
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail=f"Report {safe_name!r} not found")
    return FileResponse(
        path=str(target),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=safe_name,
    )
