"""Geography-first peer group selection engine.

Regional is ALWAYS the default. Callahan-style national asset-size groups
are an alternative view only — never the default, always clearly labeled.

Priority order for default peer group:
  1. Same state + similar asset size (±50%) — minimum 10 institutions
  2. Same MSA (if CU is in major metro) — any size, minimum 5
  3. National same-asset-size — fallback only, clearly labeled
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Optional

import numpy as np
import pandas as pd
from sqlalchemy import select, text

from db import get_engine, institutions_quarterly

logger = logging.getLogger(__name__)

# Threshold for "regional ≈ national" in signal separation.
# If regional median is within this % of national, no significant regional stress.
_REGIONAL_STRESS_THRESHOLD = 0.10    # 10% above national = regional stress
_INSTITUTION_STRESS_THRESHOLD = 0.10  # 10% above regional = institution-specific

# Callahan asset tiers (used for get_callahan_style_peer_group)
CALLAHAN_ASSET_TIERS: dict[str, tuple[float, float]] = {
    "under_250M": (0,                 250_000_000),
    "250M_1B":    (250_000_000,     1_000_000_000),
    "1B_5B":      (1_000_000_000,   5_000_000_000),
    "over_5B":    (5_000_000_000,   float("inf")),
}

# Legacy fine-grained bands used by compute_peer_distributions
ASSET_BANDS = [
    (0,              10_000_000),
    (10_000_000,     50_000_000),
    (50_000_000,     250_000_000),
    (250_000_000,    500_000_000),
    (500_000_000,    1_000_000_000),
    (1_000_000_000,  3_000_000_000),
    (3_000_000_000,  float("inf")),
]


class PeerGroupType(str, Enum):
    REGIONAL = "REGIONAL"
    STATE = "STATE"
    ASSET_SIZE = "ASSET_SIZE"
    CUSTOM = "CUSTOM"


class PeerEngine:
    """Geography-first peer group selection. Regional is ALWAYS the default."""

    def __init__(self, db_url: str | None = None):
        self._db_url = db_url

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _engine(self):
        return get_engine(self._db_url)

    def _load_all(self, period: str) -> pd.DataFrame:
        """Load all institutions for a period with basic computed ratios."""
        engine = self._engine()
        with engine.connect() as conn:
            result = conn.execute(
                select(
                    institutions_quarterly.c.charter_number,
                    institutions_quarterly.c.institution_name,
                    institutions_quarterly.c.state_code,
                    institutions_quarterly.c.county_name,
                    institutions_quarterly.c.acct_010,
                ).where(institutions_quarterly.c.period == period)
            )
            return pd.DataFrame(result.mappings().all())

    def _load_metric_values(self, period: str, metric: str) -> pd.DataFrame:
        """Load a single computed metric for all institutions in a period."""
        from processing.delinquency_engine import compute_ratios

        engine = self._engine()
        with engine.connect() as conn:
            result = conn.execute(
                select(institutions_quarterly).where(
                    institutions_quarterly.c.period == period
                )
            )
            df = pd.DataFrame(result.mappings().all())

        if df.empty:
            return df

        df = compute_ratios(df)
        cols = ["charter_number", "state_code", "county_name", "acct_010"]
        if metric in df.columns:
            cols.append(metric)
        return df[cols]

    def _institution_row(self, charter_number: str | int, period: str) -> pd.Series | None:
        df = self._load_all(period)
        row = df[df["charter_number"] == int(charter_number)]
        return row.iloc[0] if not row.empty else None

    def _counties_in_msa(self, county_fips: str) -> list[str]:
        """Return all county FIPS codes in the same MSA as the given county.

        Loads from the census_county_msa crosswalk table if it exists.
        Returns empty list if table not available — callers fall back to state.
        """
        engine = self._engine()
        try:
            with engine.connect() as conn:
                result = conn.execute(
                    text(
                        "SELECT c2.county_fips FROM census_county_msa c1 "
                        "JOIN census_county_msa c2 ON c1.msa_id = c2.msa_id "
                        "WHERE c1.county_fips = :fips"
                    ),
                    {"fips": county_fips},
                )
                return [r[0] for r in result.fetchall()]
        except Exception:
            return []

    def _county_fips_for_charter(self, charter_number: str | int) -> str | None:
        """Look up county FIPS for a charter from a branch/geocode table if available."""
        engine = self._engine()
        try:
            with engine.connect() as conn:
                result = conn.execute(
                    text(
                        "SELECT county_fips FROM ncua_branches "
                        "WHERE charter_number = :charter AND is_main_office = true "
                        "LIMIT 1"
                    ),
                    {"charter": int(charter_number)},
                )
                row = result.fetchone()
                return row[0] if row else None
        except Exception:
            return None

    # ------------------------------------------------------------------ #
    # Public methods
    # ------------------------------------------------------------------ #

    def get_default_peer_group(self, charter_number: str, period: str) -> dict:
        """Geography-first peer group selection with three-tier fallback.

        Priority:
          1. Same state + similar asset size (±50%) — minimum 10 institutions
          2. Same MSA (if CU is in major metro) — any size, minimum 5
          3. National same-asset-size — fallback only, clearly labeled

        Returns:
          peer_ids, peer_label, peer_count, geography_type, is_regional
        """
        inst = self._institution_row(charter_number, period)
        if inst is None:
            logger.warning("Charter %s not found for period %s", charter_number, period)
            return {"peer_ids": [], "peer_label": "No data", "peer_count": 0,
                    "geography_type": None, "is_regional": False}

        all_df = self._load_all(period)
        others = all_df[all_df["charter_number"] != int(charter_number)].copy()
        state = inst["state_code"]
        assets = inst["acct_010"]

        # ── Step 1: same state + similar asset size (±50%) ──────────────
        if pd.notna(assets) and assets > 0:
            lo, hi = assets * 0.5, assets * 1.5
            step1 = others[
                (others["state_code"] == state)
                & (others["acct_010"] >= lo)
                & (others["acct_010"] <= hi)
            ]
            if len(step1) >= 10:
                lo_fmt = _fmt_assets(lo)
                hi_fmt = _fmt_assets(hi)
                return {
                    "peer_ids": step1["charter_number"].tolist(),
                    "peer_label": f"{state} credit unions ({lo_fmt}–{hi_fmt} assets)",
                    "peer_count": len(step1),
                    "geography_type": "state_asset",
                    "is_regional": True,
                }
            logger.info(
                "Step 1 returned only %d peers for charter %s — trying MSA",
                len(step1), charter_number,
            )

        # ── Step 2: same MSA (major metro), any asset size ───────────────
        county_fips = self._county_fips_for_charter(charter_number)
        if county_fips:
            msa_counties = self._counties_in_msa(county_fips)
            if msa_counties:
                # Match institutions whose main office county is in the same MSA.
                # Requires county_fips on the institutions row; fall through if absent.
                if "county_fips" in others.columns:
                    step2 = others[others["county_fips"].isin(msa_counties)]
                    if len(step2) >= 5:
                        return {
                            "peer_ids": step2["charter_number"].tolist(),
                            "peer_label": f"Metro-area credit unions (MSA)",
                            "peer_count": len(step2),
                            "geography_type": "msa",
                            "is_regional": True,
                        }

        # ── Step 3: national same-asset-size — fallback, clearly labeled ─
        if pd.notna(assets) and assets > 0:
            lo, hi = assets * 0.5, assets * 1.5
            step3 = others[
                (others["acct_010"] >= lo)
                & (others["acct_010"] <= hi)
            ]
            lo_fmt = _fmt_assets(lo)
            hi_fmt = _fmt_assets(hi)
            logger.info(
                "Using national fallback for charter %s (%d peers)", charter_number, len(step3)
            )
            return {
                "peer_ids": step3["charter_number"].tolist(),
                "peer_label": f"National CUs ({lo_fmt}–{hi_fmt} assets) — national fallback",
                "peer_count": len(step3),
                "geography_type": "national_asset",
                "is_regional": False,
            }

        # Last resort: all state CUs
        state_peers = others[others["state_code"] == state]
        return {
            "peer_ids": state_peers["charter_number"].tolist(),
            "peer_label": f"All {state} credit unions",
            "peer_count": len(state_peers),
            "geography_type": "state",
            "is_regional": True,
        }

    def get_regional_peer_group(
        self,
        charter_number: str,
        geography_type: str,
        geography_id: str,
        period: str,
    ) -> dict:
        """All institutions with branch presence in the specified geography.

        No asset-size filter — shows ALL competitors in the market.
        Minimum 5 institutions; expands to state if fewer found.

        This is the competitive market view Callahan cannot provide.

        geography_type: "county" | "state" | "msa"
        geography_id:   county FIPS | state abbrev | MSA code
        """
        all_df = self._load_all(period)
        others = all_df[all_df["charter_number"] != int(charter_number)].copy()

        if geography_type == "state":
            group = others[others["state_code"] == geography_id]
            label = f"All credit unions in {geography_id}"

        elif geography_type == "county":
            # county_name matching (state + county for uniqueness where possible)
            # Use "STATE:county_name" format in geography_id if available
            if ":" in geography_id:
                state_part, county_part = geography_id.split(":", 1)
                group = others[
                    (others["state_code"] == state_part)
                    & (others["county_name"].str.lower() == county_part.lower())
                ]
                label = f"Credit unions in {county_part} ({state_part})"
            else:
                # Fallback: match county_name only (may span states)
                group = others[others["county_name"].str.lower() == geography_id.lower()]
                label = f"Credit unions in {geography_id} County"

            # Expand to state if fewer than 5
            if len(group) < 5:
                inst = self._institution_row(charter_number, period)
                if inst is not None:
                    state = inst["state_code"]
                    group = others[others["state_code"] == state]
                    label = f"Credit unions in {state} (county expanded)"
                    logger.info(
                        "County group too small for %s — expanded to state %s (%d peers)",
                        charter_number, state, len(group),
                    )

        elif geography_type == "msa":
            msa_counties = self._counties_in_msa(geography_id)
            if msa_counties and "county_fips" in others.columns:
                group = others[others["county_fips"].isin(msa_counties)]
                label = f"Credit unions in MSA {geography_id}"
            else:
                # Fallback to state if MSA crosswalk unavailable
                inst = self._institution_row(charter_number, period)
                state = inst["state_code"] if inst is not None else ""
                group = others[others["state_code"] == state]
                label = f"Credit unions in {state} (MSA fallback)"

        else:
            raise ValueError(f"Unknown geography_type: {geography_type!r}")

        return {
            "peer_ids": group["charter_number"].tolist(),
            "peer_label": label,
            "peer_count": len(group),
            "geography_type": geography_type,
            "geography_id": geography_id,
            "is_regional": True,
            "asset_filter": False,  # explicitly no asset-size filter
        }

    def get_callahan_style_peer_group(self, charter_number: str, asset_tier: str, period: str) -> dict:
        """National peer group by Callahan asset tier.

        Tiers: under_250M | 250M_1B | 1B_5B | over_5B
        ALWAYS labeled 'US CU [tier]' — never the default view.

        Returns:
          peer_ids, peer_label, peer_count, geography_type, is_regional
        """
        if asset_tier not in CALLAHAN_ASSET_TIERS:
            raise ValueError(
                f"Unknown asset_tier {asset_tier!r}. "
                f"Valid: {list(CALLAHAN_ASSET_TIERS)}"
            )

        lo, hi = CALLAHAN_ASSET_TIERS[asset_tier]
        all_df = self._load_all(period)
        others = all_df[all_df["charter_number"] != int(charter_number)]

        group = others[(others["acct_010"] >= lo) & (others["acct_010"] < hi)]

        tier_labels = {
            "under_250M": "under $250M",
            "250M_1B":    "$250M–$1B",
            "1B_5B":      "$1B–$5B",
            "over_5B":    "over $5B",
        }
        # Always prefixed with "US CU" to distinguish from regional peers
        label = f"US CU {tier_labels[asset_tier]}"

        return {
            "peer_ids": group["charter_number"].tolist(),
            "peer_label": label,
            "peer_count": len(group),
            "geography_type": "national_asset",
            "asset_tier": asset_tier,
            "is_regional": False,  # explicitly not regional
        }

    def separate_market_vs_institution_signal(
        self,
        charter_number: str,
        metric: str,
        period: str,
        geography_id: str,
        geography_type: str = "state",
    ) -> dict:
        """Determine whether elevated metric is institution-specific or market-wide.

        The answer to "Is this a me-problem?"

        Logic:
          1. institution_value — the institution's metric value
          2. regional_median   — median of all institutions in the same geography
          3. national_median   — median of national same-asset-size peers

        Signal types:
          regional_pressure     → institution > national AND regional > national
                                  Market condition; peers in same geography are also elevated.
          institution_specific  → institution > regional AND regional ≈ national
                                  Institution-specific problem; market is fine.
          outperforming_market  → institution ≈ or < regional AND regional > national
                                  Regional stress exists, but this institution is handling it well.
          no_signal             → No significant deviation detected.

        All comparisons use _REGIONAL_STRESS_THRESHOLD (10%) as the significance band.

        Returns:
          signal_type, institution_value, regional_median, national_median,
          interpretation_text, metric
        """
        all_metrics_df = self._load_metric_values(period, metric)
        if all_metrics_df.empty or metric not in all_metrics_df.columns:
            return {
                "signal_type": "no_data",
                "institution_value": None,
                "regional_median": None,
                "national_median": None,
                "interpretation_text": "Insufficient data for signal analysis.",
                "metric": metric,
            }

        target = all_metrics_df[all_metrics_df["charter_number"] == int(charter_number)]
        if target.empty:
            return {
                "signal_type": "no_data",
                "institution_value": None,
                "regional_median": None,
                "national_median": None,
                "interpretation_text": f"Charter {charter_number} not found for {period}.",
                "metric": metric,
            }

        inst_val = float(target.iloc[0][metric])
        institution_assets = target.iloc[0].get("acct_010")

        # Regional median: all institutions in the same geography
        regional_group = self.get_regional_peer_group(
            charter_number, geography_type, geography_id, period
        )
        regional_ids = set(regional_group["peer_ids"])
        regional_vals = all_metrics_df[
            all_metrics_df["charter_number"].isin(regional_ids)
        ][metric].dropna()
        regional_median = float(regional_vals.median()) if not regional_vals.empty else None

        # National median: same-asset-size peers nationally
        if pd.notna(institution_assets) and institution_assets > 0:
            lo, hi = institution_assets * 0.5, institution_assets * 1.5
            national_df = all_metrics_df[
                (all_metrics_df["acct_010"] >= lo)
                & (all_metrics_df["acct_010"] <= hi)
                & (all_metrics_df["charter_number"] != int(charter_number))
            ]
        else:
            national_df = all_metrics_df[
                all_metrics_df["charter_number"] != int(charter_number)
            ]
        national_median = float(national_df[metric].dropna().median()) if not national_df.empty else None

        # Count regional peers whose metric value exceeds the national median.
        # For ADVERSE metrics this is the "elevated" direction (higher = worse).
        # For POSITIVE metrics, "below" national is the stressed direction.
        from processing.delinquency_engine import ADVERSE_METRICS
        peers_above_national_median: Optional[int] = None
        if national_median is not None and not regional_vals.empty:
            if metric in ADVERSE_METRICS:
                peers_above_national_median = int((regional_vals > national_median).sum())
            else:
                peers_above_national_median = int((regional_vals < national_median).sum())

        if regional_median is None or national_median is None or national_median == 0:
            return {
                "signal_type": "no_data",
                "institution_value": inst_val,
                "regional_median": regional_median,
                "national_median": national_median,
                "interpretation_text": "Insufficient peer data for signal separation.",
                "metric": metric,
                "regional_group_label": regional_group.get("peer_label"),
                "regional_peer_count": regional_group.get("peer_count"),
                "peers_above_national_median": peers_above_national_median,
            }

        # Classify signal
        regional_above_national = regional_median > national_median * (1 + _REGIONAL_STRESS_THRESHOLD)
        institution_above_regional = inst_val > regional_median * (1 + _INSTITUTION_STRESS_THRESHOLD)
        institution_above_national = inst_val > national_median * (1 + _INSTITUTION_STRESS_THRESHOLD)

        if regional_above_national and not institution_above_regional:
            signal_type = "outperforming_market"
            interpretation_text = (
                f"Regional peers show elevated {metric} vs national peers "
                f"({regional_median:.4f} vs {national_median:.4f}), "
                f"but this institution ({inst_val:.4f}) is performing at or below the regional median. "
                "Regional stress exists — this institution is handling it well."
            )
        elif regional_above_national and institution_above_national:
            signal_type = "regional_pressure"
            interpretation_text = (
                f"Both this institution ({inst_val:.4f}) and the regional peer group "
                f"({regional_median:.4f}) are elevated relative to national peers "
                f"({national_median:.4f}). "
                "This is a market condition, not institution-specific. "
                "Examine local economic factors."
            )
        elif institution_above_regional and not regional_above_national:
            signal_type = "institution_specific"
            interpretation_text = (
                f"This institution's {metric} ({inst_val:.4f}) is elevated above the "
                f"regional median ({regional_median:.4f}), while regional peers are "
                f"in line with national peers ({national_median:.4f}). "
                "This is an institution-specific issue requiring management attention."
            )
        else:
            signal_type = "no_signal"
            interpretation_text = (
                f"No significant deviation detected. "
                f"Institution: {inst_val:.4f}, regional median: {regional_median:.4f}, "
                f"national median: {national_median:.4f}."
            )

        return {
            "signal_type": signal_type,
            "institution_value": inst_val,
            "regional_median": regional_median,
            "national_median": national_median,
            "interpretation_text": interpretation_text,
            "metric": metric,
            "regional_group_label": regional_group["peer_label"],
            "regional_peer_count": regional_group["peer_count"],
            "peers_above_national_median": peers_above_national_median,
        }


# ────────────────────────────────────────────────────────────────────────────
# Backward-compatible module-level functions
# All callers (API routers, processing modules) continue to work unchanged.
# ────────────────────────────────────────────────────────────────────────────

def _load_period_data(period: str, db_url: str | None) -> pd.DataFrame:
    engine = get_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(
            select(
                institutions_quarterly.c.charter_number,
                institutions_quarterly.c.state_code,
                institutions_quarterly.c.county_name,
                institutions_quarterly.c.acct_010,
            ).where(institutions_quarterly.c.period == period)
        )
        return pd.DataFrame(result.mappings().all())


def get_regional_peers(
    charter_number: int,
    period: str,
    tenant_id: str,
    min_peers: int = 10,
    db_url: str | None = None,
) -> list[int]:
    engine_obj = PeerEngine(db_url)
    result = engine_obj.get_default_peer_group(str(charter_number), period)
    peers = result["peer_ids"]
    if len(peers) < min_peers:
        logger.info(
            "Only %d default peers for %d — min_peers=%d", len(peers), charter_number, min_peers
        )
    return peers


def get_asset_size_peers(charter_number: int, period: str, db_url: str | None = None) -> list[int]:
    df = _load_period_data(period, db_url)
    target = df[df["charter_number"] == charter_number]
    if target.empty:
        return []
    assets = target.iloc[0]["acct_010"]
    if pd.isna(assets):
        return []
    # Determine Callahan tier
    tier = _callahan_tier_for_assets(float(assets))
    engine_obj = PeerEngine(db_url)
    result = engine_obj.get_callahan_style_peer_group(str(charter_number), tier, period)
    return result["peer_ids"]


def get_state_peers(charter_number: int, period: str, db_url: str | None = None) -> list[int]:
    df = _load_period_data(period, db_url)
    target = df[df["charter_number"] == charter_number]
    if target.empty:
        return []
    state = target.iloc[0]["state_code"]
    peers = df[(df["state_code"] == state) & (df["charter_number"] != charter_number)]
    return peers["charter_number"].tolist()


def get_custom_peers(tenant_id: str, group_name: str, db_url: str | None = None) -> list[int]:
    engine = get_engine(db_url)
    with engine.connect() as conn:
        result = conn.execute(
            text(
                "SELECT charter_number FROM custom_peer_groups "
                "WHERE tenant_id = :tenant_id AND group_name = :group_name"
            ),
            {"tenant_id": tenant_id, "group_name": group_name},
        )
        return [r[0] for r in result.fetchall()]


def build_peer_group(
    charter_number: int,
    period: str,
    group_type: PeerGroupType,
    tenant_id: str,
    custom_group_name: Optional[str] = None,
    db_url: str | None = None,
) -> list[int]:
    if group_type == PeerGroupType.REGIONAL:
        return get_regional_peers(charter_number, period, tenant_id, db_url=db_url)
    if group_type == PeerGroupType.STATE:
        return get_state_peers(charter_number, period, db_url=db_url)
    if group_type == PeerGroupType.ASSET_SIZE:
        return get_asset_size_peers(charter_number, period, db_url=db_url)
    if group_type == PeerGroupType.CUSTOM:
        if not custom_group_name:
            raise ValueError("custom_group_name required for CUSTOM peer group")
        return get_custom_peers(tenant_id, custom_group_name, db_url=db_url)
    raise ValueError(f"Unknown peer group type: {group_type}")


def peer_group_label(
    group_type: PeerGroupType,
    charter_number: int,
    period: str,
    db_url: str | None = None,
) -> str:
    df = _load_period_data(period, db_url)
    target = df[df["charter_number"] == charter_number]
    state = target.iloc[0]["state_code"] if not target.empty else "?"
    labels = {
        PeerGroupType.REGIONAL: f"Regional peers ({state})",
        PeerGroupType.STATE: f"All {state} credit unions",
        PeerGroupType.ASSET_SIZE: "National asset-size peers",
        PeerGroupType.CUSTOM: "Custom peer group",
    }
    return labels.get(group_type, "Peer group")


# ────────────────────────────────────────────────────────────────────────────
# Utility functions
# ────────────────────────────────────────────────────────────────────────────

def _fmt_assets(v: float) -> str:
    if v >= 1_000_000_000:
        return f"${v / 1_000_000_000:.1f}B"
    if v >= 1_000_000:
        return f"${v / 1_000_000:.0f}M"
    return f"${v:,.0f}"


def _callahan_tier_for_assets(assets: float) -> str:
    for tier, (lo, hi) in CALLAHAN_ASSET_TIERS.items():
        if lo <= assets < hi:
            return tier
    return "over_5B"


def _asset_band(assets: float) -> tuple[float, float]:
    for lo, hi in ASSET_BANDS:
        if lo <= assets < hi:
            return lo, hi
    return ASSET_BANDS[-1]
