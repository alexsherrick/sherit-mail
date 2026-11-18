#!/usr/bin/env python3
"""A device opened after days away. My browser: 188 unread shown for minutes while Gmail had 1,
because history was replayed a page at a time with each page's downloads first and one repaint at the very end. Now two passes:
every history page is applied to the mail the device holds and the screen repaints, then what it lacks is downloaded, inbox first.
Checked on WebKit and Chromium, through the real refresh():
- the held mail is corrected and repainted while every download is still blocked, and the account says "updating";
- the cursor and the owed list are written together; an add deleted on a later page is never downloaded; an old message the device
  never had that is only leaving the inbox is not owed; one coming back into the inbox, or a recent one going to Trash, is;
- downloads go inbox-unread first; when they land the badge goes and the new mail is on screen;
- 130 owed: one sync downloads 100, keeps 30, and asks for the next slice; the next sync finishes;
- a download that fails leaves the history applied and the message owed; the next sync gets it;
- an expired cursor (404) drops the owed list with the window and refills.
Usage: python3 test/catchup.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
EMAIL = "sam.owner.sxsw@gmail.com"
SETUP = r"""async (email) => {
  const day = 864e5, now = Date.now();
  const gid = (ms, n) => Math.floor(ms).toString(16) + n.toString(16).padStart(5, "0");
  const ids = { K1: gid(now - 200 * day, 1), K2: gid(now - 200 * day, 2), N1: gid(now - 60e3, 3), N2: gid(now - 50e3, 4), X: gid(now - 40e3, 5),
                O1: gid(now - 200 * day, 6), R1: gid(now - 10 * day, 7), O2: gid(now - 300 * day, 8) };
  const msg = (id, labels, subj) => ({ id, threadId: "t" + id, labelIds: labels, internalDate: String(parseInt(id.slice(0, -5), 16)), snippet: "snippet " + subj,
    payload: { headers: [{ name: "From", value: "Sender <s@example.com>" }, { name: "To", value: email }, { name: "Subject", value: subj }, { name: "Message-ID", value: "<" + id + "@x>" }] } });
  // held: two old unread inbox messages (what fillUnread loads), both handled on another device while this one was closed
  await applyGmailMessages(email, [msg(ids.K1, ["INBOX", "UNREAD"], "old unread one"), msg(ids.K2, ["INBOX", "UNREAD"], "old unread two")]);
  const lbl = (id, labels) => ({ message: { id, threadId: "t" + id, labelIds: labels } });
  window.__mock.routes["GET gmail:history?startHistoryId=100&maxResults=500"] = { nextPageToken: "p2", historyId: "130", history: [
    { id: "101", messagesAdded: [lbl(ids.N1, ["INBOX", "UNREAD"]), lbl(ids.N2, ["CATEGORY_PROMOTIONS"]), lbl(ids.X, ["INBOX", "UNREAD"])] },
    { id: "102", labelsRemoved: [{ ...lbl(ids.K1, ["CATEGORY_UPDATES"]), labelIds: ["INBOX", "UNREAD"] }] },
    { id: "103", labelsRemoved: [{ ...lbl(ids.O1, ["CATEGORY_UPDATES"]), labelIds: ["INBOX"] }] } ] };
  window.__mock.routes["GET gmail:history?startHistoryId=100&maxResults=500&pageToken=p2"] = { historyId: "130", history: [
    { id: "120", labelsRemoved: [{ ...lbl(ids.K2, ["INBOX"]), labelIds: ["UNREAD"] }] },
    { id: "121", messagesDeleted: [lbl(ids.X, [])] },
    { id: "122", labelsAdded: [{ ...lbl(ids.R1, ["TRASH"]), labelIds: ["TRASH"] }] },
    { id: "123", labelsAdded: [{ ...lbl(ids.O2, ["INBOX"]), labelIds: ["INBOX"] }] } ] };
  // downloads: every message GET is recorded; N1's waits until released; the server's current copies are what the history ended with
  window.__gm = { [ids.N1]: msg(ids.N1, ["INBOX", "UNREAD"], "brand new"), [ids.N2]: msg(ids.N2, ["CATEGORY_PROMOTIONS"], "promo"),
                  [ids.R1]: msg(ids.R1, ["TRASH"], "trashed elsewhere"), [ids.O2]: msg(ids.O2, ["INBOX"], "moved back") };
  window.__gets = []; window.__hold = new Promise((r) => { window.__release = r; });
  const f = window.fetch;
  window.fetch = async (u, o = {}) => {
    const m = String(u).match(/gmail\/v1\/users\/me\/messages\/([0-9a-f]+)\?/);
    if (m) { const id = m[1]; window.__gets.push(id);
      if (id === ids.N1) await window.__hold;
      const body = window.__gm[id] || (/^0+[0-9a-f]+$/.test(id) || id.startsWith("abc") ? { id, threadId: "t" + id, labelIds: ["CATEGORY_UPDATES"], internalDate: String(now), snippet: "bulk", payload: { headers: [{ name: "From", value: "Bulk <b@example.com>" }, { name: "Subject", value: "bulk " + id }] } } : null);
      if (!body) return { ok: false, status: 404, json: async () => ({ error: { code: 404 } }), text: async () => "{}", headers: new Map() };
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body), headers: new Map() }; }
    return f(u, o);
  };
  const st = await idb.get("state", "state|" + email); st.lastSyncAt = now - 3 * day; await idb.putAll("state", [st]);
  return ids;
}"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
        page.wait_for_function(f"(async () => {{ const s = await window.mh.idb.get('state', 'state|{EMAIL}'); return !!(s && s.filled && s.historyId === '100'); }})()", timeout=30000)
        page.wait_for_function("!window.mh.state.loading", timeout=30000)
        ids = page.evaluate(SETUP, EMAIL)
        tk = lambda k: f"{EMAIL}|t{ids[k]}"
        thread = lambda k: page.evaluate("(k) => { const t = window.mh.state.threads.get(k); return t ? { state: t.state, unread: !!t.unread } : null; }", tk(k))
        check(thread("K1") == {"state": "inbox", "unread": True} and thread("K2") == {"state": "inbox", "unread": True}, f"{name}: before: the two held messages show as unread in the inbox")
        page.evaluate("() => { window.__done = window.mh.refresh({ silent: true, accounts: ['sam.owner.sxsw@gmail.com'] }); }")
        page.wait_for_function(f"(async () => {{ const s = await window.mh.idb.get('state', 'state|{EMAIL}'); return s && s.historyId === '130'; }})()", timeout=15000)
        page.wait_for_function(f"window.__gets.includes('{ids['N1']}')", timeout=15000)
        preview.settle(page, 300)
        # pass 1 is done, the first download is held: the screen must already be right
        check(thread("K1") == {"state": "archived", "unread": False}, f"{name}: Done on another device shows here before any download ({thread('K1')})")
        check(thread("K2") == {"state": "inbox", "unread": False}, f"{name}: Read on another device shows here before any download ({thread('K2')})")
        nav = page.evaluate("() => { const a = [...document.querySelectorAll('#nav a')].find((x) => x.dataset.account === 'sam.owner.sxsw@gmail.com'); return a ? { text: a.textContent, n: a.querySelector('.n')?.textContent || '' } : null; }")
        cnt = page.evaluate("(e) => window.mh.counts().acct[e] || 0", EMAIL)
        check(nav is not None and "updating" in nav["text"], f"{name}: the account says it is updating while mail is still owed ({nav})")
        check(nav is not None and nav["n"] == (str(cnt) if cnt else "") and page.evaluate("(ks) => ks.every((k) => { const t = window.mh.state.threads.get(k); return !(t.state === 'inbox' && t.unread); })", [tk("K1"), tk("K2")]),
              f"{name}: the sidebar count is already repainted without the two handled messages (shown {nav and nav['n']!r}, counted {cnt})")
        st = page.evaluate(f"() => window.mh.idb.get('state', 'state|{EMAIL}')")
        owed = {o["id"] for o in (st.get("owed") or [])}
        check(owed == {ids["N1"], ids["N2"], ids["R1"], ids["O2"]}, f"{name}: the cursor (130) is written with what is still owed: the new mail, the recent trashed one, the old one back in the inbox ({sorted(owed)})")
        gets = page.evaluate("() => window.__gets.slice()")
        check(gets[:1] == [ids["N1"]], f"{name}: the first download is the new unread inbox message ({gets[:3]})")
        page.evaluate("() => window.__release()"); page.evaluate("() => window.__done")
        page.wait_for_function("!window.mh.state.loading", timeout=15000)
        gets = page.evaluate("() => window.__gets.slice()")
        check(ids["X"] not in gets, f"{name}: a message added and deleted on a later page is never downloaded")
        check(ids["O1"] not in gets, f"{name}: an old message this device never had, only leaving the inbox, is not downloaded")
        firsts = [g for i, g in enumerate(gets) if g not in gets[:i]]
        check(firsts[:2] == [ids["N1"], ids["O2"]] and set(firsts) == {ids["N1"], ids["O2"], ids["N2"], ids["R1"]}, f"{name}: downloads go unread inbox, then inbox, then the rest ({firsts})")
        st = page.evaluate(f"() => window.mh.idb.get('state', 'state|{EMAIL}')")
        nav = page.evaluate("() => [...document.querySelectorAll('#nav a')].find((x) => x.dataset.account === 'sam.owner.sxsw@gmail.com')?.textContent || ''")
        check(not (st.get("owed") or []) and "updating" not in nav, f"{name}: when the downloads land nothing is owed and the account stops saying updating ({len(st.get('owed') or [])} owed)")
        check(thread("N1") == {"state": "inbox", "unread": True} and thread("O2") == {"state": "inbox", "unread": False} and thread("R1") == {"state": "trash", "unread": False},
              f"{name}: the new mail is on screen ({thread('N1')}, {thread('O2')}, {thread('R1')})")
        # 130 owed: one slice of 100, the rest asked for
        page.evaluate("""(email) => { const now = Date.now(); const add = []; for (let i = 0; i < 130; i++) { const id = 'abc' + (now + i).toString(16) + '00'; add.push({ message: { id, threadId: 't' + id, labelIds: ['CATEGORY_UPDATES'] } }); }
          window.__mock.routes['GET gmail:history?startHistoryId=130&maxResults=500'] = { historyId: '140', history: [{ id: '131', messagesAdded: add }] };
          window.__mock.routes['GET gmail:history?startHistoryId=140&maxResults=500'] = { historyId: '140', history: [] };
          window.__gets = []; syncState.progress[email].window = { start: 0, n: 0 }; return window.mh.refresh({ silent: true, accounts: [email] }); }""", EMAIL)
        page.wait_for_function("!window.mh.state.loading", timeout=30000)
        st = page.evaluate(f"() => window.mh.idb.get('state', 'state|{EMAIL}')")
        n1 = len(set(page.evaluate("() => window.__gets.slice()")))
        check(n1 == 100 and len(st.get("owed") or []) == 30 and st.get("historyId") == "140", f"{name}: 130 owed: one sync downloads 100 and keeps 30 ({n1} downloaded, {len(st.get('owed') or [])} owed)")
        check(page.evaluate("(e) => catchupTimers.has(e)", EMAIL), f"{name}: and asks for the next slice")
        page.evaluate("(email) => { clearTimeout(catchupTimers.get(email)); catchupTimers.delete(email); window.__gets = []; syncState.progress[email].window = { start: 0, n: 0 }; return window.mh.refresh({ silent: true, accounts: [email] }); }", EMAIL)
        page.wait_for_function("!window.mh.state.loading", timeout=30000)
        st = page.evaluate(f"() => window.mh.idb.get('state', 'state|{EMAIL}')")
        check(len(set(page.evaluate("() => window.__gets.slice()"))) == 30 and not (st.get("owed") or []) and not page.evaluate("(e) => catchupTimers.has(e)", EMAIL), f"{name}: the next sync downloads the other 30 and stops asking")
        # a failed download: history stays applied, the message stays owed, the next sync gets it
        fid = page.evaluate("""(email) => { const id = 'abc' + Date.now().toString(16) + 'ff';
          window.__mock.routes['GET gmail:history?startHistoryId=140&maxResults=500'] = { historyId: '150', history: [{ id: '141', messagesAdded: [{ message: { id, threadId: 't' + id, labelIds: ['INBOX'] } }] }] };
          window.__mock.routes['GET gmail:history?startHistoryId=150&maxResults=500'] = { historyId: '150', history: [] };
          return id; }""", EMAIL)
        # fail every attempt of this sync (batch fallback, then the single retry)
        page.evaluate("(id) => { window.__failAll = id; const f = window.fetch; window.fetch = async (u, o = {}) => (window.__failAll && String(u).includes('/messages/' + window.__failAll + '?')) ? { ok: false, status: 500, json: async () => ({ error: { code: 500 } }), text: async () => '{}', headers: new Map() } : f(u, o); }", fid)
        page.evaluate("(email) => { syncState.progress[email].window = { start: 0, n: 0 }; return window.mh.refresh({ silent: true, accounts: [email] }); }", EMAIL)
        page.wait_for_function("!window.mh.state.loading", timeout=30000)
        st = page.evaluate(f"() => window.mh.idb.get('state', 'state|{EMAIL}')")
        check(st.get("historyId") == "150" and [o["id"] for o in (st.get("owed") or [])] == [fid], f"{name}: a download that fails leaves the history applied (cursor {st.get('historyId')}) and the message owed")
        page.evaluate("(email) => { window.__failAll = null; syncState.progress[email].window = { start: 0, n: 0 }; return window.mh.refresh({ silent: true, accounts: [email] }); }", EMAIL)
        page.wait_for_function("!window.mh.state.loading", timeout=30000)
        st = page.evaluate(f"() => window.mh.idb.get('state', 'state|{EMAIL}')")
        check(not (st.get("owed") or []) and page.evaluate("(k) => !!window.mh.state.threads.get(k)", f"{EMAIL}|t{fid}"), f"{name}: the next sync downloads it")
        # an expired cursor: the owed list goes with the window
        page.evaluate("""(email) => (async () => { const st = await idb.get('state', 'state|' + email); st.owed = [{ id: 'abc1', t: 'tabc1', l: ['INBOX'], a: 1 }]; await idb.putAll('state', [st]);
          window.__mock.routes['GET gmail:history?startHistoryId=150&maxResults=500'] = { __status: 404, error: { code: 404, message: 'Requested entity was not found.' } };
          syncState.progress[email].window = { start: 0, n: 0 }; return window.mh.refresh({ silent: true, accounts: [email] }); })()""", EMAIL)
        page.wait_for_function("!window.mh.state.loading", timeout=30000)
        st = page.evaluate(f"() => window.mh.idb.get('state', 'state|{EMAIL}')")
        check(not st.get("owed") and st.get("filled") and st.get("historyId") == "100", f"{name}: an expired cursor refills the window and drops the owed list (owed {st.get('owed')}, history {st.get('historyId')})")
        check(not errs, f"{name}: no page errors ({errs[:2]})")
        b.close()
srv.shutdown()
print(f"\n{len(fails)} failed" if fails else "\nall catch-up checks passed")
sys.exit(1 if fails else 0)
