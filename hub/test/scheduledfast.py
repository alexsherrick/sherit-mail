#!/usr/bin/env python3
"""Scheduled draws at once. It awaited GET /api/schedule before drawing anything, so the previous view stayed on screen
for the round trip; the app has had the list since boot. In WebKit and Chromium, with the app's fake network (test/mock-fetch.js) holding
the hub's answer back:
  - opening Scheduled draws what the app has at once, with the answer held back;
  - the answer, when it lands with something new, is drawn;
  - an answer that lands after the person has moved to another view does not draw over it;
  - cancelling takes the row off at once;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the at-once checks.
Usage: python3 test/scheduledfast.py"""
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
A = {"id": "sa1", "kind": "send_later", "account": "hub", "ref": None, "due_at": "2026-12-01T15:00:00Z", "payload": {"subject": "Quarterly numbers"}}
B = {"id": "sb2", "kind": "reminder", "account": "hub", "ref": None, "due_at": "2026-12-02T15:00:00Z", "payload": {"title": "Call the bank"}}
HOLD = "() => { window.__mock.hold['GET /api/schedule?status=pending'] = new Promise((r) => { window.__release = r; }); }"
ROWS = "() => [...document.querySelectorAll('#threads .sub')].map((e) => e.textContent)"
OPEN = """async () => { const t0 = performance.now(); window.mh.setView('scheduled'); let drawn = null;
  for (let i = 0; i < 100; i++) { if ([...document.querySelectorAll('#threads .sub')].some((e) => e.textContent === 'Quarterly numbers')) { drawn = performance.now() - t0; break; } await new Promise((r) => setTimeout(r, 5)); }
  return drawn; }"""

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1000)
        # what the app has: one send-later, as the boot's answer would have brought
        page.evaluate("(a) => { window.mh.state.schedules = [a]; }", A)
        page.evaluate(HOLD); page.evaluate("(x) => { window.__mock.routes['GET /api/schedule?status=pending'] = { actions: x }; }", [A, B])
        drawn = page.evaluate(OPEN)
        check(drawn is not None and drawn < 150 and page.evaluate(ROWS) == ["Quarterly numbers"], f"{name}: Scheduled draws what the app has at once, the hub's answer held back ({drawn and round(drawn)} ms, {page.evaluate(ROWS)})")
        page.evaluate("() => window.__release()"); preview.settle(page, 400)
        check(page.evaluate(ROWS) == ["Quarterly numbers", "Call the bank"], f"{name}: the answer, when it lands with something new, is drawn ({page.evaluate(ROWS)})")
        # an answer landing after the person moved on
        page.evaluate(HOLD); page.evaluate("() => { window.mh.setView('scheduled'); }"); preview.settle(page, 100)
        page.evaluate("() => { window.mh.setView('inbox'); }"); preview.settle(page, 200)
        page.evaluate("(x) => { window.__mock.routes['GET /api/schedule?status=pending'] = { actions: x }; }", [A])
        page.evaluate("() => window.__release()"); preview.settle(page, 400)
        on_inbox = page.evaluate("() => window.mh.state.view.kind") == "inbox" and page.evaluate(ROWS) != ["Quarterly numbers"] and page.evaluate("() => document.querySelectorAll('#threads .t').length") > 1
        check(on_inbox, f"{name}: an answer landing after the move to another view does not draw over it ({page.evaluate('() => window.mh.state.view.kind')}, {page.evaluate(ROWS)[:3]})")
        # cancel: the row goes at once
        page.evaluate("(x) => { window.mh.state.schedules = x; window.__mock.routes['GET /api/schedule?status=pending'] = { actions: x }; window.__mock.routes['DELETE /api/schedule/sb2'] = { ok: true, kind: 'reminder', account: 'hub' }; }", [A, B])
        page.evaluate("() => { window.mh.setView('scheduled'); }"); preview.settle(page, 300)
        page.evaluate(HOLD); page.evaluate("(x) => { window.__mock.routes['GET /api/schedule?status=pending'] = { actions: x }; }", [A])
        page.click('#threads [data-cancel="sb2"]'); preview.settle(page, 300)
        check(page.evaluate(ROWS) == ["Quarterly numbers"], f"{name}: a cancelled one is off the list at once, the hub's answer still held ({page.evaluate(ROWS)})")
        page.evaluate("() => window.__release()"); preview.settle(page, 200)
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all scheduled checks passed")
sys.exit(1 if fails else 0)
