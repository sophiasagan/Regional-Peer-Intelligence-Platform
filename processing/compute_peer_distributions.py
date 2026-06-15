"""Quarterly batch job: compute peer distributions for all account codes × all peer groups.

Runs after each NCUA ingest. Pre-computes percentile distributions so the API
reads from the peer_distributions table rather than computing on the fly.

Usage:
    python -m processing.compute_peer_distributions --period 2026Q1
"""

from __future__ import annotations

import argparse
import logging

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from db import get_engine, institutions_quarterly, peer_distributions
from processing.delinquency_engine import ADVERSE_METRICS, compute_ratios
from processing.peer_engine import ASSET_BANDS, PeerGroupType

logger = logging.getLogger(__name__)

METRICS = [
    "acct_010",          # total assets (raw)
    "acct_025B",         # total loans
    "acct_018",          # total shares/deposits
    "acct_083",          # member count
    "delinq_rate_total",
    "chargeoff_rate_total_annualized",
    "alll_coverage",
    "alll_to_loans",
    "net_worth_ratio",
    "roa_annualized",
    "efficiency_ratio",
]

PEER_GROUP_TYPES = [
    PeerGroupType.REGIONAL,
    PeerGroupType.STATE,
    PeerGroupType.ASSET_SIZE,
]


def load_financials(period: str, db_url: str | None = None) -> pd.DataFrame:
    """Load all institutions for the given period and compute derived ratios."""
    engine = get_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(
            select(institutions_quarterly).where(
                institutions_quarterly.c.period == period
            )
        )
        df = pd.DataFrame(result.mappings().all())
    if df.empty:
        return df
    return compute_ratios(df)


def _compute_distribution(values: pd.Series) -> dict:
    clean = pd.to_numeric(values, errors="coerce")
    clean = clean[np.isfinite(clean)]
    if len(clean) < 5:
        return {}
    return {
        "p10": float(clean.quantile(0.10)),
        "p25": float(clean.quantile(0.25)),
        "p50": float(clean.quantile(0.50)),
        "p75": float(clean.quantile(0.75)),
        "p90": float(clean.quantile(0.90)),
        "institution_count": len(clean),
    }


def compute_all_distributions(period: str, df: pd.DataFrame) -> pd.DataFrame:
    """Return long-form rows: (metric, peer_group_type, period, p10…p90, institution_count)."""
    rows = []

    for group_type in PEER_GROUP_TYPES:
        if group_type == PeerGroupType.REGIONAL:
            # Regional = same state; group by state_code
            for state, state_df in df.groupby("state_code"):
                for metric in METRICS:
                    if metric not in state_df.columns:
                        continue
                    dist = _compute_distribution(state_df[metric])
                    if not dist:
                        continue
                    rows.append({
                        "metric": metric,
                        "peer_group_type": f"REGIONAL:{state}",
                        "period": period,
                        **dist,
                    })

        elif group_type == PeerGroupType.STATE:
            for state, state_df in df.groupby("state_code"):
                for metric in METRICS:
                    if metric not in state_df.columns:
                        continue
                    dist = _compute_distribution(state_df[metric])
                    if not dist:
                        continue
                    rows.append({
                        "metric": metric,
                        "peer_group_type": f"STATE:{state}",
                        "period": period,
                        **dist,
                    })

        elif group_type == PeerGroupType.ASSET_SIZE:
            for lo, hi in ASSET_BANDS:
                label = f"ASSET:{int(lo/1e6)}M-{int(hi/1e6)}M" if hi < float("inf") else f"ASSET:{int(lo/1e6)}M+"
                band_df = df[(df["acct_010"] >= lo) & (df["acct_010"] < hi)]
                for metric in METRICS:
                    if metric not in band_df.columns:
                        continue
                    dist = _compute_distribution(band_df[metric])
                    if not dist:
                        continue
                    rows.append({
                        "metric": metric,
                        "peer_group_type": label,
                        "period": period,
                        **dist,
                    })

    return pd.DataFrame(rows)


def upsert_distributions(distributions: pd.DataFrame, db_url: str | None = None) -> int:
    """Upsert distribution rows into peer_distributions table."""
    if distributions.empty:
        return 0

    engine = get_engine(db_url)
    records = distributions.where(pd.notna(distributions), other=None).to_dict("records")
    pk_cols = {"metric", "peer_group_type", "period"}
    update_cols = [c.name for c in peer_distributions.c if c.name not in pk_cols and c.name != "computed_at"]

    total = 0
    with engine.begin() as conn:
        for i in range(0, len(records), 500):
            batch = records[i : i + 500]
            stmt = pg_insert(peer_distributions).values(batch)
            stmt = stmt.on_conflict_do_update(
                index_elements=list(pk_cols),
                set_={col: stmt.excluded[col] for col in update_cols},
            )
            total += conn.execute(stmt).rowcount

    return total


def run(period: str, db_url: str | None = None) -> None:
    logger.info("Computing peer distributions for %s", period)
    df = load_financials(period, db_url)
    if df.empty:
        logger.warning("No data found for period %s — skipping", period)
        return
    distributions = compute_all_distributions(period, df)
    n = upsert_distributions(distributions, db_url)
    logger.info("Wrote %d distribution rows for %s", n, period)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--period", required=True, help="e.g. 2026Q1")
    parser.add_argument("--db-url", default=None)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run(args.period, args.db_url)
