#!/usr/bin/env python3
"""Screenshot preview of the client at phone / tablet / desktop widths with the fake network from test/mock-fetch.js.
Serves src/client over a local HTTP server (so IndexedDB, workers and OPFS behave like production), drives headless Chromium
with Playwright, writes PNGs + a report. Usage: python3 test/preview.py [outdir] (default: /tmp/mail-preview)"""
import http.server, threading, socketserver, sys, os, json, time, functools, re
from pathlib import Path
from playwright.sync_api import sync_playwright

HUB = Path(__file__).resolve().parent.parent
CLIENT = HUB / "src" / "client"
PUBLIC = HUB / "public"   # immutable files now ship as Workers Static Assets from./public
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/mail-preview"); OUT.mkdir(parents=True, exist_ok=True)
BUNDLE = "\n".join((CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]).replace("__VERSION__", "test")
# The hub's script policy for the shell (index.js SHELL_CSP), sent when a test asks: preview.CSP = True, or PREVIEW_CSP=1.
# Not by default: Playwright evaluates a wait_for_function given as an expression string with eval, which the policy refuses.
CSP = os.environ.get("PREVIEW_CSP") == "1"
NONCE = "testnonce0123456789"
SHELL_CSP = re.search(r'const SHELL_CSP = "([^"]+)";', (HUB / "src/index.js").read_text()).group(1).replace("__NONCE__", NONCE)
SHELL = (CLIENT / "app.html").read_text().replace("__VERSION__", "test").replace("__NONCE__", NONCE).replace(f'<script nonce="{NONCE}" src="/app.js?v=test"></script>', f'<script nonce="{NONCE}" src="/mock-fetch.js"></script><script nonce="{NONCE}" src="/app.js"></script>')
assert "/mock-fetch.js" in SHELL, "the shell's app.js tag changed: preview.py could not put the fake network in front of it"
MOCK = (HUB / "test" / "mock-fetch.js").read_text()

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        p = self.path.split("?")[0]
        if p in ("/", "/index.html"): return self._send(SHELL, "text/html; charset=utf-8", {"x-app-shell": "1", **({"content-security-policy": SHELL_CSP} if CSP else {})})
        if p == "/app.js": return self._send(BUNDLE, "text/javascript; charset=utf-8")
        if p == "/mock-fetch.js": return self._send(MOCK, "text/javascript; charset=utf-8")
        if p == "/sw.js": return self._send("", "text/javascript", status=404)
        if p == "/search.worker.js": return self._send((PUBLIC / "search.worker.js").read_bytes(), "text/javascript; charset=utf-8")
        if p == "/sqlite3.mjs": return self._send((PUBLIC / "sqlite3.mjs").read_bytes(), "text/javascript; charset=utf-8")
        if p == "/sqlite3.wasm": return self._send((PUBLIC / "sqlite3.wasm").read_bytes(), "application/wasm")
        if p in ("/pdf.min.mjs", "/pdf.worker.min.mjs"): return self._send((PUBLIC / p[1:]).read_bytes(), "text/javascript; charset=utf-8")
        if p.startswith("/pdfjs/"):   # pdf.js's decoders, with the CORS header hub/public/_headers gives them
            f = PUBLIC / p[1:]
            if ".." in p or not f.is_file(): return self._send("", "text/plain", status=404)
            return self._send(f.read_bytes(), "application/wasm" if p.endswith(".wasm") else "text/javascript; charset=utf-8", {"Access-Control-Allow-Origin": "*"})
        if p == "/manifest.webmanifest": return self._send((CLIENT / "manifest.webmanifest").read_bytes(), "application/manifest+json")
        if p.startswith("/icons/"): f = PUBLIC / "icons" / p.split("/")[-1]; return self._send(f.read_bytes(), "image/png") if f.exists() else self._send("", "text/plain", status=404)
        return self._send("", "text/plain", status=404)
    def _send(self, body, ctype, extra=None, status=200):
        if isinstance(body, str): body = body.encode()
        self.send_response(status); self.send_header("content-type", ctype); self.send_header("content-length", str(len(body))); self.send_header("cache-control", "no-store")
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)

# Wait up to `ms`, but only until the page is quiet: mock-fetch.js tracks timers, idle callbacks, requests, IndexedDB
# transactions, animations and loading frames, and window.__settle(ms) resolves when nothing is due inside the window. It is never
# longer than the fixed wait it replaces; a page without the tracker (or one navigating away) gets the plain wait.
SETTLE_LOG = []   # (ms asked, ms taken, "quiet" or "cap: <what kept it busy>"), printed at exit with SETTLE_STATS=1
def settle(page, ms):
    t = time.time()
    try:
        why = page.evaluate("(ms) => typeof window.__settle === 'function' ? window.__settle(ms) : 'none'", ms)
        if why != "none": SETTLE_LOG.append((ms, (time.time() - t) * 1000, why)); return
    except Exception: pass
    page.wait_for_timeout(ms); SETTLE_LOG.append((ms, ms, "fixed"))
def _settle_stats():
    if not SETTLE_LOG or os.environ.get("SETTLE_STATS") != "1": return
    asked, took = sum(x[0] for x in SETTLE_LOG), sum(x[1] for x in SETTLE_LOG); by = {}
    for a, t, w in SETTLE_LOG: k = w.split(" in ")[0] if w.startswith("cap: timer") else w; b = by.setdefault(k, [0, 0]); b[0] += 1; b[1] += t
    print(f"[settle] {len(SETTLE_LOG)} waits: asked {asked / 1000:.1f} s, took {took / 1000:.1f} s; " + "; ".join(f"{k} x{n} {t / 1000:.1f} s" for k, (n, t) in sorted(by.items(), key=lambda kv: -kv[1][1])))
import atexit; atexit.register(_settle_stats)

# The passes against an older app.js prove a test catches what it was written for; that is settled when the test is written, so they
# run only when asked: CONTROL=1 python3 test/<name>.py, or test/run_all.py --control.
CONTROL = os.environ.get("CONTROL") == "1"
def control_skipped(name): print(f"skip CONTROL pass of {name} (CONTROL=1 runs it)")

# One thread per connection: a browser holds a connection it opened early and sends nothing on it, and a server that
# serves one connection at a time waited on it while the page's requests queued behind (addrlock.py stopped 30 s at its first load,
# 5 runs in 5; threaded, 0 in 5).
class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
def serve(handler=None):
    srv = TS(("127.0.0.1", 0), handler or H); t = threading.Thread(target=srv.serve_forever, daemon=True); t.start(); return srv

DEVICES = [("phone", dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)),
           ("tablet", dict(viewport={"width": 900, "height": 1180}, device_scale_factor=2, is_mobile=True, has_touch=True)),
           ("desktop", dict(viewport={"width": 1440, "height": 900}, device_scale_factor=1))]

def run():
    srv = serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"; report = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for dev, opts in DEVICES:
            for scheme in ("light", "dark"):
                ctx = browser.new_context(color_scheme=scheme, **opts); page = ctx.new_page(); errs = []
                page.on("pageerror", lambda e: errs.append("pageerror: " + str(e))); page.on("console", lambda m: errs.append("console." + m.type + ": " + m.text) if m.type in ("error",) else None)
                page.goto(base); page.wait_for_function("window.mh && window.mh.state && window.mh.state.threads.size >= 4", timeout=15000); page.wait_for_timeout(600)
                tag = f"{dev}-{scheme}"; shot = lambda name: page.screenshot(path=str(OUT / f"{tag}-{name}.png"), full_page=False)
                rows = page.evaluate("document.querySelectorAll('#threads .t').length"); shot("01-list")
                # open the first thread with a real click (as a user would)
                page.click("#threads .t >> nth=0"); page.wait_for_timeout(500); shot("02-thread")
                # narrow layouts: the drawer / menu
                if dev != "desktop":
                    if page.is_visible("#back"): page.click("#back"); page.wait_for_timeout(200)
                    btn = "#menuBtn"
                    if page.query_selector(btn) and page.is_visible(btn): page.click(btn); page.wait_for_timeout(300); shot("03-menu"); page.keyboard.press("Escape"); page.wait_for_timeout(200)
                else:
                    if page.query_selector("#sidelock"): page.click("#sidelock"); page.wait_for_timeout(300); shot("03-unlocked"); page.mouse.move(3, 400); page.wait_for_timeout(300); shot("04-unlocked-hover"); page.mouse.move(700, 400); page.wait_for_timeout(300); page.click("#sidelock") if page.is_visible("#sidelock") else None; page.wait_for_timeout(200)
                page.keyboard.press("Escape"); page.wait_for_timeout(150)
                page.evaluate("window.mh.openPalette()"); page.wait_for_timeout(300); shot("05-palette"); page.keyboard.press("Escape")
                page.evaluate("document.querySelector('#composeBtn') ? document.querySelector('#composeBtn').click() : window.mh.state"); page.wait_for_timeout(300); shot("06-compose"); page.keyboard.press("Escape")
                page.evaluate("document.querySelector('#settingsBtn') && document.querySelector('#settingsBtn').click()"); page.wait_for_timeout(400); shot("07-settings"); page.keyboard.press("Escape")
                overflow = page.evaluate("Math.max(document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth)")
                mock = page.evaluate("({errors: window.__mock.errors, calls: window.__mock.calls.length})")
                perf = page.evaluate("window.mh.perf.report().boot")
                report.append({"device": tag, "rows": rows, "horizontal_overflow_px": overflow, "page_errors": errs, "unmocked": mock["errors"], "net_calls": mock["calls"], "boot": perf})
                ctx.close()
        browser.close()
    srv.shutdown()
    (OUT / "report.json").write_text(json.dumps(report, indent=1))
    for r in report: print(f"{r['device']:<14} rows={r['rows']} overflow={r['horizontal_overflow_px']}px errors={len(r['page_errors'])} unmocked={len(r['unmocked'])} net={r['net_calls']} boot={r['boot']}")
    for r in report:
        for e in r["page_errors"][:5]: print("   ", r["device"], e[:200])
    print("shots in", OUT)

if __name__ == "__main__": run()
