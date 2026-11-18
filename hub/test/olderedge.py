#!/usr/bin/env python3
"""Old mail no longer lands in Unread by accident. The Mac app: Unread at 195, 189 of them sxsw promos
from September 2014, archived unread twelve years ago. One 2014 conversation on the device (loaded on 10-04 while it sat unread in
the inbox) was the oldest it held, and "load older mail" lists the 30 days before the oldest conversation, so one scroll loaded
September 2014. Checked on WebKit and Chromium:
- Unread lists unread mail in the inbox at any age and unread mail outside it from the last 90 days, and leaves out unread mail
  outside the inbox older than that; the sidebar's number counts the same;
- "load older mail" asks Gmail for the 30 days before the window's start (the fill's time less 90 days), never before a stray old
  conversation; it skips mail the device holds, goes back a further step when a step finds nothing new, and remembers how far it got;
- a sync writing the account's state does not roll that back; an expired history cursor (a refill) and a hub reset move it to the
  new window's start.
CONTROL=1 also runs the client as of 12ba746, which fails the Unread and the edge checks.
Usage: python3 test/olderedge.py (exit 1 on any failed check)"""
import os, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

EMAIL = "sam.owner.sxsw@gmail.com"
FILES = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]
def bundle(rev=None):
    src = lambda f: subprocess.run(["git", "show", f"{rev}:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=True).stdout if rev else (preview.CLIENT / f).read_text()
    return "\n".join(src(f) for f in FILES).replace("__VERSION__", "test")

# A Gmail of its own: list calls with after:/before: answer from window.__srv by date; message GETs answer from it and are recorded.
SETUP = r"""async (email) => {
  const day = 864e5, now = Date.now();
  const gid = (ms, n) => Math.floor(ms).toString(16) + n.toString(16).padStart(5, "0");
  const msg = (id, labels, subj) => ({ id, threadId: "t" + id, labelIds: labels, internalDate: String(parseInt(id.slice(0, -5), 16)), snippet: "snippet " + subj,
    payload: { headers: [{ name: "From", value: "Sender <s@example.com>" }, { name: "To", value: email }, { name: "Subject", value: subj }, { name: "Message-ID", value: "<" + id + "@x>" }] } });
  const ids = { STRAY: gid(Date.parse("2014-10-01T22:26:00Z"), 1), OLDUNREAD: gid(Date.parse("2014-09-20T12:00:00Z"), 2), OLDINBOX: gid(Date.parse("2014-08-01T12:00:00Z"), 3),
                RECENT: gid(now - 30 * day, 4), PAST: gid(now - 100 * day, 5), NEW1: gid(now - 95 * day, 6), NEW2: gid(now - 160 * day, 7) };
  // held: the stray (read, archived), an unread one archived in 2014, an unread one still in the inbox from 2014, and unread mail
  // outside the inbox from 30 and from 100 days ago
  await applyGmailMessages(email, [msg(ids.STRAY, ["CATEGORY_PROMOTIONS"], "stray 2014 promo"), msg(ids.OLDUNREAD, ["CATEGORY_PROMOTIONS", "UNREAD"], "unread 2014 promo"),
    msg(ids.OLDINBOX, ["INBOX", "UNREAD"], "unread 2014 inbox"), msg(ids.RECENT, ["UNREAD"], "unread archived 30 days"), msg(ids.PAST, ["UNREAD"], "unread archived 100 days")]);
  window.__srv = {}; for (const k of ["PAST", "NEW1", "NEW2"]) window.__srv[ids[k]] = msg(ids[k], ["CATEGORY_UPDATES"], "server " + k);
  window.__lists = []; window.__gets = [];
  const f = window.fetch;
  window.fetch = async (u, o = {}) => {
    const s = String(u), json = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body), headers: new Map() });
    const l = s.match(/gmail\/v1\/users\/me\/messages\?.*q=([^&]+)/);
    if (l) { const q = decodeURIComponent(l[1]), a = q.match(/after:(\d+) before:(\d+)/);
      if (a) { const after = +a[1], before = +a[2]; window.__lists.push({ after, before });
        return json({ messages: Object.values(window.__srv).filter((m) => +m.internalDate >= after * 1000 && +m.internalDate < before * 1000).map((m) => ({ id: m.id, threadId: m.threadId })) }); } }
    const g = s.match(/gmail\/v1\/users\/me\/messages\/([0-9a-f]+)\?/);
    if (g && window.__srv[g[1]]) { window.__gets.push(g[1]); return json(window.__srv[g[1]]); }
    return f(u, o);
  };
  return ids;
}"""

def run(engine, label):
    res = {}
    b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
    page.wait_for_function(f"(async () => {{ const s = await window.mh.idb.get('state', 'state|{EMAIL}'); return !!(s && s.filled && s.historyId === '100'); }})()", timeout=30000)
    page.wait_for_function("!window.mh.state.loading", timeout=30000)
    base_n = page.evaluate("() => counts().unread")
    ids = page.evaluate(SETUP, EMAIL)
    tk = {k: f"{EMAIL}|t{v}" for k, v in ids.items()}
    # --- Unread: the list and the sidebar's number ---
    page.evaluate("() => setView('unread')"); preview.settle(page, 300)
    listed = set(page.evaluate("() => visibleThreads().map((t) => t.key)"))
    shown = {k: tk[k] in listed for k in ("OLDINBOX", "RECENT", "OLDUNREAD", "PAST", "STRAY")}
    nav = page.evaluate("() => (document.querySelector('#nav a[data-view=\"unread\"]:not([data-account]) .n') || {}).textContent || ''")
    res["unread_list"] = shown == {"OLDINBOX": True, "RECENT": True, "OLDUNREAD": False, "PAST": False, "STRAY": False}
    res["unread_count"] = page.evaluate("() => counts().unread") == base_n + 2 and nav == str(base_n + 2)
    rows = page.evaluate("() => [...document.querySelectorAll('#threads .t')].map((r) => r.textContent)")
    res["unread_rows"] = any("unread 2014 inbox" in r for r in rows) and not any("unread 2014 promo" in r for r in rows)
    print(f"  [{label}] Unread shows {shown}; sidebar {nav!r} (before seeding {base_n})")
    # --- load older mail: where it asks Gmail from ---
    filled = page.evaluate(f"(async () => (await idb.get('state', 'state|{EMAIL}')).filledAt)()")
    start = (filled - 90 * 864e5) // 1000
    n1 = page.evaluate("(e) => extendGmailWindow(e, 30)", EMAIL)
    l1 = page.evaluate("() => window.__lists.slice()")
    gets1 = page.evaluate("() => window.__gets.slice()")
    print(f"  [{label}] first load older: lists {[(x['after'], x['before']) for x in l1]}, window start {int(start)}, fetched {n1}")
    res["first_step"] = len(l1) == 1 and abs(l1[0]["before"] - start) <= 2 and l1[0]["after"] == l1[0]["before"] - 30 * 86400
    res["skips_held"] = ids["PAST"] not in gets1 and ids["NEW1"] in gets1 and n1 == 1
    page.evaluate("() => { window.__lists.length = 0; window.__gets.length = 0; }")
    n2 = page.evaluate("(e) => extendGmailWindow(e, 30)", EMAIL)
    l2 = page.evaluate("() => window.__lists.slice()")
    res["steps_on"] = n2 == 1 and len(l2) == 2 and l1 and l2[0]["before"] == l1[0]["after"] and l2[1]["before"] == l2[0]["after"] and ids["NEW2"] in page.evaluate("() => window.__gets")
    edge = page.evaluate(f"() => idb.meta('gmailEdge|{EMAIL}')")
    res["remembered"] = bool(l2) and edge == l2[-1]["after"] * 1000
    print(f"  [{label}] second load older: {len(l2)} list call(s), fetched {n2}; edge {edge}")
    # a sync writes the account's state; the edge is its own record
    page.evaluate("(e) => { syncState.progress[e].window = { start: 0, n: 0 }; return window.mh.refresh({ silent: true, accounts: [e] }); }", EMAIL)
    page.wait_for_function("!window.mh.state.loading", timeout=30000)
    res["survives_sync"] = page.evaluate(f"() => idb.meta('gmailEdge|{EMAIL}')") == edge and edge is not None
    # an expired cursor drops the window and refills it: load older starts at the new window
    page.evaluate("""(e) => { window.__mock.routes['GET gmail:history?'] = { __status: 404, error: { code: 404, message: 'Requested entity was not found.' } };
      syncState.progress[e].window = { start: 0, n: 0 }; return window.mh.refresh({ silent: true, accounts: [e] }); }""", EMAIL)
    page.wait_for_function("!window.mh.state.loading", timeout=30000)
    page.wait_for_function(f"(async () => {{ const s = await idb.get('state', 'state|{EMAIL}'); return !!(s && s.filled); }})()", timeout=30000)
    page.evaluate("() => { window.__mock.routes['GET gmail:history?'] = { history: [], historyId: '100' }; window.__lists.length = 0; }")
    filled2 = page.evaluate(f"(async () => (await idb.get('state', 'state|{EMAIL}')).filledAt)()")
    page.evaluate("(e) => extendGmailWindow(e, 30)", EMAIL)
    l3 = page.evaluate("() => window.__lists.slice()")
    res["refill_resets"] = bool(l3) and abs(l3[0]["before"] - (filled2 - 90 * 864e5) // 1000) <= 2
    print(f"  [{label}] after a refill: first list before {l3[0]['before'] if l3 else None}, window start {int((filled2 - 90 * 864e5) // 1000)}")
    # a hub reset drops what its mirror lacks: the edge goes to the mirror's window
    at = page.evaluate(f"""(async (e) => {{ const at = new Date().toISOString();
      window.__mock.routes['GET /api/gmail/mirror?account=' + encodeURIComponent(e) + '&limit=1000'] = {{ cursor: 9, complete: true, at, rows: [], owed: [] }};
      await gmailHubMirror(e, {{ replace: 'reset' }}); return Date.parse(at); }})('{EMAIL}')""")
    res["reset_moves"] = page.evaluate(f"() => idb.meta('gmailEdge|{EMAIL}')") == at - 90 * 864e5
    res["no_errors"] = not errs
    if errs: print(f"  [{label}] page errors: {errs[:2]}")
    b.close()
    return res

NAMES = {"unread_list": "Unread lists inbox unread at any age and other unread from 90 days, not unread archived in 2014 or 100 days ago",
         "unread_count": "the sidebar's Unread number counts the same two",
         "unread_rows": "the list on screen shows the 2014 inbox mail and not the 2014 archived promo",
         "first_step": "load older asks Gmail for the 30 days before the window's start, not before the stray 2014 conversation",
         "skips_held": "it does not fetch mail the device already holds",
         "steps_on": "a step with nothing new goes on to the next 30 days, in the same call",
         "remembered": "how far it got is remembered",
         "survives_sync": "a sync writing the account's state leaves that alone",
         "refill_resets": "an expired history cursor (a refill) starts it again at the new window",
         "reset_moves": "a hub reset moves it to the mirror's window",
         "no_errors": "no page errors"}
fails = []
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        preview.BUNDLE = bundle()
        r = run(engine, engine.name)
        for k, m in NAMES.items():
            print(("ok   " if r.get(k) else "FAIL ") + f"{engine.name}: {m}")
            if not r.get(k): fails.append(f"{engine.name}: {m}")
    if preview.CONTROL:
        preview.BUNDLE = bundle("12ba746")
        r = run(pw.chromium, "12ba746")
        want = ["unread_list", "unread_count", "unread_rows", "first_step", "remembered"]
        missed = [k for k in want if r.get(k)]
        ok = not missed
        print(("ok   " if ok else "FAIL ") + f"CONTROL: the client at 12ba746 fails {', '.join(k for k in want if not r.get(k))}" + (f" (but passes {missed})" if missed else ""))
        if not ok: fails.append("CONTROL")
    else:
        preview.control_skipped("olderedge")
srv.shutdown()
print(f"\n{len(fails)} failed" if fails else "\nall older-mail checks passed")
sys.exit(1 if fails else 0)
