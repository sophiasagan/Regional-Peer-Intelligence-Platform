"""APScheduler: runs each data source on its publish schedule.

Schedules:
  NCUA 5300   — quarterly; checks monthly on the 1st for new data (~60 days after quarter end)
  FDIC SOD    — annual, typically published in October (June 30 snapshot)
  HMDA LAR    — annual, released ~March of the following year
  Census ACS  — annual 5-year estimates, released ~December

Usage:
    python -m ingestion.scheduler
"""

from __future__ import annotations

import logging
import os
from datetime import datetime

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

logger = logging.getLogger(__name__)

DB_URL = os.environ.get("DATABASE_URL")


def _current_quarter() -> tuple[int, int]:
    """Return (year, quarter) for the most recently completed NCUA reporting period."""
    now = datetime.utcnow()
    # NCUA publishes ~60 days after quarter end; lag by one quarter to be safe
    month = now.month
    quarter = (month - 1) // 3 + 1
    # Back up one quarter
    if quarter == 1:
        return now.year - 1, 4
    return now.year, quarter - 1


def _current_fdic_year() -> int:
    """FDIC SOD data is for June 30 of each year; released in October."""
    now = datetime.utcnow()
    # If we're past October, the current year's data is available; otherwise use prior year
    return now.year if now.month >= 10 else now.year - 1


def run_ncua_latest() -> None:
    from ingestion.ncua_ingester import ingest_ncua_quarter
    year, quarter = _current_quarter()
    logger.info("Scheduler: NCUA %dQ%d", year, quarter)
    try:
        ingest_ncua_quarter(year, quarter, DB_URL)
    except Exception:
        logger.exception("NCUA ingest failed for %dQ%d", year, quarter)


def run_fdic_latest() -> None:
    from ingestion.fdic_ingester import ingest as ingest_fdic
    year = _current_fdic_year()
    logger.info("Scheduler: FDIC SOD %d", year)
    try:
        ingest_fdic(year, DB_URL)
    except Exception:
        logger.exception("FDIC ingest failed for %d", year)


def run_hmda_latest() -> None:
    from ingestion.hmda_ingester import ingest as ingest_hmda
    # HMDA data lags by one year (2023 data released March 2024)
    year = datetime.utcnow().year - 1
    logger.info("Scheduler: HMDA %d", year)
    try:
        ingest_hmda(year, DB_URL)
    except Exception:
        logger.exception("HMDA ingest failed for %d", year)


def run_census_latest() -> None:
    from ingestion.census_ingester import ingest as ingest_census
    # ACS 5-year estimates also lag by one year
    year = datetime.utcnow().year - 1
    logger.info("Scheduler: Census ACS %d", year)
    try:
        ingest_census(year, DB_URL)
    except Exception:
        logger.exception("Census ingest failed for %d", year)


def build_scheduler() -> BlockingScheduler:
    scheduler = BlockingScheduler(timezone="UTC")

    # NCUA: check on the 1st of each month at 06:00 UTC
    scheduler.add_job(run_ncua_latest, CronTrigger(day=1, hour=6), id="ncua", replace_existing=True)

    # FDIC SOD: annually in October (15th at 06:00 UTC)
    scheduler.add_job(run_fdic_latest, CronTrigger(month=10, day=15, hour=6), id="fdic", replace_existing=True)

    # HMDA: annually in March
    scheduler.add_job(run_hmda_latest, CronTrigger(month=3, day=15, hour=6), id="hmda", replace_existing=True)

    # Census ACS: annually in December
    scheduler.add_job(run_census_latest, CronTrigger(month=12, day=10, hour=6), id="census", replace_existing=True)

    return scheduler


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    scheduler = build_scheduler()
    logger.info("Scheduler started — jobs: %s", [j.id for j in scheduler.get_jobs()])
    scheduler.start()
