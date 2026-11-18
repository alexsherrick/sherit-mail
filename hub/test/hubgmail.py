#!/usr/bin/env python3
"""Gmail through the hub, on the device. The hub follows Gmail and keeps each message's metadata; a device syncs Gmail
from the hub's feed beside domain mail instead of replaying Gmail's history itself. Checked on WebKit and Chromium, through the real
refresh(), starting from a device that synced Gmail directly (the mock's 90-day fill):
- when the hub says the account's mirror is ready, the device switches: it takes the whole mirror, REPLACES its copy from it (a message
  the mirror lacks goes; one it has changed is updated; a new one appears) and rewinds its feed cursor to the mirror's;
- after the switch a Gmail change arrives in the feed: a row updates labels, a deletion removes the message, a stub updates only a
  message the device holds, and the device asks Gmail for nothing (no history, no list);
- an action the device has not finished sending still wins over the feed;
- the account says "updating" while the hub owes messages or is stale, and stops when it is current;
- a mirror that is not complete never deletes what the device holds;
- if the hub stops mirroring the account, the device goes back to Gmail directly.
Usage: python3 test/hubgmail.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
E = "sam.owner.sxsw@gmail.com"
HELPERS = r"""() => {
  const E = 'sam.owner.sxsw@gmail.com';
  window.__meta = (id, tid, subj, labels) => JSON.stringify({ id, threadId: tid, labelIds: labels, internalDate: String(Date.now() - 3600e3), snippet: 'snippet ' + subj,
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Hub Sender <hub@example.com>' }, { name: 'To', value: E }, { name: 'Subject', value: subj }, { name: 'Message-ID', value: '<' + id + '@mail.gmail.com>' }] } });
  window.__row = (id, tid, subj, labels, meta = true) => ({ account: E, id, thread_id: tid, labels: JSON.stringify(labels), internal_date: Date.now() - 3600e3, meta: meta ? window.__meta(id, tid, subj, labels) : null, history_id: '9' });
  window.__status = (o = {}) => ({ [E]: { state: 'ready', synced_at: new Date().toISOString(), owed: 0, ...o } });
  window.__feed = (from, body) => { window.__mock.routes['GET /api/threads?limit=500&since_seq=' + from] = { threads: [], deleted: [], more: false, ...body }; };
  window.__mirror = (body) => { window.__mock.routes['GET /api/gmail/mirror?account=' + encodeURIComponent(E) + '&limit=1000'] = { next: null, at: new Date().toISOString(), owed: [], ...body }; };
  window.__thread = (tid) => { const t = window.mh.state.threads.get(E + '|' + tid); return t ? { state: t.state, unread: !!t.unread, subject: t.subject } : null; };
  window.__refresh = async () => { for (let i = 0; i < 200 && window.mh.state.loading; i++) await new Promise((r) => setTimeout(r, 25)); await window.mh.refresh({ silent: true }); };
  window.__calls = () => window.__mock.calls.slice();
}"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
        page.wait_for_function(f"(async () => {{ const s = await window.mh.idb.get('state', 'state|{E}'); return !!(s && s.filled); }})()", timeout=30000)
        page.wait_for_function("!window.mh.state.loading", timeout=30000)
        page.evaluate(HELPERS)
        before = {k: page.evaluate("(t) => window.__thread(t)", k) for k in ("g1", "g2", "g3")}
        check(all(before.values()) and before["g1"]["unread"], f"{name}: before: Gmail was synced directly ({before})")
        # ---- ready but still owed messages: no switch yet
        page.evaluate("() => { window.__feed(7, { cursor: 7, gmail_status: window.__status({ owed: 2 }) }); }")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        sw = page.evaluate("() => window.mh.idb.meta('gmailHub')")
        check(not (sw or {}).get(E), f"{name}: a mirror that still owes messages is not switched to ({sw})")
        # ---- the hub says the mirror is ready and owes nothing: switch
        page.evaluate("""() => { window.__feed(7, { cursor: 7, gmail_status: window.__status() });
          window.__mirror({ cursor: 5, complete: true, status: window.__status()[Object.keys(window.__status())[0]], rows: [window.__row('gm2', 'g2', 'Your order', ['INBOX', 'CATEGORY_UPDATES', 'UNREAD']), window.__row('gm5', 'g5', 'Arrived while away', ['INBOX', 'UNREAD'])] });
          window.__feed(5, { cursor: 7, gmail_status: window.__status() }); }""")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        sw = page.evaluate("() => window.mh.idb.meta('gmailHub')")
        check(sw and E in sw, f"{name}: the account switches to the hub when its mirror is ready and owes nothing ({sw})")
        t1, t2, t3, t5 = (page.evaluate("(t) => window.__thread(t)", k) for k in ("g1", "g2", "g3", "g5"))
        check(t2 == {"state": "inbox", "unread": True, "subject": "Your order"}, f"{name}: a message the mirror changed is updated (unread elsewhere: {t2})")
        check(t5 and t5["unread"] and t5["state"] == "inbox", f"{name}: a message the device never had appears ({t5})")
        check(t1 is None, f"{name}: an unread inbox message the complete mirror lacks is gone: the mirror is authoritative for it ({t1})")
        check(t3 is not None, f"{name}: old read mail the mirror never lists stays (7140366f70) ({t3})")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        seq = page.evaluate("() => window.mh.idb.meta('hubSeq')")
        check(seq == 7 and "GET /api/threads?limit=500&since_seq=5" in page.evaluate("() => window.__calls()"), f"{name}: the feed cursor was rewound to the mirror's (5), so nothing between the two reads is skipped (now {seq})")
        # ---- Storage & sync shows when the hub last read Gmail, not the stale direct-sync time (the user's phone)
        page.evaluate("() => window.mh.openSettings('data')")
        page.wait_for_function("(document.querySelector('#syncstat')?.textContent || '').includes('through the hub')", timeout=10000)
        txt = page.evaluate("() => document.querySelector('#syncstat').textContent")
        line = [l for l in page.evaluate("() => [...document.querySelectorAll('#syncstat div')].map((d) => d.textContent)") if l.startswith(E)]
        check(len(line) == 1 and "the hub last read Gmail" in line[0] and "history" not in line[0], f"{name}: Storage & sync gives a switched account one line, with the hub's last read and no stale history ({line})")
        page.evaluate("() => window.mh.closeSettings()")
        # ---- after the switch: Gmail changes come in the feed; the device asks Gmail for nothing
        n0 = len(page.evaluate("() => window.__calls()"))
        page.evaluate("""() => { window.__feed(7, { cursor: 9, gmail_status: window.__status(), gmail: [window.__row('gm2', 'g2', 'Your order', ['INBOX']), window.__row('gmX', 'gX', 'never held', ['STARRED'], false)], gmail_deleted: [{ account: Object.keys(window.__status())[0], id: 'gm3' }] });
          window.__feed(9, { cursor: 9, gmail_status: window.__status() }); }""")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        t2, t3, tx = (page.evaluate("(t) => window.__thread(t)", k) for k in ("g2", "g3", "gX"))
        later = page.evaluate("() => window.__calls()")[n0:]
        check(t2 and not t2["unread"], f"{name}: a label change arrives in the feed (read elsewhere: {t2})")
        check(t3 is None, f"{name}: a deletion in the feed removes the message ({t3})")
        check(tx is None, f"{name}: a stub for a message the device never held adds nothing ({tx})")
        gm = [c for c in later if c.startswith("GET gmail:history") or c.startswith("GET gmail:messages?")]
        check(not gm and any("since_seq=7" in c for c in later), f"{name}: the device asks Gmail for nothing to sync ({gm[:3]})")
        # a stub for a held message updates its labels only
        page.evaluate("""() => { window.__feed(9, { cursor: 10, gmail_status: window.__status(), gmail: [window.__row('gm2', 'g2', 'x', ['INBOX', 'UNREAD'], false)] }); window.__feed(10, { cursor: 10, gmail_status: window.__status() }); }""")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        t2 = page.evaluate("(t) => window.__thread(t)", "g2")
        check(t2 == {"state": "inbox", "unread": True, "subject": "Your order"}, f"{name}: a stub updates a held message's labels and nothing else ({t2})")
        # ---- an unfinished action wins over the feed
        page.evaluate(f"""() => {{ const k = '{E}|g5'; queue.recent.set(k, Date.now()); const t = window.mh.state.threads.get(k); t.state = 'archived'; t.unread = false;
          window.__feed(10, {{ cursor: 11, gmail_status: window.__status(), gmail: [window.__row('gm5', 'g5', 'Arrived while away', ['INBOX', 'UNREAD'])] }}); window.__feed(11, {{ cursor: 11, gmail_status: window.__status() }}); }}""")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        t5 = page.evaluate("(t) => window.__thread(t)", "g5")
        check(t5 and t5["state"] == "archived" and not t5["unread"], f"{name}: Done on this device still wins while its echo is on the way ({t5})")
        # ---- updating badge
        nav = lambda: page.evaluate(f"() => [...document.querySelectorAll('#nav a')].find((x) => x.dataset.account === '{E}')?.textContent || ''")
        page.evaluate("() => { window.__feed(11, { cursor: 11, gmail_status: window.__status({ owed: 3 }) }); }")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        check("updating" in nav(), f"{name}: the account says updating while the hub still owes messages ({nav()!r})")
        page.evaluate("() => { window.__feed(11, { cursor: 11, gmail_status: window.__status() }); }")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        check("updating" not in nav(), f"{name}: and stops when the hub is current ({nav()!r})")
        # ---- a mirror that is not complete never deletes what the device holds
        page.evaluate("() => window.__mirror({ cursor: 11, complete: false, rows: [window.__row('gm1', 'g1', 'Personal note', ['INBOX'])] })")
        page.evaluate(f"() => gmailHubMirror('{E}', {{ replace: true }})")
        t5 = page.evaluate("(t) => window.__thread(t)", "g5")
        check(t5 is not None, f"{name}: a mirror still owed messages replaces nothing ({t5})")
        # ---- a mirror read that stops at the page cap is incomplete: it replaces nothing
        trunc = page.evaluate(f"""async () => {{ const real = window.api; window.api = async () => ({{ rows: [], next: 'more', cursor: 3, complete: true, owed: [], at: new Date().toISOString() }});
          try {{ return await gmailHubMirror('{E}', {{ replace: 'reset' }}); }} finally {{ window.api = real; }} }}""")
        t5 = page.evaluate("(t) => window.__thread(t)", "g5")
        check(trunc and trunc["complete"] is False and t5 is not None, f"{name}: a mirror read cut off by the page cap replaces nothing ({trunc}, {t5})")
        # ---- the hub stops mirroring: back to Gmail directly
        page.evaluate("() => { window.__feed(11, { cursor: 11, gmail_status: { 'sam.owner.sxsw@gmail.com': { state: null, synced_at: null, owed: 0 } } }); }")
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        sw = page.evaluate("() => window.mh.idb.meta('gmailHub')")
        n1 = len(page.evaluate("() => window.__calls()"))
        page.evaluate("() => window.__refresh()"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        direct = [c for c in page.evaluate("() => window.__calls()")[n1:] if c.startswith("GET gmail:history")]
        check(E not in (sw or {}) and direct, f"{name}: when the hub stops mirroring the account, the device syncs it with Gmail directly again ({sw}, {direct[:1]})")
        check(not errs, f"{name}: no page errors ({errs[:2]})")
        b.close()
srv.shutdown()
print(f"\n{len(fails)} failed" if fails else "\nall hub-Gmail checks passed")
sys.exit(1 if fails else 0)
