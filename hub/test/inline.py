#!/usr/bin/env python3
"""Inline (cid:) images in Gmail mail, end to end in a real browser.

Reported 2026-09-18, twice: the inline images of a mail digest did not show. The USPS Informed Delivery
digest embeds its pictures as INLINE ATTACHMENTS; `<img alt="campaign" src="cid:mailer-1000000001.jpg">` with a matching
`Content-ID: <mailer-1000000001.jpg>` part (verified against the real message, Gmail id 18f0000000000001). Two separate defects
hid them:

  1. The Gmail adapter built attachments with no `url`, so proxyImages() had nothing to resolve a cid: reference TO and emitted
     an empty src. Fixed 2026-09-18 (commit 9318160).
  2. That fix did not reach mail already in the body cache. cachedThread() served the stale copy back verbatim, so a message
     cached BEFORE the fix stayed broken forever. The digest arrived 13:24Z and the fix deployed ~16:47Z, which is exactly why
     it "still" did not show. cachedThread() now refuses a cached body whose inline attachment carries no url.

Both are checked here, plus the control: a body that IS current must still be served from cache, or the fix would simply have
disabled the cache and called it a win. Usage: python3 test/inline.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

CID = "mailer-1000000001.jpg"            # a Content-ID shaped like the USPS digest's
URL = "/api/gmail/att/sam%40gmail.com/18f0000000000001/ANGjdAAAAAAAAA?mime=image%2Fjpeg"

with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 1200, "height": 900}); page = ctx.new_page(); page.goto(base)
    page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)

    # --- 1. proxyImages resolves a cid: reference through the attachment's url ---
    out = page.evaluate("""([cid, url]) => window.mh.proxyImages(
        '<img id="campaign-representative-image-src-id" alt="campaign" src="cid:' + cid + '">',
        [{ cid: '<' + cid + '>', url }])""", [CID, URL])
    check(URL in out, f"a cid: image resolves to its attachment url  ->  {out[:120]}")
    check("cid:" not in out, "and no raw cid: reference survives (the frame's CSP would block it and show alt text)")

    # the angle brackets on Content-ID must not defeat the match, and a miss must not emit a live remote URL
    out2 = page.evaluate("""([cid, url]) => window.mh.proxyImages('<img src="cid:' + cid + '">', [{ cid, url }])""", [CID, URL])
    check(URL in out2, "a Content-ID stored without angle brackets matches too")
    miss = page.evaluate("""() => window.mh.proxyImages('<img src="cid:nope@x">', [])""")
    check('src=""' in miss, f"an unresolvable cid: becomes an empty src rather than leaking anything  ->  {miss[:80]}")

    # --- 2. a body cached BEFORE attachments carried url must be refused, not served ---
    seed = """async ([cid, url, withUrl]) => {
        const key = 'gmail|t-usps';
        const att = { id: 'A1', name: 'mailer.jpg', cid: '<' + cid + '>' };
        if (withUrl) att.url = url;
        await window.mh.idb.putAll('bodies', [{ key: 'sam@gmail.com|m1', threadKey: key, id: 'm1', date: 1, at: Date.now(),
            m: { id: 'm1', date: 1, html: '<img src="cid:' + cid + '">', attachments: [att], unsub: '' } }]);
        const t = { key, kind: 'gmail', id: 't-usps', account: 'sam@gmail.com', count: 1, lastMsgId: 'm1', unsubKnown: true };
        const d = await window.mh.cachedThread(t);
        await window.mh.idb.delAll('bodies', ['sam@gmail.com|m1']);
        return d ? 'served' : 'refused';
    }"""
    check(page.evaluate(seed, [CID, URL, False]) == "refused",
          "a body cached before the fix (inline attachment, no url) is REFUSED, so the thread is refetched and the images appear")
    check(page.evaluate(seed, [CID, URL, True]) == "served",
          "CONTROL: a current body IS still served from cache — the guard did not just switch the body cache off")

    ctx.close(); b.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all inline-image checks passed")
sys.exit(1 if fails else 0)
