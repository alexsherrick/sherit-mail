#!/usr/bin/env python3
"""Launch-path receipts: what a cold open must NOT pay for. The FTS5 search engine is 628 KB of
sqlite3.mjs plus a wasm compile, and it used to start on every launch and index every cached thread (1,497 of them on my 
phone) competing for the same main thread as the interactions that measured act:trash 365 ms. Both councils
 flagged it. It now starts when search is actually reached, which is early enough:
focusing the box happens well before a query exists. Usage: python3 test/launch.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0,"test")
import preview
from playwright.sync_api import sync_playwright
srv=preview.serve(); base=f"http://127.0.0.1:{srv.server_address[1]}/"
UA="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36"
fails=[]
def check(c,m):
    print(("ok   " if c else "FAIL ")+m); (c or fails.append(m))
with sync_playwright() as pw:
    b=pw.chromium.launch(); ctx=b.new_context(user_agent=UA,viewport={"width":390,"height":844},has_touch=True)
    page=ctx.new_page()
    got=[]
    page.on("request", lambda r: got.append(r.url.split("/")[-1].split("?")[0]))
    page.goto(base)
    page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
    preview.settle(page, 4000)
    boot = list(got)
    check("sqlite3.mjs" not in boot, f"the 628 KB SQLite engine is NOT fetched on launch (boot fetched: {[x for x in boot if 'sqlite' in x or 'search' in x] or 'neither'})")
    check("search.worker.js" not in boot, "nor is the search worker started")
    got.clear()
    page.evaluate("() => document.querySelector('#q').focus()")
    preview.settle(page, 3500)
    after = list(got)
    check(any("search.worker" in x for x in after), f"focusing the search box starts it ({[x for x in after if 'sqlite' in x or 'search' in x]})")
    ctx.close(); b.close()
srv.shutdown()
print(("FAILED: "+"; ".join(fails)) if fails else "all deferral checks passed")
sys.exit(1 if fails else 0)
