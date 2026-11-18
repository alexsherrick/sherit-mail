#!/usr/bin/env python3
"""A search typed in Trash or Spam looks there, and a search of all mail says when Trash or Spam has matches: on WebKit and Chromium.

Founder: a search started in the Trash folder should start from it. All mail leaves Trash
and Spam out (Gmail's default), so a search typed in Trash skipped the folder on screen.

Checks, per engine, on rows that arrive through the app's own hub sync (and two Gmail rows put in the store), typed into the box:
  - the empty box says "Search Trash" in Trash, "Search Spam" in Spam, "Search" in the Inbox;
  - typed in Trash: the box keeps "rocket", the query is "rocket in:trash", the Trash chip is lit, Trash is listed;
  - the hub and Gmail are asked "rocket in:trash"; one character typed asks no server;
  - an in: of its own typed in Trash is kept as typed (in:archive lists Archive);
  - All mail tapped there is all mail, and stays all mail as more is typed; cleared and typed again in Trash, it is Trash again;
  - typed in Spam: "rocket in:spam"; typed in the Inbox: all mail, as before;
  - a search of all mail with matches in Trash and Spam says so, and "Show them" makes it in:anywhere; with a match in Trash only and
    none listed, the empty list says so and "Show them" lists it (in:trash); a search with an in: never says it;
  - CONTROL: the app as released at 9c734dcf searches all mail from Trash, with no word of
    the Trash matches.
Usage: SEARCHFROM_CONTROL=<the released app.js earlier> python3 test/searchfrom.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright
import searchops as so   # its rows, server and boot (importing it does not run it: see the __main__ guard there)

CONTROL = Path(os.environ["SEARCHFROM_CONTROL"]) if os.environ.get("SEARCHFROM_CONTROL") else None   # preview.py reads argv[1] as its output folder
STATE = """() => { const S = window.mh.state; return { box: document.querySelector('#q').value, q: S.search, on: [...document.querySelectorAll('#chips [data-scope].on')].map((b) => b.textContent),
  rows: window.mh.visibleThreads().map((t) => t.subject).filter((s) => /^Rocket/.test(s)).map((s) => s.slice(7)).sort(), note: (document.querySelector('#threads .leftout') || {}).textContent || '',
  empty: (document.querySelector('#threads .empty') || {}).textContent || '' }; }"""

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def run(bundle, label, control=False):
    srv = so.server(bundle); base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as pw:
        for engine in ((pw.chromium,) if control else (pw.webkit, pw.chromium)):
            name = f"{engine.name}{' ' + label if label else ''}"
            b = engine.launch(); page = b.new_page(viewport={"width": 1100, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            so.boot(page, base)
            page.focus("#q")   # starts the device index; every row in it before the first query, so its answer is the whole one
            page.wait_for_function("() => { const st = window.mh.searchIndex.status; return st.ready && st.indexed >= window.mh.state.threads.size; }", timeout=30000)
            page.evaluate("() => document.querySelector('#q').blur()")
            st = lambda: page.evaluate(STATE)
            def go(v): page.evaluate("async ([v]) => { await window.mh.setView(v); }", [v]); preview.settle(page, 300)
            def typed(text): page.fill("#q", text); preview.settle(page, 500); return st()
            def clear(): page.focus("#q"); page.keyboard.press("Escape"); preview.settle(page, 300)   # Esc in the box: clearSearch, as a person clears it
            if control:
                go("trash"); s = typed("rocket")
                check(s["q"] == "rocket" and "trashed" not in s["rows"] and not s["note"], f"{name}: CONTROL — the app at 9c734dcf searches all mail from Trash, Trash left out, no note ({s})")
                b.close(); continue
            go("trash"); ph_t = page.evaluate("() => document.querySelector('#q').placeholder")
            go("spam"); ph_s = page.evaluate("() => document.querySelector('#q').placeholder")
            go("inbox"); ph_i = page.evaluate("() => document.querySelector('#q').placeholder")
            check((ph_t, ph_s, ph_i) == ("Search Trash", "Search Spam", "Search"), f"{name}: the empty box says where it will look ({ph_t!r}, {ph_s!r}, {ph_i!r})")
            go("trash"); n0 = len(page.evaluate("() => window.__mock.calls"))
            typed("r"); preview.settle(page, 1000)
            one = page.evaluate("([n]) => window.__mock.calls.slice(n).filter((c) => /[?&]q=/.test(c))", [n0])
            check(one == [], f"{name}: one character typed in Trash asks no server ({one[:2]})")
            s = typed("rocket"); preview.settle(page, 1300)
            check(s["box"] == "rocket" and s["q"] == "rocket in:trash" and s["on"] == ["Trash"] and s["rows"] == ["binned", "trashed"],
                  f"{name}: typed in Trash, \"rocket\" looks in Trash, its chip lit, the box as typed ({s})")
            calls = page.evaluate("([n]) => window.__mock.calls.slice(n).filter((c) => /[?&]q=/.test(c))", [n0])
            want = page.evaluate("() => encodeURIComponent('rocket in:trash')")
            check(any(c.startswith("GET /api/threads?limit=200&box=all&q=" + want) for c in calls) and any(c.startswith(f"GET gmail:messages?maxResults=40&q={want}") for c in calls),
                  f"{name}: the hub and Gmail are asked \"rocket in:trash\" ({calls[:3]})")
            s = typed("rocket in:archive")
            check(s["q"] == "rocket in:archive" and s["rows"] == ["archived", "sent"], f"{name}: an in: typed in Trash is kept as typed ({s})")
            s = typed("rocket"); page.click('#chips [data-scope=""]'); preview.settle(page, 500); s = st()
            check(s["box"] == "rocket" and s["q"] == "rocket" and s["on"] == ["All mail"] and s["rows"] == so.ALL, f"{name}: All mail tapped in Trash is all mail ({s})")
            s = typed("rocket launch")
            check(s["q"] == "rocket launch" and s["on"] == ["All mail"], f"{name}: … and stays all mail as more is typed ({s})")
            check("Some messages in Trash and Spam match your search" in s["note"], f"{name}: … and says Trash and Spam have matches ({s['note']!r})")
            clear(); s = typed("rocket")
            check(s["q"] == "rocket in:trash" and s["on"] == ["Trash"], f"{name}: cleared and typed again in Trash, it is Trash again ({s})")
            clear(); go("spam"); s = typed("rocket")
            check(s["q"] == "rocket in:spam" and s["rows"] == ["spam"] and s["on"] == ["Spam"], f"{name}: typed in Spam, it looks in Spam ({s})")
            clear(); go("inbox"); s = typed("rocket")
            check(s["q"] == "rocket" and s["rows"] == so.ALL and s["on"] == ["All mail"], f"{name}: typed in the Inbox, all mail as before ({s})")
            check("Some messages in Trash and Spam match your search" in s["note"], f"{name}: … the footer says Trash and Spam have matches ({s['note']!r})")
            page.click("#threads .leftout button"); preview.settle(page, 500); s = st()
            check(s["box"] == "rocket in:anywhere" and s["q"] == "rocket in:anywhere" and "trashed" in s["rows"] and "spam" in s["rows"] and not s["note"],
                  f"{name}: \"Show them\" searches everywhere, and the note is gone ({s})")
            clear(); s = typed("trashed")
            check(s["rows"] == [] and "Nothing here" in s["empty"] and "Some messages in Trash match your search" in s["note"], f"{name}: no match listed, one in Trash: the empty list says so ({s})")
            page.click("#threads .leftout button"); preview.settle(page, 500); s = st()
            check(s["q"] == "trashed in:trash" and s["rows"] == ["trashed"], f"{name}: … and \"Show them\" lists it ({s})")
            s = typed("rocket in:inbox")
            check(not s["note"], f"{name}: a search with an in: never says it ({s['note']!r})")
            clear(); s = typed("inbox")
            check(not s["note"], f"{name}: nothing in Trash or Spam matches, no note ({s['note']!r})")
            check(not errs, f"{name}: no page errors {errs[:2]}")
            b.close()
    srv.shutdown()

if __name__ == "__main__":
    run(preview.BUNDLE, "")
    if CONTROL: run(CONTROL.read_text(), "(control)", control=True)
    else: print("(no control bundle given: pass the app as released before this change)")
    print(f"{len(fails)} failed" if fails else "all search-from checks passed")
    sys.exit(1 if fails else 0)
