#!/usr/bin/env python3
"""On a phone, the undo toast and the confirm box sit above the bottom bar, not on it: WebKit and Chromium.

Reported 2026-10-20: in the Android app the undo toast after Trash or Done sat on the bottom bar, over Reply and the
other buttons. At phone width the inbox's search bar (61 px) and the conversation's action bar are pinned to the
bottom, and the toast sat 16 px up, entirely on them.

At 390 x 844, with a mouse (keyboard hints under the action bar's buttons: 80 px) and, in Chromium, as a touch phone like the
Android app (no hints: 58 px): Trash from a conversation's action bar, Done from an inbox row, and a confirm box over each; whichever
bar is showing, the toast (or the box) clears it by 8 to 16 px, and its Undo is still tappable. At a 1000 px Mac window, where no bar
is at the bottom, the toast stays 16 px from the bottom.
CONTROL: APP_HTML_SRC=<the app.html before the change> fails the phone checks. Usage: python3 test/toastclear.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_HTML_SRC"):   # the control: the same page built from another app.html
    preview.SHELL = Path(os.environ["APP_HTML_SRC"]).read_text().replace("__VERSION__", "test").replace(
        '<script src="/app.js?v=test"></script>', '<script src="/mock-fetch.js"></script><script src="/app.js"></script>')
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
CAPTURE = "() => { window.__rows = []; window.mh.queue.add = async (row) => { window.__rows.push(row); return { key: 'cap' + window.__rows.length }; }; }"
# what is at the bottom right now: the action bar under a conversation, the search bar under the inbox (only when pinned there)
GEOM = """(sel) => { const h = innerHeight, vis = (e) => e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
  const app = document.querySelector('#app'), bar = app.classList.contains('viewing') ? document.querySelector('#actions') : document.querySelector('.list .top');
  const pinned = vis(bar) && getComputedStyle(bar).position === 'fixed' ? bar.getBoundingClientRect() : null, e = document.querySelector(sel), r = e.getBoundingClientRect();
  return { shown: vis(e), bottom: Math.round(h - r.bottom), top: Math.round(h - r.top), bar: pinned ? Math.round(h - pinned.top) : 0, viewing: app.classList.contains('viewing') }; }"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
def clears(g, what):
    return (g["shown"] and g["bar"] + 8 <= g["bottom"] <= g["bar"] + 16,
            f"{what} sits {g['bottom']}-{g['top']} px up, the bar {g['bar']} px tall ({'conversation' if g['viewing'] else 'inbox'})")
def ready(page):
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    page.evaluate(CAPTURE)
    return page.evaluate("() => [...document.querySelectorAll('.t')].map((d) => d.dataset.key)")

def phone(b, name, label, touch):
    ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=touch, is_mobile=touch)
    page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    keys = ready(page); tag = f"{name} {label}"
    # a conversation's Trash, from its action bar
    page.evaluate("(k) => window.mh.openThread(k)", keys[0]); preview.settle(page, 500)
    page.evaluate("() => document.querySelector('#actions button[data-act=trash]').click()"); preview.settle(page, 300)
    ok, msg = clears(page.evaluate(GEOM, "#toast"), "the Trash toast"); check(ok, f"{tag}: {msg}")
    check(page.evaluate("() => !!document.querySelector('#toast button')"), f"{tag}: the toast offers Undo")
    page.evaluate("() => document.querySelector('#toast button').click()") if touch else page.click("#toast button")
    preview.settle(page, 300)
    n = len(page.evaluate("() => window.__rows")); check(n >= 2, f"{tag}: Undo where it now sits works ({n} queued)")
    # a confirm box over a conversation
    page.evaluate("(k) => window.mh.openThread(k)", keys[1]); preview.settle(page, 400)
    page.evaluate("() => { window.mh.ask('Delete these?'); }"); preview.settle(page, 200)
    ok, msg = clears(page.evaluate(GEOM, "#ask"), "the confirm box"); check(ok, f"{tag}: {msg}")
    page.keyboard.press("Escape"); preview.settle(page, 200)
    # the inbox: a row's Done (its quick button is hidden on a touch screen; the action is the same)
    page.evaluate("() => window.mh.back()"); preview.settle(page, 400)
    page.evaluate("(k) => document.querySelector(`.t[data-key=\"${k}\"] .quick [data-q=archive]`).click()", keys[2]); preview.settle(page, 300)
    ok, msg = clears(page.evaluate(GEOM, "#toast"), "the Done toast"); check(ok, f"{tag}: {msg}")
    page.evaluate("() => { window.mh.ask('Delete these?'); }"); preview.settle(page, 200)
    ok, msg = clears(page.evaluate(GEOM, "#ask"), "the confirm box"); check(ok, f"{tag}: {msg}")
    page.keyboard.press("Escape")
    check(not errs, f"{tag}: no page errors {errs[:2]}")
    ctx.close()

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        phone(b, name, "phone", False)
        if name == "chromium": phone(b, name, "touch phone", True)   # is_mobile is Chromium's; the Android app is Chromium
        # a Mac window: no bar at the bottom, the toast where it was
        page = b.new_page(viewport={"width": 1000, "height": 700}); keys = ready(page)
        page.evaluate("(k) => window.mh.openThread(k)", keys[0]); preview.settle(page, 400)
        page.evaluate("() => document.querySelector('#actions button[data-act=trash]').click()"); preview.settle(page, 300)
        g = page.evaluate(GEOM, "#toast")
        check(g["shown"] and g["bottom"] == 16 and g["bar"] == 0, f"{name} Mac window: the toast stays 16 px from the bottom ({g['bottom']} px, bar {g['bar']})")
        page.close()
        b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all toastclear checks passed")
sys.exit(1 if fails else 0)
