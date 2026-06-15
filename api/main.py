"""FastAPI application entry point — cu_market_intelligence API."""

from __future__ import annotations

import json
import logging
import math
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response
from jose import JWTError, jwt


class NaNSafeJSONResponse(JSONResponse):
    """JSONResponse that converts nan/inf → null so json.dumps never raises."""

    @staticmethod
    def _sanitize(obj):
        if isinstance(obj, float) and not math.isfinite(obj):
            return None
        if isinstance(obj, dict):
            return {k: NaNSafeJSONResponse._sanitize(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [NaNSafeJSONResponse._sanitize(v) for v in obj]
        return obj

    def render(self, content) -> bytes:
        return json.dumps(
            self._sanitize(content),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")

from api.routers import alerts, market_share, onboarding, peer_comparison, query, reports

logger = logging.getLogger(__name__)

JWT_SECRET    = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM = "HS256"

SKIP_AUTH = ("/onboarding", "/health", "/docs", "/openapi.json", "/redoc")

# Permissive CORS — Bearer token auth, no cookies, so wildcard is safe
_CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
    "Access-Control-Max-Age":       "86400",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting cu_market_intelligence API")
    try:
        from db import create_all_tables
        create_all_tables()
        logger.info("Database tables verified/created")
    except Exception as exc:
        logger.warning("create_all_tables failed (check DATABASE_URL): %s", exc)
    yield


app = FastAPI(
    title="CU Market Intelligence API",
    version="2.0.0",
    description="Regional peer intelligence — NCUA + FDIC + HMDA + Census ACS",
    lifespan=lifespan,
    default_response_class=NaNSafeJSONResponse,
)


def _extract_tenant(token: str) -> str:
    try:
        payload    = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        tenant_id  = payload.get("tenant_id")
        if not tenant_id:
            raise HTTPException(status_code=401, detail="Missing tenant_id in token")
        return str(tenant_id)
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}")


@app.middleware("http")
async def tenant_middleware(request: Request, call_next):
    # OPTIONS preflight — return immediately with CORS headers, no auth needed
    if request.method == "OPTIONS":
        return Response(status_code=204, headers=_CORS)

    path = request.url.path

    # Auth-exempt paths — pass through, attach CORS to response
    if any(path == s or path.startswith(s) for s in SKIP_AUTH):
        resp = await call_next(request)
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp

    # JWT auth required
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"detail": "Bearer token required"},
            headers={"Access-Control-Allow-Origin": "*"},
        )

    token = auth.removeprefix("Bearer ").strip()
    try:
        request.state.tenant_id = _extract_tenant(token)
    except HTTPException as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers={"Access-Control-Allow-Origin": "*"},
        )

    resp = await call_next(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "2.0.0"}


app.include_router(market_share.router,    prefix="/market-share",   tags=["market-share"])
app.include_router(peer_comparison.router, prefix="/peer-comparison", tags=["peer-comparison"])
app.include_router(query.router,           prefix="/ask",             tags=["nl-query"])
app.include_router(alerts.router,          prefix="/alerts",          tags=["alerts"])
app.include_router(reports.router,         prefix="/reports",         tags=["reports"])
app.include_router(onboarding.router,      prefix="/onboarding",      tags=["onboarding"])
