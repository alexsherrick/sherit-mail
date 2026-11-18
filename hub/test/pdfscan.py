#!/usr/bin/env python3
"""Scanned PDFs render in the viewer: CCITT fax / JBIG2, JPEG 2000 and ICC colour decode, on WebKit and Chromium.

Garbled in the viewer, correct once downloaded. A
scanner's PDF keeps its lettering as CCITT Group 4 image masks; pdf.js 6 decodes those (and JBIG2) with jbig2.wasm, JPEG 2000 with
openjpeg.wasm, and without them skipped the images. pdf.js now loads its own decoders from
/pdfjs/<version>/ on this origin (`wasmUrl`), and the frame's CSP opens that folder and WebAssembly, nothing else. WebKit cannot compile
openjpeg.wasm (relaxed SIMD; Safari 26.5 neither), so there pdf.js imports its JavaScript fallback from the same folder: this test's
WebKit takes the Mac's path. The fixtures are built here (Pillow), so no real document is in the repo. Checks:
  - a CCITT G4 image-mask page and a JPEG 2000 page draw their block, and the page around it stays white;
  - a plain PDF asks for no decoder, nor an ICC-coloured one (pdf.js's ICC decoder is off while useWorkerFetch is false, as before:
    it draws through the profile's alternate colour space); each scan asks only for what it needs, every request answered 200, none
    with a cookie;
  - in the frame, eval and new Function stay blocked (measured in the frame's own task, as the old frame too), no request leaves the
    decoder folder, the origin stays opaque and the parent closed; WebAssembly compiles;
  - pdf.js's worker runs as a worker on both engines: no "Setting up fake worker", which on Chromium (Android,
    Windows) meant parsing on the app's own thread; a data: worker started in the frame keeps the frame's walls;
  - one pdf.js worker while a PDF is open, still one after moving to another file, none once the viewer is closed;
  - FALLBACK: with data: workers refused by the frame's CSP, the PDF still draws (the old path takes over); and with a worker that never
    says "ready", it is dropped after the frame's timeout (cut from 10 s to 300 ms here) and the PDF still draws;
  - CONTROL: the app at the commit before the change leaves the CCITT and JPEG 2000 blocks off the page, and on Chromium runs pdf.js
    on the fake worker.
Usage: python3 test/pdfscan.py (exit 1 on any failed check)"""
import sys, io, base64, subprocess, socketserver, threading
sys.path.insert(0, "test")
import preview
from PIL import Image, ImageDraw, ImageCms
from playwright.sync_api import sync_playwright

W, H = 400, 200; BLOCK = (120, 70, 280, 130)   # the block, in image pixels (x0, y0, x1, y1)

def build(objs):
    out = b"%PDF-1.4\n"; offs = []
    for i, o in enumerate(objs, 1): offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out); out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
def page(resources, content, extra=()):
    return build([b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                  b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources %s /Contents 4 0 R >>" % (W, H, resources),
                  b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream", *extra])
def stream(d, data): return d + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"
def image_pdf(xobject_dict, data): return page(b"<< /XObject << /Im1 5 0 R >> >>", b"q %d 0 0 %d 0 0 cm /Im1 Do Q" % (W, H), [stream(xobject_dict, data)])
def ccitt_pdf():
    # A one-strip Group 4 TIFF from libtiff; its strip is the CCITT data a scanner writes into the PDF (K -1).
    im = Image.new("1", (W, H), 1); ImageDraw.Draw(im).rectangle(BLOCK, fill=0)
    buf = io.BytesIO(); im.save(buf, "TIFF", compression="group4", tiffinfo={278: H}); raw = buf.getvalue()
    t = Image.open(io.BytesIO(raw)); (off,), (n,) = t.tag_v2[273], t.tag_v2[279]
    black_is_1 = t.tag_v2.get(262, 0) == 1   # Photometric BlackIsZero: the strip's 1 bits are white
    return image_pdf(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ImageMask true /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns %d /Rows %d%s >>"
                     % (W, H, W, H, b" /BlackIs1 true" if black_is_1 else b""), raw[off:off + n])
def jpx_pdf():
    im = Image.new("L", (W, H), 255); ImageDraw.Draw(im).rectangle(BLOCK, fill=0)
    buf = io.BytesIO(); im.save(buf, "JPEG2000"); return image_pdf(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /JPXDecode" % (W, H), buf.getvalue())
def icc_pdf():
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    return page(b"<< /ColorSpace << /CS0 5 0 R >> >>", b"/CS0 cs 0.9 0.1 0.1 sc %d %d %d %d re f" % (BLOCK[0], H - BLOCK[3], BLOCK[2] - BLOCK[0], BLOCK[3] - BLOCK[1]),
                [b"[/ICCBased 6 0 R]", stream(b"<< /N 3", srgb)])
def plain_pdf(): return page(b"<< >>", b"0 0 0 rg %d %d %d %d re f" % (BLOCK[0], H - BLOCK[3], BLOCK[2] - BLOCK[0], BLOCK[3] - BLOCK[1]))

FILES = {"ccitt": ccitt_pdf(), "jpx": jpx_pdf(), "icc": icc_pdf(), "plain": plain_pdf()}
OPEN = "([id, size]) => window.mh.attOpen(window.mh.state.threads.get('hub|11111111-1111-1111-1111-111111111111'), [{ id, name: id + '.pdf', mime: 'application/pdf', size, url: '/api/att/' + id }], 0)"
HISTORY = subprocess.run(["git", "cat-file", "-e", "ccae005^{commit}"], cwd=preview.HUB, capture_output=True).returncode == 0; OLD_APP = subprocess.run(["git", "show", "ccae005:hub/src/client/app.js"], cwd=preview.HUB, capture_output=True, text=True, check=HISTORY).stdout
OLD_BUNDLE = "\n".join((preview.CLIENT / f).read_text() if f != "app.js" else OLD_APP for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]).replace("__VERSION__", "test")
# The frame's walls, measured by the frame's own code in a later task: code Playwright evaluates runs past the page's CSP, eval included.
WALLS = """([hub]) => new Promise((done) => { const s = document.createElement('script');
  s.textContent = `setTimeout(async () => { const out = {}, hub = ${JSON.stringify(hub)};
    try { eval('1'); out.eval = 'ran'; } catch (e) { out.eval = 'blocked'; }
    try { new Function('return 1')(); out.fn = 'ran'; } catch (e) { out.fn = 'blocked'; }
    for (const [k, u] of [['api', hub + '/api/threads'], ['root', hub + '/'], ['other', 'https://example.com/'], ['folder', hub + '/pdfjs/6.3.289/jbig2.wasm']])
      try { const r = await fetch(u); out[k] = r.status; } catch (e) { out[k] = 'blocked'; }
    try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); out.wasm = 'compiles'; } catch (e) { out.wasm = 'blocked'; }
    try { out.parent = parent.document.title; } catch (e) { out.parent = 'blocked'; }
    out.origin = String(location.origin);
    const wsrc = "const o = {}; try { eval('1'); o.eval = 'ran'; } catch (e) { o.eval = 'blocked'; } try { new Function('return 1')(); o.fn = 'ran'; } catch (e) { o.fn = 'blocked'; }"
      + " for (const [k, u] of [['api', " + JSON.stringify(hub + '/api/threads') + "], ['folder', " + JSON.stringify(hub + '/pdfjs/6.3.289/jbig2.wasm') + "]]) { try { o[k] = (await fetch(u)).status; } catch (e) { o[k] = 'blocked'; } } postMessage(o);";
    out.worker = await new Promise((r) => { let w; try { w = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(wsrc), { type: 'module' }); } catch (e) { return r('throws'); }
      w.onmessage = (e) => r(e.data); w.onerror = () => r('load failed'); setTimeout(() => r('no answer'), 5000); });
    window.__walls = out; }, 0);`;
  document.body.appendChild(s); const t = setInterval(() => { if (window.__walls) { clearInterval(t); done(window.__walls); } }, 50); })"""

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def server(bundle):
    log = []
    class Hd(preview.H):
        def do_GET(self):
            p = self.path.split("?")[0]
            if p == "/app.js": return self._send(bundle, "text/javascript; charset=utf-8")
            if p.startswith("/pdfjs/"):
                f = preview.PUBLIC / p[1:]; log.append((p.rsplit("/", 1)[-1], 200 if f.is_file() else 404, bool(self.headers.get("Cookie"))))
            return super().do_GET()
    class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
    srv = TS(("127.0.0.1", 0), Hd); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv, log

def frame(page): fh = page.query_selector("#avbody iframe.avframe"); return fh.content_frame() if fh else None
def show(page, key):
    page.evaluate(OPEN, [key, len(FILES[key])])
    page.wait_for_function("() => +(document.querySelector('#avbody iframe.avframe')?.dataset.drawn || 0) >= 1", timeout=30000); preview.settle(page, 400)
    im = Image.open(io.BytesIO(frame(page).query_selector(".pg canvas").screenshot())).convert("RGB"); w, h = im.size
    def mean(x0, y0, x1, y1):
        px = list(im.crop((int(x0 * w / W), int(y0 * h / H), int(x1 * w / W), int(y1 * h / H))).getdata())
        return tuple(round(sum(p[i] for p in px) / len(px)) for i in range(3))
    return mean(BLOCK[0] + 10, BLOCK[1] + 10, BLOCK[2] - 10, BLOCK[3] - 10), mean(10, 10, 100, 50)
dark = lambda c: max(c) < 60
white = lambda c: min(c) > 230

def run(bundle, label, control=False, fallback=False):
    srv, log = server(bundle); base = f"http://127.0.0.1:{srv.server_address[1]}/"; hub = base.rstrip("/")
    with sync_playwright() as pw:
        for engine in ((pw.chromium,) if control else (pw.webkit, pw.chromium)):
            name = engine.name + (" " + label if label else ""); log.clear()
            b = engine.launch(); pg = b.new_page(viewport={"width": 1280, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            logs = []; pg.on("console", lambda m: logs.append(m.text)); fake = lambda: any("fake worker" in l for l in logs)
            pg.goto(base); pg.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(pg, 800)
            pg.evaluate("(fs) => { document.cookie = 'sid=signed-in; path=/'; for (const [id, b64] of fs) window.__mock.routes['GET /api/att/' + id] = { __b64: b64 }; }", [[k, base64.b64encode(v).decode()] for k, v in FILES.items()])
            if fallback:
                cc = show(pg, "ccitt")
                check(dark(cc[0]) and white(cc[1]), f"{name}: FALLBACK — {'with data: workers refused' if 'refused' in label or label == '(fallback)' else 'with the worker silent past the timeout'}, the CCITT page still draws its block (block {cc[0]}; {'main-thread fallback' if fake() else 'blob worker'})")
                check(not errs, f"{name}: FALLBACK — no page errors {errs[:2]}")
                b.close(); continue
            if control:
                cc, jj = show(pg, "ccitt"), show(pg, "jpx"); walls = frame(pg).evaluate(WALLS, [hub])
                check(fake(), f"{name}: CONTROL — the app at ccae005 runs pdf.js on the fake worker (on the app's thread)")
                check(not dark(cc[0]) and not dark(jj[0]), f"{name}: CONTROL — the app at ccae005 leaves the CCITT and JPEG 2000 blocks off the page (blocks {cc[0]}, {jj[0]})")
                check(walls["eval"] == "blocked" and walls["fn"] == "blocked", f"{name}: CONTROL — the walls check sees eval blocked in the old frame too, so it measures the CSP ({ {k: v for k, v in walls.items() if k != 'worker'} })")
                check(walls["worker"] == "load failed", f"{name}: CONTROL — the old frame refuses a data: worker, so the worker check measures this change ({walls['worker']})")
                b.close(); continue
            relaxed = pg.evaluate("(b64) => WebAssembly.validate(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))", base64.b64encode((preview.PUBLIC / "pdfjs/6.3.289/openjpeg.wasm").read_bytes()).decode())   # can this engine compile it?
            pl = show(pg, "plain")
            check(dark(pl[0]) and white(pl[1]) and log == [], f"{name}: a plain PDF draws and asks for no decoder (block {pl[0]}, {log})")
            cc = show(pg, "ccitt"); got = [f for f, _, _ in log]
            check(dark(cc[0]) and white(cc[1]), f"{name}: a CCITT G4 image-mask page draws its block on white (block {cc[0]}, page {cc[1]})")
            check(got == ["jbig2.wasm"], f"{name}: it asked only for the JBIG2/CCITT decoder ({got})")
            log.clear(); jj = show(pg, "jpx"); got = [f for f, _, _ in log]
            want = ["openjpeg.wasm"] if relaxed else ["openjpeg.wasm", "openjpeg_nowasm_fallback.js"]
            check(dark(jj[0]) and white(jj[1]), f"{name}: a JPEG 2000 page draws its block on white (block {jj[0]}, page {jj[1]})")
            check(got == want, f"{name}: it asked for the JPEG 2000 decoder{'' if relaxed else ' and, this engine lacking relaxed SIMD as Safari does, its JavaScript fallback'} ({got})")
            log.clear(); ic = show(pg, "icc"); got = [f for f, _, _ in log]
            check(ic[0][0] > 180 and ic[0][1] < 80 and ic[0][2] < 80 and white(ic[1]) and got == [], f"{name}: an ICC-coloured block draws red and asks for no decoder (block {ic[0]}, {got})")
            log.clear(); show(pg, "ccitt"); show(pg, "jpx"); seen = list(log)
            check(seen and all(st == 200 and not ck for _, st, ck in seen), f"{name}: every decoder request is answered 200 and none carries the app's cookie ({seen})")
            walls = frame(pg).evaluate(WALLS, [hub]); wk = walls.pop("worker", None)
            check(not fake(), f"{name}: pdf.js runs in its own worker, not on the app's thread (no 'Setting up fake worker')")
            check(wk == {"eval": "blocked", "fn": "blocked", "api": "blocked", "folder": 200}, f"{name}: a data: worker started in the frame keeps its walls: eval and Function blocked, only the decoder folder reachable ({wk})")
            check(walls == {"eval": "blocked", "fn": "blocked", "api": "blocked", "root": "blocked", "other": "blocked", "folder": 200, "wasm": "compiles", "parent": "blocked", "origin": "null"},
                  f"{name}: in the frame eval and new Function stay blocked, nothing outside the decoder folder is reachable, origin opaque, parent closed; WebAssembly compiles ({walls})")
            # the worker's life is the viewer's: replaced when it moves to another file, gone when it closes
            pg.keyboard.press("Escape"); preview.settle(pg, 800); w0 = len(pg.workers)
            pg.evaluate("([fs]) => window.mh.attOpen(window.mh.state.threads.get('hub|11111111-1111-1111-1111-111111111111'), fs, 0)", [[{"id": k, "name": k + ".pdf", "mime": "application/pdf", "size": len(FILES[k]), "url": "/api/att/" + k} for k in ("plain", "ccitt", "icc")]])
            drawn = "() => +(document.querySelector('#avbody iframe.avframe')?.dataset.drawn || 0) >= 1"
            pg.wait_for_function(drawn, timeout=30000); preview.settle(pg, 400); w1 = len(pg.workers)
            for _ in range(2): pg.keyboard.press("ArrowRight"); preview.settle(pg, 300); pg.wait_for_function(drawn, timeout=30000); preview.settle(pg, 400)
            w2 = len(pg.workers); pg.keyboard.press("Escape"); preview.settle(pg, 1500); w3 = len(pg.workers)
            check((w0, w1, w2, w3) == (0, 1, 1, 0), f"{name}: one pdf.js worker while a PDF is open, one after moving through three files, none once closed ({w0}, {w1}, {w2}, {w3})")
            check(not errs, f"{name}: no page errors {errs[:2]}")
            b.close()
    srv.shutdown()

run(preview.BUNDLE, "")
if preview.CONTROL: run(OLD_BUNDLE, "(control)", control=True)
else: preview.control_skipped("pdfscan.py")
assert preview.BUNDLE.count("worker-src blob: data:;") == 1
run(preview.BUNDLE.replace("worker-src blob: data:;", "worker-src blob:;"), "(fallback)", fallback=True)
SILENT = preview.BUNDLE
for old, new in (('w.addEventListener("message", heard);', ""), ("t = setTimeout(lost, 10000);", "t = setTimeout(lost, 300);")):
    assert SILENT.count(old) == 1, old; SILENT = SILENT.replace(old, new)
run(SILENT, "(silent worker)", fallback=True)
print(f"{len(fails)} failed" if fails else "all scanned-PDF checks passed")
sys.exit(1 if fails else 0)
