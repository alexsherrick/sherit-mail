#!/usr/bin/env python3
"""Settings → About in the Android app: its version, and a tap to update; on Chromium (the Android web view's engine).

About should offer a tap to update. The app's own update check runs at most every six hours, from a
fresh start, and offers the update as a notification; there was no way to ask for it. Checks, with the page told it is the Android app
(its user agent carries "SheritAndroid/1.11", as MainActivity sets it) and a stand-in for the app's bridge:
  - About shows "Android app 1.11"; with latest.json at 1.14 it offers "Update to 1.14";
  - a tap asks the app (bridge op "update") and, when the app answers "installing 1.14", says to tap Update on Android's screen;
  - an app that does not know the op (1.13 and older answer "unknown op") gets the APK's address opened outside (bridge "openExternal");
  - latest.json at the app's own version: "Up to date.", and a Check again button; latest.json missing: says it could not check.
Usage: python3 test/appupdate.py"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

BRIDGE = """([mode]) => { window.__ops = []; const b = { onmessage: null, postMessage(s) { const m = JSON.parse(s); window.__ops.push({ op: m.op, args: m.args });
  const reply = (o) => setTimeout(() => b.onmessage && b.onmessage({ data: JSON.stringify({ id: m.id, ...o }) }), 30);
  if (m.op === 'update') return reply(window.__updMode === 'old' ? { error: 'unknown op' } : { result: 'installing 1.14' });
  if (m.op === 'takeStashes' || m.op === 'activeKeys') return reply({ result: [] });
  if (m.op === 'pushDevice') return reply({ result: null });
  return reply({ result: true }); } }; window.SheritAndroid = b; }"""
fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for mode, latest in (("new", {"versionCode": 15, "versionName": "1.14", "url": "https://mail.yourdomain.example/dl/android/SheritMail-1.14.apk"}),
                         ("old", {"versionCode": 15, "versionName": "1.14", "url": "https://mail.yourdomain.example/dl/android/SheritMail-1.14.apk"}),
                         ("same", {"versionCode": 12, "versionName": "1.11", "url": "x"}), ("none", None)):
        ua = b.new_page().evaluate("() => navigator.userAgent")
        ctx = b.new_context(viewport={"width": 1000, "height": 760}, user_agent=ua + " SheritAndroid/1.11"); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(f"window.__updMode = {json.dumps(mode)};"); page.add_init_script(BRIDGE.replace("([mode]) => ", "(() => ") + ")();")
        if latest: page.add_init_script(f"window.__mockSetup = (mk) => {{ mk.routes['GET /dl/android/latest.json'] = {json.dumps(latest)}; }};")   # the app's fake network (test/mock-fetch.js); none: it answers 404
        page.goto(base); page.wait_for_function("() => window.mh && window.mh.state.threads.size >= 1", timeout=30000); preview.settle(page, 500)
        page.evaluate("() => window.mh.openSettings('about')"); preview.settle(page, 800)
        s = lambda: page.evaluate("() => ({ ver: (document.querySelector('#appver') || {}).textContent, btn: (document.querySelector('#appupd') || {}).textContent, hidden: !!(document.querySelector('#appupd') || {}).hidden, hint: (document.querySelector('#appupdhint') || {}).textContent })")
        st = s()
        if mode in ("new", "old"):
            check(st["ver"] == "1.11" and st["btn"] == "Update to 1.14" and not st["hidden"] and "1.14 is ready" in st["hint"], f"{mode}: About shows the app's version and offers the newer one ({st})")
            page.click("#appupd"); preview.settle(page, 600); st2 = s(); ops = page.evaluate("() => window.__ops.filter((o) => o.op === 'update' || o.op === 'openExternal')")
            if mode == "new": check([o["op"] for o in ops] == ["update"] and "Tap Update on Android's screen" in st2["hint"], f"new: the tap asks the app to update, and says what comes next ({ops}; {st2['hint']})")
            else: check([o["op"] for o in ops] == ["update", "openExternal"] and ops[1]["args"].get("url") == latest["url"] and "browser is downloading" in st2["hint"], f"old: an app without the op gets the APK opened outside ({ops}; {st2['hint']})")
        elif mode == "same": check(st["hint"] == "Up to date." and st["btn"] == "Check again" and not st["hidden"], f"same: up to date, with Check again ({st})")
        else: check("Could not check" in st["hint"] and st["btn"] == "Check again", f"none: no latest.json, says it could not check ({st})")
        check(not errs, f"{mode}: no page errors {errs[:2]}")
        ctx.close()
    b.close()
srv.shutdown()
print("all app-update checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
