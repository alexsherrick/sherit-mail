#!/usr/bin/env python3
"""Zoom a message: on Chromium (Android, Windows); WebKit (the Mac app) is the documented exception. M
essages could not be zoomed on Android.

A mail in its frame zooms by Ctrl/Cmd + wheel, a trackpad pinch (wheel events with ctrlKey, or WebKit's gesture events), two fingers and
a double tap (the attachment viewer's inputs) from its fitted size up to three times its own size, never below the fit. The zoom
multiplies the frame's fit scale, so the frame grows with the mail; a zoomed mail pans sideways inside its frame with one finger (the
frame's html opens overflow-x; the old scrolling="no" would have stopped that) while the conversation keeps scrolling vertically. The
point under the pointer or the fingers stays put. A mouse double-click still selects a word, never zooms.

WebKit runs no event listener that the page attaches inside the message frame (a sandbox without allow-scripts) not a click on the
document, the window or the body, not a wheel, synthetic or real (measured in October 2026; Chromium runs them all). So on the Mac the zoom
inputs never reach the frame, and the mail stays at its fit; this test records that, so it flips the day WebKit or the sandbox changes.
(The same holds for the frame's click, dragover and drop handlers on the Mac; links there open through <base target="_blank">.)
At a phone width:
  - a plain mail: fit is scale 1; five Ctrl + wheel ticks zoom it to 1.61, the frame height grows with it, the mail is wider than the frame
    and scrolls sideways, the marked word stays under the pointer, the events are default-prevented; a plain wheel and a mouse
    double-click change nothing; more ticks stop at 3x; ticks the other way stop at the fit, with the transform and the sideways scroll gone;
  - a 600 px newsletter: fit is below 1; ticks zoom it from there; the cap is still 3x its own size;
  - WebKit: the frame has no scrolling attribute and the fit is as before; a Ctrl + wheel and a gesture pinch change nothing (no listener runs);
  - Chromium with a touch screen: a real two-finger pinch through CDP zooms the mail; one finger dragged sideways pans the zoomed mail inside
    its frame and dragged up scrolls the conversation, neither changing the zoom; a double tap fits the mail again and, from fit, shows a plain
    mail at 2x and a shrunk newsletter at its own size;
  - a slow two-finger pinch (half a pixel of spread per touch event, as a finger moves) never scrolls the conversation backwards and keeps the
    point under the fingers vertically (before, the zoom's own scroll was read as the fingers moving and panned back, and
    the mail shook; CONTROL: app.js at 2b5d118 fails these two, with 16 backward frames and 57 px scrolled of 128 needed);
  - a phone's pinch, replayed: on a real phone a touch's coordinates inside the frame are measured before the app's last
    move of the frame has landed, while its place on the screen is true. Delivered that way: two fingers spreading in place must scroll
    the conversation one way only, in steps under 40 px, with the point under them held within 3 px of the mail at every step;
    CONTROL: app.js at 876529f bounces it (64 backward steps, 159 px of drift); the same with the frame's coordinates 100 px off at the
    start (held within 3 px after the first fresh event); fingers moving down 0.5 px an event while spreading (the mail moves with them,
    held within 3 px); a screen whose units differ by 5 % (no screen tracking: no backward steps, held within 12 px); and a third finger
    landing and lifting mid-pinch, after which the two left still zoom;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails every Chromium zoom check (the scale never moves) and the scrolling-attribute
checks, and passes the rest.
Usage: python3 test/msgzoom.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
PARA = "The quick brown fox jumps over the lazy dog and keeps running through the long grass until the evening comes. "
PLAIN = "<div>" + "".join(f'<p>Paragraph {i}. {PARA}{"<span id=mk>MARK</span> " if i == 8 else ""}{PARA}</p>' for i in range(1, 41)) + "</div>"
NEWS = '<div style="width:600px">' + "".join(f"<p>Column {i}. {PARA}</p>" for i in range(1, 41)) + "</div>"
OPEN = """async ([k, tid, html]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k); await new Promise((res) => setTimeout(res, 700)); return true; }"""
# the frame, its fit, its sideways scroll, the conversation's scroller and the marked word's position on the page
STATE = """() => { const fr = document.querySelector('#msgs iframe'), d = fr.contentDocument, de = d.documentElement, r = fr.getBoundingClientRect();
  let sc = fr.parentElement; while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  const mk = d.getElementById('mk'), m = mk ? mk.getBoundingClientRect() : null;
  return { fit: fr._fit, h: parseFloat(fr.style.height), top: r.top, left: r.left, w: r.width, sl: de.scrollLeft, sw: de.scrollWidth, cw: de.clientWidth,
    ox: getComputedStyle(de).overflowX, tf: d.body.style.transform, st: sc ? sc.scrollTop : null, mk: m ? [r.left + m.left, r.top + m.top] : null,
    scrolling: fr.getAttribute('scrolling') }; }"""
WHEEL = """([dy, ctrl, x, y]) => { const fr = document.querySelector('#msgs iframe'), d = fr.contentDocument, r = fr.getBoundingClientRect(); const el = d.elementFromPoint(x - r.left, y - r.top) || d.body;
  return el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, ctrlKey: ctrl, bubbles: true, cancelable: true, clientX: x - r.left, clientY: y - r.top })); }"""
GESTURE = """([type, scale, x, y]) => { const fr = document.querySelector('#msgs iframe'), d = fr.contentDocument, r = fr.getBoundingClientRect(); const el = d.elementFromPoint(x - r.left, y - r.top) || d.body;
  const e = new Event(type, { bubbles: true, cancelable: true }); e.scale = scale; e.clientX = x - r.left; e.clientY = y - r.top; return el.dispatchEvent(e); }"""
DBL = """([x, y]) => { const fr = document.querySelector('#msgs iframe'), d = fr.contentDocument, r = fr.getBoundingClientRect(); const el = d.elementFromPoint(x - r.left, y - r.top) || d.body;
  return el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x - r.left, clientY: y - r.top })); }"""
# scroll the conversation so the marked word sits about 400 px down the screen
SHOW_MARK = """() => { const fr = document.querySelector('#msgs iframe'), d = fr.contentDocument; let sc = fr.parentElement; while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
  const m = d.getElementById('mk').getBoundingClientRect(), r = fr.getBoundingClientRect(); sc.scrollTop += r.top + m.top - 400; }"""
# which parent-attached listeners fire inside the frame for a synthetic click and wheel (WebKit: none)
LISTENS = """() => { const fr = document.querySelector('#msgs iframe'), d = fr.contentDocument, w = d.defaultView, seen = []; const log = (k) => (e) => seen.push(k + ':' + e.type);
  d.addEventListener('click', log('doc'), true); w.addEventListener('click', log('win'), true); d.body.addEventListener('click', log('body'), true); d.addEventListener('wheel', log('doc'), { passive: false });
  const p = d.querySelector('p'); p.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); p.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true })); return seen; }"""
fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
near = lambda a, b, tol: a is not None and b is not None and abs(a - b) <= tol
sc = lambda st: round((st["fit"] or {}).get("scale") or 0, 3)

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
VP = {"width": 390, "height": 844}
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        page = b.new_page(viewport=VP); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(OPEN, [KEY, TID, PLAIN]); page.evaluate(SHOW_MARK); preview.settle(page, 150); s0 = page.evaluate(STATE)
        check(sc(s0) == 1 and s0["ox"] != "auto" and s0["sw"] <= s0["cw"] + 1 and s0["scrolling"] is None, f"{name}: a plain mail fits at scale 1, not scrollable sideways, no scrolling attribute (ox {s0['ox']}, sw {s0['sw']} cw {s0['cw']}, scrolling {s0['scrolling']!r})")
        mx, my = s0["mk"]
        if name == "webkit":   # the documented exception: no listener runs inside the frame, so nothing zooms
            heard = page.evaluate(LISTENS)
            check(heard == [], f"{name}: runs no listener the page attaches inside the message frame — click, wheel, on the document, window or body ({heard})")
            for _ in range(5): page.evaluate(WHEEL, [-30, True, mx + 4, my + 6])
            page.evaluate(GESTURE, ["gesturestart", 1, mx, my]); page.evaluate(GESTURE, ["gesturechange", 1.5, mx, my]); page.evaluate(GESTURE, ["gestureend", 1.5, mx, my]); preview.settle(page, 150)
            w0 = page.evaluate(STATE); check(sc(w0) == 1 and w0["ox"] != "auto" and near(w0["h"], s0["h"], 2), f"{name}: so Ctrl + wheel and a gesture pinch leave the mail at its fit (scale {sc(w0)}, height {w0['h']})")
            page.evaluate(OPEN, [KEY, TID, NEWS]); n0 = page.evaluate(STATE)
            check(0 < sc(n0) < 1 and n0["ox"] != "auto" and n0["scrolling"] is None, f"{name}: a 600 px newsletter fits below 1 as before (scale {sc(n0)})")
            check(not errs, f"{name}: no page errors {errs[:2]}")
            page.close(); b.close(); continue
        check(300 <= my <= 500, f"{name}: the marked word is on screen before zooming ({mx}, {my})")
        prevented = [not page.evaluate(WHEEL, [-30, True, mx + 4, my + 6]) for _ in range(5)]; preview.settle(page, 150); s1 = page.evaluate(STATE)
        check(near(sc(s1), 1.61, 0.011) and all(prevented), f"{name}: five Ctrl + wheel ticks zoom the mail to 1.61 and are default-prevented (scale {sc(s1)}, prevented {prevented})")
        check(near(s1["h"], s0["h"] * sc(s1), s0["h"] * 0.03 + 6), f"{name}: the frame grows with the mail (height {s0['h']} -> {s1['h']} px)")
        check(s1["ox"] == "auto" and s1["sw"] > s1["cw"] + 20, f"{name}: the zoomed mail is wider than its frame and the frame scrolls sideways (ox {s1['ox']}, sw {s1['sw']} cw {s1['cw']})")
        check(near(s1["mk"][0], mx, 6) and near(s1["mk"][1], my, 6), f"{name}: the word under the pointer stayed put within 6 px (at the first small steps the frame cannot scroll far enough to hold a point near its right edge) (({mx}, {my}) -> {s1['mk']}, frame scrollLeft {s1['sl']}, conversation scrollTop {s0['st']} -> {s1['st']})")
        kept = page.evaluate(WHEEL, [-30, False, mx + 4, my + 6]); page.evaluate(DBL, [mx + 4, my + 6]); page.wait_for_timeout(100); s2 = page.evaluate(STATE)
        check(kept and sc(s2) == sc(s1), f"{name}: a plain wheel and a mouse double-click change nothing (scale {sc(s2)}, wheel not prevented {kept})")
        for _ in range(30): page.evaluate(WHEEL, [-30, True, mx + 4, my + 6])
        page.wait_for_timeout(100); s3 = page.evaluate(STATE)
        check(sc(s3) == 3, f"{name}: the zoom stops at 3x the mail's own size ({sc(s3)})")
        for _ in range(40): page.evaluate(WHEEL, [30, True, mx + 4, my + 6])
        preview.settle(page, 150); s4 = page.evaluate(STATE)
        check(sc(s4) == 1 and s4["tf"] == "" and s4["ox"] != "auto" and near(s4["h"], s0["h"], 2), f"{name}: ticks the other way stop at the fit, transform and sideways scroll gone (scale {sc(s4)}, transform {s4['tf']!r}, ox {s4['ox']}, height {s4['h']})")
        # a shrunk newsletter: the fit is the floor, the cap is still 3x its own size
        page.evaluate(OPEN, [KEY, TID, NEWS]); n0 = page.evaluate(STATE); b0 = sc(n0); x, y = n0["left"] + 100, n0["top"] + 120
        check(0 < b0 < 1 and n0["ox"] != "auto", f"{name}: a 600 px newsletter fits below 1 (scale {b0}), not scrollable sideways")
        for _ in range(5): page.evaluate(WHEEL, [-30, True, x, y])
        preview.settle(page, 150); n1 = page.evaluate(STATE)
        check(near(sc(n1), round(b0 * 1.1 ** 5, 3), 0.012) and n1["ox"] == "auto", f"{name}: five ticks zoom it from its fit (scale {b0} -> {sc(n1)}), and it scrolls sideways")
        for _ in range(60): page.evaluate(WHEEL, [-30, True, x, y])
        page.wait_for_timeout(100); n2 = page.evaluate(STATE); check(sc(n2) == 3, f"{name}: its cap is 3x its own size ({sc(n2)})")
        for _ in range(80): page.evaluate(WHEEL, [30, True, x, y])
        preview.settle(page, 150); n3 = page.evaluate(STATE); check(sc(n3) == b0, f"{name}: and the floor is its fit ({sc(n3)})")
        page.evaluate(GESTURE, ["gesturestart", 1, x, y]); page.evaluate(GESTURE, ["gesturechange", 1.5, x, y]); page.evaluate(GESTURE, ["gestureend", 1.5, x, y]); page.wait_for_timeout(100)
        g = page.evaluate(STATE); check(near(sc(g), round(b0 * 1.5, 3), 0.012), f"{name}: a trackpad pinch arriving as gesture events (1.5) zooms the mail by 1.5 ({b0} -> {sc(g)})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        page.close(); b.close()
    # Chromium with a touch screen: real touches through CDP
    b = pw.chromium.launch(); ctx = b.new_context(viewport=VP, has_touch=True, is_mobile=True); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    cdp = ctx.new_cdp_session(page)
    def touch(kind, pts): cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i + 1} for i, (x, y) in enumerate(pts)]})
    def pinch(cy, spread):
        touch("touchStart", [(120, cy), (270, cy)])
        for d in spread: touch("touchMove", [(120 - d, cy), (270 + d, cy)]); page.wait_for_timeout(40)
        touch("touchEnd", []); preview.settle(page, 150)
    def drag(pts):
        touch("touchStart", [pts[0]])
        for p in pts[1:]: touch("touchMove", [p]); page.wait_for_timeout(30)
        touch("touchEnd", []); preview.settle(page, 300)
    def doubletap(x, y):
        for _ in range(2): touch("touchStart", [(x, y)]); touch("touchEnd", []); page.wait_for_timeout(80)
        preview.settle(page, 200)
    page.evaluate(OPEN, [KEY, TID, PLAIN]); t0 = page.evaluate(STATE); cy = min(t0["top"] + 200, 600)
    pinch(cy, (20, 40, 60, 80, 100)); t1 = page.evaluate(STATE)
    check(1.7 <= sc(t1) <= 1.95, f"chromium touch: two fingers spreading from 150 to 350 px zoom a plain mail by about 1.84, the first 35 px arming the pinch ({sc(t1)})")
    drag([(300, cy), (260, cy + 2), (200, cy + 3), (140, cy + 4), (100, cy + 5)]); t2 = page.evaluate(STATE)
    check(t2["sl"] > 30 and sc(t2) == sc(t1), f"chromium touch: one finger dragged sideways pans the zoomed mail inside its frame (scrollLeft {t1['sl']} -> {t2['sl']}, zoom {sc(t2)})")
    drag([(200, cy + 150), (200, cy + 100), (200, cy + 40), (200, cy - 20), (200, cy - 60)]); t3 = page.evaluate(STATE)
    check(t3["st"] > t2["st"] + 30 and sc(t3) == sc(t1), f"chromium touch: one finger dragged up scrolls the conversation (scrollTop {t2['st']} -> {t3['st']}, zoom {sc(t3)})")
    doubletap(200, 400); t4 = page.evaluate(STATE); check(sc(t4) == 1, f"chromium touch: a double tap on a zoomed mail fits it again ({sc(t4)})")
    doubletap(200, 400); t5 = page.evaluate(STATE); check(sc(t5) == 2, f"chromium touch: and a double tap at fit shows a plain mail at 2x ({sc(t5)})")
    page.evaluate(OPEN, [KEY, TID, NEWS]); u0 = page.evaluate(STATE)
    doubletap(200, 400); u1 = page.evaluate(STATE); check(0 < sc(u0) < 1 and sc(u1) == 1, f"chromium touch: a double tap on a shrunk newsletter shows it at its own size ({sc(u0)} -> {sc(u1)})")
    doubletap(200, 400); u2 = page.evaluate(STATE); check(sc(u2) == sc(u0), f"chromium touch: and again fits it ({sc(u2)})")
    # A finger-like pinch: half a CSS px of spread per touch event, so most events are under the zoom step and only pan.
    # The zoom scrolls the conversation to keep the point under the fingers; that scroll must never be read as the fingers moving.
    # Before the fix the next event panned it back: the conversation scrolled backwards on 53 of 267 frames and the mail shook.
    page.evaluate(OPEN, [KEY, TID, PLAIN]); doubletap(200, 400); doubletap(200, 400); p0 = page.evaluate(STATE)
    page.evaluate("""() => { window.__zs = []; const fr = document.querySelector('#msgs iframe'); let sc = fr.parentElement; while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
      const go = () => { window.__zs.push([sc.scrollTop, (fr._fit || {}).scale || 1]); if (window.__zs.length < 300) requestAnimationFrame(go); }; requestAnimationFrame(go); }""")
    fy = 420; touch("touchStart", [(150, fy), (240, fy)])
    for i in range(1, 121): touch("touchMove", [(150 - i * 0.5, fy), (240 + i * 0.5, fy)]); page.wait_for_timeout(8)
    touch("touchEnd", []); preview.settle(page, 300); zs = page.evaluate("() => window.__zs"); p1 = page.evaluate(STATE)
    back = sum(1 for a, b2 in zip(zs, zs[1:]) if b2[0] < a[0] - 0.5)
    want = (fy - p0["top"] - (p0["fit"] or {}).get("top", 0)) * (sc(p1) - sc(p0)) / sc(p0)
    check(sc(p1) > 1.5 and back == 0, f"chromium touch: a slow two-finger pinch never scrolls the conversation backwards ({back} backward frames, zoom {sc(p0)} -> {sc(p1)})")
    check(abs((p1["st"] - p0["st"]) - want) < 40, f"chromium touch: and keeps the point under the fingers vertically (scrolled {p1['st'] - p0['st']}, needed about {round(want)})")
    # A phone's pinch: each touch's frame coordinates measured against the frame's place before the previous handler ran
    # (what the user's phone recorded), its screen coordinates true, the page 29 px across and 121 down on the screen as on that phone.
    # CDP's touches are measured after the page settles and cannot show this; synthetic TouchEvents can. Measured at every step: the
    # mail's own y under the fingers' true place (it must not move), the conversation's scroll steps, and the zoom.
    REPLAY = """async (o) => { const fr = document.querySelector('#msgs iframe'), d = fr.contentDocument, w = d.defaultView, K = [29, 121];
      let sc = fr.parentElement; while (sc && !/auto|scroll/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement;
      sc.scrollTop += fr.getBoundingClientRect().top + 300 - 420;
      const at = (i) => { const h = 45 + i * o.spread, y = 420 + i * (o.pan || 0); return [[195 - h, y], [195 + h, y]].concat(o.third && i >= o.third[0] && i < o.third[1] ? [[60, 600]] : []); };
      const touches = (pts, r, off = 0) => pts.map(([x, y], j) => new w.Touch({ identifier: j + 1, target: d.body, clientX: x - r.left, clientY: y - r.top + off, pageX: x - r.left, pageY: y - r.top + off,
        screenX: (x + K[0]) * (o.unit || 1), screenY: (y + K[1]) * (o.unit || 1) }));
      const fire = (type, list) => d.body.dispatchEvent(new w.TouchEvent(type, { touches: list, targetTouches: list, changedTouches: list, bubbles: true, cancelable: true }));
      const under = (i) => { const r = fr.getBoundingClientRect(), f = fr._fit || {}; return (at(i)[0][1] - r.top - (f.top || 0)) / (f.scale || 1); };
      let r = fr.getBoundingClientRect(); const y0 = under(0), st = [sc.scrollTop], drift = [];
      fire('touchstart', touches(at(0).slice(0, 2), r, o.staleStart || 0));
      let n = 2;
      for (let i = 1; i <= o.steps; i++) {
        const pts = at(i);
        if (pts.length !== n) { fire(pts.length > n ? 'touchstart' : 'touchend', touches(pts, fr.getBoundingClientRect())); n = pts.length; r = fr.getBoundingClientRect(); continue; }
        const t = touches(pts, r);           // measured against the frame's place before the last handler ran
        r = fr.getBoundingClientRect();      // the next event will lag behind this one
        fire('touchmove', t); st.push(sc.scrollTop); drift.push(under(i) - y0); await new Promise((res) => requestAnimationFrame(res));
      }
      fire('touchend', []);
      const steps = st.slice(1).map((v, i) => v - st[i]), late = drift.slice(o.settle || 0);
      return { scale: (fr._fit || {}).scale || 1, back: steps.filter((x) => x < -0.5).length, maxStep: Math.round(Math.max(...steps.map(Math.abs))),
        maxDrift: Math.round(Math.max(...late.map(Math.abs)) * 10) / 10, endDrift: Math.round(drift[drift.length - 1] * 10) / 10 }; }"""
    def replay(**o):
        page.evaluate(OPEN, [KEY, TID, PLAIN]); preview.settle(page, 300); return page.evaluate(REPLAY, {"spread": 0.4, "steps": 240, **o})
    rp = replay()
    check(rp["scale"] > 2 and rp["back"] == 0 and rp["maxStep"] < 40, f"chromium touch: a phone's pinch (frame coordinates one scroll behind) scrolls the conversation one way only, in small steps ({rp['back']} backward steps, biggest {rp['maxStep']} px, zoom {rp['scale']})")
    check(rp["maxDrift"] <= 3, f"chromium touch: and holds the point under the fingers at every step (at most {rp['maxDrift']} px of the mail)")
    rs = replay(staleStart=100, settle=3)
    check(rs["back"] == 0 and rs["maxDrift"] <= 3, f"chromium touch: a pinch whose start is 100 px stale recovers by the first fresh event (held within {rs['maxDrift']} px after it, {rs['back']} backward steps)")
    rm = replay(pan=0.5)
    check(rm["maxDrift"] <= 3 and rm["scale"] > 2, f"chromium touch: fingers moving down while spreading carry the mail with them (held within {rm['maxDrift']} px, zoom {rm['scale']})")
    ru = replay(unit=1.05)
    check(ru["back"] == 0 and ru["maxDrift"] <= 12 and ru["scale"] > 2, f"chromium touch: a screen in other units falls back without shaking ({ru['back']} backward steps, held within {ru['maxDrift']} px, zoom {ru['scale']})")
    r3 = replay(third=[80, 90])
    check(r3["scale"] > 2 and r3["back"] == 0, f"chromium touch: a third finger landing and lifting mid-pinch leaves the two still zooming (zoom {r3['scale']}, {r3['back']} backward steps)")
    check(not errs, f"chromium touch: no page errors {errs[:2]}")
    b.close()
srv.shutdown()
print("all message zoom checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
