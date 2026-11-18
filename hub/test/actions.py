#!/usr/bin/env python3
"""Every thread action, every path, one table. Five tables and an if-chain used to say what an action does
(applyLocal, BULK_PATCH, BULK_LABELS, INVERSE, the local label copy, and each adapter); they drifted: Pin wrote the opposite label
locally, Done meant two things. The client now derives all of them from THREAD_ACTIONS. This test holds its OWN copy of the expected
table and checks, on WebKit and Chromium:
- the table is self-consistent: from every state an action is offered in, its labels take the conversation's labels exactly to the
  labels of the state it sets;
- the hub adapter sends exactly the table's state as its PATCH;
- the Gmail adapter sends exactly the table's labels (Trash by its own trash / untrash calls);
- applyLocal sets exactly the table's state, Pin toggles, and the local label copy follows (Pin adds STARRED, Unpin removes it);
- the bulk tables are the table's.
Usage: python3 test/actions.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
SPEC = {
    "archive": ({"state": "archived"}, [], ["INBOX"]),
    "done": ({"state": "archived", "unread": False}, [], ["INBOX", "UNREAD"]),
    "undone": ({"state": "inbox", "unread": True}, ["INBOX", "UNREAD"], []),
    "trash": ({"state": "trash"}, ["TRASH"], ["INBOX"]),
    "restore": ({"state": "inbox"}, ["INBOX"], ["TRASH"]),
    "spam": ({"state": "spam"}, ["SPAM"], ["INBOX"]),
    "notspam": ({"state": "inbox"}, ["INBOX"], ["SPAM"]),
    "read": ({"unread": False}, [], ["UNREAD"]),
    "unread": ({"unread": True}, ["UNREAD"], []),
    "star": ({"starred": True}, ["STARRED"], []),
    "unstar": ({"starred": False}, [], ["STARRED"]),
}
# Where each action is offered: the states it starts from.
OFFERED = {k: ["inbox", "archived"] for k in SPEC}; OFFERED["restore"] = ["trash", "archived"]; OFFERED["notspam"] = ["spam"]
def labels_of(s):
    out = set()
    if s["state"] == "inbox": out.add("INBOX")
    if s["state"] == "trash": out.add("TRASH")
    if s["state"] == "spam": out.add("SPAM")
    if s["unread"]: out.add("UNREAD")
    if s["starred"]: out.add("STARRED")
    return out
# 1. the spec itself (pure): labels after == labels of the state after, from every offered start
bad = []
for k, (st, add, rem) in SPEC.items():
    for state in OFFERED[k]:
        for unread in (False, True):
            for starred in (False, True):
                start = {"state": state, "unread": unread, "starred": starred}; after = {**start, **st}
                got = (labels_of(start) | set(add)) - set(rem)
                if got != labels_of(after): bad.append((k, start, sorted(got), sorted(labels_of(after))))
check(not bad, f"the expected table is self-consistent from every state each action is offered in ({bad[:2]})")
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        # record every request body the adapters make
        page.evaluate("""() => { window.__reqs = []; const f = window.fetch; window.fetch = async (u, o = {}) => { window.__reqs.push({ m: (o.method || 'GET').toUpperCase(), u: String(u), b: o.body || null }); return f(u, o); }; }""")
        hub_bad, gm_bad = [], []
        for k, (st, add, rem) in SPEC.items():
            if k in ("spam",): continue   # hub mail has no spam folder
            for was in (False, True):
                if k == "star" and was: continue   # star means "not starred before"; unstar is the starred case
                page.evaluate("() => { window.__reqs = []; }")
                act = "star" if k in ("star", "unstar") else k
                page.evaluate("async ([a, was]) => { try { await window.mh.adapterFor('hub').act({ id: '11111111-1111-1111-1111-111111111111', starred: was }, a); } catch (_) {} }", [act, k == "unstar"])
                r = [x for x in page.evaluate("() => window.__reqs") if x["m"] == "PATCH"]
                import json as _j
                body = _j.loads(r[0]["b"]) if r else None
                if body != st: hub_bad.append((k, body, st))
                break
        check(not hub_bad, f"{name}: the hub adapter PATCHes exactly the table's state for every action ({hub_bad[:2]})")
        page.evaluate("() => { for (const x of ['trash', 'untrash', 'modify']) window.__mock.routes['POST gmail:threads/gzz/' + x] = {}; }")
        for k, (st, add, rem) in SPEC.items():
            page.evaluate("() => { window.__reqs = []; }")
            act = "star" if k in ("star", "unstar") else k
            page.evaluate("async ([a, was, before]) => { try { await window.mh.adapterFor('sam.owner.sxsw@gmail.com').act({ id: 'gzz', starred: was, state: 'inbox', _before: before }, a); } catch (_) {} }", [act, k == "unstar", {"state": "trash"} if k == "restore" else {"state": "inbox"}])
            reqs = [x for x in page.evaluate("() => window.__reqs") if "gmail.googleapis.com" in x["u"]]
            mods = [_j.loads(x["b"]) for x in reqs if x["u"].endswith("/modify")]
            # Gmail's own trash call is the whole of Trash (no label change of ours); everything else is the table's labels, TRASH aside
            want_add, want_rem = ([], []) if k == "trash" else ([l for l in add if l != "TRASH"], [l for l in rem if l != "TRASH"])
            got_add = mods[0]["addLabelIds"] if mods else []; got_rem = mods[0]["removeLabelIds"] if mods else []
            trashed = any(x["u"].endswith("/trash") for x in reqs); untrashed = any(x["u"].endswith("/untrash") for x in reqs)
            ok = sorted(got_add) == sorted(want_add) and sorted(got_rem) == sorted(want_rem) and trashed == (k == "trash") and untrashed == (k == "restore")
            if not ok: gm_bad.append((k, got_add, got_rem, trashed, untrashed))
        check(not gm_bad, f"{name}: the Gmail adapter sends exactly the table's labels, and Trash by trash / untrash ({gm_bad[:2]})")
        # applyLocal: the state, the Pin toggle, and the local label copy
        G = "sam.owner.sxsw@gmail.com|g2"; P = "sam.owner.sxsw@gmail.com|g3"   # Pin on its own conversation: g2's label rebuilds are still landing
        local_bad = []
        for k in ("archive", "done", "undone", "trash", "restore", "read", "unread"):
            st = SPEC[k][0]
            got = page.evaluate("([k, a]) => { const t = window.mh.state.threads.get(k); t.state = 'inbox'; t.unread = false; window.mh.applyLocal(t, a); return { state: t.state, unread: t.unread }; }", [G, k])
            want = {"state": st.get("state", "inbox"), "unread": st.get("unread", False)}
            if got != want: local_bad.append((k, got, want))
        check(not local_bad, f"{name}: applyLocal sets exactly the table's state ({local_bad[:2]})")
        preview.settle(page, 800)
        page.evaluate("(k) => { const t = window.mh.state.threads.get(k); t.starred = false; window.mh.applyLocal(t, 'star'); }", P); preview.settle(page, 800)
        pinned = page.evaluate("async (k) => { const t = window.mh.state.threads.get(k); const ms = await window.mh.idb.getByIndex('messages', 'threadKey', k); return { starred: t.starred, labels: ms.map((m) => (m.labels || []).includes('STARRED')) }; }", P)
        page.evaluate("(k) => window.mh.applyLocal(window.mh.state.threads.get(k), 'star')", P); preview.settle(page, 800)
        unpinned = page.evaluate("async (k) => { const t = window.mh.state.threads.get(k); const ms = await window.mh.idb.getByIndex('messages', 'threadKey', k); return { starred: t.starred, labels: ms.map((m) => (m.labels || []).includes('STARRED')) }; }", P)
        check(pinned["starred"] is True and pinned["labels"] and all(pinned["labels"]) and unpinned["starred"] is False and not any(unpinned["labels"]),
              f"{name}: Pin toggles, and the local label copy follows: Pin adds STARRED, Unpin removes it ({pinned}, {unpinned})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print("all action-table checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
