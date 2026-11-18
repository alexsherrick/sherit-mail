#!/usr/bin/env python3
"""Clearing a search (A quick way to clear a search, Esc on the Mac and Windows and the best equivalent
on Android). Covered here:
- the X inside the box: shown only while there is text, one click clears the search;
- Esc in the box: the first clears, the second leaves the box. Esc elsewhere clears the search too;
- on a phone, the back gesture: from a conversation opened out of the results it returns to the results, then to the plain list,
  and only then would it leave the app.
Usage: python3 test/searchclear.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
S = "() => ({ q: document.querySelector('#q').value, search: window.mh.state.search, x: !document.querySelector('#qClear').hidden, focused: document.activeElement === document.querySelector('#q'), layers: window.mh.layers.filter((l) => !l.spent).map((l) => l.name) })"
def boot(page):
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1200)
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        boot(page)
        check(page.evaluate(S)["x"] is False, f"{name} desktop: no X while the box is empty")
        page.click("#q"); page.keyboard.type("hello"); preview.settle(page, 300)
        s = page.evaluate(S)
        check(s["x"] and s["search"] == "hello" and "search" in s["layers"], f"{name} desktop: typing shows the X and the search is one step of the back stack ({s})")
        page.click("#qClear"); preview.settle(page, 300); s = page.evaluate(S)
        check(s["q"] == "" and s["search"] == "" and not s["x"] and "search" not in s["layers"], f"{name} desktop: the X clears it ({s})")
        check(s["focused"], f"{name} desktop: and the box keeps its focus, ready for the next search")
        page.keyboard.type("hello"); preview.settle(page, 200); page.keyboard.press("Escape"); preview.settle(page, 200); s = page.evaluate(S)
        check(s["q"] == "" and s["search"] == "" and s["focused"], f"{name} desktop: Esc in the box clears it and stays in the box ({s})")
        page.keyboard.press("Escape"); preview.settle(page, 200); s = page.evaluate(S)
        check(not s["focused"], f"{name} desktop: a second Esc leaves the box")
        page.click("#q"); page.keyboard.type("hello"); preview.settle(page, 200); page.evaluate("() => document.querySelector('#q').blur()")
        page.keyboard.press("Escape"); preview.settle(page, 300); s = page.evaluate(S)
        check(s["search"] == "" and s["q"] == "", f"{name} desktop: Esc with the focus elsewhere clears the search too ({s})")
        page.click("#q"); page.keyboard.type("hello"); preview.settle(page, 200)
        page.click("[data-clearsearch]"); preview.settle(page, 300); s = page.evaluate(S)
        check(s["search"] == "" and not s["x"] and "search" not in s["layers"], f"{name} desktop: the X in the chips row still clears it ({s})")
        check(not errs, f"{name} desktop: no page errors {errs[:2]}")
        b.close()
    b = pw.chromium.launch(); ctx = b.new_context(user_agent=UA, viewport={"width": 390, "height": 844}, has_touch=True)
    page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e))); boot(page)
    page.tap("#q"); page.keyboard.type("hello"); preview.settle(page, 400)
    page.keyboard.press("Enter"); preview.settle(page, 200)
    check(not page.evaluate(S)["focused"], "phone: the keyboard's search key puts the keyboard away so the results show")
    k = page.evaluate("() => [...document.querySelectorAll('.t')][0]?.dataset.key")
    page.evaluate("(k) => window.mh.openThread(k)", k); preview.settle(page, 500)
    viewing = lambda: page.evaluate("() => document.querySelector('#app').classList.contains('viewing')")
    check(viewing(), "phone: a conversation opened from the results")
    check(page.evaluate("() => window.mh.back()") is True and not viewing() and page.evaluate(S)["search"] == "hello", "phone: back closes the conversation and keeps the results")
    preview.settle(page, 300)
    check(page.evaluate("() => window.mh.back()") is True and page.evaluate(S)["search"] == "" and page.evaluate(S)["q"] == "", "phone: back again clears the search, back to the plain list")
    preview.settle(page, 300)
    check(page.evaluate("() => window.mh.back()") is False, "phone: only then does back leave the app")
    page.tap("#q"); page.keyboard.type("hi"); preview.settle(page, 300)
    box = page.eval_on_selector("#qClear", "(b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }")
    check(box[0] >= 40 and box[1] >= 40, f"phone: the X is a full-size touch target ({box})")
    page.tap("#qClear"); preview.settle(page, 300)
    check(page.evaluate(S)["search"] == "", "phone: tapping the X clears it")
    check(not errs, f"phone: no page errors {errs[:2]}")
    b.close()
srv.shutdown()
print("all search-clear checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
