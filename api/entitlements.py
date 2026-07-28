"""Tenant entitlement checks — controls which institutions a tenant can access.

ALLOW_ANONYMOUS_ACCESS defaults to True so the public Vercel demo works without
real JWT issuance. Set ALLOW_ANONYMOUS_ACCESS=false in production once real
per-tenant login and JWT issuance are in place.
"""

from __future__ import annotations

import os
from typing import Optional

from fastapi import HTTPException

# Default True keeps the demo working as-is. Flip to "false" once the auth
# service issues real per-tenant JWTs and tenants have been provisioned.
ALLOW_ANONYMOUS_ACCESS: bool = (
    os.environ.get("ALLOW_ANONYMOUS_ACCESS", "true").lower() == "true"
)

_DB_URL: Optional[str] = os.environ.get("DATABASE_URL")


def grant_entitlement(
    tenant_id: str,
    charter_number: int,
    db_url: Optional[str] = None,
) -> None:
    """Insert (tenant_id, charter_number) — idempotent via ON CONFLICT DO NOTHING."""
    from db import get_engine, tenant_entitlements
    from sqlalchemy.dialects.postgresql import insert

    engine = get_engine(db_url or _DB_URL)
    stmt = (
        insert(tenant_entitlements)
        .values(tenant_id=tenant_id, charter_number=charter_number)
        .on_conflict_do_nothing(index_elements=["tenant_id", "charter_number"])
    )
    with engine.begin() as conn:
        conn.execute(stmt)


def revoke_entitlement(
    tenant_id: str,
    charter_number: int,
    db_url: Optional[str] = None,
) -> None:
    """Remove the (tenant_id, charter_number) row if it exists."""
    from db import get_engine, tenant_entitlements
    from sqlalchemy import delete

    engine = get_engine(db_url or _DB_URL)
    stmt = delete(tenant_entitlements).where(
        tenant_entitlements.c.tenant_id == tenant_id,
        tenant_entitlements.c.charter_number == charter_number,
    )
    with engine.begin() as conn:
        conn.execute(stmt)


def is_entitled(
    tenant_id: str,
    charter_number: int,
    db_url: Optional[str] = None,
) -> bool:
    """Return True if the tenant may access this institution's data.

    anonymous tenants: governed by ALLOW_ANONYMOUS_ACCESS env flag.
    Real tenants: must have a row in tenant_entitlements.
    """
    if tenant_id == "anonymous":
        return ALLOW_ANONYMOUS_ACCESS

    from db import get_engine, tenant_entitlements
    from sqlalchemy import select

    engine = get_engine(db_url or _DB_URL)
    with engine.connect() as conn:
        row = conn.execute(
            select(tenant_entitlements.c.charter_number).where(
                tenant_entitlements.c.tenant_id == tenant_id,
                tenant_entitlements.c.charter_number == charter_number,
            )
        ).first()
    return row is not None


def require_entitlement(
    tenant_id: str,
    charter_number: int,
    db_url: Optional[str] = None,
) -> None:
    """Raise HTTP 403 if the tenant is not entitled to this institution."""
    if not is_entitled(tenant_id, charter_number, db_url):
        raise HTTPException(
            status_code=403,
            detail=(
                f"Not entitled to institution {charter_number}. "
                "Contact your Magnus account team to add it to your subscription."
            ),
        )
