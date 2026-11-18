#!/usr/bin/env python3
"""Interaction speed battery, measured with the app's own instrumentation (perf.js: input event -> next animation frame).

Chromium at phone size with the CPU throttled 4x stands in for the Android app; WebKit at the Mac window's size, unthrottled (Playwright
cannot throttle WebKit), stands in for the Mac app. 1,500 conversations are put in the store and the page is reloaded, so boot reads them
from IndexedDB like a real launch. Every interaction is a real click or key press, so perf.measure() times it from the input event.
Caveats: the network is test/mock-fetch.js (instant), preview.py serves no service worker, and the seeded conversations have no bodies, 
only the fixture conversation can be opened. Usage: BENCH_OUT=out.txt python3 test/bench.py (not an argument: test/preview.py takes argv[1] as its screenshot folder)"""
import sys, json, time, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

ACCT = "sam.owner.sxsw@gmail.com"; N = 1500
OPEN_KEY = "hub|11111111-1111-1111-1111-111111111111"   # the fixture conversation whose body the mock serves
SEED = """async ([acct, n]) => { const S = window.mh.state; const now = Date.now(); const rows = [];
  for (let i = 0; i < n; i++) { const id = 'gb' + String(i).padStart(5, '0'); const key = acct + '|' + id;
    const t = { key, kind: 'gmail', account: acct, id, state: i % 3 ? 'inbox' : 'archived', unread: i % 2 === 0, starred: false, subject: 'Subject line number ' + i + ' about something', fromAddr: 's' + (i % 300) + '@example.com', fromName: 'Sender ' + (i % 300), date: now - (i + 1) * 3600e3 * 2, count: 1 + (i % 4), labels: ['INBOX'], snippet: 'A snippet of the message body for row ' + i, msgIds: [] };
    S.threads.set(key, t); rows.push(t); window.__mock.routes['POST gmail:threads/' + id + '/trash'] = {}; window.__mock.routes['POST gmail:threads/' + id + '/modify'] = {}; }
  await window.mh.idb.putAll('threads', rows); window.mh.prefs().groupSenders = false; window.mh.writeSnapshotNow && window.mh.writeSnapshotNow(); }"""
FRAME = "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))"

def run(pw, engine, label, ctx_opts, throttle):
    out = {}
    srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
    b = engine.launch(); ctx = b.new_context(**ctx_opts); page = ctx.new_page()
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); page.wait_for_timeout(1500)
    page.evaluate(SEED, [ACCT, N]); page.wait_for_timeout(1500)
    cdp = ctx.new_cdp_session(page) if throttle else None
    if cdp: cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    # 1. cold boot from the store (reload with the 1,500 rows in IndexedDB and the snapshot in localStorage)
    page.reload(); page.wait_for_function("window.mh && window.mh.state.threads.size >= 1500", timeout=60000)
    page.wait_for_function("window.mh.perf.boot.networkDone", timeout=60000); page.wait_for_timeout(1500)
    for _ in range(2):   # the mock answers instantly; let the boot refresh and any reconcile settle
        page.evaluate("() => window.mh.queue.drain && window.mh.queue.drain()"); page.wait_for_timeout(500)
    bt = page.evaluate("() => ({ ...window.mh.perf.boot, nav: window.mh.perf.report().nav })")
    out["boot"] = {k: bt.get(k) for k in ("storeReady", "firstPaint", "networkDone", "cached")} | {"domReady": (bt.get("nav") or {}).get("domReady")}
    if cdp: cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    page.evaluate("() => window.mh.perf.reset()")
    if cdp: cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    # 2. real interactions, each repeated
    for _ in range(6):   # switch views from the sidebar
        page.evaluate("() => window.mh.setView('inbox')"); page.evaluate(FRAME)
        page.evaluate("""async () => { const t0 = performance.now(); window.mh.setView('unread'); await new Promise((r) => requestAnimationFrame(r)); window.mh.perf.record('bench:switch-view', performance.now() - t0); }""")   # timed directly: on a phone the sidebar is an edge-swipe drawer
        page.evaluate(FRAME)
    page.evaluate("() => window.mh.setView('inbox')"); page.evaluate(FRAME)
    for _ in range(6):   # a refresh re-render of the same list (what every push/poll paints), timed directly
        page.evaluate("""async () => { const t0 = performance.now(); window.mh.render(); document.body.offsetHeight; await new Promise((r) => requestAnimationFrame(r)); window.mh.perf.record('bench:re-render', performance.now() - t0); }""")
        page.evaluate(FRAME)
    for _ in range(4):   # full refresh() (sync against the instant mock + index + render)
        page.evaluate("() => window.mh.refresh({ silent: true })"); page.wait_for_timeout(400)
    page.evaluate("k => { const t = window.mh.state.threads.get(k); t.date = Date.now(); t.state = 'inbox'; }", OPEN_KEY)   # top of the inbox, on screen
    for i in range(6):   # open the fixture conversation, prerendered and cold
        cold = i % 2 == 1
        page.evaluate("""async ([k, cold]) => { window.mh.setView('inbox'); if (cold) { window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((r) => r.key)); } else { await window.mh.prefetchBodies([window.mh.state.threads.get(k)]); await new Promise((r) => setTimeout(r, 600)); } }""", [OPEN_KEY, cold])
        page.evaluate(FRAME); row = page.locator(f'#threads .t[data-key="{OPEN_KEY}"]')
        page.evaluate("() => { document.querySelector('#threads').scrollTop = 0; }"); page.evaluate(FRAME)
        row.first.click(); page.wait_for_timeout(900)
        (out.setdefault("open_cold_ms" if cold else "open_prerendered_ms", [])).append(page.evaluate("() => { const s = window.mh.perf.stats['open-thread:visible']; return s ? s.samples[s.samples.length - 1] : null; }"))
        page.evaluate("() => window.mh.back && window.mh.back()"); page.evaluate(FRAME)
    page.evaluate("() => window.mh.setView('inbox')"); page.evaluate(FRAME)
    for i in range(8):   # trash from the list with the keyboard: hover a row (sets the key target), press #
        page.evaluate("() => { const el = document.querySelector('#threads'); el.scrollTop = 0; }"); page.evaluate(FRAME)
        r = page.locator("#threads .t[data-key^='sam.owner.sxsw@gmail.com|gb']").nth(3); r.hover(); page.keyboard.press("#"); page.wait_for_timeout(300)
    # search: type a query one key at a time, time each keystroke to the frame after the list changed
    page.evaluate("() => window.mh.setView('inbox')"); page.evaluate(FRAME)
    page.click("#q"); ks = []
    for ch in "number 12":
        t = page.evaluate("""(ch) => new Promise((res) => { const q = document.querySelector('#q'); const el = document.querySelector('#threads'); const t0 = performance.now(); let done = false;
          const mo = new MutationObserver(() => { if (done) return; done = true; mo.disconnect(); requestAnimationFrame(() => res(performance.now() - t0)); }); mo.observe(el, { childList: true, subtree: true });
          q.value += ch; q.dispatchEvent(new Event('input', { bubbles: true })); setTimeout(() => { if (!done) { done = true; mo.disconnect(); res(null); } }, 3000); })""", ch)
        if t is not None: ks.append(round(t, 1))
        page.wait_for_timeout(250)
    out["search_keystroke_ms"] = ks
    page.evaluate("() => { const q = document.querySelector('#q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }"); page.wait_for_timeout(500)
    # scrolling into older rows: the 80-row append and any long tasks while flinging down the list
    page.evaluate("() => window.mh.setView('inbox')"); page.evaluate(FRAME)
    lt = page.evaluate("""async () => { const longs = []; let po; try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(Math.round(e.duration)); }); po.observe({ type: 'longtask', buffered: false }); } catch (_) {}
      const el = document.querySelector('#threads'); const frames = []; let last = performance.now();
      for (let i = 0; i < 60; i++) { el.scrollTop += 400; await new Promise((r) => requestAnimationFrame(r)); const now = performance.now(); frames.push(now - last); last = now; }
      po && po.disconnect(); frames.sort((a, b) => a - b); return { rowsNow: el.querySelectorAll('.t').length, frame_p50: Math.round(frames[30]), frame_p95: Math.round(frames[56]), frame_max: Math.round(frames[59]), longTasks: longs }; }""")
    out["scroll_fling"] = lt
    if cdp: cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    rep = page.evaluate("() => window.mh.perf.report().rows")
    SCRIPTED = {"switch-view", "search-keystroke"}   # driven from script here, so perf.js times them from a stale input: not reported
    out["interactions"] = {r["name"]: {k: r[k] for k in ("n", "p50", "p95", "under50", "under100")} for r in rep if r["n"] and r["name"] not in SCRIPTED and not r["name"].endswith(":net")}
    ctx.close(); b.close(); srv.shutdown()
    return out

with sync_playwright() as pw:
    res = {
        "android-like: Chromium 390x844, CPU 4x slower": run(pw, pw.chromium, "phone", {"viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True, "device_scale_factor": 3}, True),
        "mac-like: WebKit 1280x792, unthrottled": run(pw, pw.webkit, "mac", {"viewport": {"width": 1280, "height": 792}}, False),
    }
text = f"bench.py — {time.strftime('%Y-%m-%d %H:%M %Z')} — {N} conversations in the store\n" + json.dumps(res, indent=1)
print(text)
if os.environ.get("BENCH_OUT"): Path(os.environ["BENCH_OUT"]).write_text(text + "\n")
