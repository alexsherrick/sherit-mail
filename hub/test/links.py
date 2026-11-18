#!/usr/bin/env python3
"""Link receipts on headless Chromium (fake network from test/mock-fetch.js): one tap on a link in a mail body must open the
link ONCE: the 2026-09-11 Android report was that a tapped link opened two or three times. Every window.open the page makes is
recorded, in a plain browser tab and in the installed app (a real `display-mode: standalone` window from Chromium's --app=,
Android user agent), where the Chrome intent: URL is used. Covers the Settings switch, a reopened conversation (a second click
handler stacked on one body was the other half of the bug) and the unsubscribe page, which goes through the same helper.
Usage: python3 test/links.py [outdir] (exit 1 on any failed check)
Set CHROMIUM_PATH when the local Chromium build does not match the installed Playwright."""
import os, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/mail-links"); OUT.mkdir(parents=True, exist_ok=True)
KT = "hub|44444444-4444-4444-4444-444444444444"  # its body_html carries <a href="https://e2e.ti.example/x">
LINK = "https://e2e.ti.example/x"
ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
EXE = os.environ.get("CHROMIUM_PATH")
fails = []
def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg); (cond or fails.append(msg))

# window.open is replaced before anything is clicked, and returns null exactly as the real one does with "noopener"
RECORD = "() => { window.__opens = []; window.open = (u) => { window.__opens.push(String(u)); return null; }; }"
# a body the frame is still waiting on when the app first arms it: the load event then lands after the poll has armed the
# document, which is where a second click handler used to be stacked on top of the first
SLOW_BODY = ("<div><p>Per the ongoing discussion on E2E, an answer was suggested.</p>"
             "<p><a href='https://e2e.ti.example/x'>View the thread</a></p>"
             "<img src='https://x.example/slow.png'></div>")

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"

# Playwright's default headless Chromium is the "headless shell", which silently IGNORES --app=: the context comes up holding one
# about:blank, androidApp() is false, and every installed-app check below died on a 20 s timeout with a traceback instead of a
# result, so the half of this file that covers the Android intent (the actual reported bug) was not running at all on macOS.
# channel="chromium" is the FULL browser under the new headless mode, where --app= really is a display-mode: standalone window.
APP_CHANNELS = ["chromium", "chrome"]  # the full Playwright build, else a locally installed Chrome

def app_page(ctx, timeout=15):
    """The --app= window opens by itself; until it does, ctx.pages holds only about:blank. Never assume pages[0] is it."""
    end = time.time() + timeout
    while time.time() < end:
        for pg in ctx.pages:
            if base.rstrip("/") in pg.url: return pg
        time.sleep(0.25)
    return None

def session(pw, app_mode):
    """A plain tab, or an installed-app window: --app= is a real display-mode: standalone, which is what androidApp() reads."""
    if app_mode:
        tried = []
        # CHROMIUM_PATH names an exact binary, so it is used as given; otherwise try each channel until one honours --app=.
        for ch in ([None] if EXE else APP_CHANNELS):
            kw = {"executable_path": EXE} if EXE else {"channel": ch}
            try: ctx = pw.chromium.launch_persistent_context("", headless=True, args=["--app=" + base], user_agent=ANDROID_UA,
                                                             viewport={"width": 390, "height": 844}, has_touch=True, **kw)
            except Exception as e: tried.append(f"{ch or EXE}: {type(e).__name__} {e}"[:120]); continue
            page = app_page(ctx)
            if page: return ctx, page
            ctx.close(); tried.append(f"{ch or EXE}: launched but ignored --app= (headless shell?)")
        raise RuntimeError("no Chromium here opens an --app= window, so the installed-app checks cannot run — "
                           "`python3 -m playwright install chromium` installs the full build, or set CHROMIUM_PATH.\n  " + "\n  ".join(tried))
    b = pw.chromium.launch(executable_path=EXE) if EXE else pw.chromium.launch()
    ctx = b.new_context(user_agent=ANDROID_UA, viewport={"width": 390, "height": 844}, has_touch=True)
    page = ctx.new_page(); page.goto(base)
    return ctx, page

def drive(page, app_mode):
    errs = []
    page.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
    page.on("console", lambda m: errs.append(m.type + ": " + m.text)
            if m.type == "error" and "fetching the script" not in m.text and "Failed to load resource" not in m.text else None)
    page.wait_for_function("window.mh && window.mh.state && window.mh.state.threads.size >= 4", timeout=20000); preview.settle(page, 800)
    label = "installed app" if app_mode else "plain tab"

    def open_mail():
        page.evaluate("([k, h]) => { window.__mock.routes['GET /api/threads/44444444-4444-4444-4444-444444444444'].messages[0].body_html = h;"
                      "  window.mh.prerendered.delete(k); return window.mh.idb.del('bodies', 'hub|m4').then(() => window.mh.openThread(k)); }", [KT, SLOW_BODY])
        page.wait_for_function("""() => { const fr = document.querySelector('#msgs iframe'); const d = fr && fr.contentDocument;
            return !!(d && d.querySelector('a[href]')); }""", timeout=15000)
        preview.settle(page, 1500)  # let the frame's load event land on top of the poll that already armed the document

    def tap_link():
        page.evaluate(RECORD)
        # a real finger fires pointerdown, then pointerup, then click. The press is what warms the link's origin, so a test that
        # only dispatches `click` would silently skip it, and would have passed a warming check that never ran.
        page.evaluate("""() => { const d = document.querySelector('#msgs iframe').contentDocument; const a = d.querySelector('a[href]');
            const W = d.defaultView;
            try { a.dispatchEvent(new W.PointerEvent('pointerdown', {bubbles: true, cancelable: true, view: W})); } catch (_) {}
            a.dispatchEvent(new W.MouseEvent('click', {bubbles: true, cancelable: true, view: W})); }""")
        preview.settle(page, 300); o = page.evaluate("window.__opens"); print("   opens:", o); return o

    check(page.evaluate("!!window.mh.androidApp()") == app_mode, f"{label}: androidApp() is {app_mode}")
    open_mail()
    o = tap_link()
    check(len(o) == 1, f"{label}: one tap opens ONCE — got {len(o)}: {o}")
    if app_mode:
        check(len(o) == 1 and o[0].startswith("intent://e2e.ti.example/x#Intent;") and "package=com.android.chrome" in o[0]
              and "S.browser_fallback_url=" in o[0], f"{label}: the one open is the Chrome intent, carrying its own fallback URL — {o}")
        page.evaluate("() => window.mh.state.prefs.openInChrome = false")  # what the Settings switch writes
        o = tap_link(); check(o == [LINK], f"{label}: with 'open in Chrome' off, one plain open — got {len(o)}: {o}")
        page.evaluate("() => window.mh.state.prefs.openInChrome = true")
    else:
        check(o == [LINK], f"{label}: the one open is the link itself — {o}")

    # a late image finishes and the frame fires `load` again, long after the poll armed the document: this is what used to
    # stack a second click handler on the same body, so the very next tap opened the link twice over
    page.evaluate("() => { const f = document.querySelector('#msgs iframe'); for (let i = 0; i < 3; i++) f.dispatchEvent(new Event('load')); }")
    preview.settle(page, 200); o = tap_link()
    check(len(o) == 1, f"{label}: after three late frame `load`s, still one open per tap — got {len(o)}: {o}")

    open_mail(); o = tap_link()  # reopening must not stack a second handler on the body either
    check(len(o) == 1, f"{label}: reopened conversation, still one open per tap — got {len(o)}: {o}")

    page.evaluate(RECORD); page.evaluate("window.mh.openExternal('https://list.example/unsub?x=1')")
    o = page.evaluate("window.__opens"); print("   opens:", o)
    check(len(o) == 1, f"{label}: the unsubscribe page opens once — got {len(o)}: {o}")
    # the origin the link points at must be warmed BEFORE the tap, in the parent document Chrome shares a profile with
    check(not errs, f"{label}: no page errors — {errs[:3]}")
    page.screenshot(path=str(OUT / ("links-app.png" if app_mode else "links-tab.png")))

with sync_playwright() as pw:
    for app_mode in (False, True):
        ctx, page = session(pw, app_mode)
        try: drive(page, app_mode)
        finally: ctx.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all link checks passed")
sys.exit(1 if fails else 0)
