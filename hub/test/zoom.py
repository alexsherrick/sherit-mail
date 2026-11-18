#!/usr/bin/env python3
"""Zoom in the attachment viewer: a previewed PDF or picture zooms by trackpad pinch (wheel events with ctrlKey, or
WebKit's gesture events), Ctrl/Cmd + wheel, two fingers, a double-click or double-tap, and the + - 0 keys, from the page or inside the
frame. A previewed PDF or picture could not be zoomed, by pinch or otherwise.
Checked in WebKit (the Mac app's engine) and Chromium (Android, Windows), with pdf.js drawing real pages:
- Ctrl + wheel ticks zoom in 1.1 steps and are default-prevented; a plain wheel is not; a wheel pinch (ctrlKey, small pixel deltas) zooms by exp(-dy/100);
- the point under the pointer stays where it was; above 1x the frame scrolls sideways; the page is drawn again, sharper, 400 ms later;
- past the 4-megapixel cap a detail canvas covers the part on screen and goes away at 1x; a scroll draws one for the page now on screen and frees far pages;
- gesture events (WebKit's trackpad pinch) zoom, and wheel events during a gesture are ignored, so a pinch WebKit reports both ways counts once;
- a real two-finger pinch through CDP zooms on Chromium, one finger still scrolls, a double tap toggles;
- + - 0 pressed on the page reach the frame; a double-click toggles fit and 2x; Esc still closes and the arrows still change files;
- a picture zooms the same way, the viewer body becomes a block so it scrolls from its left edge, and the header shows the percentage.
Usage: python3 test/zoom.py (exit 1 on any failed check)"""
# Fixed waits on purpose: the zoomed PDF's detail canvas is drawn by work preview.settle() cannot see, so a wait that
# ends when the page looks quiet checked the canvas before it was drawn.
import sys, base64, zlib, struct
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def png():
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * 4 for _ in range(4))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
def pdf_pages(n):
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % (3 + 2 * k) for k in range(n)), n)]
    for k in range(n):
        stream = b"0 0 1 rg 20 20 160 %d re f" % (40 + k)
        objs += [b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Contents %d 0 R >>" % (4 + 2 * k), b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"]
    out = b"%PDF-1.4\n"; offs = []
    for i, o in enumerate(objs, 1): offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out); out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
B = lambda b: base64.b64encode(b).decode()
FILES = {
    "img": {"id": "z-img", "name": "photo.png", "mime": "image/png", "bytes": png()},
    "pdf": {"id": "z-pdf", "name": "one page.pdf", "mime": "application/pdf", "bytes": pdf_pages(1)},
    "big": {"id": "z-big", "name": "manual.pdf", "mime": "application/pdf", "bytes": pdf_pages(40)},
}
def files(*keys): return [{"id": FILES[k]["id"], "name": FILES[k]["name"], "mime": FILES[k]["mime"], "size": len(FILES[k]["bytes"]), "url": f"/api/att/{FILES[k]['id']}"} for k in keys]
KEY = "hub|11111111-1111-1111-1111-111111111111"
OPEN = "([fs, i]) => window.mh.attOpen(window.mh.state.threads.get('" + KEY + "'), fs, i)"
DRAWN = "() => +(document.querySelector('#avbody iframe.avframe')?.dataset.drawn || 0) >= 1"
ZOOM = "() => +(document.querySelector('#avbody iframe.avframe')?.dataset.zoom || 1)"
META = "() => document.querySelector('#avmeta').textContent"
# inside the frame: the first page's box, its canvases, the scroll
STATE = """() => { const b = document.querySelector('.pg'), r = b.getBoundingClientRect(), c = b.querySelector('canvas:not(.dt)'), d = b.querySelector('canvas.dt'), e = document.documentElement;
  return { w: Math.round(r.width), h: Math.round(r.height), top: r.top, left: r.left, cw: c ? c.width : 0, ch: c ? c.height : 0, dt: d ? [d.width, d.height, d.style.left, d.style.top, d.style.width] : null,
    dts: document.querySelectorAll('canvas.dt').length, canvases: document.querySelectorAll('canvas').length, sw: e.scrollWidth, cwid: e.clientWidth, sx: scrollX, sy: scrollY }; }"""
WHEEL = "([dy, ctrl, x, y, mode]) => document.elementFromPoint(x, y).dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: mode, ctrlKey: ctrl, bubbles: true, cancelable: true, clientX: x, clientY: y }))"
GESTURE = "([type, scale, x, y]) => { const e = new Event(type, { bubbles: true, cancelable: true }); e.scale = scale; e.clientX = x; e.clientY = y; return document.elementFromPoint(x, y).dispatchEvent(e); }"
DBL = "([x, y]) => document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y }))"
# the page fraction under a client point, from the page under it
W0 = min(1280, 1100) - 24   # fit width: the viewer body capped at 1100, less the 12 px gutters (attPdf)
CAPW = int(200 * (4e6 / (200 * 260)) ** 0.5)   # a 200x260 pt page drawn within 4 Mpx: 1754 px wide
FRAC = "([x, y]) => { const b = [...document.querySelectorAll('.pg')].find((p) => { const r = p.getBoundingClientRect(); return y >= r.top && y <= r.bottom; }) || document.querySelector('.pg'); const r = b.getBoundingClientRect(); return [(x - r.left) / r.width, (y - r.top) / r.height]; }"

def setup(page):
    errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); page.wait_for_timeout(800)
    page.evaluate("(fs) => { for (const [id, b64] of fs) window.__mock.routes['GET /api/att/' + id] = { __b64: b64 }; }", [[f["id"], B(f["bytes"])] for f in FILES.values()])
    return errs
def frame(page): fh = page.query_selector("#avbody iframe.avframe"); return fh.content_frame() if fh else None
def open_pdf(page, key="pdf", i=None, fs=None):
    page.evaluate(OPEN, [fs or files("img", "pdf", "big"), i if i is not None else {"pdf": 1, "big": 2}[key]])
    page.wait_for_function(DRAWN, timeout=30000); page.wait_for_timeout(300); return frame(page)

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1280, "height": 900}); errs = setup(page)
        fr = open_pdf(page)
        s0 = fr.evaluate(STATE)
        check(s0["w"] == W0 and s0["cw"] == W0 and s0["dts"] == 0 and page.evaluate(ZOOM) == 1, f"{name}: a PDF opens at fit width, one canvas per page, zoom 1 ({s0['w']}px, canvas {s0['cw']}px)")
        # a plain wheel scrolls (not prevented); Ctrl + wheel zooms and is prevented
        plain = fr.evaluate(WHEEL, [100, False, 600, 300, 0])
        f0 = fr.evaluate(FRAC, [600, 300])
        ctrl = fr.evaluate(WHEEL, [-100, True, 600, 300, 0]); page.wait_for_timeout(100)
        z1 = page.evaluate(ZOOM); s1 = fr.evaluate(STATE); f1 = fr.evaluate(FRAC, [600, 300])
        check(plain and not ctrl, f"{name}: a plain wheel is left to the browser, a Ctrl + wheel is taken (prevented: plain {not plain}, ctrl {not ctrl})")
        check(z1 == 1.33 and s1["w"] == round(W0 * 1.33), f"{name}: 100 px of Ctrl + wheel is three 1.1 steps: zoom {z1}, the page {s1['w']}px wide")
        check(abs(f1[0] - f0[0]) < 0.01 and abs(f1[1] - f0[1]) < 0.01, f"{name}: the point under the pointer stays put ({[round(v, 3) for v in f0]} -> {[round(v, 3) for v in f1]})")
        check(s1["cw"] == W0, f"{name}: during the gesture the drawn canvas only stretches ({s1['cw']}px of pixels for {s1['w']}px)")
        page.wait_for_timeout(700); s2 = fr.evaluate(STATE)
        check(s2["cw"] == round(W0 * 1.33) and s2["dts"] == 0 and s2["canvases"] == 1, f"{name}: 400 ms later the page is drawn again at the new size, within the pixel budget, no detail canvas ({s2['cw']}px, {s2['canvases']} canvas)")
        check(s2["sw"] > s2["cwid"], f"{name}: wider than the frame, it scrolls sideways ({s2['sw']} > {s2['cwid']})")
        # past the cap: the capped canvas stays and a detail canvas covers the part on screen
        for _ in range(3): fr.evaluate(WHEEL, [-100, True, 600, 300, 0]); page.wait_for_timeout(30)
        page.wait_for_timeout(900); z3 = page.evaluate(ZOOM); s3 = fr.evaluate(STATE)
        check(z3 >= 3 and s3["cw"] == CAPW and s3["dt"] and s3["dts"] == 1, f"{name}: at zoom {z3} the page's canvas is capped at 4 Mpx ({s3['cw']}x{s3['ch']}) and one detail canvas is laid over it ({s3['dt']})")
        vis_w = min(s3["cwid"], s3["w"]); det = s3["dt"] or [0, 0]
        check(det[0] >= vis_w - 2 and det[0] * det[1] <= 4.05e6, f"{name}: the detail canvas covers at least the part on screen and stays within the budget ({det[0]}x{det[1]} for {vis_w}px visible)")
        meta3 = page.evaluate(META); check(meta3.endswith(f"· {round(z3 * 100)}%"), f"{name}: the header shows the zoom ({meta3!r})")
        # keys from the page: 0 resets, = and - step by 1.25
        page.keyboard.press("0"); page.wait_for_timeout(700); s4 = fr.evaluate(STATE)
        check(page.evaluate(ZOOM) == 1 and s4["w"] == W0 and s4["dts"] == 0 and s4["cw"] == W0 and "%" not in page.evaluate("() => document.querySelector('#avmeta').textContent"), f"{name}: 0 on the page puts it back to fit width, the detail canvas gone and the page redrawn ({s4['w']}px, {s4['cw']}px, {s4['dts']} detail)")
        page.keyboard.press("="); page.wait_for_timeout(100); za = page.evaluate(ZOOM); page.keyboard.press("-"); page.wait_for_timeout(100); zb = page.evaluate(ZOOM)
        check(za == 1.25 and zb == 1, f"{name}: = and - on the page step the frame's zoom by 1.25 ({za}, {zb})")
        # keys inside the frame, with Ctrl: the browser's zoom is not asked for
        taken = fr.evaluate("() => { const e = new KeyboardEvent('keydown', { key: '=', ctrlKey: true, bubbles: true, cancelable: true }); return !document.body.dispatchEvent(e); }"); page.wait_for_timeout(100)
        check(taken and page.evaluate(ZOOM) == 1.25, f"{name}: Ctrl + = inside the frame zooms the PDF and is prevented ({page.evaluate(ZOOM)})")
        page.keyboard.press("0"); page.wait_for_timeout(100)
        # double-click toggles fit and 2x
        fr.evaluate(DBL, [600, 300]); page.wait_for_timeout(100); zd = page.evaluate(ZOOM); fr.evaluate(DBL, [600, 300]); page.wait_for_timeout(100); ze = page.evaluate(ZOOM)
        check(zd == 2 and ze == 1, f"{name}: a double-click goes to 2x and back ({zd}, {ze})")
        # WebKit's gesture events: they zoom, and a wheel event during the gesture is ignored (the same pinch reported twice)
        fr.evaluate(GESTURE, ["gesturestart", 1, 600, 300]); fr.evaluate(GESTURE, ["gesturechange", 1.5, 600, 300]); page.wait_for_timeout(50); zg = page.evaluate(ZOOM)
        dup = fr.evaluate(WHEEL, [-100, True, 600, 300, 0]); page.wait_for_timeout(50); zh = page.evaluate(ZOOM)
        fr.evaluate(GESTURE, ["gesturechange", 2, 600, 300]); fr.evaluate(GESTURE, ["gestureend", 2, 600, 300]); page.wait_for_timeout(50); zi_ = page.evaluate(ZOOM)
        fr.evaluate(WHEEL, [-100, True, 600, 300, 0]); page.wait_for_timeout(50); zj = page.evaluate(ZOOM)
        check(zg == 1.5 and zh == 1.5 and not dup and zi_ == 2 and zj == 2.66, f"{name}: gesture events zoom (1.5 then 2), a wheel inside the gesture is swallowed, one after it counts ({zg}, {zh}, {zi_}, {zj})")
        page.keyboard.press("0"); page.wait_for_timeout(100)
        # a wheel pinch: ctrlKey with small pixel deltas, the factor exp(-dy/100)
        for _ in range(10): fr.evaluate(WHEEL, [-3, True, 600, 300, 0])
        page.wait_for_timeout(50); zp = page.evaluate(ZOOM)
        check(1.33 <= zp <= 1.36, f"{name}: ten pinch steps of 3 px zoom by about e^0.3 ({zp})")
        # mouse wheel notches (line mode): one 1.1 step per notch
        page.keyboard.press("0"); page.wait_for_timeout(100); fr.evaluate(WHEEL, [-1, True, 600, 300, 1]); page.wait_for_timeout(50)
        check(page.evaluate(ZOOM) == 1.1, f"{name}: a notched wheel with Ctrl is one step per click ({page.evaluate(ZOOM)})")
        # Esc and the arrows still work while zoomed
        page.keyboard.press("ArrowRight"); page.wait_for_function("() => +(document.querySelector('#avbody iframe.avframe')?.dataset.pages || 0) === 40", timeout=30000)
        check(page.evaluate("() => document.querySelector('#avmeta').textContent").endswith("3 of 3"), f"{name}: the arrow keys still change files, and the next PDF opens at fit width ({page.evaluate(ZOOM)})")
        # the 40-page PDF: zoomed, a scroll draws the detail for the page now on screen and frees the far ones
        page.wait_for_function(DRAWN, timeout=30000)
        for _ in range(4): fr2 = frame(page); fr2.evaluate(WHEEL, [-100, True, 600, 300, 0]); page.wait_for_timeout(30)
        page.wait_for_timeout(900); fr2 = frame(page)
        before = fr2.evaluate("() => ({ z: document.querySelectorAll('canvas.dt').length, p1: !!document.querySelectorAll('.pg')[0].querySelector('canvas.dt') })")
        fr2.evaluate("() => document.querySelectorAll('.pg')[9].scrollIntoView()"); page.wait_for_timeout(1200)
        after = fr2.evaluate("() => { const p = document.querySelectorAll('.pg'); return { dts: document.querySelectorAll('canvas.dt').length, p10: !!p[9].querySelector('canvas.dt'), p1: p[0].querySelectorAll('canvas').length, alive: document.querySelectorAll('canvas').length }; }")
        check(before["p1"] and after["p10"] and after["p1"] == 0 and after["dts"] <= 2 and after["alive"] <= 10, f"{name}: zoomed in on a 40-page PDF, scrolling to page 10 draws its detail and frees page 1 entirely ({before} -> {after})")
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        check(not page.evaluate("() => document.querySelector('#avmodal').classList.contains('on')"), f"{name}: Esc closes the zoomed preview")
        # a picture: the same inputs on the <img>, the body a block while zoomed, the header with the percentage
        page.evaluate(OPEN, [files("img", "pdf"), 0]); page.wait_for_function("() => document.querySelector('#avbody img.avimg')?.naturalWidth > 0", timeout=15000); page.wait_for_timeout(200)
        box = page.evaluate("() => { const r = document.querySelector('#avbody img.avimg').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width]; }")
        page.evaluate(WHEEL, [-100, True, box[0], box[1], 0]); page.wait_for_timeout(100)
        im = page.evaluate("() => { const b = document.querySelector('#avbody'), i = b.querySelector('img.avimg'); return { zoomed: b.classList.contains('zoomed'), w: i.style.width, meta: document.querySelector('#avmeta').textContent, display: getComputedStyle(b).display }; }")
        check(im["zoomed"] and im["w"] == f"{round(box[2] * 1.33, 2):g}px".replace(".0px", "px") and im["display"] == "block" and im["meta"].endswith("· 133%"), f"{name}: Ctrl + wheel zooms a picture to 133%, the viewer body a block ({im})")
        page.evaluate(DBL, [box[0], box[1]]); page.wait_for_timeout(100)
        im2 = page.evaluate("() => { const b = document.querySelector('#avbody'), i = b.querySelector('img.avimg'); return [b.classList.contains('zoomed'), i.style.width, document.querySelector('#avmeta').textContent]; }")
        check(not im2[0] and im2[1] == "" and "%" not in im2[2], f"{name}: a double-click on a zoomed picture fits it again ({im2})")
        page.keyboard.press("="); page.wait_for_timeout(100)
        meta5 = page.evaluate(META); check(meta5.endswith("· 125%"), f"{name}: = on the page zooms the picture ({meta5!r})")
        page.keyboard.press("ArrowRight"); page.wait_for_function(DRAWN, timeout=30000)
        check(page.evaluate(ZOOM) == 1 and not page.evaluate("() => document.querySelector('#avbody').classList.contains('zoomed')"), f"{name}: the next file starts at fit, the picture's zoom forgotten")
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        check(not errs, f"{name}: page errors {errs[:3]}")
        b.close()
    # Chromium with a touch screen: a real two-finger pinch through CDP, one finger scrolling, a double tap
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 1280, "height": 900}, has_touch=True); page = ctx.new_page(); errs = setup(page)
    fr = open_pdf(page); cdp = ctx.new_cdp_session(page)
    def touch(kind, pts): cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i + 1} for i, (x, y) in enumerate(pts)]})
    touch("touchStart", [(500, 400), (700, 400)])
    for d in (30, 70, 100): touch("touchMove", [(500 - d, 400), (700 + d, 400)]); page.wait_for_timeout(40)
    touch("touchEnd", []); page.wait_for_timeout(100); zt = page.evaluate(ZOOM)
    check(1.4 <= zt <= 1.7, f"chromium touch: two fingers spreading from 200 to 400 px zoom the PDF (the first 35 px arm the pinch): {zt}")
    sy0 = fr.evaluate("() => scrollY"); touch("touchStart", [(600, 600)])
    for y in (560, 500, 440, 400): touch("touchMove", [(600, y)]); page.wait_for_timeout(30)
    touch("touchEnd", []); page.wait_for_timeout(300); sy1 = fr.evaluate("() => scrollY")
    check(sy1 > sy0 and page.evaluate(ZOOM) == zt, f"chromium touch: one finger still scrolls, without zooming ({sy0} -> {sy1}, zoom {page.evaluate(ZOOM)})")
    for _ in range(2): touch("touchStart", [(600, 400)]); touch("touchEnd", []); page.wait_for_timeout(80)
    page.wait_for_timeout(150); zd = page.evaluate(ZOOM)
    check(zd == 1, f"chromium touch: a double tap on a zoomed PDF fits it again ({zd})")
    for _ in range(2): touch("touchStart", [(600, 400)]); touch("touchEnd", []); page.wait_for_timeout(80)
    page.wait_for_timeout(150)
    check(page.evaluate(ZOOM) == 2, f"chromium touch: and a double tap at fit goes to 2x ({page.evaluate(ZOOM)})")
    check(not errs, f"chromium touch: page errors {errs[:3]}")
    b.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all zoom checks passed")
sys.exit(1 if fails else 0)
