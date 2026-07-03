"""Resolve HMDA LEI codes → institution names via the free GLEIF API.

Queries all unique respondent_ids from hmda_originations, fetches entity
names from https://api.gleif.org in batches, and upserts into
hmda_respondents so the market share engine can display readable names.

Usage:
    python -m ingestion.lei_enricher            # resolve all LEIs in DB
    python -m ingestion.lei_enricher --force    # re-fetch even if already resolved
"""

from __future__ import annotations

import argparse
import logging
import time

import requests
from sqlalchemy import select, text

from db import get_engine, hmda_originations, hmda_respondents, metadata

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

_GLEIF_URL  = "https://api.gleif.org/api/v1/lei-records"
_BATCH_SIZE = 100   # GLEIF allows up to ~200, stay conservative
_SLEEP_S    = 0.5   # polite delay between batches


_CU_KEYWORDS = frozenset([
    "CREDIT UNION", "FCU", "FEDERAL CREDIT UNION", "C.U.",
])


def _is_credit_union(name: str) -> bool:
    upper = name.upper()
    return any(kw in upper for kw in _CU_KEYWORDS)


def _gleif_batch(leis: list[str]) -> dict[str, dict]:
    """Return {lei: {name, city, state}} for a batch of LEI codes."""
    params = {
        "filter[lei]": ",".join(leis),
        "page[size]": len(leis),
    }
    try:
        r = requests.get(_GLEIF_URL, params=params, timeout=30)
        r.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("GLEIF request failed: %s", exc)
        return {}

    out: dict[str, dict] = {}
    for record in r.json().get("data", []):
        lei  = record.get("id", "")
        attr = record.get("attributes", {})
        entity = attr.get("entity", {})
        name   = entity.get("legalName", {}).get("name", "")
        hq     = entity.get("headquartersAddress", {})
        city   = hq.get("city", "")
        state  = (hq.get("region", "") or "").split("-")[-1][:2]   # "US-MI" → "MI"
        out[lei] = {"name": name, "city": city, "state": state}
    return out


def enrich(force: bool = False, db_url: str | None = None) -> None:
    engine = get_engine(db_url)

    # Ensure table exists
    metadata.create_all(engine, tables=[hmda_respondents], checkfirst=True)

    with engine.connect() as conn:
        # All LEIs in hmda_originations
        all_leis_rows = conn.execute(
            select(hmda_originations.c.respondent_id).distinct()
        ).fetchall()
        all_leis = [r[0] for r in all_leis_rows if r[0]]

        if not force:
            # LEIs already resolved
            existing_rows = conn.execute(
                select(hmda_respondents.c.respondent_id)
            ).fetchall()
            existing = {r[0] for r in existing_rows}
            leis_to_fetch = [lei for lei in all_leis if lei not in existing]
        else:
            leis_to_fetch = all_leis

    logger.info(
        "Total LEIs in hmda_originations: %d  |  To fetch: %d",
        len(all_leis), len(leis_to_fetch),
    )

    if not leis_to_fetch:
        logger.info("All LEIs already resolved — run with --force to re-fetch")
        return

    resolved = 0
    for i in range(0, len(leis_to_fetch), _BATCH_SIZE):
        batch = leis_to_fetch[i : i + _BATCH_SIZE]
        results = _gleif_batch(batch)

        rows = []
        for lei in batch:
            info = results.get(lei, {})
            name = info.get("name", "")
            rows.append({
                "respondent_id":   lei,
                "respondent_name": name or lei,   # fall back to LEI if GLEIF has no record
                "institution_type": "cu" if _is_credit_union(name) else "bank",
                "respondent_city":  info.get("city", ""),
                "respondent_state": info.get("state", ""),
            })

        if rows:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "INSERT INTO hmda_respondents "
                        "(respondent_id, respondent_name, institution_type, "
                        " respondent_city, respondent_state) "
                        "VALUES (:respondent_id, :respondent_name, :institution_type, "
                        "        :respondent_city, :respondent_state) "
                        "ON CONFLICT (respondent_id) DO UPDATE SET "
                        "  respondent_name  = EXCLUDED.respondent_name, "
                        "  institution_type = EXCLUDED.institution_type, "
                        "  respondent_city  = EXCLUDED.respondent_city, "
                        "  respondent_state = EXCLUDED.respondent_state, "
                        "  fetched_at       = NOW()"
                    ),
                    rows,
                )
            resolved += len(rows)

        logger.info(
            "Batch %d/%d done — %d/%d resolved so far",
            i // _BATCH_SIZE + 1,
            (len(leis_to_fetch) + _BATCH_SIZE - 1) // _BATCH_SIZE,
            resolved, len(leis_to_fetch),
        )
        time.sleep(_SLEEP_S)

    logger.info("Done — resolved %d LEI codes", resolved)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Resolve HMDA LEI codes via GLEIF API")
    parser.add_argument("--force", action="store_true",
                        help="Re-fetch even already-resolved LEIs")
    parser.add_argument("--db-url", default=None)
    args = parser.parse_args()
    enrich(force=args.force, db_url=args.db_url)
