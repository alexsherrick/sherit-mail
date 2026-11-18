#!/usr/bin/env python3
"""A mail whose attributes are written with no space between them keeps its pictures: on WebKit and Chromium.

Founder: a hotel newsletter showed none of its photos. Revinate's
template writes `border="0"src="https://img.revinate.com/…"alt="Hotel Logo"`. HTML reads the attribute after the closing quote (WHATWG
13.2.5.39: a missing-whitespace-between-attributes parse error, reconsumed as the next attribute's name); the hub's readers wanted
whitespace before the name, so nine pictures were never rewritten to /api/img and the frame's CSP refused them: empty boxes with the
alt text. The pixel, written with spaces, was blocked as before.

The fixture (test/glued.html) is that mail's ten <img> tags verbatim, plus the same habit on a td background, an img srcset, a <source>
srcset holding a tracker candidate, and a td background that is a tracker. At a Mac window width, in each engine:
  - the nine pictures are rewritten to /api/img and drawn (a natural width, from this test's own /api/img);
  - the SendGrid pixel is blanked and named, and no sendgrid.net URL is left anywhere in the frame (the glued src, the glued <source>
    candidate and the glued td background all go);
  - the glued td background, the glued srcset's candidates and the <source>'s surviving candidate are proxied;
  - nothing in the page asked img.revinate.com or sendgrid.net for anything, and Chromium's CSP refused nothing;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the proxied, drawn, sendgrid-free, background, srcset and <source>
checks, and on Chromium the no-direct-request check (WebKit never issues a request its CSP refuses), and passes the rest. Usage: python3 test/glued.py"""
import os, sys, struct, zlib, socketserver, threading
from pathlib import Path
from urllib.parse import urlparse
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
MAIL = (Path(__file__).resolve().parent / "glued.html").read_text()

def png(w, h, rgb=(200, 80, 40)):
    row = b"\x00" + bytes(rgb) * w
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * h, 1)) + chunk(b"IEND", b"")
PIC = png(20, 20)
class H(preview.H):
    def do_GET(self):
        if self.path.startswith("/api/img?"): return self._send(PIC, "image/png")   # every proxied picture is this 20 px square
        return super().do_GET()
class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
srv = TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}/"
KEY = "hub|11111111-1111-1111-1111-111111111111"; TID = "11111111-1111-1111-1111-111111111111"
PROXIED = "/api/img?u=https%3A%2F%2Fimg.revinate.com%2F"
prox = lambda s: (s or "").startswith(PROXIED)
first = lambda srcset: (srcset or "").split(",")[0].strip().split(" ")[0]
fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        page = b.new_page(viewport={"width": 1280, "height": 792}); errs = []; asked = []; csp = []
        page.on("pageerror", lambda e: errs.append(str(e))); page.on("request", lambda r: asked.append(r.url))
        page.on("requestfailed", lambda r: csp.append(r.url) if r.failure == "csp" else None)   # Chromium reports a request its CSP refused; WebKit never issues it
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 500)
        page.evaluate("""([tid, html]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; }); }""", [TID, MAIL])
        info = page.evaluate("""async (k) => { window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((r) => r.key));
            await window.mh.cachedThread(window.mh.state.threads.get(k)); await window.mh.openThread(k);
            // until the nine pictures are drawn, up to 10 s: a fixed 2.5 s ran out with twelve tests at once
            for (let t = Date.now(); Date.now() - t < 10000; await new Promise((r) => setTimeout(r, 50))) { const d = document.querySelector('#msgs iframe')?.contentDocument;
              const im = d ? [...d.querySelectorAll('img')] : []; if (im.length >= 12 && im.slice(0, 9).every((i) => i.naturalWidth > 0)) break; }
            const doc = document.querySelector('#msgs iframe').contentDocument;
            return { imgs: [...doc.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src') || '', srcset: i.getAttribute('srcset') || '', alt: i.getAttribute('alt'), tracker: i.getAttribute('data-mh-tracker'), w: i.naturalWidth })),
                     tds: [...doc.querySelectorAll('td[background]')].map((t) => t.getAttribute('background')),
                     sources: [...doc.querySelectorAll('source')].map((s) => s.getAttribute('srcset') || ''),
                     html: doc.documentElement.outerHTML, note: document.body.innerText }; }""", KEY)
        imgs = info["imgs"]
        check(len(imgs) == 12, f"{name}: the frame holds the mail's 12 <img> ({len(imgs)})")
        if len(imgs) == 12:
            ace, pixel, two, pic = imgs[:9], imgs[9], imgs[10], imgs[11]
            check(all(prox(i["src"]) for i in ace), f"{name}: the nine pictures are rewritten to the hub's image proxy ({sum(prox(i['src']) for i in ace)} of 9; first src {ace[0]['src'][:72]!r})")
            check(all(i["w"] > 0 for i in ace), f"{name}: and drawn ({sum(i['w'] > 0 for i in ace)} of 9 have a natural width)")
            check(pixel["tracker"] == "SendGrid" and pixel["src"].startswith("data:image/gif"), f"{name}: the SendGrid pixel is blanked and named ({pixel['tracker']}, {pixel['src'][:20]})")
            cands = [c.strip().split(" ")[0] for c in two["srcset"].split(",")]
            check(len(cands) == 2 and all(prox(c) for c in cands) and prox(two["src"]), f"{name}: the glued srcset's two candidates and its src are proxied ({two['srcset'][:80]!r})")
            check(len(info["sources"]) == 1 and prox(first(info["sources"][0])) and "sendgrid" not in info["sources"][0] and prox(pic["src"]), f"{name}: the <source> keeps its picture candidate, proxied, and loses the tracker ({info['sources'][0][:80]!r})")
        check("sendgrid.net" not in info["html"], f"{name}: no sendgrid.net URL is left anywhere in the frame (glued src, <source> candidate, td background)")
        check(len(info["tds"]) == 2 and prox(info["tds"][0]) and info["tds"][1].startswith("data:image/gif"), f"{name}: the glued td background is proxied and the tracker background is a blank pixel ({[t[:40] for t in info['tds']]})")
        check("SendGrid" in info["note"], f"{name}: the mail says a SendGrid tracker was blocked")
        leaked = [u for u in asked if (urlparse(u).hostname or "").endswith(("revinate.com", "sendgrid.net"))]   # by host: a proxied URL carries the sender's host in its query
        check(not leaked and not csp, f"{name}: nothing asked the sender for a picture and the CSP refused nothing ({len(leaked)} direct, {len(csp)} refused)")
        check(not errs, f"{name}: no page errors {errs}")
        b.close()
srv.shutdown()
print("all glued checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
