#!/usr/bin/env python3
"""A mail that fits the pane keeps its pictures at the size the mail gives them: on WebKit and Chromium.

Its pictures were drawn wrong, not as YC laid them out. The
frame gave every picture `max-width:100%`, and a picture with a percentage max-width in an auto-width table cell counts as zero wide
when the table sizes its columns (CSS Sizing 3), so the text beside it took its room: the 100 px logos were drawn smaller and over
their titles, and Stripe's 94 px invoice picture was squeezed into its 76 px cell (to 0 px in the real mail at 565 and 800 px). The
shrink now applies only to a mail wider than the pane.

At a Mac window and a phone width:
  - YC's Launchpad cards (their markup, three of their titles): every logo is 100 px and clear of its title by its 25 px margin;
  - Stripe's invoice row: the 94 x 91 picture is drawn at 94 x 91;
  - a 2000 px photo with no width, arriving late: it ends inside the pane and the mail is not scaled (the shrink still works);
  - a fixed 600 px newsletter on the phone ends inside the pane;
  - the shrink is on for those two and off for YC and Stripe;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the YC and Stripe checks and the shrink check (it has no shrink switch),
and passes the photo and newsletter checks with the same sizes. Usage: python3 test/imgfit.py"""
import os, sys, struct, zlib, time, socketserver, threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")

def png(w, h, rgb=(200, 80, 40)):
    row = b"\x00" + bytes(rgb) * w
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * h, 1)) + chunk(b"IEND", b"")
SIZES = {"logo.png": (150, 150), "invoice.png": (188, 182), "photo.png": (2000, 1000), "hero.png": (1200, 400)}
IMGS = {k: png(*v) for k, v in SIZES.items()}

class H(preview.H):
    def do_GET(self):
        if self.path.startswith("/api/img?"):
            name = parse_qs(urlparse(self.path).query).get("u", [""])[0].rsplit("/", 1)[-1]
            if name == "photo.png": time.sleep(0.8)   # arrives after the first fit, as a real photo does
            return self._send(IMGS[name], "image/png") if name in IMGS else self._send("", "text/plain", status=404)
        return super().do_GET()
class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
srv = TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}/"

TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
# YC's Launchpad card, as sent 2026-10-18 (Gmail 0000000000000000), its Mailchimp-only properties left out.
CARD = """<table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse"><tr><td>
<div class="launch" style="border:2px solid #000;border-radius:15px;padding:15px;margin-bottom:20px;display:flex;align-items:center">
<table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse"><tr>
<td valign="middle"><a href="https://ex.com/c"><img class="companyimg" height="100" src="https://cdn.ex.com/logo.png" width="100" style="border:0;height:auto !important;outline:none;float:left;margin-left:10px;margin-right:25px"></a></td>
<td valign="top"><div style="overflow:hidden"><div style="overflow:hidden"><a class="launchtitle" href="https://ex.com/t" style="font-size:19px;line-height:1.3;color:#000 !important;font-weight:600 !important;text-decoration:none !important">{title}</a></div>
<div class="launchtagline" style="padding:4px 0 8px;font-weight:200;color:#000;line-height:1.3;overflow:hidden">{tag}</div></div></td>
</tr></table></div></td></tr></table>"""
YC = ('<div style="max-width:600px;margin:0 auto;font:16px Helvetica,Arial,sans-serif">'
      + CARD.format(title="Collar: The AI for public company Investor Relations", tag="Find the right investors. Prepare for earnings. Answer analyst questions live with approved company information.")
      + CARD.format(title="Rhem Labs: Health assistant robots for your parents", tag="Rhem handles everything that doesn’t need a pair of hands, while keeping you in the loop.")
      + CARD.format(title="Maritime: Fully managed cloud for running AI agents at scale", tag="Run millions of agents, each on its own isolated, persistent VM.")
      + "</div>")
# Stripe's invoice row (hub sample): the text cell and a 76 px cell holding a 94 x 91 picture.
STRIPE = """<table cellpadding="0" cellspacing="0" style="width:100%"><tr>
<td style="border:0;margin:0;padding:0"><span style="font:24px sans-serif;font-weight:500">Invoice from a long company name for this month's services</span><br><span style="color:#7A7A7A;font-size:14px">Paid October 8, 2026</span></td>
<td style="border:0;margin:0;padding:0;width:76px;max-width:76px"><img id="inv" src="https://cdn.ex.com/invoice.png" width="94" height="91" style="border:0;margin:0 auto;padding:0;display:block;border-radius:8px" alt="invoice illustration"></td>
</tr></table>"""
PHOTO = """<div style="font:16px sans-serif"><p>Here is the photo from Saturday.</p><img id="photo" src="https://cdn.ex.com/photo.png" alt=""><p>See you soon.</p></div>"""
NEWS = """<table width="600" style="width:600px" cellpadding="0" cellspacing="0"><tr><td><img id="hero" src="https://cdn.ex.com/hero.png" width="600" style="display:block"></td></tr>
<tr><td style="font:16px sans-serif">A fixed-width newsletter, six hundred pixels wide, the way most marketing mail is built.</td></tr></table>"""

OPEN = """async ([k, tid, html]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k);
  const fr = document.querySelector('#msgs iframe'); const t0 = Date.now();
  while (Date.now() - t0 < 6000) { const d = fr.contentDocument; if (d && d.images.length && [...d.images].every((im) => im.complete && im.naturalWidth)) break; await new Promise((res) => setTimeout(res, 100)); }
  await new Promise((res) => setTimeout(res, 700));
  const d = fr.contentDocument, R = (el) => { const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
  return { fit: fr._fit, pane: fr.clientWidth, shrink: d.documentElement.hasAttribute('data-mh-shrink'),
    logos: [...d.querySelectorAll('img.companyimg')].map((im) => ({ ...R(im), title: R(im.closest('td').nextElementSibling.querySelector('.launchtitle')).left })),
    imgs: Object.fromEntries([...d.querySelectorAll('img[id]')].map((im) => [im.id, R(im)])) }; }"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        for label, vp in (("Mac window", {"width": 1000, "height": 640}), ("phone", {"width": 390, "height": 844})):
            page = b.new_page(viewport=vp); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
            y = page.evaluate(OPEN, [KEY, TID, YC]); f = y["fit"] or {}
            sizes = [(l["w"], l["h"]) for l in y["logos"]]; gaps = [l["title"] - l["right"] for l in y["logos"]]
            check(len(sizes) == 3 and all(s == (100, 100) for s in sizes), f"{name} {label}: YC's logos are 100 x 100 ({sizes}, pane {y['pane']} px, scale {f.get('scale')})")
            check(len(gaps) == 3 and all(g >= 24 for g in gaps), f"{name} {label}: each logo is clear of its title by its 25 px margin (gaps {gaps})")
            check(f.get("scale") == 1, f"{name} {label}: the YC mail fits the pane unscaled (scale {f.get('scale')})")
            s = page.evaluate(OPEN, [KEY, TID, STRIPE]); inv = s["imgs"].get("inv") or {}
            check((inv.get("w"), inv.get("h")) == (94, 91), f"{name} {label}: Stripe's invoice picture is 94 x 91 ({inv.get('w')} x {inv.get('h')})")
            p = page.evaluate(OPEN, [KEY, TID, PHOTO]); ph = p["imgs"].get("photo") or {}; pf = p["fit"] or {}
            check(0 < ph.get("w", 0) <= p["pane"] and pf.get("scale") == 1,
                  f"{name} {label}: a late 2000 px photo with no width ends inside the pane, unscaled ({ph.get('w')} px in {p['pane']}, scale {pf.get('scale')})")
            on = {"YC": y["shrink"], "Stripe": s["shrink"], "photo": p["shrink"]}
            if label == "phone":
                n = page.evaluate(OPEN, [KEY, TID, NEWS]); nf = n["fit"] or {}; hero = n["imgs"].get("hero") or {}; on["newsletter"] = n["shrink"]
                check(hero.get("w", 0) * (nf.get("scale") or 1) <= n["pane"],
                      f"{name} {label}: a 600 px newsletter ends inside the pane (hero {hero.get('w')} px x scale {nf.get('scale')}, pane {n['pane']})")
            check(on == {k: k not in ("YC", "Stripe") for k in on}, f"{name} {label}: the shrink is on only for the mail wider than the pane ({on})")
            check(not errs, f"{name} {label}: no page errors {errs[:2]}")
            page.close()
        b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all imgfit checks passed")
sys.exit(1 if fails else 0)
