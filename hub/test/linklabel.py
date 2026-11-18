#!/usr/bin/env python3
"""Every link in a mail goes where it says, and says where it goes: on WebKit (the Mac app) and Chromium (Android, Windows).

Mail links must open cleaned, and hovering one should show where it goes. The fix:
WebKit runs no listener the page attaches inside the scriptless mail frame, so on the Mac the tap handler that cleaned a link
(cleanLink: tracking parameters off, Google and Outlook SafeLinks redirects unwrapped) never ran and the shell opened the href as
written. Now the frame's HTML is rewritten at render: each http(s) link's href IS the cleaned URL, and its title is that URL, so the
native tooltip on hover shows where the link leads (the tooltip itself is the browser's; this test checks the attributes it reads).
Plain-text mail gets the same on the links it finds. Checks, in each engine:
  - a Google redirect and an Outlook SafeLinks link point at the wrapped URL, href and title alike;
  - a shop link loses utm_source and utm_campaign and keeps id; its text is unchanged;
  - a mailto: and a relative link are untouched and get no title;
  - the sender's own title ("Click here") is replaced by the destination;
  - an unsubscribe link keeps its parameters (NO_CLEAN_PATH) and is titled with itself;
  - a link whose attributes are glued together (class="x"href="…") is cleaned too;
  - a plain-text mail's URL renders as a link whose href and title are the cleaned URL and whose text is the URL as written;
  - Chromium: a click opens the cleaned URL once (window.open recorded); WebKit: the popup a click opens (what the Mac shell receives) is the cleaned URL;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the href and title checks and passes the untouched-link checks.
Usage: python3 test/linklabel.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
SHOP = "https://shop.example/item?id=42&amp;utm_source=news&amp;utm_campaign=oct"; SHOP_GO = "https://shop.example/item?id=42"
GOOG = "https://www.google.com/url?q=https%3A%2F%2Fdocs.example%2Fpaper&amp;sa=D"; GOOG_GO = "https://docs.example/paper"
SAFE = "https://nam04.safelinks.protection.outlook.com/?url=https%3A%2F%2Fportal.example%2Finvoice%3Fn%3D7&amp;data=05"; SAFE_GO = "https://portal.example/invoice?n=7"
UNSUB = "https://list.example/unsubscribe?u=abc&amp;utm_source=news"; UNSUB_GO = "https://list.example/unsubscribe?u=abc&utm_source=news"
GLUED = "https://a.example/?utm_source=y&amp;k=1"; GLUED_GO = "https://a.example/?k=1"
MAIL = f'''<div><p>Shop: <a id="shop" href="{SHOP}">the item</a></p><p>Doc: <a id="goog" href="{GOOG}">a paper</a></p><p>Bill: <a id="safe" href="{SAFE}">invoice</a></p>
<p>Write: <a id="mailto" href="mailto:bob@example.com">bob</a> or see <a id="rel" href="/local/page">this</a></p><p><a id="titled" href="https://t.example/x" title="Click here">titled</a></p>
<p><a id="unsub" href="{UNSUB}">unsubscribe</a></p><p><a id="glued"class="x"href="{GLUED}"target="_blank">glued</a></p></div>'''
TEXT = "Hi,\n\nhave a look at https://shop.example/item?id=42&utm_source=news&utm_campaign=oct when you can.\n\nSam"
OPEN = """async ([k, tid, html, text]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; m.body_text = text; });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k); await new Promise((res) => setTimeout(res, 600)); return true; }"""
LINKS = """() => { const fr = document.querySelector('#msgs iframe'), d = fr.contentDocument; const o = {}; for (const a of d.querySelectorAll('a[id]')) o[a.id] = { href: a.getAttribute('href'), title: a.getAttribute('title'), text: a.textContent }; return o; }"""
TEXTLINKS = """() => [...document.querySelectorAll('#msgs a.tl')].map((a) => ({ href: a.getAttribute('href'), title: a.getAttribute('title'), text: a.textContent }))"""
RECORD = "() => { window.__opens = []; window.open = (u) => { window.__opens.push(String(u)); return null; }; }"
fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        ctx = b.new_context(viewport={"width": 1000, "height": 700}); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(RECORD); page.evaluate(OPEN, [KEY, TID, MAIL, ""]); L = page.evaluate(LINKS)
        g = lambda i: L.get(i) or {}
        check(g("goog").get("href") == GOOG_GO and g("goog").get("title") == GOOG_GO, f"{name}: a Google redirect points at the wrapped page, href and title ({g('goog')})")
        check(g("safe").get("href") == SAFE_GO and g("safe").get("title") == SAFE_GO, f"{name}: an Outlook SafeLinks link points at the wrapped page ({g('safe')})")
        check(g("shop").get("href") == SHOP_GO and g("shop").get("title") == SHOP_GO and g("shop").get("text") == "the item", f"{name}: a shop link loses utm_source and utm_campaign, keeps id, text unchanged ({g('shop')})")
        check(g("mailto").get("href") == "mailto:bob@example.com" and g("mailto").get("title") is None, f"{name}: a mailto: link is untouched, no title ({g('mailto')})")
        check(g("rel").get("href") == "/local/page" and g("rel").get("title") is None, f"{name}: a relative link is untouched, no title ({g('rel')})")
        check(g("titled").get("title") == "https://t.example/x" and g("titled").get("href") == "https://t.example/x", f"{name}: the sender's own title is replaced by the destination ({g('titled')})")
        check(g("unsub").get("href") == UNSUB_GO and g("unsub").get("title") == UNSUB_GO, f"{name}: an unsubscribe link keeps its parameters and is titled with itself ({g('unsub')})")
        check(g("glued").get("href") == GLUED_GO and g("glued").get("title") == GLUED_GO, f"{name}: a link with glued attributes is cleaned and titled ({g('glued')})")
        # the click: Chromium opens through the page (window.open, once, the cleaned URL); WebKit's popup is what the Mac shell is handed
        if name == "chromium":
            page.evaluate("() => document.querySelector('#msgs iframe').contentDocument.getElementById('shop').click()"); preview.settle(page, 300)
            opens = page.evaluate("() => window.__opens")
            check(opens == [SHOP_GO], f"{name}: a click opens the cleaned URL once ({opens})")
        else:
            try:   # the destination is served by the test, so the popup's navigation commits and its URL can be read
                ctx.route("https://shop.example/**", lambda route: route.fulfill(status=200, content_type="text/html", body="<title>shop</title>"))
                with ctx.expect_page(timeout=5000) as pi: page.evaluate("() => document.querySelector('#msgs iframe').contentDocument.getElementById('shop').click()")
                pop = pi.value; pop.wait_for_load_state("domcontentloaded", timeout=5000); url = pop.url
                check(url == SHOP_GO, f"{name}: the popup a click opens — what the Mac shell is handed — is the cleaned URL ({url})")
                pop.close()
            except Exception as e: check(False, f"{name}: a click on the link opened no popup ({str(e).splitlines()[0]})")
        page.evaluate(OPEN, [KEY, TID, "", TEXT]); T = page.evaluate(TEXTLINKS)
        check(len(T) == 1 and T[0]["href"] == SHOP_GO and T[0]["title"] == SHOP_GO and T[0]["text"] == "https://shop.example/item?id=42&utm_source=news&utm_campaign=oct", f"{name}: a plain-text mail's URL is a link to the cleaned URL, titled with it, its text as written ({T})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        ctx.close(); b.close()
srv.shutdown()
print("all link label checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
