#!/usr/bin/env python3
"""A bulk action says where its time goes. The phone's bulk Trash took 909 ms (median of 5, the field speed report of
2026-11-25) against 33-52 ms for the same work at 4x CPU here, and its one timer (tap to next frame) could not say which part. In Chromium,
selecting rows and tapping Trash in the selection bar records, beside bulk:trash: the wait between the tap and the code running, the
conversations patched, the list redrawn, the badge, the wait from the end of that work to the next frame, and how many were trashed.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails (none of them is recorded).
Usage: python3 test/bulkphases.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
PHASES = ["bulk:trash", "bulk:phase:input-wait", "bulk:phase:patch", "bulk:phase:draw", "bulk:phase:badge", "bulk:phase:to-frame", "bulk:count"]
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_page(viewport={"width": 412, "height": 900}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1000)
    page.evaluate("() => window.mh.perf.reset()")
    n = page.evaluate("""() => { const S = window.mh.state; const rows = [...document.querySelectorAll('#threads .t')].slice(0, 2); for (const r of rows) S.checked.add(r.dataset.key);
      S.selecting = true; document.getElementById('app').classList.add('selecting'); document.querySelector('#selbar').style.display = 'flex'; return rows.length; }""")
    page.click('#selbar [data-bulk="trash"]', force=True); preview.settle(page, 600)
    stats = page.evaluate("(ps) => Object.fromEntries(ps.map((p) => { const s = window.mh.perf.stats[p]; return [p, s ? s.samples.slice(-1)[0] : null]; }))", PHASES)
    check(all(stats[p] is not None for p in PHASES), f"a bulk Trash records its tap-to-frame time and each part ({stats})")
    check(stats["bulk:count"] == n, f"and how many it trashed ({stats['bulk:count']} of {n})")
    check(not errs, f"no page errors {errs[:2]}")
    b.close()
print(f"{len(fails)} failed" if fails else "all bulk-phase checks passed")
sys.exit(1 if fails else 0)
