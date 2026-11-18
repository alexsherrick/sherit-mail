#!/usr/bin/env python3
"""A notification tapped for a conversation the app already holds shows the new reply, and an open conversation follows its row.
 WebKit and Chromium, at a phone (and a Mac window for the reply case), with a fake Android bridge.

A reply to a conversation the user had just answered arrived at 20:33, its notification was tapped
at 20:39, and the conversation opened without it; leaving and opening it again showed it. The page had been frozen in the background,
so the push's download was imported only as the tap ran; the tap drew the prerendered copy from before the reply, with no freshness
check, and when the import or the resume sync then taught the row about the reply, only the list was redrawn.

Thread K holds an inbound message and the user's reply, and is opened. A new reply lands on the hub. Then:
  - the thaw: the push's queued importNow(), the tap's openUrl() and the page becoming visible, in both orders, with the phone's
    download stashed; and with no download (only the resume sync learns of it); and tapped from the list. Each ends with the open
    conversation showing the new reply, still open, and back() returns to the list;
  - the app in front: refresh() (what a push does then) with the conversation open draws the reply into it;
  - scrolled into the conversation: refresh() leaves the view where it was (a redraw starts at the top);
  - a reply being written (Mac window): refresh() keeps the text and the view; once the box is empty the next refresh() draws it;
  - a row whose newest message the conversation never has: two refreshes make one attempt to fetch it, not one per refresh;
  - no page errors.
CONTROL=1 also runs the client at 0c2f6c7, whose open conversation stays without the reply in the thaw cases.
"""
import subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

FILES = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]
def src(rev, f): return subprocess.run(["git", "show", f"{rev}:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=True).stdout if rev else (preview.CLIENT / f).read_text()
def bundle(rev=None): return "\n".join(src(rev, f) for f in FILES).replace("__VERSION__", "test")

ID = "77777777-7777-7777-7777-777777777777"; KEY = f"hub|{ID}"
INIT = """(() => {
  const ID = '%s';
  const msg = (id, dir, name, addr, at, text) => ({ id, direction: dir, from_addr: addr, from_name: name, identity: 'sam@yourdomain.example', to_addrs: [{ address: dir === 'out' ? 'desk@case.example' : 'sam@yourdomain.example' }], cc_addrs: [], subject: 'Case 345', body_text: text, body_html: '', created_at: at, attachments: [], message_id: '<' + id + '@x.example>', labels: '[]' });
  const m1 = msg('k1', 'in', 'Case Desk', 'desk@case.example', '2026-11-17T20:20:56Z', 'first comment');
  const m2 = msg('k2', 'out', 'Sam', 'sam@yourdomain.example', '2026-11-17T20:29:20Z', Array.from({ length: 120 }, (_, i) => 'line ' + i + ' of my reply').join('\\n'));
  const m3 = msg('k3', 'in', 'Case Desk', 'desk@case.example', '2026-11-17T20:33:51Z', 'NEW REPLY');
  const row = (ms, unread) => ({ id: ID, subject_norm: 'case 345', participants: '[]', last_message_at: ms[ms.length - 1].created_at, message_count: ms.length, state: 'inbox', starred: 0, unread, labels: '[]',
    last: { ...ms[ms.length - 1], to_addrs: JSON.stringify(ms[ms.length - 1].to_addrs) } });
  window.__case = { ID, m1, m2, m3, row, detail: (ms, unread) => ({ thread: { id: ID, state: 'inbox', starred: 0, unread, labels: '[]' }, messages: ms }) };
  window.__mockSetup = (m) => { m.hubThreads.unshift(row([m1, m2], 0)); m.routes['GET /api/threads/' + ID] = window.__case.detail([m1, m2], 0); };
  // The Android app's bridge, answering asynchronously as the real one does (a Java thread).
  window.__stashes = [];
  window.SheritAndroid = { onmessage: null, postMessage(s) { const q = JSON.parse(s); let result = null;
    if (q.op === 'takeStashes') result = window.__stashes.map((x) => ({ ...x, file: 'f' + x.id + '.json', mtime: x.mtime }));
    if (q.op === 'ackStashes') { window.__stashes = window.__stashes.filter((x) => !q.args.files.some((f) => f.mtime === x.mtime)); result = true; }
    if (q.op === 'activeKeys') result = []; if (q.op === 'dismiss') result = []; if (q.op === 'log') result = true;
    setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify({ id: q.id, result }) }), 15); } };
})();""" % ID

STATE = """(k) => ({ cur: window.mh.state.cur, viewing: document.querySelector('#app').classList.contains('viewing'), shown: document.querySelectorAll('#msgs .m').length,
  ids: (window.mh.state.curThread?.messages || []).map((m) => m.id), lastMsgId: window.mh.state.threads.get(k)?.lastMsgId, top: document.querySelector('#msgs').scrollTop,
  rtext: document.querySelector('#rtext').value })"""
LAND = """(ms) => { const c = window.__case, r = window.__mock.routes, list = ms.map((x) => c[x]);
  r['GET /api/threads/' + c.ID] = c.detail(list, 1); const row = c.row(list, 1); window.__mock.hubThreads[0] = row;
  r['GET /api/threads?limit=500&since_seq=7'] = { threads: [row], cursor: 7, deleted: [], more: false }; }"""
STASH = """() => { const c = window.__case; window.__stashes = [{ kind: 'imap', account: 'hub', id: c.ID, at: Date.now(), mtime: Date.now(), raw: c.detail([c.m1, c.m2, c.m3], 1) }]; }"""
OPEN_URL = f"window.mh.openUrl('/?account=hub&thread={ID}')"
VIS = "document.dispatchEvent(new Event('visibilitychange'))"
THAW = {"stash, import first": f"() => {{ window.mh.importNow(); {OPEN_URL}; {VIS}; }}",
        "stash, resume first": f"() => {{ {VIS}; window.mh.importNow(); {OPEN_URL}; }}",
        "no stash": f"() => {{ {OPEN_URL}; {VIS}; }}",
        "from the list": f"() => {{ window.mh.importNow(); {OPEN_URL}; {VIS}; }}"}

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def page_for(b, vp, errs):
    page = b.new_page(viewport=vp); page.on("pageerror", lambda e: errs.append(str(e))); page.add_init_script(INIT)
    page.goto(base); page.wait_for_function(f"() => window.mh && window.mh.state.threads.has('{KEY}')", timeout=30000); preview.settle(page, 800)
    page.evaluate("(k) => window.mh.openThread(k)", KEY); preview.settle(page, 600); return page

def run(engine, tag, control=False):
    out = {}; b = engine.launch(); PHONE = {"width": 390, "height": 844}
    for case, thaw in THAW.items():
        errs = []; page = page_for(b, PHONE, errs)
        if case == "from the list": page.evaluate("() => window.mh.back()"); preview.settle(page, 400)
        page.evaluate(LAND, ["m1", "m2", "m3"])
        if case != "no stash": page.evaluate(STASH)
        page.evaluate(thaw); preview.settle(page, 2500); s = page.evaluate(STATE, KEY); out[case] = s
        if not control:
            check(s["lastMsgId"] == "k3" and s["cur"] == KEY and s["viewing"] and s["shown"] == 3 and "k3" in s["ids"], f"{tag} tap, {case}: the conversation shows the new reply (shown {s['shown']}, {s['ids']})")
            page.evaluate("() => window.mh.back()"); preview.settle(page, 400)
            check(not page.evaluate("() => document.querySelector('#app').classList.contains('viewing')"), f"{tag} tap, {case}: back() returns to the list")
            check(not errs, f"{tag} tap, {case}: no page errors {errs[:2]}")
        page.close()
    if control: b.close(); return out
    # the app in front: a push only refreshes
    errs = []; page = page_for(b, PHONE, errs); page.evaluate(LAND, ["m1", "m2", "m3"]); page.evaluate("() => window.mh.refresh()"); preview.settle(page, 1500)
    s = page.evaluate(STATE, KEY); check(s["shown"] == 3 and "k3" in s["ids"] and s["viewing"], f"{tag} in front: a refresh draws the reply into the open conversation (shown {s['shown']})")
    page.close()
    # scrolled into the conversation: left where it is
    errs = []; page = page_for(b, PHONE, errs); page.evaluate("() => { document.querySelector('#msgs').scrollTop = 400; }"); top0 = page.evaluate(STATE, KEY)["top"]
    page.evaluate(LAND, ["m1", "m2", "m3"]); page.evaluate("() => window.mh.refresh()"); preview.settle(page, 1500); s = page.evaluate(STATE, KEY)
    check(top0 > 40 and s["shown"] == 2 and s["top"] == top0, f"{tag} scrolled: a refresh leaves the view where it was (top {top0} -> {s['top']}, shown {s['shown']})")
    check(not errs, f"{tag} in front and scrolled: no page errors {errs[:2]}")
    page.close()
    # a reply being written, at a Mac window: kept; drawn once the box is empty
    errs = []; page = page_for(b, {"width": 1000, "height": 740}, errs); page.evaluate("() => { document.querySelector('#rtext').value = 'Thanks, I will'; }")
    page.evaluate(LAND, ["m1", "m2", "m3"]); page.evaluate("() => window.mh.refresh()"); preview.settle(page, 1500); s = page.evaluate(STATE, KEY)
    check(s["rtext"] == "Thanks, I will" and s["shown"] == 2, f"{tag} replying: a refresh keeps the reply being written and the view ({s['rtext']!r}, shown {s['shown']})")
    page.evaluate("() => { document.querySelector('#rtext').value = ''; document.activeElement && document.activeElement.blur(); }"); page.evaluate("() => window.mh.refresh()"); preview.settle(page, 1500); s = page.evaluate(STATE, KEY)
    check(s["shown"] == 3, f"{tag} replying: once the box is empty the next refresh draws the reply (shown {s['shown']})")
    check(not errs, f"{tag} replying: no page errors {errs[:2]}")
    page.close()
    # a row whose newest message the conversation never has: fetched at most once
    errs = []; page = page_for(b, PHONE, errs)
    page.evaluate("""() => { const c = window.__case, r = window.__mock.routes; const row = c.row([c.m1, c.m2, c.m3], 0);
      window.__mock.hubThreads[0] = row; r['GET /api/threads?limit=500&since_seq=7'] = { threads: [row], cursor: 7, deleted: [], more: false }; }""")   # the detail keeps 2 messages
    # Counted by caller: the list's own fetch-ahead (prefetchBodies) also fetches a conversation whose prerender went stale, once per
    # refresh, with or without this change (measured in November 2026); only followOpenThread's fetches are this check's business.
    page.evaluate(f"""() => {{ const f = window.fetch; window.__follow = 0; window.fetch = (url, o) => {{
      if (/\\/api\\/threads\\/{ID}(\\?|$)/.test(String(url)) && String(new Error().stack || '').includes('followOpenThread')) window.__follow++; return f(url, o); }}; }}""")
    for _ in range(2): page.evaluate("() => window.mh.refresh()"); preview.settle(page, 1200)
    n = page.evaluate("() => window.__follow"); s = page.evaluate(STATE, KEY)
    check(s["lastMsgId"] == "k3" and s["shown"] == 2 and n == 1, f"{tag} never shown: the row knows a newest message the conversation lacks, and two refreshes try to fetch it once ({n} fetches, row {s['lastMsgId']}, shown {s['shown']})")
    check(not errs, f"{tag} never shown: no page errors {errs[:2]}")
    page.close(); b.close(); return out

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        preview.BUNDLE = bundle(); run(engine, engine.name)
    if preview.CONTROL:   # 0c2f6c7: the tap draws the prerendered copy and nothing redraws it
        preview.BUNDLE = bundle("0c2f6c7"); r = run(pw.chromium, "0c2f6c7", control=True)
        stale = {k: v["shown"] for k, v in r.items() if k != "from the list"}
        check(all(n == 2 for n in stale.values()), f"CONTROL: the client at 0c2f6c7 leaves the reply out of the open conversation after the tap ({stale})")
    else:
        preview.control_skipped("notifyfresh")
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all notification-freshness checks passed")
sys.exit(1 if fails else 0)
