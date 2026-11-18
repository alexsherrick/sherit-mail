#!/usr/bin/env python3
"""Run the hub's tests many at once and say which failed and which were slow.
Every test file in test/ that runs on its own: the browser tests (*.py) and the node tests (*.mjs, *.cjs); helpers are skipped.
Each test's whole output goes to <logs>/<name>.log; the summary lists failures first, then the slowest. The slowest tests start
first (times from the last run, in ~/.cache/hub-tests/times.json), so the run is not left waiting on one long test at the end.
A test that holds time limits says "run_all: alone" in its first lines; those run one at a time after the rest.
Usage: python3 test/run_all.py [-j N] [--control] [--only a,b] [--logs DIR] [name...] (from hub/; exit 1 if any test failed)
  -j N tests at once (default: two thirds of the cores, at least 2; 12 on an 18-core Mac, 105 of 105 in three runs)
  --control also run each test's pass against an older app.js (CONTROL=1), which proves the test catches what it was written for
  name run only these files (e.g. rowlook.py smoke.cjs); --only takes the same as a comma list"""
import argparse, json, os, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent; HUB = HERE.parent
TIMES = Path.home() / ".cache" / "hub-tests" / "times.json"
# not tests: the shared harness, screenshot tools, the benchmark and pages other tests load
SKIP = {"preview.py", "bench.py", "run_all.py", "mock-fetch.js", "mention-page.cjs", "signout-page.cjs"}

def tests():
    out = []
    for p in sorted(HERE.iterdir()):
        if p.name in SKIP or p.name.startswith("_") or p.suffix not in (".py", ".mjs", ".cjs"): continue
        out.append(p.name)
    return out

def alone(name):
    try: return "run_all: alone" in "".join((HERE / name).read_text(errors="replace").splitlines(True)[:5])
    except Exception: return False

def run_one(name, logs, timeout, env):
    cmd = [sys.executable, f"test/{name}"] if name.endswith(".py") else ["node", f"test/{name}"]
    t = time.time()
    try:
        r = subprocess.run(cmd, cwd=HUB, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, env=env)
        code, out = r.returncode, r.stdout
    except subprocess.TimeoutExpired as e:
        code, out = 124, (e.stdout or b"") + f"\n[run_all] stopped after {timeout} s\n".encode()
    (logs / f"{name}.log").write_bytes(out)
    last = [l for l in out.decode(errors="replace").splitlines() if l.strip()][-1:] or [""]
    return name, code, time.time() - t, last[0][:120]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("-j", type=int, default=max(2, (os.cpu_count() or 4) * 2 // 3))
    ap.add_argument("--only", default=""); ap.add_argument("--control", action="store_true"); ap.add_argument("--logs", default=""); ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("names", nargs="*"); a = ap.parse_args()
    pick = [x for x in a.names + [y for y in a.only.split(",") if y]]
    names = [n for n in tests() if not pick or n in pick]
    missing = [x for x in pick if x not in names]
    if missing: print("no such test:", ", ".join(missing)); return 2
    logs = Path(a.logs) if a.logs else Path(tempfile.mkdtemp(prefix="hub-tests-")); logs.mkdir(parents=True, exist_ok=True)
    try: times = json.loads(TIMES.read_text())
    except Exception: times = {}
    names.sort(key=lambda n: -times.get(n, 1e9))   # slowest first; a test never timed goes first of all
    env = {**os.environ, **({"CONTROL": "1"} if a.control else {})}
    t0 = time.time(); res = []
    print(f"{len(names)} tests, {a.j} at once; logs in {logs}", flush=True)
    solo = [n for n in names if alone(n)]; pool = [n for n in names if n not in solo]
    def show(r):
        n, code, dt, last = r; res.append(r); print(f"{'ok  ' if code == 0 else 'FAIL'} {dt:6.1f}s  {n}" + ("" if code == 0 else f"   {last}"), flush=True)
    with ThreadPoolExecutor(max_workers=a.j) as ex:
        for f in as_completed([ex.submit(run_one, n, logs, a.timeout, env) for n in pool]): show(f.result())
    for n in solo: show(run_one(n, logs, a.timeout, env))   # alone: nothing else running
    wall = time.time() - t0; bad = [r for r in res if r[1] != 0]
    if not a.control:
        try: TIMES.parent.mkdir(parents=True, exist_ok=True); TIMES.write_text(json.dumps({**times, **{n: round(dt, 1) for n, _, dt, _ in res}}, indent=0, sort_keys=True))
        except Exception: pass
    print(f"\n{len(res) - len(bad)} passed, {len(bad)} failed; {wall:.0f} s wall, {sum(r[2] for r in res):.0f} s of test time")
    for n, code, dt, last in sorted(bad): print(f"  FAILED {n} (exit {code}): {last}   log: {logs / (n + '.log')}")
    print("slowest: " + ", ".join(f"{n} {dt:.0f}s" for n, _, dt, _ in sorted(res, key=lambda r: -r[2])[:6]))
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
