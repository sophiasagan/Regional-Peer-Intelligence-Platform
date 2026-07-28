"""Router: /admin — internal-only provisioning endpoints. Not for tenant use.

Gated by X-Admin-Key header (static secret from ADMIN_API_KEY env var).
Returns 503 if ADMIN_API_KEY is not configured, 401 if the key is wrong.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

router = APIRouter()

_ADMIN_API_KEY: Optional[str] = os.environ.get("ADMIN_API_KEY")
_DB_URL: Optional[str] = os.environ.get("DATABASE_URL")


def _check_admin_key(x_admin_key: Optional[str]) -> None:
    if not _ADMIN_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="Admin API not configured (ADMIN_API_KEY env var is not set).",
        )
    if x_admin_key != _ADMIN_API_KEY:
        raise HTTPException(
            status_code=401,
            detail="Invalid or missing X-Admin-Key header.",
        )


class EntitlementRequest(BaseModel):
    tenant_id:      str
    charter_number: int


@router.post("/entitlements/grant")
async def grant_entitlement_endpoint(
    body: EntitlementRequest,
    x_admin_key: Optional[str] = Header(default=None),
):
    """Grant a tenant access to a specific charter number (idempotent)."""
    _check_admin_key(x_admin_key)
    from api.entitlements import grant_entitlement
    grant_entitlement(body.tenant_id, body.charter_number, _DB_URL)
    return {
        "granted":        True,
        "tenant_id":      body.tenant_id,
        "charter_number": body.charter_number,
    }


@router.post("/entitlements/revoke")
async def revoke_entitlement_endpoint(
    body: EntitlementRequest,
    x_admin_key: Optional[str] = Header(default=None),
):
    """Revoke a tenant's access to a specific charter number."""
    _check_admin_key(x_admin_key)
    from api.entitlements import revoke_entitlement
    revoke_entitlement(body.tenant_id, body.charter_number, _DB_URL)
    return {
        "revoked":        True,
        "tenant_id":      body.tenant_id,
        "charter_number": body.charter_number,
    }
