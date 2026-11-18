#!/usr/bin/env python3
"""The Letterhead box. The hub frames a send from an address on a branded domain (BRANDS) unless the draft says plain,
and the app shows a "Letterhead" box only for such a From, on by default. Headless Chromium and WebKit over the fake network. Checks:
the box is hidden for an unbranded From; it appears, ticked, when the From is on the branded domain, hides again on a switch back,
and comes back ticked; a send with it unticked posts plain: true, a send with it ticked posts no plain; the reply box does the same.
Usage: python3 test/letterhead.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0,"test")
import preview
from playwright.sync_api import sync_playwright
srv=preview.serve(); base=f"http://127.0.0.1:{srv.server_address[1]}/"
fails=[]
def check(c,m):
    print(("ok   " if c else "FAIL ")+m); (c or fails.append(m))
SUPPORT="support@domain7.example"; MINE="sam@yourdomain.example"
SETUP="""() => {
  window.mh.state.me.brands = ['domain7.example'];
  window.mh.state.me.identities.push({ email: 'support@domain7.example', display_name: 'Brandseven Support', domain: 'domain7.example' });
  window.__mock.routes['POST /api/send'] = { id: 's1', thread_id: 't1', message_id: '<s1@hub.test>' };
  window.__sent = [];
  const f = window.fetch;
  window.fetch = (u, o = {}) => { const k = String(u); if ((o.method || 'GET').toUpperCase() === 'POST' && (/\\/api\\/send$/.test(k) || /\\/api\\/messages\\/[^/]+\\/reply$/.test(k))) { try { window.__sent.push({ url: k, body: JSON.parse(o.body) }); } catch (_) {} } return f(u, o); };
}"""
def set_from(page, sel, addr):
    page.evaluate("([s, a]) => { const el = document.querySelector(s); el.value = a; el.dispatchEvent(new Event('change', { bubbles: true })); }", [sel, addr])
def shown(page, sel): return page.evaluate("(s) => getComputedStyle(document.querySelector(s)).display !== 'none'", sel)
with sync_playwright() as pw:
    for name, launcher in (("chromium", pw.chromium), ("webkit", pw.webkit)):
        b=launcher.launch(); ctx=b.new_context(viewport={"width":1200,"height":800})
        page=ctx.new_page(); errs=[]; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1200)
        page.evaluate(SETUP)
        # the composer
        page.click("#composeBtn"); preview.settle(page, 300)
        check(page.input_value("#cfrom") == MINE and not shown(page, "#cbrandl"), f"{name}: a new message from {MINE} shows no Letterhead box ({page.input_value('#cfrom')})")
        set_from(page, "#cfrom", SUPPORT); page.wait_for_timeout(100)
        check(shown(page, "#cbrandl") and page.is_checked("#cbrand"), f"{name}: From {SUPPORT}: the box appears, ticked")
        set_from(page, "#cfrom", MINE); page.wait_for_timeout(100)
        check(not shown(page, "#cbrandl"), f"{name}: back to {MINE}: the box hides")
        set_from(page, "#cfrom", SUPPORT); page.wait_for_timeout(100)
        page.uncheck("#cbrand")
        page.fill("#cto", "steve@example.com"); page.fill("#csub", "Plain one"); page.fill("#ctext", "Just a note.")
        page.evaluate("() => { window.mh.state.maybeSent = null; }"); page.click("#csend")
        page.wait_for_function("() => window.__sent.some((s) => /\\/api\\/send$/.test(s.url))", timeout=8000); preview.settle(page, 200)
        sent = page.evaluate("() => window.__sent.filter((s) => /\\/api\\/send$/.test(s.url)).pop().body")
        check(sent.get("from") == SUPPORT and sent.get("plain") is True, f"{name}: unticked, the send posts plain: true from {SUPPORT} ({ {k: sent.get(k) for k in ('from','plain','subject')} })")
        page.click("#composeBtn"); preview.settle(page, 300); set_from(page, "#cfrom", SUPPORT); page.wait_for_timeout(100)
        check(shown(page, "#cbrandl") and page.is_checked("#cbrand"), f"{name}: the next message starts with the box ticked again")
        page.fill("#cto", "steve@example.com"); page.fill("#csub", "Framed one"); page.fill("#ctext", "With the letterhead.")
        page.evaluate("() => { window.mh.state.maybeSent = null; }"); page.click("#csend")
        page.wait_for_function("() => window.__sent.filter((s) => /\\/api\\/send$/.test(s.url)).length >= 2", timeout=8000); preview.settle(page, 200)
        sent = page.evaluate("() => window.__sent.filter((s) => /\\/api\\/send$/.test(s.url)).pop().body")
        check(sent.get("from") == SUPPORT and "plain" not in sent, f"{name}: ticked, the send posts no plain ({ {k: sent.get(k) for k in ('from','plain','subject')} })")
        # the reply box on a hub conversation
        key = page.evaluate("() => [...window.mh.state.threads.values()].find((t) => t.kind === 'hub').key")
        page.evaluate("(k) => window.mh.openThread(k)", key); preview.settle(page, 600)
        page.evaluate("() => document.querySelector('#actions [data-act=reply]').click()"); preview.settle(page, 300)   # phone-only button; desktop opens it the same way (audit.py)
        check(shown(page, "#replybox") and page.input_value("#rfrom") == MINE and not shown(page, "#rbrandl"), f"{name}: a reply as {MINE} shows no box ({page.input_value('#rfrom')})")
        set_from(page, "#rfrom", SUPPORT); page.wait_for_timeout(100)
        check(shown(page, "#rbrandl") and page.is_checked("#rbrand"), f"{name}: a reply as {SUPPORT}: the box appears, ticked")
        mid = page.evaluate("() => window.mh.state.replyTo && window.mh.state.replyTo.id")
        page.evaluate("(m) => { window.__mock.routes['POST /api/messages/' + m + '/reply'] = { id: 'r1', thread_id: 't1', message_id: '<r1@hub.test>' }; }", mid)
        page.uncheck("#rbrand"); page.fill("#rtext", "Plain reply."); page.evaluate("() => { window.mh.state.maybeSent = null; }"); page.click("#rsend")
        page.wait_for_function("() => window.__sent.some((s) => /\\/reply$/.test(s.url))", timeout=8000); preview.settle(page, 200)
        rep = page.evaluate("() => window.__sent.filter((s) => /\\/reply$/.test(s.url)).pop().body")
        check(rep.get("from") == SUPPORT and rep.get("plain") is True, f"{name}: the unticked reply posts plain: true ({ {k: rep.get(k) for k in ('from','plain')} })")
        check(not errs, f"{name}: no page errors {errs}")
        b.close()
print(("\n%d FAILED" % len(fails)) if fails else "\nall passed")
sys.exit(1 if fails else 0)
