#!/usr/bin/env python3
"""An action queued while the phone says it is offline must still go out. My phone showed a read at
"attempts 0 · due now" while Gmail still had the mail unread. persist() skips a row when navigator.onLine is false without counting an
attempt, and nothing looked at that row again except the "online" event, which a phone waking from sleep does not always deliver.
Checked on WebKit and Chromium:
- a read made while offline is not sent, and is not counted as a failed attempt;
- once the device is online again it goes out by itself, with no "online" event;
- after a timer the system froze, coming back to the front sends what is due at once.
Usage: python3 test/queueresume.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
E = "sam.owner.sxsw@gmail.com"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
        page.wait_for_function("!window.mh.state.loading", timeout=30000)
        page.evaluate("() => { window.__online = true; Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => window.__online }); }")
        sent = lambda tid: page.evaluate(f"() => window.__mock.calls.filter((c) => c === 'POST gmail:threads/{tid}/modify').length")
        row = lambda tid: page.evaluate(f"() => {{ const r = queue.pending().find((x) => x.threadKey === '{E}|{tid}'); return r ? {{ attempts: r.attempts, due: r.notBefore <= Date.now() }} : null; }}")
        # ---- offline: skipped, not counted; online again: sent with no "online" event
        before = sent("g1")
        page.evaluate(f"async () => {{ window.__online = false; await window.mh.act(window.mh.state.threads.get('{E}|g1'), 'read'); }}")
        preview.settle(page, 1500)
        r = row("g1")
        check(r is not None and r["attempts"] == 0 and r["due"] and sent("g1") == before, f"{name}: a read made while offline waits, uncounted ({r})")
        page.evaluate("() => { window.__online = true; }")   # back online, and no "online" event is fired
        page.wait_for_function(f"() => !queue.pending().some((x) => x.threadKey === '{E}|g1')", timeout=20000)
        check(sent("g1") == before + 1, f"{name}: once online it goes out by itself, with no 'online' event")
        # ---- a frozen timer: coming back to the front sends what is due at once
        before = sent("g2")
        page.evaluate(f"async () => {{ window.__online = false; await window.mh.act(window.mh.state.threads.get('{E}|g2'), 'read'); }}")
        preview.settle(page, 800)
        page.evaluate("() => { clearTimeout(queue.timer); window.__online = true; document.dispatchEvent(new Event('visibilitychange')); }")
        preview.settle(page, 1500)
        check(row("g2") is None and sent("g2") == before + 1, f"{name}: coming back to the front sends a due action at once ({row('g2')})")
        check(not errs, f"{name}: no page errors ({errs[:2]})")
        b.close()
srv.shutdown()
print(f"\n{len(fails)} failed" if fails else "\nall queue-resume checks passed")
sys.exit(1 if fails else 0)
