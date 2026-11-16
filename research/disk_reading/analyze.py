"""Per-disk table, top-3 accuracy, confidence thresholds and a simple ensemble."""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

recs = json.loads(Path(sys.argv[1]).read_text())
DISTINCT = {"0", "1", "2", "3"}
by = defaultdict(dict)
for r in recs:
    by[(r["plate"], r["disk"])][r["engine"]] = r
engines = sorted({r["engine"] for r in recs})


def top3(r):
    names = [r["name"]] + [c for c in re.findall(r"'([^']+)'\)", r["info"].split("->")[-1])]
    return names


print("| disk | printed | " + " | ".join(engines) + " |")
print("|---|---|" + "---|" * len(engines))
for (p, d), rs in sorted(by.items(), key=lambda t: (int(t[0][0]), t[0][1])):
    if p not in DISTINCT:
        continue
    t = next(iter(rs.values()))
    cells = []
    for e in engines:
        r = rs[e]
        ok = "✅" if r["name"] == r["want"] else "❌"
        m = re.search(r"-> ([^(]+)\(", r["info"])
        cells.append(f"{ok} {m.group(1).strip() if m else (r['name'] or '–')}")
    print(f"| {p}/{d} | {t['truth']} | " + " | ".join(cells) + " |")

if "ppocr" in engines:
    pp = [rs["ppocr"] for rs in by.values()]
    print("\nppocr confidence threshold (all 66 disks):")
    for th in (-1, -2, -3, -4, -5):
        acc = [r for r in pp if r["score"] >= th]
        ok = sum(r["name"] == r["want"] for r in acc)
        print(f"  logp >= {th}: auto-accepted {len(acc)}/{len(pp)}, of which correct {ok}/{len(acc)}; "
              f"sent to the user {len(pp) - len(acc)}")
if {"ppocr", "tesseract"} <= set(engines):
    for th in (-3, -4):
        ok_all = ok_d = n_d = 0
        for (p, d), rs in by.items():
            choice = rs["ppocr"] if rs["ppocr"]["score"] >= th or rs["tesseract"]["score"] < 0.6 else rs["tesseract"]
            good = choice["name"] == choice["want"]
            ok_all += good
            if p in DISTINCT:
                ok_d += good
                n_d += 1
        print(f"ensemble (ppocr if logp>={th}, else tesseract if its score>=0.6): all {ok_all}/{len(by)}, distinct {ok_d}/{n_d}")

if "ppocr" in engines:
    for scope in ("all", "distinct"):
        rows = [rs["ppocr"] for (p, d), rs in by.items() if scope == "all" or p in DISTINCT]
        hits = 0
        for r in rows:
            cand = re.findall(r"'([A-Z/]+) [0-9.]+'", r["info"].split("->")[-1])
            truth_code = r["truth"].split()[0]
            first = re.search(r"-> ([A-Z/]+) ", r["info"])
            codes = ([first.group(1)] if first else []) + cand
            hits += r["name"] == r["want"] or truth_code in codes[:3]
        print(f"ppocr top-3 ({scope}): {hits}/{len(rows)}")
if {"ppocr", "templates"} <= set(engines):
    for th in (-2, -3):
        ok_all = ok_d = n_d = 0
        for (p, d), rs in by.items():
            choice = rs["ppocr"] if rs["ppocr"]["score"] >= th or not rs["templates"]["name"] else rs["templates"]
            good = choice["name"] == choice["want"]
            ok_all += good
            if p in DISTINCT:
                ok_d += good
                n_d += 1
        print(f"ensemble (ppocr if logp>={th}, else templates): all {ok_all}/{len(by)}, distinct {ok_d}/{n_d}")
    d_pp = [rs["ppocr"] for (p, d), rs in by.items() if p in DISTINCT]
    for th in (-2, -3):
        acc = [r for r in d_pp if r["score"] >= th]
        print(f"distinct, ppocr logp>={th}: accepted {len(acc)}/{len(d_pp)}, correct {sum(r['name'] == r['want'] for r in acc)}")
