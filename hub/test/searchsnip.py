#!/usr/bin/env python3
"""A search's preview line reads the way the mail does. The search index kept a mail's HTML with its tags gone but its
comments' contents read as words and its entities left encoded, so a newsletter built for Outlook (<!--[if mso]>...
<o:PixelsPerInch>96</o:PixelsPerInch>... <![endif]--> and <!--<![endif]-->) was previewed in a search as
"&lt;!-- 96 &lt;!-- Join us at...". In Chromium, with the app's own search worker (SQLite FTS5 in the page):
  - a cached body in that shape is indexed without its comments and with its entities read ("&amp;" is "&");
  - a search for it previews its first words, with no "<!--", no "&lt;" and no word from inside a comment;
  - an unclosed comment hides what follows it, as the browser does, and keeps what came before;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> plus that commit's search.js fails the preview checks.
Usage: python3 test/searchsnip.py"""
import os, sys, subprocess
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):
    search = os.environ.get("SEARCH_JS_SRC")
    preview.BUNDLE = "\n".join((Path(search).read_text() if (f == "search.js" and search) else (preview.CLIENT / f).read_text()) for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
MJML = ('<!doctype html><html><head><title></title><!--[if !mso]><!--><meta http-equiv="X-UA-Compatible" content="IE=edge"><!--<![endif]-->'
        '<style>#outlook a{padding:0}</style><!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch>'
        '</o:OfficeDocumentSettings></xml></noscript><![endif]--></head><body><!--[if mso | IE]><table><tr><td>outlookonlyword<![endif]-->'
        '<div>Quarterly trivia night &amp; potluck at the hall</div><p>Bring a dish to share.</p></body></html>')
CUT = '<div>Before the cut zebrastripe</div><!-- an unclosed comment <div>hiddenword after</div>'
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    page.evaluate("() => window.mh.ensureSearch()")
    page.wait_for_function("() => window.mh.searchIndex.status.ready", timeout=30000)
    # two conversations of their own: the body backfill that starts with search re-indexes the fixture's cached ones
    keys = ["hub|snip-test-1", "hub|snip-test-2"]
    page.evaluate("""([k1, k2, mjml, cut]) => { const t = (key, subject) => ({ key, kind: 'hub', account: 'hub', subject, fromName: 'Hall', fromAddr: 'news@hall.example', date: Date.now() });
      window.mh.searchIndex.indexBodies(t(k1, 'Trivia'), [{ id: 'x1', html: mjml, text: '' }].map(tagSafeMsg));
      window.mh.searchIndex.indexBodies(t(k2, 'Cut'), [{ id: 'x2', html: cut, text: '' }].map(tagSafeMsg));
      return window.mh.searchIndex.flush(); }""", [keys[0], keys[1], MJML, CUT])
    page.wait_for_timeout(600)
    hit = page.evaluate("async () => (await window.mh.searchIndex.query('potluck')) || []")
    snip = (hit[0] or {}).get("snip", "") if hit else ""
    check(bool(hit) and hit[0]["key"] == keys[0], f"the newsletter is found by a word of its body ({len(hit)} hit)")
    check("<!--" not in snip and "&lt;" not in snip and "&amp;" not in snip and "96" not in snip and "&" in snip, f"its preview is its own words, entities read, nothing from a comment ({snip!r})")
    inside = page.evaluate("async () => ((await window.mh.searchIndex.query('outlookonlyword')) || []).length")
    check(inside == 0, f"a word inside an Outlook-only comment is not indexed ({inside} hits)")
    before = page.evaluate("async () => ((await window.mh.searchIndex.query('zebrastripe')) || []).length")
    after = page.evaluate("async () => ((await window.mh.searchIndex.query('hiddenword')) || []).length")
    check(before == 1 and after == 0, f"an unclosed comment hides what follows it and keeps what came before ({before} before, {after} after)")
    check(not errs, f"no page errors {errs[:2]}")
    b.close()
print(f"{len(fails)} failed" if fails else "all search-preview checks passed")
sys.exit(1 if fails else 0)
