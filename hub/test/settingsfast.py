#!/usr/bin/env python3
# run_all: alone (it holds a time limit: Settings drawn within 150 ms, which other tests' CPU would decide)
"""Settings draws at once. Settings awaited seven requests to the hub one after another before it drew
anything, 1.0 s from the user's Mac, more on a phone, and again on every redraw. Covered here, in WebKit and Chromium, with the app's
fake network (test/mock-fetch.js) holding the hub's answer back where it matters:
- opening Settings asks the hub once, GET /api/settings, and none of the seven routes it stands for;
- with that answer held back, the screen is drawn at once from what the app last had;
- when the answer lands with something new, the screen shows it, keeping what is typed in it, the focused field and the scroll;
- after an action (a rule removed) the redraw waits for the hub's answer, one request;
- on the next launch, with the hub never answering, Settings still draws from what this device kept, and that copy is in the app's
  database, which signing out wipes.
Usage: python3 test/settingsfast.py (exit 1 on any failed check)
CONTROL=1: the same against the client at 7b57722, from before the change; it must fail (skipped where that commit is not in the checkout)."""
import subprocess, sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright

FILES = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]
OLD = "7b57722"
if preview.CONTROL:
    if subprocess.run(["git", "cat-file", "-e", OLD + "^{commit}"], cwd=preview.HUB, capture_output=True).returncode != 0:
        print(f"SKIP control: the commit it replays ({OLD}) is not in this checkout"); sys.exit(0)
    preview.BUNDLE = "\n".join(subprocess.run(["git", "show", f"{OLD}:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=True).stdout for f in FILES).replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
SEVEN = ["/api/push/subscriptions", "/api/quiet-rules", "/api/trash-rules", "/api/locks", "/api/mention-rules", "/api/trackers/status", "/api/unsubscribes"]
RULE = "{ id: '11111111-2222-3333-4444-555555555555', sender: 'venmo@venmo.example', subject: 'venmo security code', hits: 7, created_at: '2026-10-06T10:00:00Z' }"
# Hold GET /api/settings until window.__release() (each call holds anew)
HOLD = """() => { window.__mock.hold['GET /api/settings'] = new Promise((r) => { window.__release = r; }); }"""
# Open Settings on a section; how long until its card is drawn, and the calls made meanwhile
OPEN = """async (sec) => { const c0 = window.__mock.calls.length, t0 = performance.now();
  const p = window.mh.openSettings(sec); let drawn = null;
  for (let i = 0; i < 200; i++) { if (document.querySelector('#scard section[data-sec="' + sec + '"]:not([hidden])')) { drawn = performance.now() - t0; break; } await new Promise((r) => setTimeout(r, 5)); }
  return { drawn, calls: window.__mock.calls.slice(c0) }; }"""
rules_shown = "() => [...document.querySelectorAll('#scard section[data-sec=\"notifications\"] [data-qdel]')].map((b) => b.dataset.qdel)"
if True:
    with sync_playwright() as pw:
        for engine in (pw.webkit, pw.chromium):
            name = engine.name
            b = engine.launch(); ctx = b.new_context(viewport={"width": 1200, "height": 800}); page = ctx.new_page(); errs = []
            page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1200)
            # 1. one request
            r = page.evaluate(OPEN, "notifications"); preview.settle(page, 400)
            calls = page.evaluate("() => window.__mock.calls"); asked = [c for c in calls if any(c == "GET " + p for p in SEVEN)]
            check(r["drawn"] is not None and "GET /api/settings" in calls and not asked, f"{name}: Settings asks the hub once, GET /api/settings, none of the seven it stands for ({[c for c in r['calls'] if c.startswith('GET /api/')]}, asked {asked})")
            page.evaluate("() => window.mh.closeSettings()"); preview.settle(page, 200)
            # 2. drawn at once with the answer held back; the answer lands, typed text and focus kept
            page.evaluate(HOLD); page.evaluate(f"() => {{ window.__mock.routes['GET /api/quiet-rules'] = {{ rules: [{RULE}] }}; }}")
            r = page.evaluate(OPEN, "notifications")
            check(r["drawn"] is not None and r["drawn"] < 150 and page.evaluate(rules_shown) == [], f"{name}: with the hub's answer held back, the screen is drawn at once from what the app had ({r['drawn'] and round(r['drawn'])} ms)")
            page.evaluate("() => { const body = document.querySelector('#scard .st-body'); const q = document.getElementById('qsender'); q.value = 'grace@exam'; q.focus(); q.setSelectionRange(4, 4); }")
            page.evaluate("() => window.__release()"); preview.settle(page, 500)
            st = page.evaluate("() => { const q = document.getElementById('qsender'); return { v: q && q.value, focus: document.activeElement && document.activeElement.id, at: q && q.selectionStart }; }")
            check(page.evaluate(rules_shown) == ["11111111-2222-3333-4444-555555555555"], f"{name}: when the answer lands, the new rule is on screen ({page.evaluate(rules_shown)})")
            check(st == {"v": "grace@exam", "focus": "qsender", "at": 4}, f"{name}: and what was typed, the focus and the cursor are kept ({st})")
            # 3. after an action the redraw waits for the hub's answer, one request
            page.evaluate("() => { window.__mock.routes['DELETE /api/quiet-rules/11111111-2222-3333-4444-555555555555'] = { ok: true, removed: 1 }; window.__mock.routes['GET /api/quiet-rules'] = { rules: [] }; }")
            page.evaluate(HOLD); c0 = page.evaluate("() => window.__mock.calls.length")
            page.click('#scard [data-qdel="11111111-2222-3333-4444-555555555555"]'); preview.settle(page, 300)
            during = page.evaluate("() => document.querySelectorAll('#scard [data-qdel]').length")
            page.evaluate("() => window.__release()"); preview.settle(page, 400)
            after = page.evaluate("(c0) => window.__mock.calls.slice(c0).filter((c) => c.startsWith('GET /api/'))", c0)
            check(after == ["GET /api/settings"] and page.evaluate(rules_shown) == [], f"{name}: after removing a rule, one request, and the screen shows the hub's answer ({after}, {during} row(s) while it was held)")
            page.evaluate("() => window.mh.closeSettings()"); preview.settle(page, 200)
            kept = page.evaluate("async () => { const d = await window.mh.idb.meta('settings'); return !!(d && d.quiet && d.trackers); }")
            check(kept, f"{name}: the last answer is kept in the app's database (wiped at sign-out with the mail)")
            # 4. the next launch, the hub never answering: drawn from what was kept
            page.evaluate(f"() => {{ window.__mock.routes['GET /api/quiet-rules'] = {{ rules: [{RULE}] }}; }}"); page.evaluate(HOLD); page.evaluate("() => window.mh.openSettings('notifications')"); page.evaluate("() => window.__release()"); preview.settle(page, 500)
            page.evaluate("() => window.mh.closeSettings()"); preview.settle(page, 300)
            page2 = ctx.new_page(); page2.on("pageerror", lambda e: errs.append(str(e)))
            page2.add_init_script("window.__mockSetup = (mk) => { mk.hold['GET /api/settings'] = new Promise(() => {}); };")
            page2.goto(base); page2.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page2, 1200)
            r = page2.evaluate(OPEN, "notifications")
            check(r["drawn"] is not None and r["drawn"] < 150 and page2.evaluate(rules_shown) == ["11111111-2222-3333-4444-555555555555"], f"{name}: on the next launch, with the hub never answering, Settings draws at once from what was kept ({r['drawn'] and round(r['drawn'])} ms, {page2.evaluate(rules_shown)})")
            page2.close()
            check(not errs, f"{name}: no page errors {errs[:3]}")
            b.close()
print(("\n%d failed" % len(fails)) if fails else "\nall settings-speed checks passed")
sys.exit(1 if fails else 0)
