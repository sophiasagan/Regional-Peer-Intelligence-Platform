"""Router: /geography — geographic lookup helpers.

Provides search/autocomplete for CBSA (MSA) codes so the frontend doesn't
require users to know numeric codes.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Query
from sqlalchemy import text

from db import get_engine

router = APIRouter()
DB_URL = os.environ.get("DATABASE_URL")


@router.get("/msa/search")
async def search_msa(q: str = Query(..., min_length=2, max_length=100)):
    """Return up to 10 CBSAs whose title contains the query string.

    Case-insensitive substring match. Search by city name (e.g. 'Detroit'),
    metro area name, or partial CBSA title.
    """
    engine = get_engine(DB_URL)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    "SELECT DISTINCT ON (cbsa_code) cbsa_code, cbsa_title, is_metro "
                    "FROM geo_cbsa_counties "
                    "WHERE LOWER(cbsa_title) LIKE LOWER(:q) "
                    "ORDER BY cbsa_code, cbsa_title "
                    "LIMIT 10"
                ),
                {"q": f"%{q}%"},
            ).mappings().all()
        return [
            {"cbsa_code": r["cbsa_code"], "cbsa_title": r["cbsa_title"], "is_metro": r["is_metro"]}
            for r in rows
        ]
    except Exception:
        return []
