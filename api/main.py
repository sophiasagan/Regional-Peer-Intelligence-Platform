"""FastAPI application entry point — cu_market_intelligence API.

JWT middleware extracts tenant_id from bearer token on every request.
All routers enforce tenant isolation — never cross-contaminate tenant data.
Tenants only see institutions in their subscribed geographies.

Run:
    uvicorn api.main:app --reload
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from jose import JWTError, jwt

from api.routers import alerts, market_share, onboarding, peer_comparison, query, reports

logger = logging.getLogger(__name__)

JWT_SECRET = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM = "HS256"


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting cu_market_intelligence API")
    yield
    logger.info("Shutting down")


app = FastAPI(
    title="CU Market Intelligence API",
    version="2.0.0",
    description="Regional peer intelligence — NCUA + FDIC + HMDA + Census ACS",
    lifespan=lifespan,
)

_raw_origins = os.environ.get("ALLOWED_ORIGINS", "")
_allow_origins = _raw_origins.split(",") if _raw_origins else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=bool(_raw_origins),   # credentials only when origins are explicit
    allow_methods=["*"],
    allow_headers=["*"],
)


def _extract_tenant(token: str) -> str:
    """Decode JWT bearer token and return tenant_id claim."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        tenant_id = payload.get("tenant_id")
        if not tenant_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing tenant_id in token")
        return str(tenant_id)
    except JWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {exc}")


@app.middleware("http")
async def tenant_middleware(request: Request, call_next):
    """Attach tenant_id to request.state; handle CORS on every response."""
    origin = request.headers.get("Origin", "")
    cors = {"Access-Control-Allow-Origin": origin} if origin else {}

    if request.method == "OPTIONS":
        return Response(
            status_code=200,
            headers={
                **cors,
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
                "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
                "Access-Control-Max-Age": "600",
            },
        )

    if request.url.path in ("/health", "/docs", "/openapi.json", "/redoc"):
        response = await call_next(request)
        for k, v in cors.items():
            response.headers[k] = v
        return response

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"detail": "Bearer token required"},
            headers=cors,
        )
    token = auth.removeprefix("Bearer ").strip()
    try:
        request.state.tenant_id = _extract_tenant(token)
    except HTTPException as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers=cors,
        )

    response = await call_next(request)
    for k, v in cors.items():
        response.headers[k] = v
    return response


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "2.0.0"}


app.include_router(market_share.router,   prefix="/market-share",   tags=["market-share"])
app.include_router(peer_comparison.router, prefix="/peer-comparison", tags=["peer-comparison"])
app.include_router(query.router,          prefix="/ask",             tags=["nl-query"])
app.include_router(alerts.router,         prefix="/alerts",          tags=["alerts"])
app.include_router(reports.router,        prefix="/reports",         tags=["reports"])
app.include_router(onboarding.router,     prefix="/onboarding",      tags=["onboarding"])
