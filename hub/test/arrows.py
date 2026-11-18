#!/usr/bin/env python3
"""↓ / ↑ walk the conversation list (The up and down arrow keys open the next or the previous
conversation in the reading pane). Covered, on WebKit (the Mac app) and Chromium (Windows):
- ↓ opens the next conversation in the reading pane, ↑ the previous, exactly as j / k;
- the opened row is scrolled into view when the walk passes the bottom of the list;
- the arrows still belong to the search box and other typing fields there.
Usage: python3 test/arrows.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
ROWS = "() => [...document.querySelectorAll('#threads .t')].map((d) => d.dataset.key)"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 420}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1000)
        rows = page.evaluate(ROWS)
        page.evaluate("(k) => window.mh.openThread(k)", rows[0]); preview.settle(page, 400)
        page.evaluate("() => document.activeElement && document.activeElement.blur()")
        page.keyboard.press("ArrowDown"); preview.settle(page, 300)
        cur = page.evaluate("() => window.mh.state.cur")
        title = page.evaluate("() => document.querySelector('#vtitle').textContent")
        check(cur == rows[1] and page.evaluate("() => document.querySelector('#app').classList.contains('viewing')"), f"{name}: ↓ opens the next conversation in the reading pane ({title!r})")
        page.keyboard.press("ArrowUp"); preview.settle(page, 300)
        check(page.evaluate("() => window.mh.state.cur") == rows[0], f"{name}: ↑ goes back to the previous one")
        page.keyboard.press("ArrowUp"); preview.settle(page, 200)
        check(page.evaluate("() => window.mh.state.cur") == rows[0], f"{name}: ↑ on the first conversation stays put")
        n = len(rows) - 1
        for _ in range(n): page.keyboard.press("ArrowDown"); page.wait_for_timeout(120)
        last = page.evaluate("() => window.mh.state.cur")
        vis = page.evaluate("""(k) => { const r = document.querySelector(`.t[data-key="${CSS.escape(k)}"]`).getBoundingClientRect(), l = document.querySelector('#threads').getBoundingClientRect(); return r.top >= l.top - 1 && r.bottom <= l.bottom + 1; }""", last)
        check(last == rows[-1] and vis, f"{name}: walking down {n} conversations keeps the open one's row in view (at the last: {last == rows[-1]}, visible: {vis})")
        page.keyboard.press("ArrowDown"); preview.settle(page, 200)
        check(page.evaluate("() => window.mh.state.cur") == rows[-1], f"{name}: ↓ on the last conversation stays put")
        page.click("#q"); page.keyboard.type("hel"); before = page.evaluate("() => window.mh.state.cur")
        page.keyboard.press("ArrowUp"); preview.settle(page, 200)
        check(page.evaluate("() => window.mh.state.cur") == before, f"{name}: in the search box the arrows stay with the box")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print("all arrow checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
