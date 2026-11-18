#!/usr/bin/env python3
"""The page's own row scan reads a quoted phrase as one term: the rows shown before the index answers, and wherever its
worker is unavailable. "hello there" lists only the conversation holding those words together; weekly news without quotes lists every
conversation holding both words in any of its fields; a half-typed quote still finds. CONTROL: APP_JS_SRC=<app.js before the change>
fails the phrase and the two-word checks. Usage: python3 test/phrase.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright
if os.environ.get("APP_JS_SRC"):
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
SCAN = """(q) => { const S = window.mh.state; S.search = q; S.searchHits = null; S.serverHitKeys = null; S.serverSearch = new Map(); return window.mh.visibleThreads().map((t) => t.subject).sort(); }"""
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 7", timeout=30000); preview.settle(page, 500)
    for q, want, m in [('"hello there"', ["Hello there"], "a quoted phrase lists only the conversation holding it"),
                       ('"there hello"', [], "the order counts"),
                       ("weekly news", ["Weekly", "Weekly digest"], "two bare words list every conversation holding both, in any field"),
                       ('"weekly digest"', ["Weekly digest"], "quoted, only the one holding them together"),
                       ('"hello there', ["Hello there"], "a quote still being typed finds as bare words")]:
        got = page.evaluate(SCAN, q); check(got == sorted(want), f"{q}: {m} ({got})")
    check(not errs, f"no page errors {errs[:2]}"); b.close()
print("all phrase scan checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
