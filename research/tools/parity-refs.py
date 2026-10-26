# Every "matches" row of research/PARITY.md must cite a test or code that exists: e2e step names (run.ts, perf.ts),
# Rust test functions, Vitest names, repo paths. Exit 1 with the rows that don't.
# usage: python3 research/tools/parity-refs.py <repo root>
import re, glob, os, sys
root = sys.argv[1]
os.chdir(root)
steps = re.findall(r'^\s*(?:step\(\s*|\s{2})"([^"]+)"', open("app/src/e2e/run.ts").read(), re.M)
steps += re.findall(r'name: "([^"]+)"', open("app/src/e2e/perf.ts").read())
rust = "".join(open(f).read() for f in glob.glob("app/src-tauri/tests/*.rs") + glob.glob("app/src-tauri/src/**/*.rs", recursive=True))
vit = "".join(open(f).read() for f in glob.glob("app/tests/*.ts"))
rows = []
for line in open("research/PARITY.md"):
    m = re.match(r"\| ([A-Z]+-\d+) \|", line)
    if not m: continue
    c = [x.strip() for x in line.strip().strip("|").split("|")]
    if c[3] != "matches": continue
    rows.append((c[0], c[2], c[4], c[5]))
bad = []
for rid, item, ev, test in rows:
    refs, ok, why = 0, True, []
    for q in re.findall(r'e2e[^"“]*["“]([^"”]+)["”]', test):
        refs += 1
        key = q.split("…")[0].rstrip(". ")
        if not any(s.startswith(key[:60]) or key[:60] in s for s in steps):
            ok = False; why.append(f"e2e step not found: {q[:70]}")
    for fn in re.findall(r"\b([a-z][a-z0-9]*(?:_[a-z0-9]+){3,})\b", test):
        refs += 1
        if f"fn {fn}" not in rust:
            ok = False; why.append(f"rust test not found: {fn}")
    for q in re.findall(r'Vitest[^"]*"([^"]+)"', test):
        refs += 1
        if q.rstrip("…").replace("…","")[:40] not in vit:
            ok = False; why.append(f"vitest not found: {q[:60]}")
    for p in re.findall(r"(app/[\w./-]+\.(?:tsx?|rs|css|json))", test + " " + ev):
        refs += 1
        if not os.path.exists(p):
            ok = False; why.append(f"file missing: {p}")
    if refs == 0 and test.strip() in ("", "—", "same Rust test"):
        if test.strip() != "same Rust test":
            ok = False; why.append("no test or code cited")
    if not ok: bad.append((rid, item[:60], "; ".join(why)))
print(f"matches rows: {len(rows)}; with a broken or missing reference: {len(bad)}")
for b in bad: print(" | ".join(b))
sys.exit(1 if bad else 0)
