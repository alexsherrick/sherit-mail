#!/usr/bin/env python3
"""An opened mail holds every picture's box before the picture arrives: on WebKit and Chromium.

A mail grew in steps as its pictures loaded, instead of coming up all at once. The
text was written at once and each picture then arrived with no box held for it, so the mail grew in steps. The hub now measures each
picture it keeps and the app gives it `aspect-ratio: auto w / h` from those sizes before the first paint.

Every picture here is served 0.8 s late by the test server. Checks, at a Mac window and a phone width:
  - with the sizes synced, the frame keeps the height it first painted at while the pictures come in;
  - CONTROL: without them, the same mail grows (the steps the user saw), so the measurement can see the fault;
  - once loaded, every picture is the same size with and without the sizes (a shop newsletter's width-only hero, a width-only picture with
    max-width, a width in the inline style, one with both attributes, a srcset), so no mail looks different;
  - pictures with no width (a height only, or no size: the frame's img{height:auto} gives them their natural size) are left exactly
    as before, styles, first paint and final size alike;
  - a picture with both attributes is left alone; no page errors.
Usage: python3 test/imgdims.py"""
import sys, struct, zlib, time, socketserver, threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

def png(w, h, rgb=(200, 80, 40)):
    row = b"\x00" + bytes(rgb) * w
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * h, 1)) + chunk(b"IEND", b"")
SIZES = {"hero.png": (979, 1143), "wide.png": (600, 200), "small.png": (200, 50), "both.png": (120, 30), "set.png": (200, 100), "set2.png": (400, 200), "tall.png": (300, 700), "css.png": (600, 300), "bare.png": (180, 120)}
IMGS = {k: png(*v) for k, v in SIZES.items()}
DELAY = 0.8

class H(preview.H):
    def do_GET(self):
        if self.path.startswith("/api/img?"):
            u = parse_qs(urlparse(self.path).query).get("u", [""])[0]; name = u.rsplit("/", 1)[-1]
            time.sleep(DELAY)
            if name in IMGS: return self._send(IMGS[name], "image/png")
            return self._send("", "text/plain", status=404)
        return super().do_GET()
class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
srv = TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}/"

TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
MAIL = """<div style="max-width:600px;margin:0 auto;font:16px sans-serif">
<p>Shop the new collection before everyone else.</p>
<img id="hero" src="https://cdn.ex.com/hero.png" width="600" style="display:block;width:100%;height:auto" alt="Early Access" title="Early Access">
<p>Middle text between the pictures.</p>
<img id="wide" src="https://cdn.ex.com/wide.png" width="300" style="max-width:100%" alt="">
<img id="css" src="https://cdn.ex.com/css.png" style="width:100%" alt="">
<img id="both" src="https://cdn.ex.com/both.png" width="120" height="30" alt="">
<img id="set" src="https://cdn.ex.com/set.png" srcset="https://cdn.ex.com/set.png 1x, https://cdn.ex.com/set2.png 2x" width="200" alt="">
<p>Bottom text after every picture.</p></div>"""
UNSIZED = """<div style="max-width:600px;margin:0 auto;font:16px sans-serif"><p>Pictures with no width.</p>
<img id="small" src="https://cdn.ex.com/small.png" height="50" alt=""><img id="tall" src="https://cdn.ex.com/tall.png" height="45" alt="">
<img id="bare" src="https://cdn.ex.com/bare.png" alt=""><p>After them.</p></div>"""
SYNC = """async (sizes) => { const days = { [new Date().toISOString().slice(0, 10)]: Object.entries(sizes).map(([n, [w, h]]) => [window.mh.urlHash(new URL('https://cdn.ex.com/' + n).href), w, h]) };
  window.__mock.routes['GET /api/imgdims?'] = { seq: 7, days, more: false }; await window.mh.syncImgDims({ force: true }); return window.mh.imgDims.size; }"""
OPEN = """async ([k, tid, html, clear]) => { if (clear) window.mh.imgDims.clear();
  const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k); await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  const fr = () => document.querySelector('#msgs iframe'); const first = fr().offsetHeight, seen = new Set([first]);
  const d = fr().contentDocument; const t0 = performance.now();
  while (performance.now() - t0 < 4000 && ![...d.images].every((im) => im.complete)) { seen.add(fr().offsetHeight); await new Promise((res) => setTimeout(res, 40)); }
  for (let i = 0; i < 8; i++) { seen.add(fr().offsetHeight); await new Promise((res) => setTimeout(res, 40)); }
  const rects = {}; for (const im of d.images) { const b = im.getBoundingClientRect(); rects[im.id] = [Math.round(b.width * 10) / 10, Math.round(b.height * 10) / 10]; }
  return { first, final: fr().offsetHeight, heights: [...seen], rects, loaded: [...d.images].every((im) => im.complete && im.naturalWidth > 0),
           styled: Object.fromEntries([...d.images].map((im) => [im.id, im.style.getPropertyValue('aspect-ratio')])) }; }"""

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        for label, vp in (("Mac window", {"width": 1000, "height": 760}), ("phone", {"width": 390, "height": 844})):
            page = b.new_page(viewport=vp); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
            n = page.evaluate(SYNC, {k: list(v) for k, v in SIZES.items()})
            check(n >= len(SIZES), f"{name} {label}: the sizes sync into the app ({n} known)")
            on = page.evaluate(OPEN, [KEY, TID, MAIL, False])
            off = page.evaluate(OPEN, [KEY, TID, MAIL, True])
            check(on["loaded"] and off["loaded"], f"{name} {label}: every picture loaded in both opens")
            check(abs(on["final"] - on["first"]) <= 1 and len(on["heights"]) <= 2, f"{name} {label}: with the sizes the mail keeps its first height while its pictures arrive ({on['first']} -> {on['final']} px, heights seen {sorted(on['heights'])})")
            check(off["final"] - off["first"] > 100, f"{name} {label}: CONTROL — without them the same mail grows as its pictures arrive ({off['first']} -> {off['final']} px)")
            same = all(abs(a - c) <= 0.5 for k in on["rects"] for a, c in zip(on["rects"][k], off["rects"][k]))
            check(same and abs(on["final"] - off["final"]) <= 1, f"{name} {label}: once loaded every picture is the size it is without the sizes ({on['rects']} vs {off['rects']})")
            check(not on["styled"]["both"] and all(on["styled"][k] for k in ("hero", "wide", "css", "set")), f"{name} {label}: a picture with both attributes is left alone; the others get the hub's ratio ({on['styled']})")
            page.evaluate(SYNC, {k: list(v) for k, v in SIZES.items()}); un = page.evaluate(OPEN, [KEY, TID, UNSIZED, False]); unoff = page.evaluate(OPEN, [KEY, TID, UNSIZED, True])
            check(not any(un["styled"].values()) and un["first"] == unoff["first"] and un["rects"] == unoff["rects"] and un["final"] == unoff["final"],
                  f"{name} {label}: pictures with no width are left exactly as before (styles {un['styled']}; first {un['first']} vs {unoff['first']}; final {un['rects']})")
            check(not errs, f"{name} {label}: no page errors {errs[:2]}")
            page.close()
        b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all picture-size checks passed")
sys.exit(1 if fails else 0)
