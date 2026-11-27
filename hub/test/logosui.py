#!/usr/bin/env python3
"""Business mail shows its sender's logo in the list, from the hub (/api/logo, with the picture key), never from the
sender. In WebKit and Chromium with the app's fake network (test/mock-fetch.js) and /api/logo answered by the test:
  - a newsletter from news@mail.shop.example shows the logo of shop.example over its letter, asked of the hub with the key;
  - one whose domain has no logo (404) drops back to its letter, and the domain is not asked again on the next render;
  - mail from a person shows its letter, and nothing is asked for a free mailbox domain;
  - a new company's logo on its first mail; no logo for mail not proven (DMARC) from its domain, or in Spam;
  - a sender named after a protected brand (Shop, from lookalike.example) shows its letter, and its logo is never asked for;
  - the Settings switch turns logos off;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the logo checks.
Usage: python3 test/logosui.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa7b1d1f70000000049454e44ae426082")
SETUP = "try { localStorage.setItem('mh:ik', 'testkey'); } catch (_) {}"   # the picture key, as a device keeps it from its last boot
ROWS = """() => { const st = window.mh.state, now = Date.now(); st.view = { kind: 'inbox' }; st.search = '';
  const mk = (id, from, name, cat, o = {}) => st.threads.set('hub|lg-' + id, { key: 'hub|lg-' + id, kind: 'hub', account: 'hub', id: 'lg-' + id, subject: 'Subject ' + id, snippet: 'x', from: name + ' <' + from + '>', fromAddr: from, fromName: name, to: 'sam@yourdomain.example', identity: 'sam@yourdomain.example', out: false, date: now - (o.days || 0) * 864e5 - 60000 * id.length, unread: false, starred: false, state: o.state || 'inbox', labels: [], cat, count: 1, lastMsgId: 'm' + id, msgIds: [], msgIdHdr: '', hasAtt: false, unsub: '', unsubPost: '', unsubKnown: true, proven: o.proven !== false });
  mk('shop', 'news@mail.shop.example', 'Shop', 'newsletters'); mk('shopold', 'news@shop.example', 'Shop', 'newsletters', { days: 20, state: 'archived' });
  mk('nologo', 'hello@nologo.example', 'Nologo', 'notifications'); mk('nologoold', 'hello@nologo.example', 'Nologo', 'notifications', { days: 20, state: 'archived' });
  mk('friend', 'bob@gmail.com', 'Pat', 'personal'); mk('freebiz', 'alice@gmail.com', 'Deals', 'newsletters');
  mk('fresh', 'hello@newco.example', 'Newco', 'notifications');   // first mail from a new company
  mk('borrow', 'alerts@lookalike.example', 'Shop', 'notifications');   // named after a protected brand, from another domain
  mk('unproven', 'billing@unproven.example', 'Unproven', 'notifications', { proven: false }); mk('unprovenold', 'billing@unproven.example', 'Unproven', 'notifications', { days: 30, state: 'archived' });
  mk('spammy', 'promo@spammy.example', 'Spammy', 'newsletters', { state: 'spam' }); mk('spammyold', 'promo@spammy.example', 'Spammy', 'newsletters', { days: 30, state: 'archived' });
  window.mh.render(); }"""
TILES = """() => Object.fromEntries(['shop', 'nologo', 'friend', 'freebiz', 'fresh', 'unproven', 'borrow'].map((id) => { const row = document.querySelector('#threads .t[data-key="hub|lg-' + id + '"]'); const img = row && row.querySelector('.av img.logo');
  return [id, { img: img ? img.getAttribute('src') : null, drawn: !!(img && img.complete && img.naturalWidth > 0), letter: row ? row.querySelector('.av').firstChild.textContent : null }]; }))"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        asked = []
        def logo(route):
            u = route.request.url; asked.append(u)
            route.fulfill(status=200, body=PNG, headers={"content-type": "image/png"}) if any(("d=" + x) in u for x in ("shop.example", "newco.example", "lookalike.example")) else route.fulfill(status=404, body="")
        page.route("**/api/logo?**", logo)
        page.add_init_script(SETUP)
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(ROWS); preview.settle(page, 900)
        t = page.evaluate(TILES)
        check(t["shop"]["img"] and "d=shop.example" in t["shop"]["img"] and "k=testkey" in t["shop"]["img"] and t["shop"]["drawn"], f"{name}: a newsletter shows its organisation's logo, asked of the hub with the key ({t['shop']})")
        check(t["nologo"]["img"] is None and t["nologo"]["letter"] == "N", f"{name}: a domain with no logo drops back to its letter ({t['nologo']})")
        check(t["friend"]["img"] is None and t["freebiz"]["img"] is None and not any("gmail.com" in u for u in asked), f"{name}: a person's mail and a free mailbox domain show their letter, nothing asked ({[u.split('?')[1] for u in asked]})")
        check(t["fresh"]["img"] and "d=newco.example" in t["fresh"]["img"] and t["fresh"]["drawn"] and t["unproven"]["img"] is None, f"{name}: a new company's logo on its first mail (no wait), none for mail not proven from its domain ({t['fresh']}, {t['unproven']['img']})")
        check(t["borrow"]["img"] is None and not any("lookalike" in u for u in asked), f"{name}: a sender named after a protected brand, from another domain, shows its letter and nothing is asked ({t['borrow']})")
        sp = page.evaluate("() => { window.mh.state.view = { kind: 'spam' }; window.mh.render(); const r = document.querySelector('#threads .t[data-key=\"hub|lg-spammy\"]'); const n = r ? r.querySelectorAll('img.logo').length : -1; window.mh.state.view = { kind: 'inbox' }; window.mh.render(); return n; }")
        check(sp == 0, f"{name}: no logo in Spam ({sp})")
        n = len([u for u in asked if "nologo" in u]); page.evaluate("() => window.mh.render()"); preview.settle(page, 400)
        check(len([u for u in asked if "nologo" in u]) == n, f"{name}: a domain without one is not asked again on the next render")
        # A miss is kept five minutes, not the session (the hub may still be looking it up), and the address
        # carries the day, so the hub's day-long "none" and week-long logo answers are asked again the next day.
        check(t["shop"]["img"] and "&t=" in t["shop"]["img"], f"{name}: the logo's address carries the day ({t['shop']['img']})")
        page.evaluate("() => { const real = Date.now; window.__realNow = real; Date.now = () => real() + 6 * 60e3; window.mh.render(); }"); preview.settle(page, 500)
        page.evaluate("() => { Date.now = window.__realNow; }")
        check(len([u for u in asked if "nologo" in u]) > n, f"{name}: a domain that had none is asked again after five minutes")
        # Gmail names the parent domain whose policy it applied: header.from=shop.example for news@emails.shop.example (as on real mail).
        pv = page.evaluate("""() => { const st = (hf, r = 'pass') => ['mx.google.com; dkim=pass header.i=@x; spf=pass smtp.mailfrom=x; dmarc=' + r + ' (p=quarantine) header.from=' + hf];
          return [provenBy(st('shop.example'), 'mx.google.com', 'news@emails.shop.example'), provenBy(st('emails.shop.example'), 'mx.google.com', 'news@emails.shop.example'),
                  provenBy(st('shop.example'), 'mx.google.com', 'news@evilshop.example'), provenBy(st('a.shop.example'), 'mx.google.com', 'news@b.shop.example'),
                  provenBy(st('example'), 'mx.google.com', 'news@shop.example'), provenBy(st('shop.example', 'fail'), 'mx.google.com', 'news@emails.shop.example'),
                  provenBy(['mx.google.com; dmarc=pass header.from=evil.example; dmarc=pass header.from=shop.example'], 'mx.google.com', 'news@shop.example')]; }""")
        check(pv == [True, True, False, False, False, False, False], f"{name}: proven by a pass for the From's own domain or its parent; never a look-alike, a sibling, a bare suffix, a fail, or two verdicts ({pv})")
        page.evaluate("() => { window.mh.state.prefs.logos = false; window.mh.render(); }"); preview.settle(page, 300)
        off = page.evaluate("() => document.querySelectorAll('#threads img.logo').length")
        check(off == 0, f"{name}: the Settings switch turns logos off ({off} left)")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all logo-in-the-list checks passed")
sys.exit(1 if fails else 0)
