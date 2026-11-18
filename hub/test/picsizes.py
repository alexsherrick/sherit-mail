#!/usr/bin/env python3
"""The app's side of the picture sizes, on WebKit (the Mac app) and Chromium:
- every picture a mail shows is asked for at a size: w=1600 in a desktop window, w=1080 on a phone;
- a mail's first two pictures are asked for first (eager, high priority), the rest when scrolled to (lazy);
- the first four pictures of a mail being made ready are warmed into the device's cache from the hub, with x-warm: 1 so the hub never
  passes them to a sender, at the very URLs the frame will ask for, once each; none when the phone is saving data;
- the mock mail with a picture is warmed when the app makes it ready on its own (prerender), with no open;
- a received mail's pictures carry the day it was received (t, rounded down to the day), so the hub never fetches a picture of recent
  mail from its sender at an open; with no time (a sent mail), none.
CONTROL: APP_JS_SRC=<app.js before the change> fails the size, priority and warm checks.
Usage: python3 test/picsizes.py (exit 1 on any failed check)"""
import os, re, sys
from datetime import datetime, timezone
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

# every picture fetch the page makes, with its x-warm header; installed once the page is up, over the test's mock network
RECORD = """(() => { const f = window.fetch; window.__warm = []; window.fetch = function (u, o) { const h = (o && o.headers) || {}; const x = h["x-warm"] || (h.get && h.get("x-warm"));
  if (String(u).includes("/api/img?")) window.__warm.push({ u: String(u), warm: x || null }); return f.apply(this, arguments); }; })();"""
SAVE_DATA = "Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' }, configurable: true });"
HTML = "".join(f'<img src="https://cdn.example.com/p{i}.png" width="40" height="30">' for i in range(5)) + '<div style="background:url(https://cdn.example.com/bg.png)"></div>'
OUT = "(h) => { const o = window.mh.proxyImages(h, []); const d = document.createElement('div'); d.innerHTML = o; return { o, imgs: [...d.querySelectorAll('img')].map((i) => [i.getAttribute('src'), i.getAttribute('loading'), i.getAttribute('fetchpriority')]) }; }"

def ready(page):
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 600)

def run(b, name):
    ctx = b.new_context(viewport={"width": 1280, "height": 800}); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    ready(page)
    # the app fetches /api/img itself only to warm (a frame's <img> is not a fetch); the mock network logs every call it answers
    auto = page.evaluate("() => (window.__mock.calls || []).filter((c) => /\\/api\\/img\\?/.test(c))")
    check(any("x%2Fy.png" in u for u in auto) and page.evaluate("() => window.mh.state.cur") is None, f"{name}: the mock mail's picture is warmed when the app makes the mail ready, with no open ({len(auto)} warm-ups)")
    check(any("x%2Fy.png" in u and re.search(r"&t=\d+000(&|$)", u) for u in auto), f"{name}: the received mock mail's picture carries the day it was received ({[u[-40:] for u in auto][:1]})")
    tt = page.evaluate("(h) => [window.mh.proxyImages(h, [], [], Date.parse('2026-11-15T13:45:00Z')), window.mh.proxyImages(h, [], [], 0)]", HTML)
    day = "&t=" + str(int(datetime(2026, 11, 15, tzinfo=timezone.utc).timestamp() * 1000))
    check(tt[0].count(day) == 6 and "&t=" not in tt[1], f"{name}: pictures of a mail received 2026-11-15 13:45 UTC carry that day ({tt[0].count(day)} of 6); with no time, none")
    page.evaluate(RECORD)
    r = page.evaluate(OUT, HTML)
    check(all(s and s.endswith("&w=1600") for s, _, _ in r["imgs"]) and "&w=1600)" in r["o"], f"{name}: desktop pictures and backgrounds ask for 1600 px ({r['imgs'][0][0][-40:]})")
    lp = [(l, p) for _, l, p in r["imgs"]]
    check(lp[:2] == [("eager", "high")] * 2 and all(x == ("lazy", None) for x in lp[2:]), f"{name}: the first two are asked for first, the rest when scrolled to ({lp})")
    page.evaluate("() => { window.__warm.length = 0; }")
    page.evaluate("(o) => window.mh.warmPictures([o])", r["o"])
    preview.settle(page, 200); w = page.evaluate("() => window.__warm")
    want = [s for s, _, _ in r["imgs"]][:4]
    check([x["u"] for x in w] == want and all(x["warm"] == "1" for x in w), f"{name}: the first four are warmed, x-warm set, at the frame's own URLs ({len(w)} warm-ups)")
    page.evaluate("(o) => window.mh.warmPictures([o])", r["o"]); preview.settle(page, 100)
    check(len(page.evaluate("() => window.__warm")) == 4, f"{name}: and only once")
    check(not errs, f"{name}: no page errors {errs[:2]}"); ctx.close()
    # a phone, and a phone saving data
    touch = name == "chromium"
    ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=touch, has_touch=touch); ctx.add_init_script(SAVE_DATA); page = ctx.new_page(); ready(page); page.evaluate(RECORD)
    r = page.evaluate(OUT, HTML)
    check(all(s and s.endswith("&w=1080") for s, _, _ in r["imgs"]), f"{name} phone: pictures ask for 1080 px ({r['imgs'][0][0][-30:]})")
    page.evaluate("() => { window.__warm.length = 0; }"); page.evaluate("(o) => window.mh.warmPictures([o])", r["o"]); preview.settle(page, 200)
    check(page.evaluate("() => window.__warm.length") == 0, f"{name} phone: nothing is warmed while the phone saves data")
    ctx.close()

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        try: b = engine.launch()
        except Exception as e: check(False, f"{engine.name}: browser not installed ({str(e).splitlines()[0]})"); continue
        try: run(b, engine.name)
        except Exception as e: check(False, f"{engine.name}: the run stopped ({str(e).splitlines()[0]})")
        b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all picsizes checks passed")
sys.exit(1 if fails else 0)
