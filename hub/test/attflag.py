#!/usr/bin/env python3
"""A conversation that carries a file says so (about a PDF that arrived on sam@yourdomain.example:
the list should show a small attachment mark). Hub rows hard-coded hasAtt false, so
domain mail never showed the list's paperclip, and in the message the only sign was the chip under the whole body. Covered here, in
WebKit (the Mac app) and Chromium:
- a hub conversation the hub marks has_att shows the paperclip in the list; one it does not mark shows none;
- the open message shows its file as a card above the text; a collapsed one shows the paperclip and count.
Usage: python3 test/attflag.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
WITH, WITHOUT = "hub|11111111-1111-1111-1111-111111111111", "hub|33333333-3333-3333-3333-333333333333"
CLIP = "(k) => !!document.querySelector(`.t[data-key=\"${k}\"] .sub .ic use[href=\"#i-attach\"]`)"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1280, "height": 900}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1200)
        check(page.evaluate("(k) => window.mh.state.threads.get(k)?.hasAtt === true", WITH), f"{name}: a hub conversation the hub marks has_att is a conversation with a file")
        check(page.evaluate(CLIP, WITH), f"{name}: and its list row shows the paperclip")
        check(not page.evaluate(CLIP, WITHOUT), f"{name}: a hub conversation without one shows none")
        page.evaluate("(k) => document.querySelector(`.t[data-key=\"${k}\"]`).click()", WITH)
        page.wait_for_function("() => document.querySelector('.m .h')", timeout=15000); preview.settle(page, 600)
        # An open message shows the file as a card directly under its header; a collapsed one shows the paperclip
        hdr = page.evaluate("() => { const m = document.querySelector('#msgs .m'), c = m.querySelector('.atts.files .att.card'), b = m.querySelector('.b'); return c ? { above: c.getBoundingClientRect().bottom <= b.getBoundingClientRect().top + 1, name: c.querySelector('.an').textContent } : null; }")
        check(bool(hdr) and hdr["above"] and hdr["name"] == "f.pdf", f"{name}: the open message shows its file as a card above the text ({hdr})")
        chip = page.evaluate("() => [...document.querySelectorAll('.m .atts a, .m .atts button')].map((x) => x.textContent.trim())")
        check(any("f.pdf" in c for c in chip), f"{name}: and the file's chip ({chip})")
        # the header counts files only: a part the body shows is not one (the same rule as the hub's has_att)
        H = """(m) => { const d = document.createElement('div'); d.innerHTML = window.mh.messageHtml(Object.assign({ id: 'x', from: 'a', to: 'b', date: 0, text: '', out: false }, m), 3, 4); const s = d.querySelector('.hasatt'); return s ? s.getAttribute('aria-label') : null; }"""
        img = '<p>hi <img src="cid:logo@x"></p>'
        r1 = page.evaluate(H, {"html": img, "attachments": [{"id": "a1", "name": "f.pdf", "cid": None}, {"id": "a2", "name": "logo.png", "cid": "<logo@x>"}]})
        r2 = page.evaluate(H, {"html": img, "attachments": [{"id": "a2", "name": "logo.png", "cid": "<logo@x>"}]})
        r3 = page.evaluate(H, {"html": "<p>hi</p>", "attachments": [{"id": "a3", "name": "spec.pdf", "cid": "<file@x>"}]})
        check(r1 == "1 attachment" and r2 is None and r3 == "1 attachment", f"{name}: a collapsed message's paperclip counts files, not images the body shows ({r1!r}, {r2!r}, {r3!r})")
        # a row cached before the hub sent has_att: the one-time full pass refreshes it; with the pass already done it would stay stale
        def stale(flag):
            page.evaluate("""async ([k, flag]) => { const t = window.mh.state.threads.get(k); t.hasAtt = false; await window.mh.idb.putAll('threads', [t]);
                await window.mh.idb.meta('hubSeq', 7); await window.mh.idb.meta('hubFullAt', Date.now()); await window.mh.idb.meta('attflag1', flag); }""", [WITH, flag])
            page.reload(); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 2500)
            return page.evaluate("async (k) => [window.mh.state.threads.get(k)?.hasAtt, (await window.mh.idb.get('threads', k))?.hasAtt, await window.mh.idb.meta('attflag1')]", WITH)
        before = stale(1)
        check(before[0] is False, f"{name}: CONTROL — with the pass already done, a stale cached row stays stale ({before})")
        after = stale(None)
        check(after[0] is True and after[1] is True and after[2] == 1, f"{name}: a device updating to this version refreshes its cached rows once, so old conversations gain the paperclip ({after})")
        check(not errs, f"{name}: page errors {errs[:3]}")
        b.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all attachment-flag checks passed")
sys.exit(1 if fails else 0)
