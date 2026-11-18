#!/usr/bin/env python3
"""A toast button the hub has carried out shows in the page at once, and is not sent again (window.mh.actedElsewhere, called by the
Windows app once /api/notify/act answers): WebKit and Chromium.

Trash on a Windows notification looked as if it had not worked. The hub had trashed both mails (events notify_act
17:00:30 and 17:05:32); the open window kept them, the open one on screen, until its next minute's poll.

  - Trash on the open domain conversation: it is trashed here, gone from the list, and the conversation closes;
  - Done on a Gmail conversation: archived and read, gone from the list;
  - Mark read: read, still in the list;
  - Snooze: gone from the inbox;
  - none of them sends anything (no request, nothing queued);
  - a conversation not in the page, or Stop these, changes nothing.
CONTROL: APP_JS_SRC=<the app.js before the change> fails the first check. Usage: python3 test/notifyact.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
G = "sam.owner.sxsw@gmail.com|"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1000, "height": 700}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.has('sam.owner.sxsw@gmail.com|g3')", timeout=30000); preview.settle(page, 1200)
        a = page.evaluate("() => [...window.mh.state.threads.values()].find((x) => x.kind === 'hub' && !x.out && x.state === 'inbox').key")
        page.evaluate("(k) => window.mh.openThread(k)", a); preview.settle(page, 600)
        before = page.evaluate("() => window.__mock.calls.length")
        listed = lambda k: page.evaluate("(k) => !!document.querySelector(`#threads .t[data-key=\"${k}\"]`)", k)
        t = lambda k: page.evaluate("(k) => { const t = window.mh.state.threads.get(k); return t && { state: t.state, unread: !!t.unread }; }", k)
        ok = page.evaluate("([k]) => window.mh.actedElsewhere ? window.mh.actedElsewhere(k, 'trash') : 'missing'", [a]); preview.settle(page, 400)
        s = page.evaluate("() => [window.mh.state.cur, document.querySelector('#app').classList.contains('viewing')]")
        check(ok is True and t(a)["state"] == "trash" and not listed(a), f"{name}: Trash from a toast trashes the domain conversation here and takes it off the list ({ok}, {t(a)}, listed {listed(a)})")
        check(s == [None, False], f"{name}: and the open conversation closes ({s})")
        page.evaluate("([k]) => window.mh.actedElsewhere(k, 'done')", [G + "g2"]); preview.settle(page, 300)
        check(t(G + "g2") == {"state": "archived", "unread": False} and not listed(G + "g2"), f"{name}: Done on a Gmail conversation: archived, read, off the list ({t(G + 'g2')})")
        page.evaluate("([k]) => window.mh.actedElsewhere(k, 'read')", [G + "g1"]); preview.settle(page, 300)
        check(t(G + "g1")["unread"] is False and listed(G + "g1"), f"{name}: Mark read: read, and still in the list ({t(G + 'g1')}, listed {listed(G + 'g1')})")
        page.evaluate("([k]) => window.mh.actedElsewhere(k, 'snooze')", [G + "g3"]); preview.settle(page, 300)
        check(not listed(G + "g3"), f"{name}: Snooze: off the inbox ({t(G + 'g3')})")
        none = page.evaluate("([k]) => [window.mh.actedElsewhere('hub|nope', 'trash'), window.mh.actedElsewhere(k, 'quiet')]", [G + "g1"])
        check(none == [False, False], f"{name}: a conversation not in the page, or Stop these, changes nothing ({none})")
        preview.settle(page, 800)
        sent = page.evaluate("(n) => window.__mock.calls.slice(n).filter((c) => !c.startsWith('GET '))", before)
        pending = page.evaluate("() => window.mh.queue.pending().length")
        check(not sent and pending == 0, f"{name}: nothing is sent again: the hub has done it ({sent[:4]}, {pending} queued)")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print("all notification-action checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
