#!/usr/bin/env python3
"""Drag to select, on WebKit (the Mac app) and Chromium, with a mouse, in a list of 60 conversations:
- pressed on the fifth row and dragged up to the first, the five rows are selected, the selection bar says so, no text is
  highlighted and nothing opens; a double-click selects no text either;
- dragged down and back up in one press, the selection shrinks with it; a new drag replaces the selection, a ⌘-drag adds to it;
- held below the list's bottom edge, the list scrolls and the selection grows past the rows that were on screen;
- a plain click, and a click with a 3 px tremor, still open the conversation; shift-click with nothing checked selects from the open
  conversation to the one clicked.
CONTROL: APP_JS_SRC=<app.js before the change> APP_HTML_SRC=<app.html before it> fails the drag checks.
Usage: python3 test/dragselect.py (exit 1 on any failed check)"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js and app.html
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
if os.environ.get("APP_HTML_SRC"):
    N = preview.NONCE
    preview.SHELL = Path(os.environ["APP_HTML_SRC"]).read_text().replace("__VERSION__", "test").replace("__NONCE__", N).replace(
        f'<script nonce="{N}" src="/app.js?v=test"></script>', f'<script nonce="{N}" src="/mock-fetch.js"></script><script nonce="{N}" src="/app.js"></script>')
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

# 60 conversations in the inbox, one sender each, a minute apart; the mock's own go to Archive
SEED = """() => { const S = window.mh.state, all = [...S.threads.values()], h = all.find((t) => t.kind === 'hub' && !t.out);
  for (const t of all) t.state = 'archived';
  const now = Date.now(); for (let i = 0; i < 60; i++) { const id = 'dr' + String(i).padStart(2, '0'); S.threads.set('hub|' + id, { ...h, id, key: 'hub|' + id, state: 'inbox', unread: false, out: false, hasOut: false,
    date: now - 60000 * (i + 1), fromAddr: id + '@sender.example', fromName: 'Sender ' + id, subject: 'Subject ' + id, snippet: 'Snippet text ' + id, labels: [], cat: 'personal' }); }
  S.prefs.groupByDay = false; prerendered.clear(); window.mh.setView('inbox'); window.mh.render(); }"""
KEYS = "() => [...document.querySelectorAll('#threads .t[data-key]')].map((r) => r.dataset.key)"
STATE = """() => ({ checked: [...window.mh.state.checked].sort(), cur: window.mh.state.cur, text: String(getSelection()), selecting: document.querySelector('#app').classList.contains('selecting'),
  count: document.querySelector('#selcount')?.textContent || '', scroll: document.querySelector('#threads').scrollTop })"""

def mid(page, key):
    b = page.locator(f'#threads .t[data-key="{key}"]').bounding_box(); return b["x"] + b["width"] * 0.55, b["y"] + b["height"] / 2
def drag(page, pts, mod=None, hold=0):   # press at the first point, move through the rest in small steps, release at the last
    if mod: page.keyboard.down(mod)
    x, y = pts[0]; page.mouse.move(x, y); page.mouse.down()
    for (x1, y1) in pts[1:]:
        for i in range(1, 9): page.mouse.move(x + (x1 - x) * i / 8, y + (y1 - y) * i / 8); page.wait_for_timeout(16)
        x, y = x1, y1
    if hold: page.wait_for_timeout(hold)
    page.mouse.up(); preview.settle(page, 250)
    if mod: page.keyboard.up(mod)
    return page.evaluate(STATE)

def run(engine, name):
    b = engine.launch(); ctx = b.new_context(viewport={"width": 1280, "height": 760}); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 500)
    page.evaluate(SEED); preview.settle(page, 400); k = page.evaluate(KEYS)
    x, y = mid(page, k[8]); page.mouse.dblclick(x, y); preview.settle(page, 300); dbl = page.evaluate("() => String(getSelection())")
    check(dbl == "", f"{name}: a double-click on a row selects no text ({dbl[:30]!r})")
    page.evaluate("() => { window.mh.setView('inbox'); }"); preview.settle(page, 300)
    s = drag(page, [mid(page, k[4]), mid(page, k[0])])
    check(s["checked"] == sorted(k[:5]), f"{name}: dragged from the fifth row up to the first, the five are selected ({len(s['checked'])})")
    check(s["selecting"] and s["count"] == "5 selected", f"{name}: the selection bar says so ({s['count']!r})")
    check(s["text"] == "" and s["cur"] is None, f"{name}: no text highlighted and nothing opened ({s['text'][:40]!r}, {s['cur']})")
    s = drag(page, [mid(page, k[1]), mid(page, k[7]), mid(page, k[3])])
    check(s["checked"] == sorted(k[1:4]), f"{name}: down to the eighth and back to the fourth, rows two to four, and the earlier five are gone ({len(s['checked'])})")
    s = drag(page, [mid(page, k[9]), mid(page, k[11])], mod="Meta")
    check(s["checked"] == sorted(k[1:4] + k[9:12]), f"{name}: a ⌘-drag adds rows ten to twelve ({len(s['checked'])})")
    page.evaluate("() => { document.querySelector('#selbar [data-bulk=\"cancel\"]').click(); }"); preview.settle(page, 200)
    r = page.locator("#threads").bounding_box(); x0, y0 = mid(page, k[0]); on_screen = sum(1 for kk in k if (page.locator(f'#threads .t[data-key="{kk}"]').bounding_box() or {"y": 1e9})["y"] < r["y"] + r["height"])
    s = drag(page, [(x0, y0), (x0, r["y"] + r["height"] - 6)], hold=1200)
    check(s["scroll"] > 100 and len(s["checked"]) > on_screen, f"{name}: held at the bottom edge, the list scrolls ({s['scroll']:.0f} px) and the selection grows past the {on_screen} rows on screen ({len(s['checked'])})")
    check(s["checked"] == sorted(k[:len(s["checked"])]), f"{name}: and it is the run from the first row down, with no gap")
    page.evaluate("() => { document.querySelector('#selbar [data-bulk=\"cancel\"]').click(); document.querySelector('#threads').scrollTop = 0; }"); preview.settle(page, 300)
    x, y = mid(page, k[2]); page.mouse.click(x, y); preview.settle(page, 400)
    check(page.evaluate("() => window.mh.state.cur") == k[2], f"{name}: a plain click opens the conversation")
    page.evaluate("() => window.mh.closeThread ? window.mh.closeThread() : null"); preview.settle(page, 200)
    x, y = mid(page, k[3]); page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 1, y + 3); page.mouse.up(); preview.settle(page, 400)
    check(page.evaluate("() => window.mh.state.cur") == k[3], f"{name}: a click with a 3 px tremor still opens it")
    x, y = mid(page, k[6]); page.keyboard.down("Shift"); page.mouse.click(x, y); page.keyboard.up("Shift"); preview.settle(page, 300)
    s = page.evaluate(STATE)
    check(s["checked"] == sorted(k[3:7]), f"{name}: shift-click with nothing checked selects from the open conversation to the one clicked ({len(s['checked'])})")
    check(not errs, f"{name}: no page errors {errs[:2]}")
    b.close()

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        try: run(engine, engine.name)
        except Exception as e: check(False, f"{engine.name}: the run stopped ({str(e).splitlines()[0]})")
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all dragselect checks passed")
sys.exit(1 if fails else 0)
