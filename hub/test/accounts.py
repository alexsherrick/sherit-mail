#!/usr/bin/env python3
"""The sidebar's accounts in the user's order and names, and Domains whole or one entry per domain (Reorder the accounts
by dragging in Settings so the sidebar follows, give Domains another name, or split it into one entry
per domain). Drag by mouse and by finger, arrow keys, names, the split, and that a domain's
entry shows exactly that domain's mail. Usage: python3 test/accounts.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
TWO_DOMAINS = """() => { window.mh.state.me.identities = [{ email: 'sam@yourdomain.example', display_name: 'Sam', domain: 'yourdomain.example' }, { email: 'sam@domain2.example', display_name: 'Sam', domain: 'domain2.example' }]; window.mh.render(); }"""
NAV = "() => [...document.querySelectorAll('#nav a[data-account]')].map((a) => a.dataset.account)"
NAV_TEXT = "() => [...document.querySelectorAll('#nav a[data-account]')].map((a) => a.textContent.trim())"
ROWS = "() => [...document.querySelectorAll('#scard [data-side]')].map((r) => r.dataset.side)"
def drag_mouse(page, frm, to_top_of):
    g = page.locator(f'#scard [data-side="{frm}"] [data-grip]').bounding_box(); t = page.locator(f'#scard [data-side="{to_top_of}"]').bounding_box()
    page.mouse.move(g["x"] + g["width"] / 2, g["y"] + g["height"] / 2); page.mouse.down()
    for i in range(1, 13): page.mouse.move(g["x"] + g["width"] / 2, g["y"] + (t["y"] + 4 - g["y"]) * i / 12); page.wait_for_timeout(16)
    page.mouse.up(); preview.settle(page, 300)
with sync_playwright() as pw:
    b = pw.chromium.launch(); page = b.new_page(viewport={"width": 1280, "height": 860}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 400)
    page.evaluate(TWO_DOMAINS)
    page.evaluate("() => window.mh.openSettings('accounts')"); preview.settle(page, 400)
    rows0 = page.evaluate(ROWS); check(len(rows0) >= 2 and rows0 == page.evaluate(NAV), f"Settings lists the sidebar's accounts in the sidebar's order ({rows0})")
    last = rows0[-1]; drag_mouse(page, last, rows0[0]); rows1 = page.evaluate(ROWS)
    check(rows1[0] == last and sorted(rows1) == sorted(rows0), f"dragging the last account above the first moves it there ({rows1})")
    check(page.evaluate("() => window.mh.state.prefs.acctOrder") == rows1 and page.evaluate(NAV) == rows1, f"the order is saved and the sidebar follows ({page.evaluate(NAV)})")
    page.focus(f'#scard [data-side="{rows1[0]}"] [data-grip]'); page.keyboard.press("ArrowDown"); preview.settle(page, 300); rows2 = page.evaluate(ROWS)
    check(rows2[1] == rows1[0] and page.evaluate(NAV) == rows2, f"the arrow keys move it too ({rows2})")
    page.fill('[data-sname="hub"]', "Personal domains"); page.dispatch_event('[data-sname="hub"]', "change"); preview.settle(page, 400)
    check(any(x.startswith("P") and "Personal domains" in x for x in page.evaluate(NAV_TEXT)), f"a name given to Domains shows in the sidebar ({page.evaluate(NAV_TEXT)})")
    check(page.evaluate("() => window.mh.state.prefs.acctNames") == {"hub": "Personal domains"}, "and is saved in the synced prefs")
    hub_at = page.evaluate(NAV).index("hub")
    # every domain switched to its own row
    for d in ("domain2.example", "yourdomain.example"): page.check(f'#scard [data-ownrow="{d}"]'); preview.settle(page, 400)
    nav = page.evaluate(NAV)
    check("hub" not in nav and nav[hub_at:hub_at + 2] == ["hub:domain2.example", "hub:yourdomain.example"], f"split: each domain is its own entry, where Domains was ({nav})")
    page.evaluate("() => { window.mh.closeSettings(); document.querySelector('#nav a[data-account=\"hub:domain2.example\"]').click(); }"); preview.settle(page, 400)
    shown = page.evaluate("() => [...document.querySelectorAll('#threads .t[data-key]')].map((d) => window.mh.state.threads.get(d.dataset.key)).filter(Boolean).map((t) => [t.kind, (t.identity || '').split('@')[1]])")
    check(len(shown) > 0 and all(k == "hub" and d == "domain2.example" for k, d in shown), f"a domain's entry shows that domain's mail and nothing else ({shown})")
    page.evaluate("() => window.mh.openSettings('accounts')"); preview.settle(page, 300)
    page.fill('[data-sname="hub:domain2.example"]', "Brand Two"); page.dispatch_event('[data-sname="hub:domain2.example"]', "change"); preview.settle(page, 400)
    page.evaluate("() => { window.mh.closeSettings(); window.mh.setView('inbox'); }"); preview.settle(page, 400)
    badges = page.evaluate("() => [...document.querySelectorAll('#threads .t[data-key]')].filter((d) => (window.mh.state.threads.get(d.dataset.key)?.identity || '').endsWith('@domain2.example')).map((d) => d.querySelector('.when .acl')?.textContent)")
    check(badges and all(x == "Brand Two" for x in badges), f"its mail carries the new name in the unified inbox ({badges})")
    page.evaluate("() => window.mh.setView('inbox', 'hub:domain2.example')"); page.evaluate("() => window.mh.openSettings('accounts')"); preview.settle(page, 300)
    for d in ("domain2.example", "yourdomain.example"): page.uncheck(f'#scard [data-ownrow="{d}"]'); preview.settle(page, 400)
    nav = page.evaluate(NAV)
    check("hub" in nav and nav.index("hub") == hub_at and not any(x.startswith("hub:") for x in nav), f"split off: Domains is back in its place ({nav})")
    check(page.evaluate("() => window.mh.state.view.account") is None, "and a view of a domain that no longer has an entry goes to the unified inbox")
    # a synced value of the wrong type cannot break the sidebar: names must be text, the order a list of ids
    bad = page.evaluate("() => normalizePrefs({ acctNames: { hub: 42, 'hub:domain2.example': '  Brand  ', x: '' }, acctOrder: [1, 'hub', null] })")
    check(bad.get("acctNames") == {"hub:domain2.example": "Brand"} and bad.get("acctOrder") == ["hub"], f"names that are not text and order entries that are not ids are dropped ({bad.get('acctNames')}, {bad.get('acctOrder')})")
    check(not errs, f"page errors {errs[:2]}"); b.close()
    # the phone: settings is a sheet, the drag is a finger on the grip
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 411, "height": 918}, is_mobile=True, has_touch=True); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 400)
    page.evaluate(TWO_DOMAINS); page.evaluate("() => window.mh.openSettings('accounts')"); preview.settle(page, 400)
    rows0 = page.evaluate(ROWS); cdp = ctx.new_cdp_session(page)
    g = page.locator(f'#scard [data-side="{rows0[-1]}"] [data-grip]').bounding_box(); t = page.locator(f'#scard [data-side="{rows0[0]}"]').bounding_box()
    x, y0, y1 = g["x"] + g["width"] / 2, g["y"] + g["height"] / 2, t["y"] + 4
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y0}]})
    for i in range(1, 13): cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y0 + (y1 - y0) * i / 12}]}); page.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []}); preview.settle(page, 400)
    rows1 = page.evaluate(ROWS)
    check(rows1[0] == rows0[-1] and page.evaluate("() => window.mh.state.prefs.acctOrder") == rows1, f"phone: a finger on the grip drags the account to the top ({rows0} -> {rows1})")
    check(not errs, f"phone: page errors {errs[:2]}"); b.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all account-order checks passed")
sys.exit(1 if fails else 0)
