#!/usr/bin/env python3
"""The buttons on a phone notification are the user's to pick, and their order. Settings → Notifications has three slots, left to right. Each change saves one list, in
order, without gaps or repeats. The hub side (the list in every push; Trash and Snooze from a notification) is test/ingest.mjs; Notify.kt
draws it. Usage: python3 test/notifybuttons.py"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
SPY = """() => { const sent = window.__prefsSent = []; const f = window.fetch;
  window.fetch = (url, o = {}) => { if (String(url).includes('/api/prefs') && (o.method || '').toUpperCase() === 'PUT') sent.push(JSON.parse(o.body)); return f(url, o); }; }"""
SLOTS = "() => [0, 1, 2].map((i) => document.querySelector('#nb' + i)?.value)"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1200, "height": 900}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(SPY)
        page.evaluate("() => window.mh.openSettings('notifications')"); preview.settle(page, 800)
        check(page.evaluate(SLOTS) == ["done", "read", "quiet"], f"{name}: three slots, by default Done · Mark read · Stop these ({page.evaluate(SLOTS)})")
        page.select_option("#nb1", "trash"); preview.settle(page, 500)
        sent = page.evaluate("() => window.__prefsSent")
        check(sent and sent[-1] == {"notifyButtons": ["done", "trash", "quiet"]}, f"{name}: changing the middle one saves the list in order ({sent[-1:] if sent else sent})")
        check(page.evaluate(SLOTS) == ["done", "trash", "quiet"], f"{name}: and the slots show it after the screen redraws")
        page.select_option("#nb0", ""); preview.settle(page, 500)
        check(page.evaluate("() => window.__prefsSent").pop() == {"notifyButtons": ["trash", "quiet"]}, f"{name}: an empty slot leaves no gap")
        page.select_option("#nb0", "trash"); preview.settle(page, 500)
        check(page.evaluate("() => window.__prefsSent").pop() == {"notifyButtons": ["trash", "quiet"]}, f"{name}: the same button twice is saved once")
        toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
        check("Trash · Stop these" in toast, f"{name}: and it says what the phone will show ({toast[:80]})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print("all notification-button checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
