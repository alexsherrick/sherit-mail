#!/usr/bin/env python3
"""Mail in dark mode (A Google Calendar invitation mixed light and dark mode in its content). The message
frame is white paper; the invitation declared dark support and carried dark rules that turned its text near-white, so on a dark
device it read white on white. Pins: mail that declares dark support AND has dark rules is drawn dark when the app is dark, under its
own rules; mail with dark rules but no declaration stays on white with them switched off; mail that only declares, or has neither, is
untouched. Checked in Chromium (Android) and WebKit (Mac), and across a theme change while the message is open.
Usage: python3 test/maildark.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
DARK_RULES = "<style>.t{color:#3c4043}@media (prefers-color-scheme: dark){.t{color:#e8eaed !important}}</style>"
INVITE = '<html><head><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' + DARK_RULES + '</head><body><div class="t">Join us Wednesday</div></body></html>'
UNDECLARED = '<html><head>' + DARK_RULES + '</head><body><div class="t">Your receipt</div><picture><source srcset="https://x.example/dark.png" media="(prefers-color-scheme: dark)"><img src="https://x.example/light.png"></picture></body></html>'
CASES = {
  "invite": (INVITE, "dark"),
  "css-declared": ('<style>:root{color-scheme:light dark}@media (prefers-color-scheme:dark){.t{color:#fff}}</style><div class="t">x</div>', "dark"),
  "reversed-meta": ('<meta content="light dark" name="color-scheme"><style>@media (prefers-color-scheme: dark){.t{color:#fff}}</style><div class="t">x</div>', "dark"),
  "undeclared": (UNDECLARED, "paper"),
  "media-attr-only": ('<picture><source srcset="https://x.example/d.png" media="(prefers-color-scheme: dark)"><img src="https://x.example/l.png"></picture>', "paper"),
  "declared-no-rules": ('<meta name="color-scheme" content="light dark"><p style="color:#333">plain</p>', "light"),
  "plain": ('<p>hello</p>', "light"),
  "two-media-queries": ('<picture><source srcset="https://x.example/d.png" media="(prefers-color-scheme: dark), (prefers-color-scheme:dark) and (min-width: 1px)"><img src="https://x.example/l.png"></picture>', "paper"),
  "light-only-meta": ('<meta name="color-scheme" content="light only"><style>@media (prefers-color-scheme: dark){.t{color:#fff}}</style><div class="t">x</div>', "paper"),
}
RENDER = """(html) => { const docs = []; const h = messageHtml({ id: 'x', html, from: 'A <a@example.com>', fromAddr: 'a@example.com', to: 'me@example.com', date: Date.now(), subject: 's' }, 0, 1, docs);
  let ov = document.querySelector('#ov'); if (ov) ov.remove(); ov = document.createElement('div'); ov.id = 'ov'; ov.style.cssText = 'position:fixed;inset:0;z-index:99;background:var(--bg)';
  ov.innerHTML = h; document.body.appendChild(ov); mountBodies(ov, docs); return docs[0]; }"""
PROBE = """() => { const f = document.querySelector('#ov iframe'), d = f.contentDocument, w = d.defaultView, t = d.querySelector('.t');
  return { body: w.getComputedStyle(d.body).backgroundColor, text: t && w.getComputedStyle(t).color, frame: getComputedStyle(f).backgroundColor, dark: f.hasAttribute('data-dark') }; }"""
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(); page = ctx.new_page(); page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
    for name, (html, want) in CASES.items():
        got = page.evaluate("(h) => mailTheme(h)", html); check(got == want, f"{name}: {want} ({got})")
    doc = page.evaluate(RENDER, UNDECLARED)
    check("prefers-color-scheme: dark" not in doc and doc.count("prefers-color-scheme: x-off") == 2, "undeclared: its dark rule AND its <picture> dark source are switched off")
    doc2 = page.evaluate(RENDER, CASES["two-media-queries"][0])
    check(not __import__("re").search(r"prefers-color-scheme\s*:\s*dark", doc2) and doc2.count("x-off") == 2, "every dark query in one media attribute is switched off, not only the first")
    ctx.close(); b.close()
    for engine in ("chromium", "webkit"):
        b = getattr(pw, engine).launch()
        ctx = b.new_context(color_scheme="dark", viewport={"width": 411, "height": 900}); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
        page.evaluate(RENDER, INVITE); preview.settle(page, 500); p = page.evaluate(PROBE)
        check(p["body"] == "rgb(26, 27, 32)" and p["frame"] == "rgb(26, 27, 32)" and p["text"] == "rgb(232, 234, 237)" and p["dark"], f"{engine}, dark: the invitation is drawn on the dark card with its own light text {p}")
        page.emulate_media(color_scheme="light"); preview.settle(page, 400); p = page.evaluate(PROBE)
        check(p["body"] == "rgb(255, 255, 255)" and p["frame"] == "rgb(255, 255, 255)" and p["text"] == "rgb(60, 64, 67)", f"{engine}: switched to light while open, it is white paper with dark text {p}")
        page.emulate_media(color_scheme="dark"); page.evaluate(RENDER, UNDECLARED); preview.settle(page, 500); p = page.evaluate(PROBE)
        check(p["body"] == "rgb(255, 255, 255)" and p["frame"] == "rgb(255, 255, 255)" and p["text"] == "rgb(60, 64, 67)" and not p["dark"], f"{engine}, dark: undeclared dark rules are off, it stays readable on white {p}")
        page.evaluate(RENDER, '<p class="t" style="color:#333">plain</p>'); preview.settle(page, 300); p = page.evaluate(PROBE)
        check(p["body"] == "rgb(255, 255, 255)" and p["text"] == "rgb(51, 51, 51)", f"{engine}, dark: plain mail is unchanged {p}")
        check(not errs, f"{engine}: page errors {errs[:2]}")
        ctx.close(); b.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all mail dark-mode checks passed")
sys.exit(1 if fails else 0)
