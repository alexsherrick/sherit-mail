#!/usr/bin/env python3
"""A phone held sideways reads a conversation the way it does upright: the actions in a bar at the bottom and the reply a sheet that
opens on Reply, not the desktop layout, whose header, two rows of actions and always-open reply box left no room for the mail.

On Android, with the phone sideways, an open mail showed the reply box and the header and left no room to
read it, so the reply should not always be open on a phone. The phone layout keyed on width alone (max-width 699px); the
Pixel sideways is about 918 x 411 CSS px, so it got the desktop layout. The phone block (app.html) and phoneUI() (app.js) now also match
a touch screen under 500 px tall. Controls: a Mac window of the same height (a mouse, so hover) and a tablet keep the
desktop layout; an upright phone is unchanged. Usage: python3 test/landscape.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
STATE = """() => { const cs = (q) => getComputedStyle(document.querySelector(q)); const msgs = document.querySelector('#msgs').getBoundingClientRect();
  const bar = document.querySelector('#actions').getBoundingClientRect(); const fixedBar = cs('#actions').position === 'fixed';
  return { hoverNone: matchMedia('(hover: none)').matches, replyShown: cs('#replybox').display !== 'none', replying: document.querySelector('#app').classList.contains('replying'),
    fixedBar, replyBtn: !!document.querySelector('#actions [data-act="reply"]') && cs('#actions [data-act="reply"]').display !== 'none',
    room: Math.round(Math.min(fixedBar ? bar.top : innerHeight, msgs.bottom) - msgs.top), inner: innerHeight }; }"""
# `room` is the mail's own box, clipped by the bar or the screen: in the desktop layout the reply box below it takes its height.
CASES = [("phone sideways", {"width": 918, "height": 411}, True, "phone"),
         ("phone upright", {"width": 411, "height": 918}, True, "phone"),
         ("Mac window, 411 px tall", {"width": 918, "height": 411}, False, "desktop"),
         ("tablet", {"width": 900, "height": 1180}, True, "desktop")]
with sync_playwright() as pw:
    for engine in (pw.chromium, pw.webkit):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        for label, vp, touch, want in CASES:
            opts = {"viewport": vp, "has_touch": touch}
            if touch and name == "chromium": opts["is_mobile"] = True
            ctx = b.new_context(**opts); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 500)
            if touch and not page.evaluate("() => matchMedia('(hover: none)').matches"): print(f"note {name} {label}: touch emulation here does not report (hover: none); skipped"); ctx.close(); continue
            page.evaluate("() => window.mh.openThread([...document.querySelectorAll('.t')][0].dataset.key)"); preview.settle(page, 600)
            s = page.evaluate(STATE)
            if want == "phone":
                check(not s["replyShown"] and not s["replying"], f"{name} {label}: the conversation opens with the reply sheet closed (reply shown {s['replyShown']})")
                check(s["fixedBar"] and s["replyBtn"], f"{name} {label}: the actions are a bar at the bottom with a Reply button (fixed {s['fixedBar']}, Reply {s['replyBtn']})")
                check(s["room"] >= 0.55 * s["inner"], f"{name} {label}: the mail has most of the screen ({s['room']} of {s['inner']} px)")
                if s["replyBtn"]:
                    page.click('#actions [data-act="reply"]'); preview.settle(page, 300); s2 = page.evaluate(STATE)
                    check(s2["replying"] and s2["replyShown"], f"{name} {label}: Reply opens the sheet")
                    page.click("#rclose"); preview.settle(page, 300); s3 = page.evaluate(STATE)
                    check(not s3["replying"] and not s3["replyShown"], f"{name} {label}: its close button closes it")
            else:
                check(s["replyShown"] and not s["fixedBar"], f"{name} {label}: CONTROL — the desktop layout, reply box open and actions in the header (reply shown {s['replyShown']}, bar fixed {s['fixedBar']})")
            check(not errs, f"{name} {label}: no page errors {errs[:2]}")
            ctx.close()
        b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all landscape checks passed")
sys.exit(1 if fails else 0)
