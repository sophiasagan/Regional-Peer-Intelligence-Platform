"""Address → county FIPS geocoder using the Census Bureau Geocoding API.

Used to backfill county_fips on FDIC branch rows and NCUA branch addresses
where the source data doesn't supply a FIPS code.

Census Geocoding API docs: https://geocoding.geo.census.gov/geocoder/
Rate limit: ~1 req/sec without a key; this module enforces a 250ms delay.
"""

from __future__ import annotations

import logging
import time
from typing import Optional

import requests

logger = logging.getLogger(__name__)

CENSUS_GEOCODE_URL = "https://geocoding.geo.census.gov/geocoder/geographies/address"
TIGERWEB_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/86/query"

_REQUEST_DELAY_SEC = 0.25
_TIMEOUT = 15


def geocode_address(
    street: str,
    city: str,
    state: str,
    zip_code: str,
) -> Optional[dict]:
    """Geocode a single address. Returns dict with county_fips, lat, lon or None."""
    params = {
        "street": street,
        "city": city,
        "state": state,
        "zip": zip_code,
        "benchmark": "Public_AR_Current",
        "vintage": "Current_Current",
        "layers": "Counties",
        "format": "json",
    }
    try:
        resp = requests.get(CENSUS_GEOCODE_URL, params=params, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        matches = data.get("result", {}).get("addressMatches", [])
        if not matches:
            return None
        match = matches[0]
        coords = match.get("coordinates", {})
        geographies = match.get("geographies", {})
        counties = geographies.get("Counties", [])
        county_fips = counties[0].get("GEOID") if counties else None
        return {
            "county_fips": county_fips,
            "lat": coords.get("y"),
            "lon": coords.get("x"),
            "matched_address": match.get("matchedAddress"),
        }
    except Exception as exc:
        logger.debug("Geocode failed for %s %s %s: %s", street, city, state, exc)
        return None
    finally:
        time.sleep(_REQUEST_DELAY_SEC)


def fips_from_lat_lon(lat: float, lon: float) -> Optional[str]:
    """Reverse geocode lat/lon to 5-digit county FIPS via TIGERweb."""
    params = {
        "geometry": f"{lon},{lat}",
        "geometryType": "esriGeometryPoint",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "GEOID",
        "returnGeometry": "false",
        "f": "json",
    }
    try:
        resp = requests.get(TIGERWEB_URL, params=params, timeout=_TIMEOUT)
        resp.raise_for_status()
        features = resp.json().get("features", [])
        if features:
            return features[0]["attributes"]["GEOID"]
        return None
    except Exception as exc:
        logger.debug("Reverse geocode failed for (%s, %s): %s", lat, lon, exc)
        return None
    finally:
        time.sleep(_REQUEST_DELAY_SEC)


def batch_geocode(
    df: "pd.DataFrame",
    address_cols: dict[str, str],
    county_fips_col: str = "county_fips",
) -> "pd.DataFrame":
    """Geocode all rows where county_fips is missing.

    address_cols: {"street": col, "city": col, "state": col, "zip": col}
    """
    import pandas as pd

    df = df.copy()
    missing_mask = df[county_fips_col].isna() | (df[county_fips_col] == "")

    # First try reverse geocoding rows that have lat/lon
    if "latitude" in df.columns and "longitude" in df.columns:
        has_coords = missing_mask & df["latitude"].notna() & df["longitude"].notna()
        for idx in df[has_coords].index:
            fips = fips_from_lat_lon(df.at[idx, "latitude"], df.at[idx, "longitude"])
            if fips:
                df.at[idx, county_fips_col] = fips

    # Remaining rows without lat/lon: forward geocode from address
    missing_mask = df[county_fips_col].isna() | (df[county_fips_col] == "")
    for idx in df[missing_mask].index:
        row = df.loc[idx]
        result = geocode_address(
            street=str(row.get(address_cols.get("street", ""), "")),
            city=str(row.get(address_cols.get("city", ""), "")),
            state=str(row.get(address_cols.get("state", ""), "")),
            zip_code=str(row.get(address_cols.get("zip", ""), "")),
        )
        if result:
            df.at[idx, county_fips_col] = result["county_fips"]
            if "latitude" in df.columns and pd.isna(df.at[idx, "latitude"]):
                df.at[idx, "latitude"] = result.get("lat")
            if "longitude" in df.columns and pd.isna(df.at[idx, "longitude"]):
                df.at[idx, "longitude"] = result.get("lon")

    return df
