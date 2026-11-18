#!/usr/bin/env python3
"""Message bodies are written into sandboxed frames (writeFrame): nothing in a mail may run, on WebKit or Chromium.

Bodies moved from <iframe srcdoc> (an asynchronous navigation; in the Mac app each one also waited on the app's policy
delegate, so the mail showed 14-54 ms after the tap) to document.open/write/close into a frame whose sandbox is set before it exists,
as Proton and Mailspring do. The sandbox is the same (allow-same-origin, allow-popups, NO allow-scripts) and this test is the proof
that the new path keeps it: a hostile mail's script, event handlers, javascript: link, meta refresh and nested frame all stay dead,
and the mail is in its frame in the same task as the open (that is the speed claim). Usage: python3 test/sandbox.py"""
import socket, sys, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

KEY = "hub|11111111-1111-1111-1111-111111111111"; TID = "11111111-1111-1111-1111-111111111111"
# A stand-in for the sender's own server: every TCP connection to it is counted, so even a bare preconnect (no HTTP request) shows.
# WebKit (the Mac app's engine) opened one for a mail's <link rel="preconnect"> under the frame's CSP until links were made inert.
sender = socket.socket(); sender.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); sender.bind(("127.0.0.1", 0)); sender.listen(20)
SENDER = f"http://127.0.0.1:{sender.getsockname()[1]}"; contacted = []
def _accept():
    while True:
        try: c, _ = sender.accept()
        except OSError: return
        contacted.append(1); c.close()
threading.Thread(target=_accept, daemon=True).start()
HOSTILE = f"""<link rel="preconnect" href="{SENDER}"><link rel="dns-prefetch" href="{SENDER}"><link rel="prefetch" href="{SENDER}/prefetch">
<div style="background:url(/api/stats?probe=css)">hub route by CSS</div><svg width="4" height="4"><image href="/api/stats?probe=svg" width="4" height="4"/></svg>
<img src="https://cdn.example.com/legit.png" width="20" height="20">""" + """<p id="marker">hostile mail marker</p>
<script>parent.__pwned = (parent.__pwned || []).concat('script'); top.__pwned = (top.__pwned || []).concat('script-top');</script>
<img src="x-does-not-exist.png" onerror="parent.__pwned = (parent.__pwned || []).concat('onerror')">
<svg onload="parent.__pwned = (parent.__pwned || []).concat('svg')"><rect width="1" height="1"/></svg>
<a id="js" href="javascript:parent.__pwned=(parent.__pwned||[]).concat('jslink')">click</a>
<meta http-equiv="refresh" content="0;url=https://example.com/">
<iframe src="https://example.com/"></iframe>
<form action="https://example.com/" method="post"><input name="a" value="b"><button id="go">go</button></form>
<div style="height:600px">tall</div>"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        page = b.new_page(viewport={"width": 1280, "height": 792}); errs = []; hub = []; contacted.clear()
        page.on("pageerror", lambda e: errs.append(str(e))); page.on("request", lambda r: hub.append(r.url)); csp = set()
        page.on("requestfailed", lambda r: csp.add(r.url) if r.failure == "csp" else None)   # Chromium reports a request its CSP refused, then fails it unsent
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate("""([tid, html]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; }); }""", [TID, HOSTILE])
        # open it: the mail must already be in its frame when openThread's synchronous work is done (no navigation to wait for)
        same_task = page.evaluate("""async (k) => { window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((r) => r.key));
          const d = await window.mh.cachedThread(window.mh.state.threads.get(k)) ; await window.mh.openThread(k);
          const fr = document.querySelector('#msgs iframe'); const doc = fr && fr.contentDocument;
          return { frame: !!fr, srcdoc: fr ? fr.hasAttribute('srcdoc') : null, sandbox: fr ? fr.getAttribute('sandbox') : null, marker: !!(doc && doc.getElementById('marker')), height: fr ? fr.style.height : '' }; }""", KEY)
        check(same_task["frame"] and not same_task["srcdoc"], f"{name}: the body frame is written, not a srcdoc navigation ({same_task})")
        check(same_task["marker"], f"{name}: the mail is inside its frame in the same task as the open")
        check(same_task["sandbox"] == "allow-same-origin allow-popups allow-popups-to-escape-sandbox", f"{name}: the sandbox is unchanged, with no allow-scripts ({same_task['sandbox']})")
        preview.settle(page, 1500)
        # try the link and the form too
        page.evaluate("() => { const d = document.querySelector('#msgs iframe').contentDocument; d.getElementById('js').click(); d.getElementById('go').click(); }")
        preview.settle(page, 1500)
        pwned = page.evaluate("() => window.__pwned || null")
        check(pwned is None, f"{name}: no script, handler or javascript: link in the mail ran ({pwned})")
        after = page.evaluate("""() => { const fr = document.querySelector('#msgs iframe'); let same = false, url = null, nested = null; try { const d = fr.contentDocument; same = !!(d && d.getElementById('marker')); url = d && d.URL; const inner = d && d.querySelector('iframe'); nested = inner ? (() => { try { return inner.contentDocument ? inner.contentDocument.URL : 'blocked'; } catch (_) { return 'cross-origin'; } })() : null; } catch (_) { same = false; url = 'cross-origin'; } return { same, url, nested }; }""")
        check(after["same"], f"{name}: the meta refresh and the form did not navigate the frame away ({after['url']})")
        check(after["nested"] in (None, "about:blank", "blocked"), f"{name}: the mail's own iframe loaded nothing ({after['nested']})")
        check(not contacted, f"{name}: nothing in the mail contacted the sender's server directly — no preconnect, prefetch or DNS prefetch ({len(contacted)} connections)")
        reached = [u for u in hub if "/api/stats" in u and u not in csp]
        check(not reached, f"{name}: a CSS url() or svg <image> cannot reach any other hub address ({reached[:2]})")
        check(any("/api/img?u=" + "https%3A%2F%2Fcdn.example.com%2Flegit.png" in u for u in hub), f"{name}: the mail's real image still loads through the proxy")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print(f"\n{len(fails)} failed" if fails else "\nall passed"); sys.exit(1 if fails else 0)
