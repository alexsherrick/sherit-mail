#!/usr/bin/env python3
"""Find in the page. Wanted 2026-10-27: Find that works like Gmail. With no conversation open,
Cmd+F finds a subject, sender or start of a mail; inside a conversation, Cmd+F finds within that conversation.

Cmd/Ctrl+F opens the page's own find bar, scoped by what is on screen. Over the list (no conversation open, or on a phone the list
showing) it searches every conversation of the view by sender, subject and snippet, drawn or not: a match past the 80 drawn rows draws
up to it. In an open conversation it searches the headers, plain-text mails and each message frame's document; a collapsed message's
matches are counted from its stored document and the card is expanded when the walk reaches it. Matches are painted by the engine's
CSS Custom Highlight API (a frame's on the frame's own window registry) so the mail's markup never changes. Enter / Shift+Enter walk,
the count reads "n/m" as Chrome's bar, Esc closes and clears every mark. Chromium also opens the bar on a Cmd/Ctrl+F typed with the
focus inside a mail; WebKit runs no page listener in the frame, the Mac's Edit > Find menu covers that there.
CONTROL: APP_JS_SRC=<an app.js from before the change> never opens the bar.
Usage: python3 test/findbar.py"""
import io, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright
from PIL import Image

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
TID = "33333333-3333-3333-3333-333333333333"; KEY = "hub|" + TID
# 100 rows newer than the mock's four: the sender of row 3, the snippet of row 10 and the subject of row 95 (past the 80 drawn) say ocelot
ROWS = """() => { const S = window.mh.state; const base = [...S.threads.values()].find((t) => t.kind === 'hub'); const now = Date.now();
  for (let i = 0; i < 100; i++) { const key = 'hub|f' + String(i).padStart(3, '0'); const nm = i === 3 ? 'Ocelot Robot' : 'Sender ' + i;
    S.threads.set(key, { ...base, key, id: 'f' + i, subject: 'Row ' + i + (i === 95 ? ' quarterly ocelot attached' : ' hello'), snippet: i === 10 ? 'your ocelot is ready' : 'nothing here ' + i,
      fromName: nm, fromAddr: 'sender' + i + '@example.com', from: nm + ' <sender' + i + '@example.com>', date: now - i * 60000, unread: 0, count: 1, labels: [], msgIds: [], out: false, starred: 0, state: 'inbox', _hit: null }); }
  window.mh.render(); return document.querySelectorAll('#threads .t[data-key]').length; }"""
FILLER = "Filler sentence that says nothing of interest at all. " * 40
DEEP = "".join(f"<p>Paragraph {i}. Nothing to see.</p>" for i in range(60))
# five messages, newest last: the three newest open (OPEN_NEWEST), the two oldest collapsed; ocelot sits in the newest frame (3), a
# plain-text mail (1) and a collapsed mail's body, past its one-line preview (2)
MSGS = """([tid]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; const m0 = r.messages[0]; const at = (h) => `2026-09-08T${String(h).padStart(2, '0')}:00:00Z`;
  const mk = (id, h, text, html) => ({ ...m0, id, message_id: '<' + id + '@x>', created_at: at(h), body_text: text, body_html: html, attachments: [] });
  r.messages = [mk('o1', 9, 'nothing', '<p>Nothing at all.</p>'), mk('o2', 10, 'x', '<p>' + %r + '</p><p>hidden ocelot one, ocelot two</p>'),
    mk('o3', 11, 'plain ocelot in text', ''), mk('o4', 12, 'none', '<p>No cats here.</p>'), mk('o5', 13, 'x', '<p>The ocelot sleeps. <b>Bold</b> ocelot again.</p>' + %r + '<p id=deep>deep ocelot</p>')];
  r.thread.message_count = 5; return r.messages.length; }""" % (FILLER, DEEP)
OPEN = """async ([k]) => { window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k); await new Promise((res) => setTimeout(res, 600)); return document.querySelectorAll('#msgs .m').length; }"""
BAR = """() => { const f = window.mh.findState || {}, bar = document.getElementById('findbar'), inp = document.getElementById('findq'); const h = f.hits && f.hits[f.i];
  const row = h && h.r && !h.fr ? h.r.startContainer.parentElement.closest('.t') : null; const fr = h && h.fr;
  const box = (x) => { if (!x || !x.r) return null; const q = x.r.getBoundingClientRect(); const fb = x.fr ? x.fr.getBoundingClientRect() : { left: 0, top: 0 }; return [fb.left + q.left, fb.top + q.top, q.width, q.height]; };
  const rect = box(h), prev = f.hits && f.i > 0 ? box(f.hits[f.i - 1]) : null;
  const regs = []; try { regs.push(['page', CSS.highlights.size]); } catch (_) {} for (const ifr of document.querySelectorAll('#msgs iframe')) { try { regs.push(['frame', ifr.contentDocument.defaultView.CSS.highlights.size]); } catch (_) {} }
  const ms = document.getElementById('msgs'), mr = ms.getBoundingClientRect(), th = document.getElementById('threads'), tr = th.getBoundingClientRect();
  return { open: bar && !bar.hidden, focused: document.activeElement === inp, placeholder: inp ? inp.placeholder : null, count: (document.getElementById('findn') || {}).textContent, scope: f.scope, i: f.i, hits: f.hits ? f.hits.length : null,
    rowKey: row ? row.dataset.key : null, inFrame: !!fr, card: h && h.card ? 'collapsed' : null, rect, prev, regs, drawn: document.querySelectorAll('#threads .t[data-key]').length,
    inMsgs: rect ? rect[1] >= mr.top && rect[1] + rect[3] <= mr.bottom : null, inList: rect ? rect[1] >= tr.top && rect[1] + rect[3] <= tr.bottom : null, msgsTop: ms.scrollTop,
    layers: (window.mh.layers || []).filter((l) => !l.spent).map((l) => l.name), cards: [...document.querySelectorAll('#msgs .m')].map((m) => m.classList.contains('collapsed') ? 'c' : 'o').join('') }; }"""
def shade(p):   # the highlight colours, allowing the engine's blending
    r, g, b = p; return "orange" if r > 240 and 110 < g < 170 and b < 60 else "yellow" if r > 240 and g > 210 and b < 60 else str(p)
def paint(page, rect):   # what the match's box is painted: the highlight colour behind the glyphs, or the most common pixel
    if not rect: return "none"
    x, y, w, h = rect; im = Image.open(io.BytesIO(page.screenshot(clip={"x": x, "y": y, "width": max(1, w), "height": max(1, h)}))).convert("RGB")
    px = list(im.getdata()); n = len(px); o = sum(shade(p) == "orange" for p in px); yl = sum(shade(p) == "yellow" for p in px)
    return "orange" if o >= n * 0.2 else "yellow" if yl >= n * 0.2 else str(max(set(px), key=px.count))
fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name; mod = "Meta" if name == "webkit" else "Control"
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        page = b.new_page(viewport={"width": 1200, "height": 800}, device_scale_factor=1); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        drawn = page.evaluate(ROWS); preview.settle(page, 300)
        check(drawn == 80, f"{name}: 100 rows in the view, 80 drawn ({drawn})")
        # ----- the list -----
        page.keyboard.press(f"{mod}+f"); page.wait_for_timeout(100); s = page.evaluate(BAR)
        check(s["open"] and s["focused"] and s["scope"] == "list" and s["placeholder"] == "Find in the list" and "find" in s["layers"], f"{name}: {mod}+F with no conversation open opens the bar over the list, focused, as a layer ({s['open']}, {s['focused']}, {s['scope']!r}, {s['placeholder']!r}, {s['layers']})")
        page.keyboard.type("ocelot"); preview.settle(page, 300); s = page.evaluate(BAR)
        check(s["count"] == "1/3" and s["rowKey"] == "hub|f003", f"{name}: 'ocelot' counts the sender of row 3, the snippet of row 10 and the subject of row 95, the first current ({s['count']!r}, {s['rowKey']})")
        check(s["regs"] and s["regs"][0] == ["page", 2], f"{name}: the page's registry holds the two highlights, all matches and the current one ({s['regs']})")
        p = paint(page, s["rect"])
        check(p == "orange", f"{name}: the current match is painted orange in the row ({p})")
        page.keyboard.press("Enter"); page.wait_for_timeout(100); s = page.evaluate(BAR)
        check(s["count"] == "2/3" and s["rowKey"] == "hub|f010" and s["inList"], f"{name}: Enter walks to the snippet match of row 10, in view ({s['count']!r}, {s['rowKey']}, in list {s['inList']})")
        p = paint(page, s["rect"])
        check(p == "orange", f"{name}: painted orange there too ({p})")
        page.keyboard.press("Enter"); preview.settle(page, 250); s = page.evaluate(BAR)
        check(s["count"] == "3/3" and s["rowKey"] == "hub|f095" and s["drawn"] >= 96 and s["inList"], f"{name}: Enter again reaches row 95: the list draws up to it and scrolls it into view ({s['count']!r}, {s['rowKey']}, drawn {s['drawn']}, in list {s['inList']})")
        page.keyboard.press("Enter"); page.wait_for_timeout(100); s1 = page.evaluate(BAR); page.keyboard.press("Shift+Enter"); page.wait_for_timeout(100); s2 = page.evaluate(BAR)
        check(s1["count"] == "1/3" and s2["count"] == "3/3", f"{name}: the walk wraps, Shift+Enter walks back ({s1['count']!r}, {s2['count']!r})")
        page.keyboard.press("Escape"); page.wait_for_timeout(100); s = page.evaluate(BAR)
        check(not s["open"] and not s["focused"] and all(n == 0 for _, n in s["regs"]) and "find" not in s["layers"], f"{name}: Esc closes the bar, drops the layer and clears every highlight ({s['open']}, {s['regs']}, {s['layers']})")
        # ----- a conversation -----
        page.evaluate(MSGS, [TID]); cards = page.evaluate(OPEN, [KEY]); s = page.evaluate(BAR)
        check(cards == 5 and s["cards"] == "ooocc", f"{name}: the conversation shows five messages, the two oldest collapsed ({cards}, {s['cards']})")
        page.keyboard.press(f"{mod}+f"); page.wait_for_timeout(100); page.keyboard.type("ocelot"); preview.settle(page, 300); s = page.evaluate(BAR)
        check(s["open"] and s["scope"] == "conv" and s["placeholder"] == "Find in this conversation", f"{name}: {mod}+F with a conversation open searches the conversation ({s['scope']!r}, {s['placeholder']!r})")
        check(s["count"] == "1/6" and s["inFrame"], f"{name}: 'ocelot' counts three in the newest mail's frame, one in a plain-text mail and two in a collapsed mail's body, the first current, in its frame ({s['count']!r}, in frame {s['inFrame']})")
        frame_regs = [n for k, n in s["regs"] if k == "frame"]
        check(frame_regs and frame_regs[0] == 2 and ("page", 1) in [tuple(r) for r in s["regs"]], f"{name}: the newest frame's own registry holds its highlights; the page's holds the plain-text mail's ({s['regs']})")
        p = paint(page, s["rect"])
        check(p == "orange", f"{name}: the current match is painted orange inside the sealed frame ({p})")
        page.keyboard.press("Enter"); page.wait_for_timeout(100); s = page.evaluate(BAR); p = paint(page, s["rect"]); p1 = paint(page, s["prev"]) if s.get("prev") else None
        check(s["count"] == "2/6" and p == "orange" and p1 == "yellow", f"{name}: Enter walks to the second match in the frame, painted orange, the first now yellow ({s['count']!r}, {p}, {p1})")
        page.keyboard.press("Enter"); preview.settle(page, 150); s = page.evaluate(BAR)
        check(s["count"] == "3/6" and s["inMsgs"] and s["msgsTop"] > 200, f"{name}: the deep match scrolls the conversation to itself ({s['count']!r}, in view {s['inMsgs']}, scrollTop {s['msgsTop']})")
        page.keyboard.press("Enter"); preview.settle(page, 150); s = page.evaluate(BAR)
        check(s["count"] == "4/6" and not s["inFrame"] and s["inMsgs"], f"{name}: then the plain-text mail's match, in the page itself ({s['count']!r}, in frame {s['inFrame']}, in view {s['inMsgs']})")
        page.keyboard.press("Enter"); preview.settle(page, 400); s = page.evaluate(BAR)
        check(s["count"] == "5/6" and s["cards"] == "ooooc" and s["inFrame"] and s["inMsgs"], f"{name}: then the collapsed mail opens and its first match is current, in its new frame ({s['count']!r}, cards {s['cards']}, in frame {s['inFrame']}, in view {s['inMsgs']})")
        p = paint(page, s["rect"])
        check(p == "orange", f"{name}: painted orange in the opened mail ({p})")
        page.keyboard.press("Enter"); page.wait_for_timeout(100); s6 = page.evaluate(BAR); page.keyboard.press("Enter"); page.wait_for_timeout(100); s7 = page.evaluate(BAR)
        check(s6["count"] == "6/6" and s7["count"] == "1/6", f"{name}: the last match, then the walk wraps ({s6['count']!r}, {s7['count']!r})")
        page.keyboard.press(f"{mod}+g"); page.wait_for_timeout(100); s = page.evaluate(BAR)
        check(s["count"] == "2/6", f"{name}: {mod}+G is next ({s['count']!r})")
        page.keyboard.press("Escape"); page.wait_for_timeout(100); s = page.evaluate(BAR)
        check(not s["open"] and all(n == 0 for _, n in s["regs"]) and s["cards"] == "ooooc", f"{name}: Esc clears every registry, the opened mail stays open ({s['open']}, {s['regs']}, {s['cards']})")
        # a Cmd/Ctrl+F typed with the focus inside the mail
        fb = page.evaluate("() => { const r = document.querySelector('#msgs iframe').getBoundingClientRect(); return [r.left + 40, r.top + 12]; }")
        page.mouse.click(fb[0], fb[1]); page.keyboard.press(f"{mod}+f"); page.wait_for_timeout(100); s = page.evaluate(BAR)
        if name == "chromium": check(s["open"] and s["focused"], f"{name}: {mod}+F with the focus inside a mail opens the bar (the frame forwards it) ({s['open']})")
        else: check(not s["open"], f"{name}: {mod}+F with the focus inside a mail reaches no page listener — the Mac's Edit > Find menu item covers it ({s['open']})")
        if s["open"]: page.keyboard.press("Escape")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        page.close()
        if name == "chromium":   # a phone: the list showing with no conversation is the list; a conversation showing is the conversation; Find in the More menu
            page = b.new_page(viewport={"width": 390, "height": 844}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 500)
            page.keyboard.press("Control+f"); page.wait_for_timeout(100); s = page.evaluate(BAR); page.keyboard.press("Escape")
            check(s["open"] and s["scope"] == "list", f"phone: the list showing, Ctrl+F searches the list ({s['scope']!r})")
            page.evaluate(MSGS, [TID]); page.evaluate(OPEN, [KEY]); page.keyboard.press("Control+f"); page.wait_for_timeout(100); s = page.evaluate(BAR); page.keyboard.press("Escape")
            check(s["open"] and s["scope"] == "conv", f"phone: a conversation showing, Ctrl+F searches it ({s['scope']!r})")
            has = page.evaluate("(k) => { window.mh.openMenuFor(window.mh.state.threads.get(k)); const b = document.querySelector('#menu [data-m=find]'); const t = b ? (b.title || b.textContent.trim()) : null; document.getElementById('menu').classList.remove('on'); return t; }", KEY)
            check(has == "Find in this conversation", f"phone: the conversation's More menu offers it ({has!r})")
            check(not errs, f"phone: no page errors {errs[:2]}")
            page.close()
        b.close()
print("all find checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
