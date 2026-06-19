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

existing_lower = {e.lower() for e in existing}
KEY_COLS = ['acct_703A','acct_396','acct_385','acct_370','acct_718A5','acct_400P',
            'acct_045B','acct_752','acct_753','acct_754',
            'acct_041C1','acct_041C2','acct_041G1','acct_041G2','acct_041G3',
            'acct_041P1','acct_041P2','acct_041P3','acct_041P4','acct_1001F']
found    = [c for c in KEY_COLS if c.lower() in existing_lower]
missing  = [c for c in KEY_COLS if c.lower() not in existing_lower]

print(f"Found  ({len(found)}): {found}")
print(f"Missing({len(missing)}): {missing}")

if missing:
    print("\n⚠️  MIGRATION NOT FULLY RUN — execute migrations/add_product_delinq_columns.sql")
    print("    Then re-ingest to populate the new columns.")
    if len(missing) == len(KEY_COLS):
        sys.exit(1)   # nothing to show — stop early

# ── 2. Dort Financial raw values ─────────────────────────────────────────────
print("\n" + "=" * 60)
print("2. DORT FINANCIAL RAW VALUES (last 4 quarters)")
print("=" * 60)

# Use SQLAlchemy ORM select — it handles mixed-case column quoting automatically
from db import get_engine as _get_engine2, institutions_quarterly as iq
from sqlalchemy import select as sa_select2

eng_orm = _get_engine2(db_url)
with eng_orm.connect() as conn:
    result = conn.execute(
        sa_select2(iq).where(iq.c.charter_number == DORT_CHARTER)
        .order_by(iq.c.period.desc()).limit(4)
    )
    rows = result.mappings().all()

if not rows:
    print(f"⚠️  NO rows found for charter {DORT_CHARTER} — data not ingested yet")
else:
    for row in rows:
        d = dict(row)
        period      = d.get("period")
        loans       = d.get("acct_025B") or 0
        mortgage    = d.get("acct_703A") or 0
        d_mort      = (d.get("acct_752") or 0) + (d.get("acct_753") or 0) + (d.get("acct_754") or 0)
        cc_port     = d.get("acct_396") or 0
        d_cc        = d.get("acct_045B") or 0
        d_newveh    = d.get("acct_041C1") or 0
        d_usedveh   = d.get("acct_041C2") or 0
        comm_re     = d.get("acct_718A5") or 0
        nonfarm     = d.get("acct_400P") or 0
        d_comm_re   = (d.get("acct_041G1") or 0) + (d.get("acct_041G3") or 0)
        d_nonfarm   = (d.get("acct_041G2") or 0) + (d.get("acct_041G4") or 0)

        print(f"\n{period}:  total loans=${loans:,.0f}")
        if mortgage:
            print(f"  1st Mortgage (703A): ${mortgage:,.0f}  delinq(752+753+754)=${d_mort:,.0f}  => {d_mort/mortgage*100:.4f}%")
        else:
            print(f"  1st Mortgage (703A): NULL/0  ← denominator zero, ratio=NaN")
        print(f"  CC loans (396): ${cc_port:,.0f}  delinq(045B)=${d_cc:,.0f}")
        print(f"  New veh delinq(041C1): ${d_newveh:,.0f}  Used veh delinq(041C2): ${d_usedveh:,.0f}")
        if comm_re:
            print(f"  Comm RE (718A5): ${comm_re:,.0f}  delinq(G1+G3)=${d_comm_re:,.0f}  => {d_comm_re/comm_re*100:.4f}%")
        else:
            print(f"  Comm RE (718A5): NULL/0  ← denominator zero, ratio=NaN")
        if nonfarm:
            print(f"  Non-farm (400P): ${nonfarm:,.0f}  delinq(G2+G4)=${d_nonfarm:,.0f}  => {d_nonfarm/nonfarm*100:.4f}%")
        else:
            print(f"  Non-farm (400P): NULL/0  ← denominator zero, ratio=NaN")

# ── 3. Computed ratio check ──────────────────────────────────────────────────
print("\n" + "=" * 60)
print("3. COMPUTED RATIOS FOR DORT FINANCIAL")
print("=" * 60)
from processing.delinquency_engine import compute_ratios

df = pd.DataFrame([dict(r) for r in rows])

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
