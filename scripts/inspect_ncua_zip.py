"""
Inspect the most recent NCUA ZIP to find actual column names for
1st mortgage, commercial RE, and non-farm delinquency.

Run from project root: python scripts/inspect_ncua_zip.py
"""
import sys, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

import pandas as pd

DORT = "68708"

# Find the most recent ZIP
zips = sorted(Path("data/raw").glob("call-report-data-*.zip"), reverse=True)
if not zips:
    print("No ZIPs in data/raw/ — run ingest first")
    sys.exit(1)

zip_path = zips[0]
print(f"Inspecting: {zip_path.name}\n")

with zipfile.ZipFile(zip_path) as zf:
    files = [m.filename for m in zf.infolist()]
    print(f"Files in ZIP: {files}\n")

    def read_file(fname):
        if fname not in files:
            print(f"  {fname}: NOT IN ZIP")
            return None
        data = zf.read(fname).decode("latin-1")
        lines = data.split("\n")
        header = lines[0]
        # Try comma, tab, pipe
        for sep in (",", "\t", "|"):
            cols = [c.strip().upper() for c in header.split(sep)]
            if len(cols) > 3:
                df = pd.read_csv(
                    __import__("io").StringIO(data), sep=sep, dtype=str,
                    encoding="latin-1", low_memory=False, on_bad_lines="warn"
                )
                df.columns = [c.strip().upper() for c in df.columns]
                return df
        return None

    # ── FS220A — loan composition (should have 703A, 385, 370, 718A5, 400P) ──
    print("=" * 60)
    print("FS220A.txt — loan composition")
    df_a = read_file("FS220A.txt")
    if df_a is not None:
        cu_col = next((c for c in df_a.columns if "NUMBER" in c or c == "CU_NUMBER"), None)
        dort = df_a[df_a[cu_col] == DORT] if cu_col else pd.DataFrame()
        # Find mortgage/commercial/delinquency-looking columns
        interesting = [c for c in df_a.columns if any(x in c for x in
            ["703", "718", "400", "752", "753", "754", "756", "757", "758",
             "041D", "041E", "041F", "041H", "041R", "041S"])]
        print(f"  Columns with mortgage/RE/delinq patterns: {interesting}")
        if not dort.empty and interesting:
            print(f"  Dort Financial values:")
            for c in interesting:
                print(f"    {c}: {dort[c].values[0]}")

    # ── FS220B — (net worth? or delinquency sub-schedule?) ──
    print("\n" + "=" * 60)
    print("FS220B.txt — check for 752/753/754 delinquency codes")
    df_b = read_file("FS220B.txt")
    if df_b is not None:
        cu_col = next((c for c in df_b.columns if "NUMBER" in c or c == "CU_NUMBER"), None)
        dort = df_b[df_b[cu_col] == DORT] if cu_col else pd.DataFrame()
        interesting = [c for c in df_b.columns if any(x in c for x in
            ["752", "753", "754", "756", "757", "758", "041", "045", "RE", "MORT"])]
        all_cols_sample = df_b.columns.tolist()[:40]
        print(f"  First 40 columns: {all_cols_sample}")
        print(f"  Columns with delinq/mortgage patterns: {interesting}")
        if not dort.empty and interesting:
            print(f"  Dort Financial values:")
            for c in interesting:
                print(f"    {c}: {dort[c].values[0]}")

    # ── FS220I — per-product consumer delinquency ──
    print("\n" + "=" * 60)
    print("FS220I.txt — consumer/auto delinquency")
    df_i = read_file("FS220I.txt")
    if df_i is not None:
        cu_col = next((c for c in df_i.columns if "NUMBER" in c or c == "CU_NUMBER"), None)
        dort = df_i[df_i[cu_col] == DORT] if cu_col else pd.DataFrame()
        interesting = [c for c in df_i.columns if any(x in c for x in
            ["041C", "041D", "041E", "041G", "041P", "041H", "041R", "045", "752"])]
        print(f"  Columns with 041x/045 patterns: {interesting}")
        if not dort.empty:
            print(f"  Dort Financial values for these columns:")
            for c in interesting[:30]:
                print(f"    {c}: {dort[c].values[0] if c in dort.columns else 'N/A'}")

    # ── FS220L — commercial loan delinquency ──
    print("\n" + "=" * 60)
    print("FS220L.txt — commercial loan delinquency")
    df_l = read_file("FS220L.txt")
    if df_l is not None:
        cu_col = next((c for c in df_l.columns if "NUMBER" in c or c == "CU_NUMBER"), None)
        dort = df_l[df_l[cu_col] == DORT] if cu_col else pd.DataFrame()
        interesting = [c for c in df_l.columns if any(x in c for x in
            ["041G", "041P", "041H", "041R", "041L", "718", "400", "COMM"])]
        all_cols_sample = df_l.columns.tolist()[:50]
        print(f"  First 50 columns: {all_cols_sample}")
        print(f"  Columns with commercial delinq patterns: {interesting}")
        if not dort.empty:
            print(f"  Dort Financial values:")
            for c in interesting[:20]:
                print(f"    {c}: {dort[c].values[0] if c in dort.columns else 'N/A'}")

    # ── Look for ANY column containing "1ST MORT" or "REAL ESTATE" delinquency ──
    print("\n" + "=" * 60)
    print("ALL FILES — searching for 1st mortgage delinquency codes")
    for fname in files:
        if not fname.endswith(".txt"):
            continue
        try:
            data = zf.read(fname).decode("latin-1")
            header = data.split("\n")[0]
            for sep in (",", "\t", "|"):
                cols = [c.strip().upper() for c in header.split(sep)]
                if len(cols) < 3:
                    continue
                mort_cols = [c for c in cols if any(x in c for x in
                    ["752", "753", "754", "756", "757", "758",
                     "041D", "041E", "041F", "041H", "041R", "041S", "MORT"])]
                if mort_cols:
                    print(f"  {fname}: {mort_cols}")
                break
        except Exception:
            pass
