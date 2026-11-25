#!/usr/bin/env python3
"""Connect Gmail from an app: the click carries a one-time ticket, and the app shows the new account without a relaunch.
WebKit and Chromium, at a Mac window.

The Mac app sends /auth/gmail to the default browser (Google refuses OAuth in an embedded web view), and that browser has
no hub session. With a ticket the connect worked, but the app never learned of the account: the old flow ended by reloading the app in
the same window, and this one ends in another browser. The account stayed out of the app until it was relaunched.

Checks, with the hub's answers mocked and the browser hand-off answered 204 (the page stays, as the native apps cancel it):
  - Connect Gmail asks the hub for a ticket and goes to /auth/gmail?ticket=<it>, and the app is still there;
  - while the hub has no new account, nothing changes;
  - once the hub has one, coming back to the app (focus) loads it: in the app's accounts, in Settings, and a "Connected" toast;
  - with no focus event at all, the app's own 10-second check finds a second new account;
  - reconnecting an account the app already has changes nothing and says nothing;
  - no page errors.
CONTROL=1 also runs the client at f9eaedd, which goes to /auth/gmail with no ticket and never shows the new account.
"""
import json, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

FILES = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]
def src(rev, f): return subprocess.run(["git", "show", f"{rev}:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=True).stdout if rev else (preview.CLIENT / f).read_text()
def bundle(rev=None): return "\n".join(src(rev, f) for f in FILES).replace("__VERSION__", "test")

TICKET = "Tk" + "x" * 41
NEW1, NEW2 = "second.owner@mail.example", "third.owner@mail.example"

# the hub gains an account: both the bootstrap and the account list answer it, with a token route for it
ADD = """([email, ticket]) => {
  const R = window.__mock.routes, acct = { email, status: 'active', label: '', color: '#3366aa' };
  for (const g of [R['GET /api/bootstrap'].gmail, R['GET /api/gmail/accounts']]) if (!g.accounts.some((a) => a.email === email)) g.accounts.push(acct);
  R['POST /api/gmail/accounts/' + encodeURIComponent(email) + '/token'] = { access_token: 'tok', expires_at: new Date(Date.now() + 3600e3).toISOString(), expires_in: 3600 };
}"""
STATE = """() => ({ accounts: window.mh.state.gmail.map((g) => g.email), toast: document.querySelector('#toast')?.textContent || '',
  settings: document.body.innerText.includes('second.owner@mail.example'), still: !!window.mh && location.pathname === '/' })"""

BTN = 'a[href="/auth/gmail"]'   # the Connect Gmail link, in this client and in f9eaedd's (which has no id on it)
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def run(engine, tag, control=False):
    b = engine.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    went = []
    page.route("**/auth/gmail**", lambda route: (went.append(route.request.url), route.fulfill(status=204)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    page.evaluate("async (t) => { window.__mock.routes['POST /api/gmail/ticket'] = { ticket: t }; await window.mh.openSettings('accounts'); }", TICKET)
    page.wait_for_selector(BTN, timeout=10000)
    has = lambda email, ms: page.wait_for_function("(e) => window.mh.state.gmail.some((g) => g.email === e) && document.body.innerText.includes(e)", arg=email, timeout=ms)
    page.click(BTN); page.wait_for_timeout(1200)
    r = {"went": list(went)}
    page.evaluate("() => window.dispatchEvent(new Event('focus'))"); page.wait_for_timeout(1000)
    r["before"] = page.evaluate(STATE)
    page.evaluate(ADD, [NEW1, TICKET]); page.evaluate("() => window.dispatchEvent(new Event('focus'))")
    try: has(NEW1, 6000)
    except Exception: pass
    r["after"] = page.evaluate(STATE)
    if not control:
        # a second connect, found by the app's own check with no focus event (it runs every 10 seconds)
        page.wait_for_selector(BTN, timeout=10000); page.click(BTN); page.wait_for_timeout(800); page.evaluate(ADD, [NEW2, TICKET])
        try: has(NEW2, 16000)
        except Exception: pass
        r["timer"] = page.evaluate(STATE)
        # a reconnect of an account the app already has
        page.evaluate("() => { document.querySelector('#toast').textContent = ''; }")
        page.wait_for_selector(BTN, timeout=10000); page.click(BTN); page.wait_for_timeout(800); page.evaluate("() => window.dispatchEvent(new Event('focus'))"); page.wait_for_timeout(2500)
        r["again"] = page.evaluate(STATE)
        w = r["went"][0] if r["went"] else ""
        check(w.endswith("/auth/gmail?ticket=" + TICKET), f"{tag}: Connect Gmail goes to /auth/gmail with the hub's ticket ({w[-60:]!r})")
        check(r["before"]["still"] and NEW1 not in r["before"]["accounts"] and "Connected" not in r["before"]["toast"], f"{tag}: the app stays, and nothing changes while the hub has no new account ({r['before']['accounts']})")
        check(NEW1 in r["after"]["accounts"] and r["after"]["settings"] and NEW1 in r["after"]["toast"], f"{tag}: back in the app, the new account is loaded, listed in Settings and announced ({r['after']['accounts']}, {r['after']['toast']!r})")
        check(NEW2 in r["timer"]["accounts"] and NEW2 in r["timer"]["toast"], f"{tag}: with no focus event, the app's own check finds the next one ({r['timer']['accounts']}, {r['timer']['toast']!r})")
        check(r["again"]["toast"] == "" and len(r["again"]["accounts"]) == len(r["timer"]["accounts"]), f"{tag}: reconnecting an account it already has changes nothing and says nothing ({r['again']['toast']!r})")
        check(not errs, f"{tag}: no page errors {errs[:2]}")
    b.close(); return r

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        preview.BUNDLE = bundle(); run(engine, engine.name)
    if preview.CONTROL:   # f9eaedd: a plain link, and nothing reloads the accounts
        preview.BUNDLE = bundle("f9eaedd"); r = run(pw.chromium, "f9eaedd", control=True)
        w = r["went"][0] if r["went"] else ""
        check(w.endswith("/auth/gmail") and NEW1 not in r["after"]["accounts"], f"CONTROL: the client at f9eaedd goes to /auth/gmail with no ticket ({w[-30:]!r}) and never shows the new account ({r['after']['accounts']})")
    else:
        preview.control_skipped("gmailback")
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all Gmail connect-back checks passed")
sys.exit(1 if fails else 0)
