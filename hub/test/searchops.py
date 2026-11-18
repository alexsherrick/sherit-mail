#!/usr/bin/env python3
"""Gmail's search operators in the app's own search, and a search no longer narrowed by the tab it is typed in: on WebKit and Chromium.

Founder: search should take Gmail's operators (in:trash, in:archive, all mail) and look past
the inbox alone. The search dropped Trash and Spam whatever was asked, read in:trash as two
words, listed only the open category tab's mail, ignored the query in Set aside, and never found a set-aside conversation.

Checks, per engine, on rows that arrive through the app's own hub sync (and two Gmail rows put in the store):
  - no operator: every folder but Trash and Spam, a set-aside conversation included;
  - in:trash (also alone), in:anywhere / in:all, in:archive / in:done, in:spam, -in:inbox, in:sent, in:snoozed, is:unread, is:pinned,
    has:attachment, after:/before:, and a -word with in:anywhere, each list what they name;
  - a live Gmail conversation with a message in Trash counts for in:trash, tagged "1 in Trash";
  - the same query in the Newsletters tab, in Set aside or in Trash lists the same (the view never narrows a query; one TYPED in
    Trash or Spam gains that folder's in: before it is the query; searchfrom.py);
  - each result outside the Inbox carries its folder;
  - the chips under a search set the query's in: (Trash, then All mail);
  - the hub and Gmail are asked in Gmail's spelling with the date as epoch seconds; the device index is given the words alone;
  - a Gmail server-search row in Spam is "spam" (gmailAdapter.norm);
  - CONTROL: the app at f6beaa9 lists nothing for "rocket in:trash", narrows to the tab, and makes the Spam row "archived".
Usage: python3 test/searchops.py"""
import sys, subprocess, socketserver, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

GMAIL = "sam.owner.sxsw@gmail.com"
def head(f): return subprocess.run(["git", "show", f"f6beaa9:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=HISTORY).stdout
HISTORY = subprocess.run(["git", "cat-file", "-e", "f6beaa9^{commit}"], cwd=preview.HUB, capture_output=True).returncode == 0; OLD_BUNDLE = "\n".join(head(f) if f in ("app.js", "store.js") else (preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]).replace("__VERSION__", "test")

def server(bundle):
    class H(preview.H):
        def do_GET(self):
            if self.path.split("?")[0] == "/app.js": return self._send(bundle, "text/javascript; charset=utf-8")
            return super().do_GET()
    class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
    srv = TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv

# Seven hub conversations about a rocket, one per folder or flag, dated July (before every sync window the mock keeps).
INIT = """window.__mockSetup = (mk) => {
  const row = (n, state, subject, at, x = {}) => ({ id: 'aaaaaaa' + n + '-0000-0000-0000-00000000000' + n, subject_norm: subject.toLowerCase(), participants: '[]', last_message_at: at, message_count: 1, state, starred: 0, unread: 0, labels: '[]', has_att: 0, has_in: 1, has_out: 0, ...x,
    last: { id: 'rm' + n, direction: x.has_out ? 'out' : 'in', from_addr: 'mc@space.example', from_name: 'Mission Control', identity: 'sam@yourdomain.example', subject, snippet: 'launch notes', created_at: at, message_id: '<r' + n + '@space.example>', to_addrs: '[]' } });
  mk.hubThreads.push(row(1, 'inbox', 'Rocket inbox', '2026-07-20T12:00:00Z', { unread: 1 }), row(2, 'archived', 'Rocket archived', '2026-07-10T12:00:00Z', { has_att: 1 }),
    row(3, 'trash', 'Rocket trashed', '2026-07-15T12:00:00Z'), row(4, 'snoozed', 'Rocket snoozed', '2026-07-05T12:00:00Z'),
    row(5, 'archived', 'Rocket sent', '2026-07-18T12:00:00Z', { has_out: 1, starred: 1 }), row(6, 'inbox', 'Rocket newsletter', '2026-07-01T12:00:00Z', { category: 'newsletters' }),
    row(7, 'inbox', 'Rocket aside', '2026-07-12T12:00:00Z'));
};"""
GMAIL_ROWS = """([g]) => {
  const S = window.mh.state, at = (d) => Date.parse(d), base = { account: g, kind: 'gmail', identity: g, snippet: 'launch notes', from: 'Mission <mc@space.example>', fromAddr: 'mc@space.example', fromName: 'Mission', to: '', out: false, unread: false, starred: false, labels: [], cat: 'personal', count: 1, msgIds: [], updatedAt: Date.now() };
  S.threads.set(g + '|gs', { ...base, key: g + '|gs', id: 'gs', subject: 'Rocket spam', date: at('2026-07-14T12:00:00Z'), state: 'spam', labels: ['SPAM'] });
  S.threads.set(g + '|gb', { ...base, key: g + '|gb', id: 'gb', subject: 'Rocket binned', date: at('2026-07-13T12:00:00Z'), state: 'inbox', labels: ['INBOX'], binnedIds: ['gbm1'] });
  S.prefs = { ...(S.prefs || {}), setAside: [...((S.prefs || {}).setAside || []), 'hub|aaaaaaa7-0000-0000-0000-000000000007'] };
}"""
SCAN = """(q) => { const S = window.mh.state; S.search = q; S.searchHits = null; S.serverHitKeys = null; S.serverSearch = new Map(); return window.mh.visibleThreads().map((t) => t.subject).filter((s) => /^Rocket/.test(s)).map((s) => s.slice(7)).sort(); }"""
NORM_SPAM = """([g]) => window.mh.adapterFor(g).norm({ id: 'x', messages: [{ id: 'xm', threadId: 'x', labelIds: ['SPAM'], internalDate: '1', snippet: '', payload: { headers: [{ name: 'From', value: 'a@b.example' }, { name: 'Subject', value: 's' }] } }] }).state"""
ALL = sorted(["aside", "archived", "binned", "inbox", "newsletter", "sent", "snoozed"])

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def boot(page, base):
    page.add_init_script(INIT); page.goto(base)
    page.wait_for_function("window.mh && window.mh.state.threads.has('hub|aaaaaaa7-0000-0000-0000-000000000007')", timeout=30000); preview.settle(page, 800)
    page.evaluate(GMAIL_ROWS, [GMAIL])

def view(page, v): page.evaluate("async ([v]) => { const S = window.mh.state, q = S.search; S.search = ''; await window.mh.setView(v); S.search = q; await new Promise((r) => setTimeout(r, 300)); }", [v])

def run(bundle, label, control=False):
    srv = server(bundle); base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as pw:
        for engine in ((pw.chromium,) if control else (pw.webkit, pw.chromium)):
            name = f"{engine.name}{' ' + label if label else ''}"
            b = engine.launch(); page = b.new_page(viewport={"width": 1100, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            boot(page, base)
            S = lambda q: page.evaluate(SCAN, q)
            if control:
                check(S("rocket in:trash") == [], f"{name}: CONTROL — the app at f6beaa9 lists nothing for \"rocket in:trash\" ({S('rocket in:trash')})")
                view(page, "newsletters"); r = S("rocket"); view(page, "inbox")
                check(r == ["newsletter"], f"{name}: CONTROL — … and a search typed in the Newsletters tab lists only that tab ({r})")
                check(page.evaluate(NORM_SPAM, [GMAIL]) == "archived", f"{name}: CONTROL — … and a Gmail server-search row in Spam comes out archived")
                b.close(); continue
            for q, want, m in [("rocket", ALL, "no operator: every folder but Trash and Spam, the set-aside conversation too"),
                               ("rocket in:trash", ["binned", "trashed"], "in:trash: Trash, and the live Gmail conversation with a message in it"),
                               ("in:trash", ["binned", "trashed"], "in:trash alone lists Trash"),
                               ("rocket in:anywhere", sorted(ALL + ["spam", "trashed"]), "in:anywhere: every folder"),
                               ("rocket in:all", sorted(ALL + ["spam", "trashed"]), "in:all is in:anywhere"),
                               ("rocket in:archive", ["archived", "sent"], "in:archive"), ("in:done rocket", ["archived", "sent"], "in:done is in:archive"),
                               ("rocket in:spam", ["spam"], "in:spam"), ("rocket -in:inbox", ["archived", "sent", "snoozed"], "-in:inbox: the rest, not Trash or Spam"),
                               ("rocket in:sent", ["sent"], "in:sent"), ("rocket in:snoozed", ["snoozed"], "in:snoozed"),
                               ("rocket is:unread", ["inbox"], "is:unread"), ("rocket is:pinned", ["sent"], "is:pinned"), ("rocket has:attachment", ["archived"], "has:attachment"),
                               ("rocket after:2026/07/15", ["inbox", "sent"], "after: (local midnight)"), ("rocket before:2026/07/06", ["newsletter", "snoozed"], "before:"),
                               ("rocket -trashed in:anywhere", sorted(ALL + ["spam"]), "a -word with in:anywhere (the row scan honours it)")]:
                got = S(q); check(got == sorted(want), f"{name}: {q!r} — {m} ({got})")
            for v in ("newsletters", "aside", "trash"):
                view(page, v); got = S("rocket"); check(got == ALL, f"{name}: the same query in {v} lists the same ({got})")
            view(page, "inbox")
            # what a search result shows: its folder, and the Trash lens's tag
            page.evaluate("() => { const S = window.mh.state; S.search = 'rocket in:anywhere'; S.searchHits = null; S.serverHitKeys = null; S.serverSearch = new Map(); window.mh.render(); }"); preview.settle(page, 300)
            tags = page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('#threads .t')].map((r) => [r.querySelector('.sub')?.textContent || '', (r.querySelector('.lbl.fold') || {}).textContent || '']).filter(([s]) => /Rocket/.test(s)).map(([s, f]) => [s.replace(/^.*?Rocket (\\w+).*$/, '$1'), f]))""")
            check(tags.get("trashed") == "Trash" and tags.get("archived") == "Archive" and tags.get("snoozed") == "Snoozed" and tags.get("spam") == "Spam" and tags.get("inbox") == "" and tags.get("aside") == "",
                  f"{name}: each result outside the Inbox carries its folder ({tags})")
            page.evaluate("() => { const S = window.mh.state; S.search = 'rocket in:trash'; S.searchHits = null; window.mh.render(); }"); preview.settle(page, 300)
            bt = page.evaluate("([g]) => (document.querySelector('.t[data-key=\"' + g + '|gb\"] .sub') || {}).textContent || ''", [GMAIL])
            check("1 in Trash" in bt, f"{name}: in:trash tags the live Gmail conversation \"1 in Trash\" ({bt.strip()[:50]!r})")
            page.evaluate("() => { const S = window.mh.state; S.search = ''; window.mh.render(); }")
            # the chips under a search; the servers asked in Gmail's spelling; the device index given the words alone
            page.evaluate("() => { const ix = window.mh.searchIndex, q0 = ix.query.bind(ix); window.__ixq = []; ix.query = (q, o) => { window.__ixq.push(q); return q0(q, o); }; }")
            page.focus("#q")   # starts the device index (ensureSearch); every row in it before the first query, so its answer is the whole one
            page.wait_for_function("() => { const st = window.mh.searchIndex.status; return st.ready && st.indexed >= window.mh.state.threads.size; }", timeout=30000)
            page.fill("#q", "rocket"); preview.settle(page, 400)
            on = page.evaluate("() => [...document.querySelectorAll('#chips [data-scope].on')].map((b) => b.textContent)")
            page.click('#chips [data-scope="trash"]'); preview.settle(page, 400)
            st = page.evaluate("() => ({ q: document.querySelector('#q').value, s: window.mh.state.search, on: [...document.querySelectorAll('#chips [data-scope].on')].map((b) => b.textContent), rows: window.mh.visibleThreads().map((t) => t.subject).filter((s) => /^Rocket/.test(s)).sort() })")
            check(on == ["All mail"] and st["q"] == "rocket in:trash" and st["s"] == "rocket in:trash" and st["on"] == ["Trash"] and st["rows"] == ["Rocket binned", "Rocket trashed"], f"{name}: the Trash chip makes it \"rocket in:trash\" ({on}, {st})")
            page.click('#chips [data-scope=""]'); preview.settle(page, 400)
            check(page.evaluate("() => document.querySelector('#q').value") == "rocket", f"{name}: the All mail chip takes the in: away")
            n0 = len(page.evaluate("() => window.__mock.calls"))
            page.fill("#q", "rocket in:done is:pinned has:attachments after:2026/07/01"); preview.settle(page, 1800)
            calls = page.evaluate("([n]) => window.__mock.calls.slice(n).filter((c) => /[?&]q=/.test(c))", [n0])
            want = page.evaluate("() => encodeURIComponent('rocket in:archive is:starred has:attachment after:' + Math.floor(new Date(2026, 6, 1).getTime() / 1000))")
            check(any(c.startswith("GET /api/threads?limit=200&box=all&q=" + want) for c in calls) and any(c.startswith(f"GET gmail:messages?maxResults=40&q={want}") for c in calls),
                  f"{name}: the hub and Gmail are asked in Gmail's spelling, the date as epoch seconds ({calls[:2]})")
            page.fill("#q", "in:trash"); preview.settle(page, 400); page.fill("#q", "rocket in:trash"); preview.settle(page, 400)
            ixq = page.evaluate("() => window.__ixq")
            check("in:trash" not in ixq and "rocket" in ixq and not any("in:" in x for x in ixq), f"{name}: the device index is given the words, never the operators ({ixq})")
            check(page.evaluate(NORM_SPAM, [GMAIL]) == "spam", f"{name}: a Gmail server-search row in Spam is \"spam\"")
            check(not errs, f"{name}: no page errors {errs[:2]}")
            b.close()
    srv.shutdown()

if __name__ == "__main__":   # searchfrom.py imports the rows and helpers above
    run(preview.BUNDLE, "")
    if preview.CONTROL: run(OLD_BUNDLE, "(control)", control=True)
    else: preview.control_skipped("searchops.py")
    print(f"{len(fails)} failed" if fails else "all search operator checks passed")
    sys.exit(1 if fails else 0)
