#!/usr/bin/env python3
"""Touch receipts on a phone-sized headless Chromium (real CDP touch events, fake network from test/mock-fetch.js).
Covers the 2026-09-11 Android report: swipe → Undo → swipe must leave no blank gap and throw nothing; swiped actions must reach
IndexedDB; a fixed-width HTML body is scaled to the frame, not clipped; a row whose List-Unsubscribe was never captured learns it
from the full fetch when opened. Usage: python3 test/swipe.py [outdir] (screenshots + exit 1 on any failed check)"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/mail-swipe"); OUT.mkdir(parents=True, exist_ok=True)
K1 = "hub|11111111-1111-1111-1111-111111111111"; K2 = "sam.owner.sxsw@gmail.com|g1"; K3 = "sam.owner.sxsw@gmail.com|g3"; KW = "hub|22222222-2222-2222-2222-222222222222"
ROWS = """() => [...document.querySelectorAll('#threads > *')].map(el => ({key: el.dataset.key || null, top: Math.round(el.getBoundingClientRect().top), h: el.offsetHeight, tf: el.style.transform || ''}))"""
fails = []
def check(cond, msg):
    print(("ok   " if cond else "FAIL ") + msg); (cond or fails.append(msg))
def swipe(cdp, page, x0, x1, y, steps=14):
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}]})
    for i in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / steps, "y": y}]}); page.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
def contiguous(rows):
    for a, b in zip(rows, rows[1:]):
        if abs(b["top"] - (a["top"] + a["h"])) > 1: return f"gap of {b['top'] - (a['top'] + a['h'])} px before {b['key']}"
    return ""
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme="dark")
    page = ctx.new_page(); errs = []
    page.on("pageerror", lambda e: errs.append("pageerror: " + str(e))); page.on("console", lambda m: errs.append(m.type + ": " + m.text) if m.type in ("error", "warning") and "fetching the script" not in m.text else None)
    page.goto(base); page.wait_for_function("window.mh && window.mh.state && window.mh.state.threads.size >= 4", timeout=15000); preview.settle(page, 800)
    # arrange before anything is prefetched: a 600 px fixed-width body, and a newsletter row that lost its unsubscribe header
    page.evaluate("""() => { const r = window.__mock.routes['GET /api/threads/22222222-2222-2222-2222-222222222222']; r.messages[0].body_html = '<table width="600" style="width:600px"><tr><td id="wide" style="font-size:26px;white-space:nowrap">Acme Weekly (No. 26): Real-World Product Field Reviews | 89k+ downloads</td></tr></table>'; window.mh.state.threads.get('sam.owner.sxsw@gmail.com|g3').unsub = ''; }""")
    cdp = ctx.new_cdp_session(page)
    def box(key): return page.evaluate("k => { const r = document.querySelector(`#threads .t[data-key=\"${k}\"]`).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }", key)
    def state(key): return page.evaluate("k => window.mh.state.threads.get(k)?.state", key)
    def stored(key): return page.evaluate("k => window.mh.idb.get('threads', k).then(r => r && r.state)", key)
    # 0. a swipe shows its ACTION's colour, on either side and at either length (the user's own layout):
    #  Done green, Snooze blue, Trash red, Unsubscribe orange. Held without lifting, then cancelled, so nothing is acted on.
    saved = page.evaluate("() => { const p = window.mh.state.prefs; window.mh.state.prefs = { ...(p || {}), swipes: { right: 'archive', rightLong: 'snooze', left: 'trash', leftLong: 'unsubscribe' } }; return p; }")
    def hold(x0, x1, y, steps=10):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}]})
        for i in range(1, steps + 1):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / steps, "y": y}]}); page.wait_for_timeout(16)
        page.wait_for_timeout(80)
        got = page.evaluate("([k, right]) => { const el = document.querySelector(`#threads .t[data-key=\"${k}\"] .swipe.${right ? 'l' : 'r'}`); return el ? [el.textContent, getComputedStyle(el).backgroundColor] : null; }", [K1, x1 > x0])
        cdp.send("Input.dispatchTouchEvent", {"type": "touchCancel", "touchPoints": []}); preview.settle(page, 250)
        return got
    r = box(K1); y = r[1] + r[3] / 2
    for (x0, x1, label, rgb) in [(60, 180, "Done", "rgb(31, 157, 85)"), (60, 330, "Snooze", "rgb(124, 147, 255)"), (330, 210, "Trash", "rgb(192, 57, 43)"), (330, 60, "Unsubscribe", "rgb(232, 113, 10)")]:
        got = hold(x0, x1, y)
        check(got == [label, rgb], f"swipe colour: {label} shows {rgb} (got {got})")
    check(state(K1) == "inbox" and not errs, f"swipe colour: holding and cancelling acted on nothing ({state(K1)}, {errs[:2]})")
    page.evaluate("p => { window.mh.state.prefs = p; }", saved)
    # 1. long swipe left = trash; the toast offers Undo
    r = box(K1); swipe(cdp, page, 330, 40, r[1] + r[3] / 2); preview.settle(page, 600); page.screenshot(path=str(OUT / "01-swiped.png"))
    check(state(K1) == "trash", f"swipe A: state {state(K1)}"); check(page.evaluate("!!document.querySelector('#toast button')"), "swipe A: Undo offered")
    check(page.evaluate(f"!document.querySelector('#threads .t[data-key=\"{K1}\"]')"), "swipe A: row left the list")
    check(stored(K1) == "trash", f"swipe A: IndexedDB row state {stored(K1)} (was DataCloneError before the fix)")
    # 2. Undo brings the row back, visibly, with nothing thrown
    page.tap("#toast button"); preview.settle(page, 600); page.screenshot(path=str(OUT / "02-undone.png"))
    rows = page.evaluate(ROWS); back = [x for x in rows if x["key"] == K1]
    check(state(K1) == "inbox", f"undo: state {state(K1)}"); check(bool(back) and back[0]["tf"] == "" and back[0]["h"] > 40, f"undo: row back and visible {back}")
    check(stored(K1) == "inbox", f"undo: IndexedDB row state {stored(K1)}"); check(not errs, f"undo: page errors {errs[:2]}"); check(contiguous(rows) == "", "undo: rows contiguous " + contiguous(rows))
    # 3. the next swipe removes its row cleanly: no leftover transform, no blank gap (the Proxy bug froze render() here)
    r = box(K2); swipe(cdp, page, 330, 40, r[1] + r[3] / 2); preview.settle(page, 900); page.screenshot(path=str(OUT / "03-swiped-again.png"))
    rows = page.evaluate(ROWS)
    check(state(K2) == "trash", f"swipe B: state {state(K2)}"); check(not [x for x in rows if x["key"] == K2], "swipe B: row left the list")
    check(not [x for x in rows if x["tf"]], f"swipe B: no row keeps a transform {[x for x in rows if x['tf']]}"); check(contiguous(rows) == "", "swipe B: rows contiguous " + contiguous(rows))
    check(stored(K2) == "trash", f"swipe B: IndexedDB row state {stored(K2)}"); check(not errs, f"swipe B: page errors {errs[:2]}")
    try: page.wait_for_function("window.mh.queue.pending().length === 0", timeout=8000); check(True, "queue drained")
    except Exception: left = page.evaluate("window.mh.queue.pending().map(r => r.op + ':' + (r.args && r.args.action))"); check(False, f"queue did not drain: {left}")
    # 4. a 600 px body on a 390 px phone: scaled to the frame, right edge inside it, height follows the scale
    MEASURE = """() => { const fr = document.querySelector('#msgs iframe'); if (!fr) return null; const d = fr.contentDocument; const de = d.documentElement; const w = d.getElementById('wide'); const rr = w ? w.getBoundingClientRect() : null; const fb = fr.getBoundingClientRect(); return {cw: de.clientWidth, bodyW: d.body.getBoundingClientRect().width, tf: d.body.style.transform, ov: getComputedStyle(d.body).overflow, right: rr && Math.round(rr.right), frH: Math.round(fb.height), bodyH: d.body.scrollHeight, box: [fb.x, fb.y, fb.width, fb.height]}; }"""
    def open_wide(html):
        page.evaluate("([k,h]) => { window.__mock.routes['GET /api/threads/22222222-2222-2222-2222-222222222222'].messages[0].body_html = h; window.mh.prerendered.delete(k); return window.mh.idb.del('bodies', 'hub|m2').then(() => window.mh.openThread(k)); }", [KW, html])
    page.evaluate("k => { window.mh.prerendered.delete(k); return window.mh.idb.del('bodies', 'hub|m2').then(() => window.mh.openThread(k)); }", KW); preview.settle(page, 1800); page.screenshot(path=str(OUT / "04-wide-body.png"))
    m = page.evaluate(MEASURE)
    check(m is not None and m["tf"].startswith("scale(") and m["ov"] == "visible", f"wide body: scaled with the body unclipped {m}")
    check(m is not None and m["right"] is not None and m["right"] <= m["cw"] + 1, f"wide body: right edge inside the frame {m and (m['right'], m['cw'])}")
    check(m is not None and m["frH"] < m["bodyH"] + 8, f"wide body: frame height follows the scale {m and (m['frH'], m['bodyH'])}")
    if m:  # pixel receipt: the scaled nowrap heading must reach across the frame, not stop where the old clip was (about a third)
        from PIL import Image; import io
        png = page.screenshot(clip={"x": m["box"][0], "y": m["box"][1], "width": m["box"][2], "height": m["box"][3]}); im = Image.open(io.BytesIO(png)).convert("L"); W, H = im.size; px = im.load()
        ink = [x for x in range(W) if any(px[x, y] < 128 for y in range(H))]; reach = (max(ink) + 1) / W if ink else 0
        check(reach > 0.8, f"wide body: ink reaches {reach:.0%} of the frame width (a clipped body stops near 35%)")
    # 5. opening a row whose List-Unsubscribe was never captured refreshes it from the full fetch; the menu then offers Unsubscribe
    page.evaluate("k => { window.mh.prerendered.delete(k); return window.mh.openThread(k); }", K3); preview.settle(page, 900)
    u = page.evaluate("k => window.mh.state.threads.get(k).unsub", K3); check(u == "<mailto:u@x>", f"unsubscribe: row learned the header on open ({u!r})")
    has = page.evaluate("k => { window.mh.openMenuFor(window.mh.state.threads.get(k)); return !!document.querySelector('#menu [data-m=unsubscribe]'); }", K3); check(has, "unsubscribe: menu entry present")
    page.evaluate("() => document.querySelector('#menu').classList.remove('on')")   # it would cover the conversation's top bar
    check(stored(K3) == "inbox" and page.evaluate("k => window.mh.idb.get('threads', k).then(r => r && r.unsub)", K3) == "<mailto:u@x>", "unsubscribe: persisted to IndexedDB")
    # 6. a newer inbound message WITHOUT the header must not erase a known one: two-message thread, newest bare
    page.evaluate("""k => { const g = window.__mock.routes['GET gmail:threads/g3?']; const older = g.messages[0]; const newer = JSON.parse(JSON.stringify(older)); newer.id = 'gm3b'; newer.internalDate = String(Number(older.internalDate) + 60000); newer.payload.headers = newer.payload.headers.filter(h => !/^List-Unsubscribe/i.test(h.name)); g.messages = [older, newer]; const t = window.mh.state.threads.get(k); t.count = 2; t.lastMsgId = 'gm3b'; window.mh.prerendered.delete(k); return window.mh.openThread(k); }""", K3); preview.settle(page, 900)
    u = page.evaluate("k => window.mh.state.threads.get(k).unsub", K3); check(u == "<mailto:u@x>", f"header kept when the newest inbound message has none ({u!r})")
    # 7. derivation from message records: the newest inbound record WITH the header wins; a legacy record (no field) marks the row for backfill
    dv = page.evaluate("""() => { const a = deriveGmailThread('a@x', 't1', [{id:'m1', date:1, labels:['INBOX'], unsub:'<mailto:u@x>', unsubPost:''}, {id:'m2', date:2, labels:['INBOX'], unsub:'', unsubPost:''}]); const b = deriveGmailThread('a@x', 't2', [{id:'m3', date:3, labels:['INBOX']}]); return [a.unsub, a.unsubKnown, b.unsub, b.unsubKnown]; }""")
    check(dv == ["<mailto:u@x>", True, "", False], f"deriveGmailThread: newest-with-header wins, legacy record marks unknown {dv}")
    # 8. a body cached before the field existed is fetched fresh when the row still lacks a header, and the row learns it
    G2 = "sam.owner.sxsw@gmail.com|g2"
    page.evaluate("""k => { window.__mock.routes['GET gmail:threads/g2?'].messages[0].payload.headers.push({ name: 'List-Unsubscribe', value: '<https://shop.example/u>' }); const t = window.mh.state.threads.get(k); t.unsub = ''; t.unsubPost = ''; t.unsubKnown = false; t.count = 1; t.lastMsgId = 'gm2'; window.mh.prerendered.delete(k); return window.mh.idb.putAll('bodies', [{ key: k.split('|')[0] + '|gm2', threadKey: k, id: 'gm2', date: 1, at: Date.now(), m: { id: 'gm2', from: 'Shop <noreply@shop.example>', fromAddr: 'noreply@shop.example', date: 1, subject: 'Your order', text: 'legacy body without the header fields', html: '', out: false } }]); }""", G2)
    c0 = page.evaluate("window.__mock.calls.filter(c => c.includes('threads/g2?')).length"); page.evaluate("k => window.mh.openThread(k)", G2); preview.settle(page, 900)
    c1 = page.evaluate("window.__mock.calls.filter(c => c.includes('threads/g2?')).length"); u = page.evaluate("k => [window.mh.state.threads.get(k).unsub, window.mh.state.threads.get(k).unsubKnown]", G2)
    check(c1 == c0 + 1 and u == ["<https://shop.example/u>", True], f"stale cached body: fetched fresh (+{c1 - c0}) and the row learned {u}")
    # 9. background backfill: a row whose message record predates the header capture learns it without being opened
    page.evaluate("""k => { window.__mock.routes['GET gmail:messages/gm3?'] = { id: 'gm3', threadId: 'g3', payload: { headers: [{ name: 'List-Unsubscribe', value: '<https://list.example/u>' }, { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }] } }; const t = window.mh.state.threads.get(k); t.unsub = ''; t.unsubPost = ''; t.unsubKnown = false; window.mh.UNSUB_BACKFILL.perMinute = 1e6; const key = k.split('|')[0] + '|gm3'; return window.mh.idb.get('messages', key).then(rec => { if (!rec) return 'no record'; delete rec.unsub; delete rec.unsubPost; return window.mh.idb.putAll('messages', [rec]); }); }""", K3)
    page.evaluate("() => window.mh.backfillUnsub()"); preview.settle(page, 400)
    bf = page.evaluate("""k => { const t = window.mh.state.threads.get(k); return window.mh.idb.get('messages', k.split('|')[0] + '|gm3').then(rec => [t.unsub, t.unsubPost, t.unsubKnown, rec && rec.unsub, window.__mock.calls.filter(c => /messages\/gm3\?format=metadata&metadataHeaders=List-Unsubscribe/.test(c)).length]); }""", K3)
    check(bf[0] == "<https://list.example/u>" and bf[1] == "List-Unsubscribe=One-Click" and bf[2] is True and bf[3] == "<https://list.example/u>" and bf[4] == 1, f"backfill: row + message record learned the header with one metadata get {bf}")
    # 10. a row that leaves the store between the swipe and its deferred action gets no action, no queue row, no IndexedDB write
    if page.is_visible("#back"): page.click("#back"); preview.settle(page, 300)
    page.evaluate("document.querySelector('#threads').scrollTop = 0"); preview.settle(page, 200)
    K4 = "hub|33333333-3333-3333-3333-333333333333"; r = box(K4); swipe(cdp, page, 330, 40, r[1] + r[3] / 2)
    page.evaluate("k => window.mh.state.threads.delete(k)", K4); preview.settle(page, 700)
    q = page.evaluate("k => window.mh.queue.pending().filter(r => r.threadKey === k).length", K4); st = stored(K4)
    check(q == 0 and st == "inbox" and not errs, f"stale row during swipe: queue rows {q}, stored state {st}, errors {errs[:1]}")
    # 11. frame fixtures: bounded, stable height; wide content scaled and inside; the mail's own clip left alone
    FIX = {"nested-clip": '<div style="width:280px;overflow:hidden"><div id="wide" style="width:900px;white-space:nowrap">clipped by the mail itself, must not be scaled</div></div>',
           "important-width": '<style>html,body{width:640px !important;min-width:640px !important}</style><div id="wide" style="width:600px;background:#eee">important 640</div>',
           "pct-200": '<table style="width:200%"><tr><td id="wide" style="background:#ddd">two hundred percent table</td></tr></table>',
           "vh-height": '<div id="wide" style="height:100vh;background:#eee">viewport-high box</div>',
           "absolute": '<div style="position:relative;height:40px"><div id="wide" style="position:absolute;left:500px;top:0;width:200px;background:#eee">absolutely placed</div></div>',
           "plain": '<p id="wide">A short plain paragraph, nothing wide.</p>'}
    for name, html in FIX.items():
        open_wide(html); preview.settle(page, 900); m1 = page.evaluate(MEASURE); preview.settle(page, 1600); m2 = page.evaluate(MEASURE)
        ok = bool(m1) and bool(m2) and abs(m2["frH"] - m1["frH"]) <= 8 and m2["frH"] < 600
        check(ok, f"fit {name}: height {m1 and m1['frH']} -> {m2 and m2['frH']} bounded and stable")
        if name in ("important-width", "absolute"): check(bool(m2) and m2["tf"].startswith("scale(") and m2["right"] <= m2["cw"] + 1, f"fit {name}: scaled {m2 and m2['tf']} right {m2 and m2['right']} <= {m2 and m2['cw']}")
        if name == "pct-200": check(bool(m2) and m2["right"] <= m2["cw"] + 1, f"fit {name}: inside the frame (table max-width:100% shrinks it) right {m2 and m2['right']} <= {m2 and m2['cw']}")
        if name in ("nested-clip", "vh-height", "plain"): check(bool(m2) and m2["tf"] == "", f"fit {name}: not scaled ({m2 and m2['tf']!r})")
        if name == "plain": check(bool(m2) and m2["frH"] <= 120, f"fit {name}: frame hugs a one-line body ({m2 and m2['frH']} px)")
    # 12. backfill walks the inbound messages newest first (an older carrier is found) and does not skip outbound-last threads
    SEED = """([acct, n, out, hdrOnOlder]) => { const ks = []; for (let i = 0; i < n; i++) { const tid = 'gx' + Math.random().toString(36).slice(2, 8); const key = acct + '|' + tid; const d = Date.now() - i * 1000; const recs = [{ key: acct + '|' + tid + 'b', threadKey: key, account: acct, id: tid + 'b', threadId: tid, date: d, labels: ['INBOX'], from: 'L <l@x>', fromAddr: 'l@x', subject: 's', snippet: '' }, { key: acct + '|' + tid + 'a', threadKey: key, account: acct, id: tid + 'a', threadId: tid, date: d - 5000, labels: ['INBOX'], from: 'L <l@x>', fromAddr: 'l@x', subject: 's', snippet: '' }]; if (out) recs.push({ key: acct + '|' + tid + 'c', threadKey: key, account: acct, id: tid + 'c', threadId: tid, date: d + 1000, labels: ['SENT'], from: 'me', fromAddr: acct, subject: 's', snippet: '' }); const t = { key, account: acct, kind: 'gmail', id: tid, date: d + 2000, state: 'inbox', unread: false, starred: false, labels: ['INBOX'], subject: 's', snippet: '', from: 'L <l@x>', fromAddr: 'l@x', fromName: 'L', cat: 'newsletters', count: recs.length, lastMsgId: recs[recs.length - 1].id, msgIds: [], out: !!out, unsub: '', unsubKnown: false }; window.mh.state.threads.set(key, t); if (hdrOnOlder) window.__mock.routes['GET gmail:messages/' + tid + 'a?'] = { id: tid + 'a', payload: { headers: [{ name: 'List-Unsubscribe', value: '<https://older.example/' + tid + '>' }] } }; ks.push([key, tid]); window.mh.idb.putAll('messages', recs); } return ks; }"""
    ACCT = "sam.owner.sxsw@gmail.com"
    [[kA, tidA]] = page.evaluate(SEED, [ACCT, 1, True, True]); preview.settle(page, 200)
    page.evaluate("() => { window.mh.UNSUB_BACKFILL.perMinute = 1000; window.mh.UNSUB_BACKFILL.windowMs = 60000; window.mh.UNSUB_BACKFILL.calls = []; return window.mh.backfillUnsub(); }"); preview.settle(page, 500)
    r12 = page.evaluate("([k, tid]) => { const t = window.mh.state.threads.get(k); const calls = window.__mock.calls.filter(c => c.includes('messages/' + tid)); return [t.unsub, t.unsubKnown, calls.length, calls.map(c => c.replace(/.*messages\\//, '').slice(0, 9))]; }", [kA, tidA])
    check(r12[0] == f"<https://older.example/{tidA}>" and r12[1] is True and r12[2] == 2, f"backfill: outbound-last thread walked newest-first, older carrier found after two gets {r12}")
    page.evaluate("window.__mock.errors = window.__mock.errors.filter(e => !/messages\\/gx/.test(e))")
    # 13. hard rolling cap counts 404s: 8 legacy threads, every get unmocked (404) → at most 5 calls in any 2 s window, all rows marked known; a 500 ends the run and counts a try
    ks = page.evaluate(SEED, [ACCT, 8, False, False]); preview.settle(page, 200)
    page.evaluate("() => { window.mh.UNSUB_BACKFILL.perMinute = 5; window.mh.UNSUB_BACKFILL.windowMs = 2000; window.mh.UNSUB_BACKFILL.calls = []; window.mh.UNSUB_BACKFILL.log = []; window.mh.backfillUnsub(); }"); preview.settle(page, 7500)
    r13 = page.evaluate("ks => { const B = window.mh.UNSUB_BACKFILL; const c = [...B.log].sort((a, b) => a - b); let worst = 0; for (let i = 0; i < c.length; i++) { let n = 0; for (let j = i; j < c.length && c[j] - c[i] < 2000; j++) n++; worst = Math.max(worst, n); } return [c.length, worst, ks.map(([k]) => window.mh.state.threads.get(k).unsubKnown).filter(Boolean).length]; }", ks)
    check(r13[0] == 16 and r13[1] <= 5 and r13[2] == 8, f"backfill cap under 404s: {r13[0]} gets (2 per thread), worst 2 s window {r13[1]} <= 5, known rows {r13[2]}/8")
    [[kB, tidB]] = page.evaluate(SEED, [ACCT, 1, False, False]); page.evaluate("tid => { window.__mock.failNext = { match: new RegExp('messages/' + tid + 'b'), status: 500 }; }", tidB)
    page.evaluate("() => { window.mh.UNSUB_BACKFILL.perMinute = 1000; window.mh.UNSUB_BACKFILL.calls = []; return window.mh.backfillUnsub(); }"); preview.settle(page, 400)
    r13b = page.evaluate("([k, tid]) => { const t = window.mh.state.threads.get(k); return [t.unsubTries, t.unsubKnown, window.__mock.calls.filter(c => c.includes('messages/' + tid)).length]; }", [kB, tidB])
    check(r13b == [1, False, 1], f"backfill: a 500 ends the run after one get, counts a try, row stays a candidate {r13b}")
    page.evaluate("window.__mock.errors = window.__mock.errors.filter(e => !/messages\\/gx/.test(e))")
    # 14. a sync rebuild from legacy records keeps a header the row already learned
    r14 = page.evaluate("""([acct, k]) => { const t = window.mh.state.threads.get(k); t.unsub = '<https://learned.example/u>'; t.unsubPost = ''; t.unsubKnown = true; return rebuildGmailThreads(acct, [k]).then(() => { const u = window.mh.state.threads.get(k); return [u.unsub, u.unsubKnown]; }); }""", [ACCT, kB])
    check(r14 == ["<https://learned.example/u>", True], f"sync rebuild retains the learned header {r14}")
    # 15. hub rows: an outbound last message never supplies the header; the server's newest-inbound column does
    r15 = page.evaluate("""() => { const base = { id: 'h1', subject_norm: 's', participants: '[]', last_message_at: '2026-09-08T15:20:00Z', message_count: 2, state: 'inbox', starred: 0, unread: 0, labels: '[]', msg_ids: [], last: { id: 'm', direction: 'out', identity: 'sam@yourdomain.example', from_addr: 'sam@yourdomain.example', subject: 's', created_at: '2026-09-08T15:20:00Z', list_unsubscribe: '<mailto:leak@x>' } }; const a = window.mh.hub.norm(base); const b = window.mh.hub.norm({ ...base, unsub: JSON.stringify({ list_unsubscribe: '<https://in.example/u>', list_unsubscribe_post: 'List-Unsubscribe=One-Click' }) }); return [a.unsub, b.unsub, b.unsubPost]; }""")
    check(r15 == ["", "<https://in.example/u>", "List-Unsubscribe=One-Click"], f"hub rows: outbound last gated, newest-inbound column used {r15}")
    # 16. frame: body margins the mail forces stay inside the frame; content that shrinks after the first fit is unforced
    open_wide('<style>body{margin:20px !important}</style><table style="width:600px;min-width:600px"><tr><td id="wide">margins plus a wide table</td></tr></table>'); preview.settle(page, 1200); m = page.evaluate(MEASURE)
    check(bool(m) and m["tf"].startswith("scale(") and m["right"] <= m["cw"] - 10 + 1, f"fit margins: scaled {m and m['tf']} right {m and m['right']} inside {m and m['cw']} minus the html padding")
    open_wide('<div id="wide" style="width:700px;background:#eee">wide at first</div><p>stays</p>'); preview.settle(page, 1200); m1 = page.evaluate(MEASURE)
    page.evaluate("() => { const fr = document.querySelector('#msgs iframe'); fr.contentDocument.getElementById('wide').remove(); }"); preview.settle(page, 1800); m2 = page.evaluate("() => { const fr = document.querySelector('#msgs iframe'); const d = fr.contentDocument; return { tf: d.body.style.transform, w: d.body.style.width, ov: getComputedStyle(d.body).overflow, frH: Math.round(fr.getBoundingClientRect().height) }; }")
    check(bool(m1) and m1["tf"].startswith("scale(") and m2["tf"] == "" and m2["w"] == "" and m2["ov"] == "hidden", f"fit shrink: forced {m1 and m1['tf']} then unforced {m2}")
    # 17. links: the Android intent URL is well formed, a mail-body link goes through openExternal, and off-Android it stays a plain open
    r17 = page.evaluate("""() => { const i = window.mh.chromeIntent('https://portal.example.com/v/x?a=1&b=2#f'); return [i, window.mh.chromeIntent('mailto:x@y.z'), window.mh.chromeIntent('not a url')]; }""")
    check(r17[0] == "intent://portal.example.com/v/x?a=1&b=2#f#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=" + "https%3A%2F%2Fportal.example.com%2Fv%2Fx%3Fa%3D1%26b%3D2%23f" + ";end" and r17[1] is None and r17[2] is None, f"chrome intent url {r17}")
    r17b = page.evaluate("""() => { const seen = []; const real = window.open; window.open = (u) => { seen.push(u); return { closed: false }; }; try { window.mh.openExternal('https://ok.example/p'); } finally { window.open = real; } return [seen, window.mh.androidApp()]; }""")
    check(r17b[0] == ["https://ok.example/p"] and r17b[1] is False, f"desktop: plain open, no intent {r17b}")
    open_wide('<p><a id="wide" href="https://mail.example/link?x=1">a link in the mail</a></p>'); preview.settle(page, 900)
    r17c = page.evaluate("""() => { const seen = []; const real = window.open; window.open = (u) => { seen.push(u); return { closed: false }; }; try { const d = document.querySelector('#msgs iframe').contentDocument; d.getElementById('wide').click(); } finally { window.open = real; } return seen; }""")
    check(r17c == ["https://mail.example/link?x=1"], f"mail-body link routed through openExternal {r17c}")
    # 18. handled conversations are reported to the hub once per burst, not once per action
    page.evaluate("() => { window.__mock.routes['POST /api/notify/handled'] = { ok: true }; window.__mock.calls.length = 0; }")
    page.evaluate("""() => { const ks = [...window.mh.state.threads.keys()].slice(0, 3); window.mh.noteHandled([ks[0]]); window.mh.noteHandled([ks[1]]); window.mh.noteHandled([ks[1], ks[2]]); return ks; }""")
    preview.settle(page, 600); mid = page.evaluate("window.__mock.calls.filter(c => c.includes('notify/handled')).length")
    preview.settle(page, 4200)
    r18 = page.evaluate("""() => { const c = window.__mock.calls.filter(x => x.includes('notify/handled')); return [c.length, window.mh.state.threads.size]; }""")
    check(mid == 0 and r18[0] == 1, f"handled: nothing during the burst, one request after it ({mid} then {r18[0]})")
    # 19. the hub sync is incremental: the first sync mirrors, the next asks only for what changed, a tombstone removes the row
    r19a = page.evaluate("() => window.mh.idb.meta('hubSeq')")
    check(r19a == 7, f"first sync stored the feed position ({r19a!r})")
    page.evaluate("() => { window.__mock.calls.length = 0; }")
    page.evaluate("() => syncHub()"); preview.settle(page, 400)
    r19b = page.evaluate("""() => { const c = window.__mock.calls; return [c.filter(x => x.includes('since_seq=')).length, c.filter(x => x.includes('box=all')).length, c.filter(x => x.includes('box=trash')).length]; }""")
    check(r19b == [1, 0, 0], f"second sync is a delta, not a mirror: since={r19b[0]} box=all={r19b[1]} box=trash={r19b[2]}")
    gone_key = "hub|44444444-4444-4444-4444-444444444444"  # untouched by the earlier tests, so no pending/recent action defers it
    page.evaluate("""() => { window.__mock.routes['GET /api/threads?limit=500&since_seq=7'] = { threads: [], cursor: 8, deleted: ['44444444-4444-4444-4444-444444444444'], more: false }; window.__mock.routes['GET /api/threads?limit=500&since_seq=8'] = { threads: [], cursor: 8, deleted: [], more: false }; }""")
    page.evaluate("() => syncHub()"); preview.settle(page, 500)
    present = page.evaluate("k => window.mh.state.threads.has(k)", gone_key)
    cur = page.evaluate("() => window.mh.idb.meta('hubSeq')")
    stored = page.evaluate("k => window.mh.idb.get('threads', k).then(r => !!r)", gone_key)
    check(present is False and stored is False and cur == 8, f"a deletion event removed the thread here and moved the cursor (present={present} idb={stored} cursor={cur})")
    # a full mirror is still due after the window, and it re-learns the row the tombstone removed
    page.evaluate("() => window.mh.idb.meta('hubFullAt', 0)"); page.evaluate("() => { window.__mock.calls.length = 0; }")
    page.evaluate("() => syncHub()"); preview.settle(page, 600)
    r19d = page.evaluate("""() => [window.__mock.calls.filter(x => x.includes('box=all')).length, window.mh.state.threads.has('hub|44444444-4444-4444-4444-444444444444')]""")
    check(r19d == [1, True], f"the ten-minute reconcile mirrors again and restores what the hub still has {r19d}")
    # 20. a deletion that collides with an action this device still owes the hub is deferred, then applied once the queue drains
    K5 = "hub|33333333-3333-3333-3333-333333333333"
    page.evaluate("""k => { const t = window.mh.state.threads.get(k) || { key: k, account: 'hub', kind: 'hub', id: k.split('|')[1], state: 'inbox', unread: false, starred: false, subject: 's', date: Date.now(), msgIds: [] }; window.mh.state.threads.set(k, t); return window.mh.idb.putAll('threads', [t]); }""", K5)
    page.evaluate("""([k, seq]) => { window.mh.queue.recent.set(k, Date.now()); window.mh.idb.meta('hubSeq', seq); window.__mock.routes['GET /api/threads?limit=500&since_seq=' + seq] = { threads: [], cursor: seq + 1, deleted: [k.split('|')[1]], more: false }; window.__mock.routes['GET /api/threads?limit=500&since_seq=' + (seq + 1)] = { threads: [], cursor: seq + 1, deleted: [], more: false }; }""", [K5, 20])
    page.evaluate("() => syncHub()"); preview.settle(page, 400)
    r20a = page.evaluate("""k => window.mh.idb.meta('hubDeferredDeletes').then(d => [window.mh.state.threads.has(k), d || []])""", K5)
    check(r20a[0] is True and r20a[1] == ["33333333-3333-3333-3333-333333333333"], f"deletion deferred while an action is owed {r20a}")
    page.evaluate("k => window.mh.queue.recent.delete(k)", K5)
    page.evaluate("() => window.mh.flushDeferredDeletes()"); preview.settle(page, 400)
    r20b = page.evaluate("""k => window.mh.idb.meta('hubDeferredDeletes').then(d => [window.mh.state.threads.has(k), d || []])""", K5)
    check(r20b == [False, []], f"deferred deletion applied once nothing is owed {r20b}")
    # 21. the Gmail-copy dedupe set survives a quiet delta (A deleted message came back: it was the Gmail duplicate,
    #  unhidden because a delta that changed nothing never rebuilt the set, which has no durable copy)
    G3 = "sam.owner.sxsw@gmail.com|g3"; HUBK = "hub|22222222-2222-2222-2222-222222222222"
    page.evaluate("""([g, h]) => { const gt = window.mh.state.threads.get(g); const ht = window.mh.state.threads.get(h); gt.msgIds = ['dupe@yourdomain.example']; ht.msgIds = ['dupe@yourdomain.example']; ht.kind = 'hub'; window.mh.state.hubMsgIds = new Set(); }""", [G3, HUBK])
    before = page.evaluate("g => window.mh.isHubCopy(window.mh.state.threads.get(g))", G3)
    page.evaluate("() => syncHub()"); preview.settle(page, 500)
    after = page.evaluate("""g => [window.mh.state.hubMsgIds.size, window.mh.isHubCopy(window.mh.state.threads.get(g))]""", G3)
    check(before is False and after[1] is True and after[0] > 0, f"a quiet delta still rebuilds the dedupe set (before hidden={before}, after size={after[0]} hidden={after[1]})")
    # Settings → Swipes: picking an action repaints that slot's glyph and icon in the colour the swipe will show, and saves
    page.evaluate("() => document.querySelector('#settingsBtn').click()"); page.wait_for_function("() => !!document.querySelector('#swll')", timeout=8000)
    page.click("#scard [data-sec-nav=swipes]"); preview.settle(page, 300)
    SLOT = "id => { const el = document.getElementById(id), row = el.closest('.st-row'), pick = el.closest('.st-pick'); return [el.value, pick.style.getPropertyValue('--c'), pick.querySelector('svg.i use').getAttribute('href'), row.querySelectorAll('.st-swg rect')[1].style.fill]; }"
    before = page.evaluate(SLOT, "swll"); c0 = page.evaluate("window.__mock.calls.length")
    page.select_option("#swll", "unsubscribe"); preview.settle(page, 300)
    after = page.evaluate(SLOT, "swll"); made = page.evaluate("n => window.__mock.calls.slice(n)", c0)
    check(after == ["unsubscribe", "var(--unsub)", "#i-unsub", "var(--unsub)"], f"settings swipes: choosing Unsubscribe repaints the slot orange with its icon ({before} -> {after})")
    check("PUT /api/prefs" in made and page.evaluate("window.mh.state.prefs.swipes.leftLong") == "unsubscribe", f"settings swipes: and the choice is saved ({made})")
    page.select_option("#swll", before[0]); preview.settle(page, 200); page.evaluate("() => document.querySelector('#sclose').click()"); preview.settle(page, 300)
    # 13. pull down to refresh: a pull from the top of the list past the threshold refreshes once; a short tug, a sideways
    # drag and a pull from a scrolled list do not. (The row swipes above ran at the top of the list with this in place.)
    if page.is_visible("#back"): page.click("#back"); preview.settle(page, 300)
    # the background sync (refresh({ silent: true }) each minute) can land inside this window; only the pull's own refresh is counted
    page.evaluate("() => { window.__ptr = 0; window.__bg = 0; const o = window.refresh; window.refresh = (...a) => { if (a[0] && a[0].silent) window.__bg++; else window.__ptr++; return o(...a); }; document.querySelector('#threads').scrollTop = 0; }")
    def drag(dx, dy, steps=15, x=200):
        top = page.evaluate("() => document.querySelector('#threads').getBoundingClientRect().top") + 60
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": top}]})
        for i in range(1, steps + 1): cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x + dx * i / steps, "y": top + dy * i / steps}]}); page.wait_for_timeout(16)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []}); preview.settle(page, 700)
        return page.evaluate("window.__ptr")
    check(drag(0, 60) == 0, "a short pull (under the threshold) does not refresh")
    check(drag(-40, 18) == 0, "a sideways drag at the top of the list does not refresh")
    n = drag(0, 170); spun = page.evaluate("() => !!document.querySelector('.ptr')")
    check(n == 1 and spun, f"a pull past the threshold refreshes once ({n})")
    preview.settle(page, 500)
    check(page.evaluate("() => { const p = document.querySelector('.ptr'); return !p.classList.contains('spin') && getComputedStyle(p).opacity === '0'; }"), "the indicator goes away when the refresh is done")
    scrolled = page.evaluate("() => { const t = document.querySelector('#threads'); t.style.paddingBottom = '2000px'; t.scrollTop = 120; return t.scrollTop; }")
    check(scrolled > 0 and drag(0, 170) == 1, f"a pull from a scrolled list scrolls, it does not refresh (scrollTop {scrolled})")
    page.evaluate("() => { const t = document.querySelector('#threads'); t.style.paddingBottom = ''; t.scrollTop = 0; }")
    print(f"     (background syncs during the pull checks: {page.evaluate('window.__bg')})")
    # 14. the unread band: unread rows sit on --unread, read rows on the page; none in the Unread view, where all rows are unread
    BGS = "() => { const bg = (e) => e && getComputedStyle(e).backgroundColor; return [bg(document.querySelector('#threads .t.unread:not(.sel)')), bg(document.querySelector('#threads .t:not(.unread):not(.sel)')), bg(document.body)]; }"
    u, r, pg = page.evaluate(BGS)
    check(u and r and u != r and r == pg, f"an unread row has its band, a read row has the page's background ({u} / {r})")
    page.evaluate("() => window.mh.setView('unread')"); preview.settle(page, 400)
    u2, _, pg2 = page.evaluate(BGS)
    check(u2 == pg2, f"the Unread view has no band ({u2} / page {pg2})")
    page.evaluate("() => window.mh.setView('inbox')"); preview.settle(page, 300)
    check(not errs, f"end: page errors {errs[:3]}"); check(not page.evaluate("window.__mock.errors"), f"unmocked routes {page.evaluate('window.__mock.errors')}")
    b.close()
srv.shutdown()
print(f"\n{len(fails)} failed; shots in {OUT}"); sys.exit(1 if fails else 0)
