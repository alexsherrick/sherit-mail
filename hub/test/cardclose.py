#!/usr/bin/env python3
"""Escape, back and a click on the backdrop close the open card: the command palette, the snooze times, a prompt.

Reported 2026-10-20, in the Mac app: the command palette opened from its corner button could not be escaped or clicked away. The card (#tmodal) had no
backdrop click at all, and once the palette's box lost the focus (a click anywhere on or around the card) Escape went to the back
stack: it closed the conversation under the card and left the card up. The snooze card and other cards had no Escape of their own
either, and Android's back (window.mh.back) closed the conversation under them the same way.

WebKit and Chromium, a 1400 x 860 Mac window:
  - the palette opened from its button: Escape closes it; a click on the backdrop closes it; a click inside the card keeps it, and
    Escape then closes it; a text selection dragged from its box out to the backdrop keeps it; it opens again with Cmd+K and still
    runs a command;
  - with a conversation open, each of those closes the palette and leaves the conversation open, and so does Escape on the snooze card;
  - a prompt closed from the backdrop answers "cancelled" (null);
and at 390 x 844, a conversation with its snooze card open: back closes the card and says it did, the conversation stays; the next
back closes the conversation.
CONTROL: APP_JS_SRC=<the app.js before the change> fails the backdrop, focus-away Escape and back checks. Usage: python3 test/cardclose.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
STATE = """() => ({ card: document.querySelector('#tmodal').classList.contains('on'), viewing: document.querySelector('#app').classList.contains('viewing'),
  layers: window.mh.layers.filter((l) => !l.spent).map((l) => l.name), focus: document.activeElement.id, view: window.mh.state.view.kind })"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
def ready(page):
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    return page.evaluate("() => [...document.querySelectorAll('.t')].map((d) => d.dataset.key)")
def st(page): preview.settle(page, 200); return page.evaluate(STATE)
def palette(page):
    # a card the last step could not close covers the button (the bug itself): take it down by hand so the control runs to the end
    page.evaluate("() => document.querySelector('#tmodal').classList.remove('on')")
    page.click("#paletteBtn"); s = st(page); return s["card"] and s["focus"] == "pq"
def card_box(page): return page.evaluate("() => { const r = document.querySelector('#tcard').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }")
def backdrop(page): page.mouse.click(20, 840)   # outside the card, which is centred and at most 420 px wide
def inside(page): b = card_box(page); page.mouse.click(b["l"] + 4, b["t"] + 4)   # the card's own padding, not its box

def mac(b, name):
    page = b.new_page(viewport={"width": 1400, "height": 860}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    keys = ready(page)
    check(palette(page), f"{name}: the palette button opens the palette with the focus in its box")
    page.keyboard.press("Escape"); check(not st(page)["card"], f"{name}: Escape closes it")
    palette(page); backdrop(page); check(not st(page)["card"], f"{name}: a click on the backdrop closes it")
    palette(page); inside(page); s = st(page); check(s["card"] and s["focus"] != "pq", f"{name}: a click inside the card keeps it ({s['focus'] or 'body'} has the focus)")
    page.keyboard.press("Escape"); check(not st(page)["card"], f"{name}: Escape closes it with the focus off its box")
    palette(page); page.keyboard.type("go to"); bx = page.evaluate("() => { const r = document.querySelector('#pq').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; }")
    page.mouse.move(*bx); page.mouse.down(); page.mouse.move(200, 800, steps=6); page.mouse.move(20, 840, steps=4); page.mouse.up()
    check(st(page)["card"], f"{name}: a selection dragged from its box out to the backdrop keeps it")
    page.keyboard.press("Escape"); st(page)
    page.keyboard.press("Meta+k"); s = st(page); check(s["card"] and s["focus"] == "pq", f"{name}: Cmd+K opens it again")
    page.keyboard.type("go to sent"); page.keyboard.press("Enter"); s = st(page); check(not s["card"] and s["view"] == "sent", f"{name}: it still runs a command ({s['view']})")
    page.evaluate("() => window.mh.setView('inbox')"); preview.settle(page, 300)
    # over a conversation: the card closes, the conversation stays
    for how, close in [("Escape in its box", lambda: page.keyboard.press("Escape")), ("Escape after a click inside it", lambda: (inside(page), page.keyboard.press("Escape"))),
                       ("a click on the backdrop", lambda: backdrop(page))]:
        page.evaluate("(k) => window.mh.openThread(k)", keys[0]); preview.settle(page, 400); palette(page); close(); s = st(page)
        check(not s["card"] and s["viewing"] and s["layers"] == ["thread"], f"{name}: over a conversation, {how} closes the palette and leaves the conversation open {s}")
    page.evaluate("() => document.querySelector('#actions button[data-act=snooze]').click()"); s = st(page)
    check(s["card"], f"{name}: the snooze card opens over the conversation")
    page.keyboard.press("Escape"); s = st(page)
    check(not s["card"] and s["viewing"] and s["layers"] == ["thread"], f"{name}: Escape closes the snooze card and leaves the conversation open {s}")
    page.evaluate("() => { window.__ans = 'pending'; window.mh.askText('Name it').then((v) => { window.__ans = v; }); }"); st(page); backdrop(page); s = st(page)
    ans = page.evaluate("() => window.__ans")
    check(not s["card"] and ans is None and s["layers"] == ["thread"], f"{name}: a prompt closed from the backdrop answers cancelled ({ans!r}) {s}")
    check(not errs, f"{name}: no page errors {errs[:2]}")
    page.close()

def phone(b, name):
    ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=name == "chromium", is_mobile=name == "chromium")
    page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    keys = ready(page); page.evaluate("(k) => window.mh.openThread(k)", keys[0]); preview.settle(page, 400)
    page.evaluate("() => document.querySelector('#actions button[data-act=snooze]').click()"); s = st(page)
    check(s["card"] and s["viewing"], f"{name} phone: the snooze card opens over the conversation")
    r = page.evaluate("() => window.mh.back()"); s = st(page)
    check(r is True and not s["card"] and s["viewing"] and s["layers"] == ["thread"], f"{name} phone: back closes the card and says so ({r}), the conversation stays {s}")
    r = page.evaluate("() => window.mh.back()"); s = st(page)
    check(r is True and not s["viewing"] and s["layers"] == [], f"{name} phone: the next back closes the conversation ({r}) {s}")
    check(not errs, f"{name} phone: no page errors {errs[:2]}")
    ctx.close()

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        try: b = engine.launch()
        except Exception as e: check(False, f"{engine.name}: browser not installed ({str(e).splitlines()[0]})"); continue
        mac(b, engine.name); phone(b, engine.name); b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all cardclose checks passed")
sys.exit(1 if fails else 0)
