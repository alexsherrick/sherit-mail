#!/usr/bin/env python3
"""A Gmail message trashed on its own inside a live conversation is in Sherit's Trash: on WebKit and Chromium.

Such a message was hidden in its conversation (as in Gmail) and the conversation never
appeared in Trash, because Trash matched only a conversation whose every message is trashed, so the message was reachable in no
Sherit view. The hub trashes single messages itself (mention-rule drops, block rules). Now the list row carries the trashed messages'
ids (binnedIds, store.js trashedIds), Trash lists the conversation, opens it on those messages, and Restore untrashes them.

Checks, per engine:
  - deriveGmailThread names the trashed messages of a live conversation only (none trashed, all trashed, spam only: null);
  - the row from the Gmail sync carries binnedIds; the Inbox opens the conversation without the trashed message, as before;
  - Trash lists the conversation with an "1 in Trash" tag; it opens on the trashed message alone, with a note naming the others;
  - its action bar is Trash's: Restore shown, Done and Trash hidden;
  - the Inbox view of it afterwards still leaves the trashed message out (the body cache and prerender were not written from Trash);
  - Restore calls threads/untrash and takes the conversation out of Trash; a restore Gmail refuses (400) puts it back in Trash;
  - a conversation trashed whole is listed and opens as before, with no note;
  - CONTROL: the app at f6beaa9 does not list the conversation in Trash.
Usage: python3 test/gmailtrash.py"""
import sys, subprocess, socketserver, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

GMAIL = "sam.owner.sxsw@gmail.com"; GKEY = GMAIL + "|g2"; WKEY = GMAIL + "|g3"
def head(f): return subprocess.run(["git", "show", f"f6beaa9:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=HISTORY).stdout
HISTORY = subprocess.run(["git", "cat-file", "-e", "f6beaa9^{commit}"], cwd=preview.HUB, capture_output=True).returncode == 0; OLD_BUNDLE = "\n".join(head(f) if f in ("app.js", "store.js") else (preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]).replace("__VERSION__", "test")

def server(bundle):
    class H(preview.H):
        def do_GET(self):
            if self.path.split("?")[0] == "/app.js": return self._send(bundle, "text/javascript; charset=utf-8")
            return super().do_GET()
    class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
    srv = TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv

# An older message of g2 goes to Trash on its own; g3 is trashed whole. Untrash and modify change the mock's copy as Gmail would.
SETUP = """([gmail]) => {
  const R = window.__mock.routes, b64u = (x) => btoa(unescape(encodeURIComponent(x))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const tr = R['GET gmail:threads/g2?'], m0 = tr.messages[0];
  const m = { ...JSON.parse(JSON.stringify(m0)), id: 'gm-trash-g2', labelIds: ['TRASH'], internalDate: String(Number(m0.internalDate) - 60e3), snippet: 'the dropped one' };
  m.payload.headers = m.payload.headers.map((h) => h.name === 'Message-ID' ? { name: 'Message-ID', value: '<gm-trash-g2@mail.gmail.com>' } : h);
  m.payload.body = { data: b64u('This one was dropped by a mention rule') };
  tr.messages.unshift(m); R['GET gmail:messages/gm-trash-g2?'] = m; R['GET gmail:messages?'].messages.push({ id: m.id, threadId: 'g2' });
  R['GET gmail:threads?maxResults=60&labelIds=TRASH'] = { threads: [{ id: 'g2' }] };
  const f = window.fetch;
  window.fetch = async (url, o = {}) => {
    const r = await f(url, o); const u = String(url), post = String(o.method || '').toUpperCase() === 'POST';
    const mm = /\\/gmail\\/v1\\/users\\/me\\/threads\\/(g\\d)\\/(untrash|trash|modify)$/.exec(u);
    if (post && mm && r.ok) { const th = R['GET gmail:threads/' + mm[1] + '?'], body = JSON.parse(o.body || '{}');
      if (mm[2] === 'trash') R['GET gmail:threads?maxResults=60&labelIds=TRASH'].threads.push({ id: mm[1] });
      for (const x of th.messages) { const l = new Set(x.labelIds || []); if (mm[2] === 'untrash') l.delete('TRASH'); if (mm[2] === 'trash') l.add('TRASH'); for (const a of body.addLabelIds || []) l.add(a); for (const a of body.removeLabelIds || []) l.delete(a); x.labelIds = [...l]; const mr = R['GET gmail:messages/' + x.id + '?']; if (mr) mr.labelIds = x.labelIds; } }
    return r;
  };
}"""
UNIT = """() => {
  const d = (ls) => deriveGmailThread('a@x', 't', ls.map((l, i) => ({ id: 'm' + i, date: i, labels: l, subject: 's' })));
  return { mixed: d([['INBOX'], ['TRASH'], ['INBOX']]).binnedIds, none: d([['INBOX'], ['INBOX']]).binnedIds, all: d([['TRASH'], ['TRASH']]).binnedIds, allState: d([['TRASH'], ['TRASH']]).state, spam: d([['INBOX'], ['SPAM']]).binnedIds, mixedState: d([['INBOX'], ['TRASH']]).state };
}"""
OPEN = """async ([k]) => { await window.mh.openThread(k); await new Promise((r) => setTimeout(r, 500)); }"""
IDS = """() => (window.mh.state.curThread?.messages || []).map((m) => m.id)"""
LISTED = """([k]) => window.mh.visibleThreads().some((t) => t.key === k)"""
SHOWN = """(k) => { const b = document.querySelector('#actions [data-act="' + k + '"]'); return !!b && b.style.display !== 'none'; }"""

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def boot(page, base):
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    page.wait_for_function("([k]) => window.mh.state.threads.has(k)", arg=[GKEY], timeout=15000)
    page.evaluate(SETUP, [GMAIL]); page.evaluate("([g]) => window.mh.refresh({ silent: true, accounts: [g] })", [GMAIL])
    page.wait_for_function("([k]) => (window.mh.state.threads.get(k).shownIds || []).length > 0", arg=[GKEY], timeout=15000)

def view(page, v): page.evaluate("async ([v]) => { await window.mh.setView(v); await new Promise((r) => setTimeout(r, 600)); }", [v])

def run(bundle, label, control=False):
    srv = server(bundle); base = f"http://127.0.0.1:{srv.server_address[1]}/"; out = {}
    with sync_playwright() as pw:
        for engine in ((pw.chromium,) if control else (pw.webkit, pw.chromium)):
            name = f"{engine.name}{' ' + label if label else ''}"
            b = engine.launch(); page = b.new_page(viewport={"width": 1100, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            boot(page, base)
            view(page, "trash"); listed = page.evaluate(LISTED, [GKEY])
            if control:
                check(not listed, f"{name}: CONTROL — the app at f6beaa9 leaves the conversation with a trashed message out of Trash")
                b.close(); continue
            u = page.evaluate(UNIT)
            check(u["mixed"] == ["m1"] and u["none"] is None and u["all"] is None and u["allState"] == "trash" and u["spam"] is None and u["mixedState"] == "inbox",
                  f"{name}: deriveGmailThread names the trashed messages of a live conversation only ({u})")
            row = page.evaluate("([k]) => { const t = window.mh.state.threads.get(k); return { binned: t.binnedIds, state: t.state }; }", [GKEY])
            check(row["binned"] == ["gm-trash-g2"] and row["state"] == "inbox", f"{name}: the synced row carries the trashed message's id and stays in the inbox ({row})")
            tag = page.evaluate("([k]) => (document.querySelector('.t[data-key=\"' + k + '\"] .sub') || {}).textContent || ''", [GKEY])
            check(listed and "1 in Trash" in tag, f"{name}: Trash lists the conversation, tagged ({tag.strip()[:60]!r})")
            page.evaluate(OPEN, [GKEY]); ids = page.evaluate(IDS); note = page.evaluate("() => (document.querySelector('#msgs .binnote') || {}).textContent || ''")
            body = page.evaluate("() => document.querySelector('#msgs').textContent")
            check(ids == ["gm-trash-g2"] and "This message is in Trash" in note and "other message is not" in note, f"{name}: from Trash it opens on the trashed message alone, with a note ({ids}, {note[:70]!r})")
            check(page.evaluate(SHOWN, "restore") and not page.evaluate(SHOWN, "trash") and not page.evaluate(SHOWN, "archive"), f"{name}: its action bar is Trash's (Restore shown, Done and Trash hidden)")
            cached = page.evaluate("async ([k]) => (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((r) => r.id)", [GKEY])
            check("gm-trash-g2" not in cached and "gm-trash-g2" not in str(page.evaluate("([k]) => { const p = window.mh.prerendered.get(k); return p ? p.d.messages.map((m) => m.id) : []; }", [GKEY])),
                  f"{name}: nothing from the Trash view went into the body cache or the prerendered page ({cached})")
            view(page, "inbox"); page.evaluate(OPEN, [GKEY]); ids2 = page.evaluate(IDS)
            check(ids2 and "gm-trash-g2" not in ids2 and not page.evaluate("() => !!document.querySelector('#msgs .binnote')"), f"{name}: the Inbox still opens it without the trashed message ({ids2})")
            # a restore Gmail refuses puts the conversation back in Trash
            view(page, "trash"); page.evaluate(OPEN, [GKEY])
            page.evaluate("() => { window.__mock.failNext = { match: /threads\\/g2\\/untrash/, status: 400 }; }")
            page.click('#actions [data-act="restore"]'); preview.settle(page, 2500)
            back = page.evaluate("([k]) => { const t = window.mh.state.threads.get(k); return { binned: t.binnedIds, state: t.state }; }", [GKEY])
            check(back["binned"] == ["gm-trash-g2"] and page.evaluate(LISTED, [GKEY]), f"{name}: a restore Gmail refuses puts it back in Trash ({back})")
            # Restore
            page.evaluate(OPEN, [GKEY]); n0 = len(page.evaluate("() => window.__mock.calls"))
            page.click('#actions [data-act="restore"]')
            try: page.wait_for_function("([n]) => window.__mock.calls.slice(n).includes('POST gmail:threads/g2/untrash')", arg=[n0], timeout=8000); untrashed = True
            except Exception: untrashed = False
            preview.settle(page, 800); calls = page.evaluate("([n]) => window.__mock.calls.slice(n).filter((c) => c.includes('g2/'))", [n0])
            after = page.evaluate("([k]) => { const t = window.mh.state.threads.get(k); return { binned: t.binnedIds, state: t.state }; }", [GKEY])
            check(untrashed and not after["binned"] and after["state"] == "inbox" and not page.evaluate(LISTED, [GKEY]), f"{name}: Restore untrashes it and it leaves Trash ({calls}, {after})")
            labels = page.evaluate("async () => (await window.mh.idb.get('messages', 'sam.owner.sxsw@gmail.com|gm-trash-g2').catch(() => null))?.labels || null")
            page.evaluate("([g]) => window.mh.refresh({ silent: true, accounts: [g] })", [GMAIL]); preview.settle(page, 1500)
            check(not page.evaluate("([k]) => window.mh.state.threads.get(k).binnedIds", [GKEY]) and not page.evaluate(LISTED, [GKEY]), f"{name}: and stays out after the next sync (local labels {labels})")
            # a conversation trashed whole (by Sherit's own Trash, from the Inbox), as before
            view(page, "inbox"); page.evaluate("async ([k]) => { await window.mh.act(window.mh.state.threads.get(k), 'trash', { quiet: true }); await new Promise((r) => setTimeout(r, 1500)); }", [WKEY])
            view(page, "trash"); listedW = page.evaluate(LISTED, [WKEY]); page.evaluate(OPEN, [WKEY]); idsW = page.evaluate(IDS)
            check(listedW and idsW == ["gm3"] and not page.evaluate("() => !!document.querySelector('#msgs .binnote')") and page.evaluate(SHOWN, "restore"),
                  f"{name}: a conversation trashed whole is listed and opens as before ({idsW})")
            check(not errs, f"{name}: no page errors {errs[:2]}")
            b.close()
    srv.shutdown(); return out

run(preview.BUNDLE, "")
if preview.CONTROL: run(OLD_BUNDLE, "(control)", control=True)
else: preview.control_skipped("gmailtrash.py")
print(f"{len(fails)} failed" if fails else "all Gmail Trash checks passed")
sys.exit(1 if fails else 0)
