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


@router.get("/county/search")
async def search_county(q: str = Query(..., min_length=2, max_length=100)):
    """Return up to 15 counties whose name contains the query string.

    Searches fdic_deposits for county_name ILIKE match.
    Returns county_fips, county_name, state_code sorted by name.
    """
    engine = get_engine(DB_URL)
    try:
        with engine.connect() as conn:
            rows = conn.execute(
                text(
                    "SELECT DISTINCT county_fips, county_name, state_code "
                    "FROM fdic_deposits "
                    "WHERE LOWER(county_name) LIKE LOWER(:q) "
                    "  AND county_fips IS NOT NULL AND county_fips <> '' "
                    "ORDER BY county_name, state_code "
                    "LIMIT 15"
                ),
                {"q": f"%{q}%"},
            ).mappings().all()
        return [
            {"county_fips": r["county_fips"], "county_name": r["county_name"], "state_code": r["state_code"]}
            for r in rows
        ]
    except Exception:
        return []


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
