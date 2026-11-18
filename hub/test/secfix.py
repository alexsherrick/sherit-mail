#!/usr/bin/env python3
"""A link in a mail leaves the mail and never navigates it, and the app page runs no script it did not write: on
WebKit (the Mac app) and Chromium (Android, Windows).

A mail's `<a href="intent:#Intent;component=…;end" target="_self">` started any activity on the phone in
the Android app (route() handed intent: to startActivity for every frame); `target="_self"` on a web link loaded the page inside the
message (Mac, Android); an SVG <a> or an <area> slipped past the click handler; and the app page itself had no script policy.
Checks, per engine, on a mail opened in the app (the page served under the hub's own policy, preview.SHELL_CSP):
  - intent:, javascript:, an entity-spelled javascript:, a tab inside the scheme, an <area>'s intent: and an SVG link's xlink:href
    javascript: lose their href; every target goes; web, mailto and relative links keep theirs; a <meta http-equiv="refresh"> is gone;
  - a click on an SVG web link opens it outside (Chromium: window.open once; WebKit: the popup), and the message frame stays where it is;
  - the page runs no injected inline handler (CSP), and the app's own boot and the mail's opening report no policy violation;
  - CONTROL: APP_JS_SRC=<app.js before the change> keeps the intent: href and the target, and lets the SVG link through.
Usage: python3 test/secfix.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
preview.CSP = True   # served under the hub's own script policy
from playwright.sync_api import sync_playwright

CONTROL = bool(os.environ.get("APP_JS_SRC"))
if CONTROL:
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
MAIL = '''<meta http-equiv="refresh" content="30;url=https://evil.example/meta"><div>
<p><a id="intent" href="intent:#Intent;component=com.x/.Y;end" target="_self">intent</a></p>
<p><a id="js" href="javascript:alert(1)">js</a> <a id="ent" href="&#106;avascript:alert(1)">ent</a> <a id="tab" href="java&#x09;script:alert(1)">tab</a></p>
<p><a id="web" href="https://example.com/x" target="_self">web</a> <a id="mail" href="mailto:bob@example.com" target="_top">mail</a> <a id="rel" href="/local">rel</a></p>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" usemap="#m" width="10" height="10"><map name="m"><area id="area" href="intent:#Intent;end" shape="rect" coords="0,0,10,10" target="_self"></map>
<svg width="300" height="40" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a id="svga" href="https://example.org/s" target="_self"><text x="5" y="20">svg link</text></a><a id="svgx" xlink:href="javascript:alert(2)"><text x="150" y="20">x</text></a></svg></div>'''
OPEN = """async ([k, tid, html]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; m.body_text = ''; });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k); await new Promise((res) => setTimeout(res, 700)); return true; }"""
LINKS = """() => { const d = document.querySelector('#msgs iframe').contentDocument, o = {};
  for (const a of d.querySelectorAll('[id]')) if (/^(a|area)$/i.test(a.localName)) o[a.id] = { href: a.getAttribute('href'), xhref: a.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), target: a.getAttribute('target') };
  return { links: o, meta: !!d.querySelector('meta[http-equiv="refresh" i]'), url: d.URL }; }"""
fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in ((pw.chromium,) if CONTROL else (pw.webkit, pw.chromium)):
        name = engine.name + (" (control)" if CONTROL else "")
        b = engine.launch(); ctx = b.new_context(viewport={"width": 1000, "height": 700}); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script("window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sample || '')));")
        page.goto(base); page.wait_for_function("() => window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate("() => { window.__opens = []; window.open = (u) => { window.__opens.push(String(u)); return null; }; }")
        page.evaluate(OPEN, [KEY, TID, MAIL]); L = page.evaluate(LINKS); g = lambda i: L["links"].get(i) or {}
        if CONTROL:
            check(g("intent").get("href", "").startswith("intent:") and g("intent").get("target") == "_self", f"{name}: CONTROL — the app before the change leaves intent: and target=_self in the mail ({g('intent')})")
            b.close(); continue
        dead = [i for i in ("intent", "js", "ent", "tab", "area") if g(i).get("href") is None]
        check(len(dead) == 5 and g("svgx").get("xhref") is None and g("svgx").get("href") is None, f"{name}: intent:, javascript: (plain, entity-spelled, with a tab), an <area>'s intent: and an SVG xlink:href javascript: lose their href ({dead}; svgx {g('svgx')})")
        check(all(g(i).get("target") is None for i in ("intent", "web", "mail", "area", "svga")), f"{name}: every link's target is gone (the frame's <base target=_blank> applies) ({[(i, g(i).get('target')) for i in ('web', 'mail', 'svga')]})")
        check(g("web").get("href") == "https://example.com/x" and g("mail").get("href") == "mailto:bob@example.com" and g("rel").get("href") == "/local" and g("svga").get("href") == "https://example.org/s",
              f"{name}: web, mailto, relative and SVG web links keep their href ({g('web').get('href')}, {g('mail').get('href')}, {g('rel').get('href')}, {g('svga').get('href')})")
        check(not L["meta"], f"{name}: the mail's <meta http-equiv=refresh> is gone")
        before = L["url"]
        if engine.name == "chromium":
            page.evaluate("() => { const a = document.querySelector('#msgs iframe').contentDocument.getElementById('svga'); a.querySelector('text').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }"); preview.settle(page, 400)
            opens = page.evaluate("() => window.__opens")
            check(opens == ["https://example.org/s"], f"{name}: a click on an SVG web link opens it outside, once ({opens})")
        else:
            try:
                ctx.route("https://example.org/**", lambda route: route.fulfill(status=200, content_type="text/html", body="<title>s</title>"))
                with ctx.expect_page(timeout=5000) as pi: page.evaluate("() => { const a = document.querySelector('#msgs iframe').contentDocument.getElementById('svga'); a.querySelector('text').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); }")
                pop = pi.value; pop.wait_for_load_state("domcontentloaded", timeout=5000); check(pop.url == "https://example.org/s", f"{name}: a click on an SVG web link opens a new window — what the Mac shell is handed ({pop.url})"); pop.close()
            except Exception as e: check(False, f"{name}: a click on the SVG link opened no new window ({str(e).splitlines()[0]})")
        after = page.evaluate("() => document.querySelector('#msgs iframe').contentDocument.URL")
        check(after == before, f"{name}: the message frame did not navigate ({before} → {after})")
        clean = page.evaluate("() => window.__csp.slice()")
        check(clean == [], f"{name}: the app's boot and the mail's opening report no policy violation ({clean[:3]})")
        page.evaluate("() => { document.body.insertAdjacentHTML('beforeend', '<img id=\"pwn\" src=\"data:,x\" onerror=\"window.__pwned = 1\">'); }"); preview.settle(page, 400)
        pw_ = page.evaluate("() => ({ pwned: window.__pwned === 1, csp: window.__csp.slice() })")
        check(not pw_["pwned"] and any("script-src" in v for v in pw_["csp"]), f"{name}: an injected inline handler on the page does not run (CSP) ({pw_})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        ctx.close(); b.close()
srv.shutdown()
print("all security-fix browser checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
