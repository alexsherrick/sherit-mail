#!/usr/bin/env python3
"""A muted conversation brought back to the inbox by hand stays there; only newer mail puts it away again (finding 584464c45a,
Done 2026-10-21). The mute's stamp stayed at the moment of muting, so every refresh found the
conversation "newer than the mute" and archived it again, however often the user moved it back. Chromium, the fake network: the
server keeps answering "inbox" for the conversation, which is what a hand un-archive in Gmail looks like to the app.
CONTROL: APP_JS_SRC=<the app.js before the change> fails the second check. Usage: python3 test/mute.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright
if os.environ.get("APP_JS_SRC"):
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_context(viewport={"width": 1400, "height": 860}).new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    k = page.evaluate("() => [...window.mh.state.threads.values()].find((t) => t.kind === 'hub' && t.state === 'inbox' && !t.out)?.key")
    page.evaluate("(k) => { const t = window.mh.state.threads.get(k), p = window.mh.state.prefs; p.muted = [k]; p.mutedAt = { [k]: (t.date || 0) - 60000 }; }", k)
    st = lambda: page.evaluate("(k) => window.mh.state.threads.get(k)?.state", k)
    page.evaluate("() => window.mh.refresh({ silent: true })"); preview.settle(page, 1500)
    check(st() == "archived", f"a muted conversation with mail newer than the mute is put away ({st()})")
    page.evaluate("(k) => { window.mh.state.threads.get(k).state = 'inbox'; }", k)   # brought back by hand
    page.evaluate("() => window.mh.refresh({ silent: true })"); preview.settle(page, 1500)
    check(st() == "inbox", f"brought back by hand, it stays in the inbox on the next refresh ({st()})")
    page.evaluate("(k) => { window.mh.state.threads.get(k).date += 3600e3; }", k)   # a new reply arrives
    page.evaluate("() => window.mh.refresh({ silent: true })"); preview.settle(page, 1500)
    check(st() == "archived", f"a newer reply puts it away again, which is what a mute is for ({st()})")
    check(not errs, f"no page errors {errs[:2]}")
    b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all mute checks passed")
sys.exit(1 if fails else 0)
