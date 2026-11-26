#!/usr/bin/env python3
"""A mail is drawn in its own fonts, in WebKit (the Mac app's engine) and Chromium (Android's and Windows'). Before,
the viewer's frame allowed only data: fonts, so every web font a mail named was refused and the mail showed in its fallback font.

One mail, its fonts served the way the hub serves them (fonts from /api/img, a linked stylesheet as the hub's copy from /api/fontcss):
  - a face declared in the mail's own <style> is loaded and the text is drawn in it (its glyphs are 2 em wide, so the text is measured);
  - a face from a <link rel=stylesheet> is loaded through the hub's copy of the sheet, and drawn;
  - each face shows its text at once in the next font while its own comes (font-display: fallback, whatever the mail asked);
  - a face naming another hub address (an attachment route) is refused by the frame: nothing asks for it, the text stays in fallback;
  - warming a mail asks for its font, its stylesheet copy and the font inside that copy, before any picture;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the drawing checks (the frame refused every font).
Usage: python3 test/webfonts.py"""
import io, os, sys, socketserver, threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")

def woff2(family):
    """A real WOFF2 whose every glyph is 2 em wide: text drawn in it is measurably wider than in any fallback."""
    chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ "
    names = [".notdef"] + [f"g{ord(c)}" for c in chars]
    fb = FontBuilder(1000, isTTF=True); fb.setupGlyphOrder(names); fb.setupCharacterMap({ord(c): f"g{ord(c)}" for c in chars})
    pen = TTGlyphPen(None); pen.moveTo((0, 0)); pen.lineTo((0, 500)); pen.lineTo((500, 500)); pen.lineTo((500, 0)); pen.closePath(); box = pen.glyph()
    fb.setupGlyf({n: box for n in names}); fb.setupHorizontalMetrics({n: (2000, 0) for n in names}); fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": family, "styleName": "Regular"}); fb.setupOS2(); fb.setupPost()
    raw = io.BytesIO(); fb.save(raw); f = TTFont(io.BytesIO(raw.getvalue())); f.flavor = "woff2"; out = io.BytesIO(); f.save(out); return out.getvalue()
FONTS = {"https://cdn.ex.example/inline.woff2": woff2("Inline Test"), "https://fonts.ex.example/linked.woff2": woff2("Linked Test")}
SHEET_URL = "https://fonts.ex.example/css2?family=Linked+Test"
ASKED = []   # every request the frame or the app made of the hub's font routes and of other hub paths

class H(preview.H):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query); p = self.path.split("?")[0]
        ASKED.append((p, q.get("u", [""])[0], self.headers.get("x-warm") or ""))
        if p == "/api/img":
            u = q.get("u", [""])[0]
            if u in FONTS: return self._send(FONTS[u], "font/woff2", {"cache-control": "private, max-age=31536000, immutable"})
            return self._send("", "text/plain", status=404)
        if p == "/api/fontcss":
            if q.get("u", [""])[0] != SHEET_URL: return self._send("/* not kept */", "text/css")
            k = q.get("k", [""])[0]; tail = (f"&k={quote(k)}" if k else "")
            return self._send(f'@font-face{{font-family:"Linked Test";src:url("/api/img?u={quote("https://fonts.ex.example/linked.woff2", safe="")}{tail}") format("woff2");font-display:fallback}}', "text/css; charset=utf-8")
        return super().do_GET()
class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
srv = TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}/"

TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
MAIL = f"""<link rel="stylesheet" href="{SHEET_URL}">
<style>
@font-face {{ font-family: "Inline Test"; src: url(https://cdn.ex.example/inline.woff2) format("woff2"); font-display: block; }}
@font-face {{ font-family: "Sneaky"; src: url(/api/gmail/att/abc) format("woff2"); }}
</style>
<div style="font-size:20px">
<span id="inl" style="font-family:'Inline Test', monospace">Hello</span><br>
<span id="lnk" style="font-family:'Linked Test', monospace">Hello</span><br>
<span id="snk" style="font-family:'Sneaky', monospace">Hello</span><br>
<span id="ref" style="font-family:monospace">Hello</span>
</div>"""
OPEN = """async ([k, tid, html]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k);
  const fr = document.querySelector('#msgs iframe'); const t0 = Date.now(); let d = null;
  while (Date.now() - t0 < 6000) { d = fr.contentDocument; if (d && d.getElementById('inl') && d.fonts && [...d.fonts].filter((f) => /Inline Test|Linked Test/.test(f.family)).every((f) => f.status === 'loaded') && [...d.fonts].some((f) => /Linked Test/.test(f.family))) break; await new Promise((res) => setTimeout(res, 100)); }
  await new Promise((res) => setTimeout(res, 400)); d = fr.contentDocument;
  const w = (id) => Math.round(d.getElementById(id).getBoundingClientRect().width);
  const faces = [...d.fonts].map((f) => ({ family: f.family.replace(/["']/g, ''), status: f.status, display: f.display }));
  return { inl: w('inl'), lnk: w('lnk'), snk: w('snk'), ref: w('ref'), faces }; }"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        page = b.new_page(viewport={"width": 1000, "height": 700}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        ASKED.clear()
        r = page.evaluate(OPEN, [KEY, TID, MAIL]); faces = {f["family"]: f for f in r["faces"]}
        # 5 glyphs at 2 em of 20 px: 200 px in the mail's font; monospace is about 60
        check(r["inl"] >= 190 and r["ref"] < 120, f"{name}: the mail's own @font-face is loaded and its text drawn in it ({r['inl']} px, fallback {r['ref']} px, {faces.get('Inline Test')})")
        check(r["lnk"] >= 190, f"{name}: a face from its linked stylesheet is loaded through the hub's copy and drawn ({r['lnk']} px, {faces.get('Linked Test')})")
        check(all(faces.get(f, {}).get("display") == "fallback" for f in ("Inline Test", "Linked Test")), f"{name}: every face shows its text at once in the next font while its own comes, whatever the mail asked ({[(f, faces.get(f, {}).get('display')) for f in ('Inline Test', 'Linked Test')]})")
        sneaky = [a for a in ASKED if a[0].startswith("/api/gmail/att")]
        check(abs(r["snk"] - r["ref"]) <= 2 and not sneaky, f"{name}: a face naming another hub address is refused by the frame, never asked for ({r['snk']} px vs {r['ref']} px, {sneaky})")
        sheets = [a for a in ASKED if a[0] == "/api/fontcss"]
        check(len(sheets) >= 1 and all(a[1] == SHEET_URL for a in sheets), f"{name}: the linked stylesheet is read as the hub's copy ({sheets})")
        # warming: the mail's font, its stylesheet copy and the font that copy names, before any picture (the app's fetch() goes
        # through test/mock-fetch.js, whose call log says what was asked)
        page.evaluate("""(sheet) => { window.__mock.routes['GET /api/fontcss?'] = { __text: '@font-face{font-family:"Linked Test";src:url("/api/img?u=' + encodeURIComponent('https://fonts.ex.example/linked.woff2') + '") format("woff2");font-display:fallback}' };
          const doc = '<style>@import url("/api/fontcss?u=' + encodeURIComponent(sheet) + '");@font-face{font-family:x;src:url(/api/img?u=' + encodeURIComponent('https://cdn.ex.example/inline.woff2') + '&w=1600) format("woff2")}</style><img src="/api/img?u=' + encodeURIComponent('https://img.ex.example/a.png') + '">';
          window.__warm0 = window.__mock.calls.length; window.mh.warmPictures([doc]); }""", SHEET_URL)
        page.wait_for_timeout(500)
        warmed = [parse_qs(urlparse(c.split(" ", 1)[1]).query).get("u", [""])[0] for c in page.evaluate("() => window.__mock.calls.slice(window.__warm0)") if c.startswith("GET /api/img?") or c.startswith("GET /api/fontcss?")]
        want = ["https://cdn.ex.example/inline.woff2", SHEET_URL, "https://img.ex.example/a.png", "https://fonts.ex.example/linked.woff2"]
        check(sorted(warmed) == sorted(want) and warmed.index("https://cdn.ex.example/inline.woff2") < warmed.index("https://img.ex.example/a.png"),
              f"{name}: warming a mail asks for its font, its stylesheet copy and the font inside it, the font before its picture ({warmed})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all webfont checks passed")
sys.exit(1 if fails else 0)
