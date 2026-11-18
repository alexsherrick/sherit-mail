#!/usr/bin/env python3
"""A notification's conversation opens on top of whatever was open, and back keeps working: WebKit and Chromium.

A PDF preview stayed on screen over the conversation a notification opened. Opening a conversation from a
notification (window.mh.openUrl, as the Android and Mac apps call it) closed only the side menu and the reply sheet, so the file
preview or Settings stayed over the new conversation; and the account switch closed the old conversation under them, leaving a closed
("spent") layer at the bottom of the back stack that every later lookup of "thread" found first, so back and the Back chevron did
nothing until the app restarted.

At a phone and a Mac window width, with conversation A open and then each of: the file preview, Settings, the side menu (phone), a
confirm sheet, a text prompt card, an empty composer, a composer with a message in it; a notification opens conversation B:
  - B is the open conversation and is on screen; everything that was over it is closed, except the composer with a message, which
    stays on top with B beneath it (its first back closes the composer and shows B);
  - every back press that says it handled something changes what is on screen, until the inbox list is back with nothing over it;
  - the Back chevron closes B (preview case);
and, without a notification, a conversation opened after the account switch closed one under the preview: back is never a no-op.
CONTROL: APP_JS_SRC=<the app.js before the change> fails the overlay and back checks. Usage: python3 test/openover.py"""
import os, sys, base64
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"

STATE = """() => { const on = (s) => !!document.querySelector(s) && document.querySelector(s).classList.contains('on'); const app = document.querySelector('#app');
  return { viewing: app.classList.contains('viewing'), menu: app.classList.contains('menu'), preview: on('#avmodal'), settings: on('#smodal'), compose: on('#cmodal'),
    card: on('#tmodal'), sheet: on('#ask'), cur: window.mh.state.cur }; }"""
FILES = "[{ id: 'x-txt', name: 'notes.txt', mime: 'text/plain', size: 5, url: '/api/att/x-txt' }]"
OVERLAYS = {
    "preview":       f"(k) => window.mh.attOpen(window.mh.state.threads.get(k), {FILES}, 0)",
    "settings":      "() => window.mh.openSettings()",
    "menu":          "() => document.querySelector('#menuBtn').click()",
    "confirm sheet": "() => { window.__ans = 'pending'; window.mh.ask('Delete these?').then((v) => { window.__ans = v; }); }",
    "prompt card":   "() => { window.__ans = 'pending'; window.mh.askText('Name it').then((v) => { window.__ans = v; }); }",
    "empty composer": "() => document.querySelector('#composeBtn').click()",
    "composer with a message": "() => { document.querySelector('#composeBtn').click(); document.querySelector('#csub').value = 'Lunch'; document.querySelector('#ctext').value = 'See you at noon'; }",
}
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
VISIBLE = ("viewing", "menu", "preview", "settings", "compose", "card", "sheet")
def unwind(page, tag, keep_b=None):
    """Back until the app says there is nothing left; every handled press must change what is on screen."""
    seen, dead = [], 0
    for _ in range(8):
        before = page.evaluate(STATE); handled = page.evaluate("() => window.mh.back()"); preview.settle(page, 350); after = page.evaluate(STATE)
        seen.append(after)
        if not handled: break
        if all(before[k] == after[k] for k in VISIBLE): dead += 1
    end = seen[-1]
    check(dead == 0, f"{tag}: no back press is a no-op ({dead} did nothing)")
    check(not end["viewing"] and not any(end[k] for k in VISIBLE), f"{tag}: back ends at the inbox list with nothing over it ({ {k: end[k] for k in VISIBLE if end[k]} })")
    return seen

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        for label, vp in (("phone", {"width": 390, "height": 844}), ("Mac window", {"width": 1000, "height": 700})):
            for ov, js in OVERLAYS.items():
                if ov == "menu" and label != "phone": continue   # the side menu is a sheet only on a phone
                tag = f"{name} {label} {ov}"
                page = b.new_page(viewport=vp); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
                page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
                page.evaluate("(b64) => { window.__mock.routes['GET /api/att/x-txt'] = { __b64: b64 }; }", base64.b64encode(b"notes").decode())
                keys = page.evaluate("() => [...document.querySelectorAll('.t')].map((d) => d.dataset.key)")
                a, bk = keys[0], keys[1]; acc, th = bk.split("|", 1)
                page.evaluate("(k) => window.mh.openThread(k)", a); preview.settle(page, 400)
                page.evaluate(js, a); preview.settle(page, 500)
                opened = page.evaluate(STATE)
                page.evaluate("(u) => window.mh.openUrl(u)", f"/?account={acc}&thread={th}"); preview.settle(page, 900)
                s = page.evaluate(STATE)
                kept = ov == "composer with a message"
                check(s["cur"] == bk and s["viewing"], f"{tag}: the notification's conversation is the open one (cur {s['cur']})")
                over = {k: s[k] for k in ("menu", "preview", "settings", "card", "sheet") if s[k]}
                check(not over, f"{tag}: nothing is left over it (opened {[k for k in VISIBLE if opened[k] and k != 'viewing']}, left {list(over)})")
                check(s["compose"] == kept, f"{tag}: the composer is {'kept' if kept else 'closed'} (compose on: {s['compose']})")
                if ov in ("confirm sheet", "prompt card"):
                    ans = page.evaluate("() => window.__ans")
                    check(ans in (False, None), f"{tag}: the dialog was cancelled, its safe answer ({ans!r})")
                if kept:
                    page.evaluate("() => window.mh.back()"); preview.settle(page, 350); s1 = page.evaluate(STATE)
                    check(not s1["compose"] and s1["viewing"] and s1["cur"] == bk, f"{tag}: back closes the composer and shows the conversation beneath it")
                unwind(page, tag)
                check(not errs, f"{tag}: no page errors {errs[:2]}")
                page.close()
            # the Back chevron after a notification over the preview
            tag = f"{name} {label} chevron"
            page = b.new_page(viewport=vp)
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
            page.evaluate("(b64) => { window.__mock.routes['GET /api/att/x-txt'] = { __b64: b64 }; }", base64.b64encode(b"notes").decode())
            keys = page.evaluate("() => [...document.querySelectorAll('.t')].map((d) => d.dataset.key)"); a, bk = keys[0], keys[1]; acc, th = bk.split("|", 1)
            page.evaluate("(k) => window.mh.openThread(k)", a); preview.settle(page, 400); page.evaluate(OVERLAYS["preview"], a); preview.settle(page, 400)
            page.evaluate("(u) => window.mh.openUrl(u)", f"/?account={acc}&thread={th}"); preview.settle(page, 900)
            if label == "phone":   # on a phone the list and the conversation share the screen, so the chevron is what closes it
                page.evaluate("() => document.querySelector('#back').click()"); preview.settle(page, 400)
                check(not page.evaluate(STATE)["viewing"], f"{tag}: the Back chevron closes the conversation")
            page.close()
            # no notification: a conversation opened after the account switch closed the old one under the preview
            tag = f"{name} {label} buried layer"
            page = b.new_page(viewport=vp)
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
            page.evaluate("(b64) => { window.__mock.routes['GET /api/att/x-txt'] = { __b64: b64 }; }", base64.b64encode(b"notes").decode())
            keys = page.evaluate("() => [...document.querySelectorAll('.t')].map((d) => d.dataset.key)"); a, bk = keys[0], keys[1]; acc = bk.split("|", 1)[0]
            page.evaluate("(k) => window.mh.openThread(k)", a); preview.settle(page, 400); page.evaluate(OVERLAYS["preview"], a); preview.settle(page, 400)
            page.evaluate("(acc) => window.mh.setView('inbox', acc)", acc); preview.settle(page, 300)
            page.evaluate("(k) => window.mh.openThread(k)", bk); preview.settle(page, 500)
            unwind(page, tag)
            page.close()
        b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all openover checks passed")
sys.exit(1 if fails else 0)
