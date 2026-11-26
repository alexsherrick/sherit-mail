#!/usr/bin/env python3
"""The app's badge follows the mail when its window comes back. The Windows app's page is never hidden (WebView2 is not
told when its window is), so no visibilitychange came when the window came back, and the taskbar count caught up only at the next 60 s
poll: on 2026-11-25 it said 20 a minute after mail had been handled on the phone. And a conversation set aside was counted although the
inbox's list leaves it out.
In Chromium with the app's fake network (test/mock-fetch.js), the badge read from navigator.setAppBadge:
  - a conversation set aside is not in the badge or the Inbox count;
  - the window coming back after more than 5 s away refreshes at once, and the badge drops for mail handled elsewhere meanwhile;
  - not for a window away under 5 s, nor for focus moving into the mail's own frame and back (the document keeps focus then);
  - not twice where a visibilitychange already refreshed in the same moment;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the set-aside and the come-back checks.
Usage: python3 test/badgefocus.py"""
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
# The page's clock and focus, driven by the test: Date.now() moves on with window.__skip(ms); document.hasFocus() is window.__focused.
INIT = """(() => { const real = Date.now.bind(Date); let off = 0; Date.now = () => real() + off; window.__skip = (ms) => { off += ms; };
  window.__focused = true; Document.prototype.hasFocus = function () { return window.__focused; };
  window.__badges = []; navigator.setAppBadge = (n) => { window.__badges.push(n); return Promise.resolve(); }; navigator.clearAppBadge = () => { window.__badges.push(0); return Promise.resolve(); }; })();"""
SYNCS = "() => window.__mock.calls.filter((c) => /^GET \\/api\\/threads\\?/.test(c)).length"
LEAVE = "(ms) => { window.__focused = false; window.dispatchEvent(new Event('blur')); return new Promise((r) => setTimeout(() => { window.__skip(ms); r(); }, 20)); }"
BACK = "() => { window.__focused = true; window.dispatchEvent(new Event('focus')); return new Promise((r) => setTimeout(r, 600)); }"

with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1200, "height": 800}); page = ctx.new_page(); errs = []
    page.on("pageerror", lambda e: errs.append(str(e))); page.add_init_script(INIT)
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1500)
    # every hub conversation of the fixture unread in the inbox; one set aside
    keys = page.evaluate("""() => { const S = window.mh.state; const ks = [...S.threads.values()].filter((t) => t.kind === 'hub').map((t) => t.key);
      for (const k of ks) { const t = S.threads.get(k); t.state = 'inbox'; t.unread = true; } return ks; }""")
    n_all = page.evaluate("() => window.mh.counts().inbox")
    page.evaluate("(k) => { window.mh.state.prefs = { ...(window.mh.state.prefs || {}), setAside: [k] }; }", keys[0])
    n_aside = page.evaluate("() => window.mh.counts().inbox")
    check(len(keys) >= 2 and n_aside == n_all - 1, f"a conversation set aside is not in the Inbox count or the badge ({n_all} -> {n_aside} with one of {len(keys)} set aside)")
    page.evaluate("() => { window.mh.state.prefs.setAside = []; }")
    # 1. away 8 s: the window coming back refreshes at once, and the badge is set again from what the refresh left
    s0 = page.evaluate(SYNCS); b0 = page.evaluate("() => window.__badges.length"); page.evaluate(LEAVE, 8000); page.evaluate(BACK); preview.settle(page, 800)
    s1 = page.evaluate(SYNCS); b1 = page.evaluate("() => window.__badges.length")
    check(s1 > s0, f"the window coming back after 8 s away refreshes at once ({s1 - s0} list requests)")
    check(b1 > b0, f"and the badge is set again from what it brought ({b1 - b0} badge updates since the window left)")
    # 2. away under 5 s: nothing
    s2 = page.evaluate(SYNCS); page.evaluate(LEAVE, 2000); page.evaluate(BACK); s3 = page.evaluate(SYNCS)
    check(s3 == s2, f"a window away under 5 s does not refresh ({s3 - s2} list requests)")
    # 3. focus into the mail's frame and back: the document keeps focus, so it is not leaving
    page.evaluate("() => { window.__focused = true; window.dispatchEvent(new Event('blur')); return new Promise((r) => setTimeout(() => { window.__skip(9000); r(); }, 20)); }")
    page.evaluate(BACK); s4 = page.evaluate(SYNCS)
    check(s4 == s3, f"focus moving into the mail's own frame and back does not refresh ({s4 - s3} list requests)")
    # 4. coming back into view and to the front in the same moment (the Mac): one refresh, not two
    page.evaluate(LEAVE, 9000)
    page.evaluate("""() => { window.__focused = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); return new Promise((r) => setTimeout(r, 700)); }""")
    rec = page.evaluate("() => (window.mh.perf.stats['resume:focus-away-ms'] || { n: 0 }).n")
    check(rec == 1, f"a visibilitychange in the same moment does the refresh alone (focus refreshes counted {rec}: one from section 1, none here)")
    check(not errs, f"no page errors {errs[:2]}")
    b.close()
print(f"{len(fails)} failed" if fails else "all badge checks passed")
sys.exit(1 if fails else 0)
