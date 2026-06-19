"""
Diagnose product delinquency data pipeline.
Run from project root: python scripts/diagnose_product_delinq.py

Checks:
  1. Which new columns actually exist in PostgreSQL
  2. Dort Financial's raw field values (last 4 quarters)
  3. Computed ratio values for Dort
  4. Peer distribution rows for the 5 product metrics
  5. What's actually inside the downloaded NCUA ZIP files
"""
import os, sys, zipfile, glob
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

import pandas as pd
from sqlalchemy import create_engine, text

db_url = os.environ.get("DATABASE_URL")
if not db_url:
    print("ERROR: DATABASE_URL not set — create a .env file with DATABASE_URL=postgresql://...")
    sys.exit(1)

engine = create_engine(db_url)
DORT_CHARTER = 68708

# ── 1. Column existence ──────────────────────────────────────────────────────
NEW_COLS = [
    "acct_703a", "acct_703A",   # check both cases
    "acct_396", "acct_385", "acct_370",
    "acct_718a5", "acct_718A5",
    "acct_400p", "acct_400P",
    "acct_045b", "acct_045B",
    "acct_752", "acct_753", "acct_754",
    "acct_041c1", "acct_041C1",
    "acct_041c2", "acct_041C2",
    "acct_041g1", "acct_041G1",
    "acct_041g2", "acct_041G2",
    "acct_041g3", "acct_041G3",
    "acct_041p1", "acct_041P1",
    "acct_1001f", "acct_1001F",
]

print("=" * 60)
print("1. COLUMN EXISTENCE IN institutions_quarterly")
print("=" * 60)
with engine.connect() as conn:
    result = conn.execute(text("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'institutions_quarterly'
        ORDER BY column_name
    """))
    existing = {r[0] for r in result}

found = sorted(c for c in NEW_COLS if c in existing)
missing = sorted(c for c in NEW_COLS if c.lower() not in {e.lower() for e in existing})

print(f"Found ({len(found)}): {found}")
print(f"Missing: {[c for c in ['acct_703A','acct_396','acct_385','acct_370','acct_718A5','acct_400P','acct_045B','acct_752','acct_753','acct_754','acct_041C1','acct_041C2','acct_041G1','acct_041G2','acct_041G3','acct_041P1','acct_1001F'] if c not in existing and c.lower() not in {e.lower() for e in existing}]}")

if not found:
    print("\n⚠️  MIGRATION HAS NOT BEEN RUN — run migrations/add_product_delinq_columns.sql first")
    sys.exit(1)

# ── 2. Dort Financial raw values ─────────────────────────────────────────────
print("\n" + "=" * 60)
print("2. DORT FINANCIAL RAW VALUES (last 4 quarters)")
print("=" * 60)

# Figure out the actual column names (case may vary)
col_map = {c.lower(): c for c in existing}
def col(name): return col_map.get(name.lower(), name)

with engine.connect() as conn:
    result = conn.execute(text(f"""
        SELECT
            period,
            acct_025B,
            acct_041B,
            "{col('acct_703A')}",
            acct_752, acct_753, acct_754,
            acct_396,
            "{col('acct_045B')}",
            "{col('acct_041C1')}",
            "{col('acct_041C2')}",
            "{col('acct_718A5')}",
            "{col('acct_400P')}",
            "{col('acct_041G1')}",
            "{col('acct_041G2')}"
        FROM institutions_quarterly
        WHERE charter_number = {DORT_CHARTER}
        ORDER BY period DESC
        LIMIT 4
    """))
    rows = result.mappings().all()

if not rows:
    print(f"⚠️  NO rows found for charter {DORT_CHARTER} — data not ingested yet")
else:
    for row in rows:
        d = dict(row)
        period = d.get("period")
        loans = d.get("acct_025B") or 0
        mortgage = d.get(col("acct_703A")) or 0
        delinq_mortgage = (d.get("acct_752") or 0) + (d.get("acct_753") or 0) + (d.get("acct_754") or 0)
        auto_port = (d.get("acct_396") or 0)  # wrong field for auto but shows pattern
        delinq_cc = d.get(col("acct_045B")) or 0
        new_veh_delinq = d.get(col("acct_041C1")) or 0
        used_veh_delinq = d.get(col("acct_041C2")) or 0
        comm_re = d.get(col("acct_718A5")) or 0
        nonfarm = d.get(col("acct_400P")) or 0
        comm_re_delinq = (d.get(col("acct_041G1")) or 0) + (d.get(col("acct_041G2")) or 0)

        print(f"\n{period}:")
        print(f"  Total loans: ${loans:,.0f}")
        print(f"  1st Mortgage loans (703A): ${mortgage:,.0f}  |  delinq (752+753+754): ${delinq_mortgage:,.0f}  => {delinq_mortgage/mortgage*100:.3f}%" if mortgage else f"  1st Mortgage loans (703A): NULL/0 — denominator is ZERO, ratio will be NaN")
        print(f"  CC loans (396): ${d.get('acct_396') or 0:,.0f}  |  CC delinq (045B): ${delinq_cc:,.0f}")
        print(f"  New veh delinq (041C1): ${new_veh_delinq:,.0f}  |  Used veh delinq (041C2): ${used_veh_delinq:,.0f}")
        print(f"  Comm RE loans (718A5): ${comm_re:,.0f}  |  Nonfarm loans (400P): ${nonfarm:,.0f}")

# ── 3. Computed ratio check ──────────────────────────────────────────────────
print("\n" + "=" * 60)
print("3. COMPUTED RATIOS FOR DORT FINANCIAL")
print("=" * 60)
from db import get_engine as _get_engine, institutions_quarterly
from sqlalchemy import select as sa_select
from processing.delinquency_engine import compute_ratios

eng2 = _get_engine(db_url)
with eng2.connect() as conn:
    result = conn.execute(
        sa_select(institutions_quarterly).where(
            institutions_quarterly.c.charter_number == DORT_CHARTER
        ).order_by(institutions_quarterly.c.period.desc()).limit(4)
    )
    df = pd.DataFrame(result.mappings().all())

if df.empty:
    print("No data for Dort Financial")
else:
    df = compute_ratios(df)
    metrics = ["delinq_rate_cc", "delinq_rate_auto", "delinq_rate_1st_mortgage",
               "delinq_rate_nonfarm_nonre", "delinq_rate_commercial_re", "delinq_rate_total"]
    for _, row in df.iterrows():
        print(f"\n{row.get('period')}:")
        for m in metrics:
            v = row.get(m)
            if pd.isna(v) or v is None:
                print(f"  {m}: NaN (missing data)")
            else:
                print(f"  {m}: {v*100:.4f}%")

# ── 4. Peer distribution rows ────────────────────────────────────────────────
print("\n" + "=" * 60)
print("4. PEER DISTRIBUTION ROWS FOR PRODUCT METRICS")
print("=" * 60)
with engine.connect() as conn:
    result = conn.execute(text("""
        SELECT metric, peer_group_type, period, institution_count, p50
        FROM peer_distributions
        WHERE metric IN (
            'delinq_rate_cc', 'delinq_rate_auto',
            'delinq_rate_1st_mortgage', 'delinq_rate_nonfarm_nonre',
            'delinq_rate_commercial_re'
        )
        ORDER BY period DESC, metric
        LIMIT 30
    """))
    rows = result.mappings().all()

if rows:
    for r in rows:
        d = dict(r)
        p50_pct = f"{d['p50']*100:.3f}%" if d.get("p50") is not None else "None"
        print(f"  {d['period']}  {d['metric']:<35}  n={d['institution_count']}  median={p50_pct}")
else:
    print("⚠️  NO peer distribution rows for product metrics")
    print("    compute_peer_distributions hasn't run yet for these metrics.")
    print("    Run: python -m processing.compute_peer_distributions --period 2026Q1")

# ── 5. Check ZIP file contents ───────────────────────────────────────────────
print("\n" + "=" * 60)
print("5. ZIP FILE CONTENTS (looking for FS220H/I/L)")
print("=" * 60)
zips = sorted(Path("data/raw").glob("call-report-data-*.zip"), reverse=True)[:2]
if not zips:
    print("No ZIP files in data/raw/ — data hasn't been downloaded yet")
else:
    for zp in zips:
        print(f"\n{zp.name}:")
        with zipfile.ZipFile(zp) as zf:
            names = [m.filename for m in zf.infolist()]
            wanted = ["FS220H.txt", "FS220I.txt", "FS220L.txt", "FS220A.txt", "FS220B.txt"]
            for w in wanted:
                status = "✓ PRESENT" if w in names else "✗ MISSING"
                print(f"  {w}: {status}")
            # Check actual column names in FS220A.txt (loan composition)
            if "FS220A.txt" in names:
                import io
                data = zf.read("FS220A.txt")
                try:
                    header_line = data.decode("latin-1").split("\n")[0]
                    cols = [c.strip().upper() for c in header_line.split(",")]
                    mortgage_cols = [c for c in cols if "703" in c or "752" in c or "753" in c or "754" in c or "396" in c or "400" in c]
                    print(f"  FS220A cols with mortgage/loan codes: {mortgage_cols[:10]}")
                except Exception as e:
                    print(f"  Could not read FS220A.txt header: {e}")
