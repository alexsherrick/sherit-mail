#!/usr/bin/env python3
"""The paths that lost or revived a draft, each played in the page against the mock hub's drafts table
(test/mock-fetch.js, which keeps the real hub's rules: revisions, a revision-checked delete, the hash a tombstone keeps), on WebKit and
Chromium. Each check names its finding.

  - a38e761fcf a file attached while the hub cannot be reached is kept on this device, comes back after a restart, and goes up later;
  - 684b8c8ea5 a sent draft whose delete the hub did not answer is deleted on the next launch, not left live on the hub;
  - eb70bfe2ec a stale copy that is exactly what another device sent is dropped, not brought back;
                a copy holding newer text than what was sent is kept as a NEW draft, the sent one staying gone;
  - 95f2cb8d7b a hub reply sent with Send later leaves no draft;
  - 8ba0d5919c a sync during a discard's Undo window deletes nothing, and Undo brings the draft back;
  - 2b18c975fe a draft that cannot be opened is not opened, so closing a blank window cannot delete it;
  - of two reply drafts for one conversation, the one picked in Drafts is the one that opens;
  - 3fea183994 text typed while a draft's file is still coming down is saved, and the file stays;
  - 3b62de3e1f a message closed while its send is being queued leaves no draft, and the message opened meanwhile is not emptied.
Usage: python3 test/draftsaudit.py"""
import sys, socketserver, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

import os
# DRAFTS_BUNDLE: run against another client bundle (e.g. the one live before these fixes) to see these checks fail.
BUNDLE = Path(os.environ["DRAFTS_BUNDLE"]).read_text() if os.environ.get("DRAFTS_BUNDLE") else None
def server():
    class H(preview.H):
        def do_GET(self):
            if BUNDLE and self.path.split("?")[0] == "/app.js": return self._send(BUNDLE, "text/javascript; charset=utf-8")
            return super().do_GET()
    srv = preview.TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv   # threaded

READY = "window.mh && window.mh.state && window.mh.state.threads.size >= 4 && window.mh.state.me && window.mh.state.me.identities.length"
HUB_LIVE = "() => [...window.__mock.drafts.rows.values()].filter((r) => !r.deleted).map((r) => ({ id: r.id, kind: r.kind, key: r.thread_key, text: r.content && r.content.text, subject: r.subject, files: (r.content && r.content.files || []).map((f) => f.name) }))"
LOCAL = "(s) => { const d = [...window.mh.draftStore.map.values()].find((x) => x.subject === s); return d ? { id: d.id, deleted: !!d.deleted, dirty: !!d.dirty, pending: (d.pending || []).map((p) => p.name), text: d.content && d.content.text } : null; }"
# The mock hub lives in the page; a reload carries its table across, as the real hub keeps it.
DUMP = """async () => { const D = window.__mock.drafts; const files = []; for (const [k, f] of D.files) files.push({ k, f: { ...f, blob: null }, b64: btoa(String.fromCharCode(...new Uint8Array(await f.blob.arrayBuffer()))) }); return JSON.stringify({ rows: [...D.rows.values()], seq: D.seq, files }); }"""
def restore_script(dump, fail):
    return "window.__mockSetup = (m) => { const x = " + dump + "; m.drafts.rows = new Map(x.rows.map((r) => [r.id, r])); m.drafts.seq = x.seq; for (const it of x.files) m.drafts.files.set(it.k, { ...it.f, blob: new Blob([Uint8Array.from(atob(it.b64), (c) => c.charCodeAt(0))], { type: it.f.type }) }); m.drafts.fail = " + ("true" if fail else "false") + "; };"
HASH = "async (c) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(c))))].map((b) => b.toString(16).padStart(2, '0')).join('')"
GONE = "async (id) => { const r = window.__mock.drafts.rows.get(id); const h = await (" + HASH + ")(r.content); Object.assign(r, { deleted: true, rev: r.rev + 1, seq: ++window.__mock.drafts.seq, content: null, gone_hash: h }); }"   # another device sent it

fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (None if c else fails.append(m))

def compose(page, to, sub, text, files=None):
    page.click("#composeBtn"); preview.settle(page, 200); page.fill("#cto", to); page.fill("#csub", sub)
    if files: page.set_input_files("#cfiles", files=files)
    page.click("#ctext"); page.keyboard.type(text)

def run(engine):
    srv = server(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as pw:
        b = getattr(pw, engine).launch(); ctx = b.new_context(viewport={"width": 1280, "height": 860}); page = ctx.new_page(); errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function(READY, timeout=20000); preview.settle(page, 500); E = engine
        # a38e761fcf: offline file kept on this device, back after a restart, up later
        page.evaluate("window.__mock.drafts.fail = true")
        compose(page, "kim@grid.example", "Offline file", "The queue PDF, attached on the train.", [{"name": "offline.pdf", "mimeType": "application/pdf", "buffer": b"%PDF offline bytes"}])
        preview.settle(page, 1900); loc = page.evaluate(LOCAL, "Offline file"); page.click("#ccancel"); preview.settle(page, 400)
        blob = page.evaluate("async (id) => { const d = window.mh.draftStore.map.get(id); const p = (d.pending || [])[0]; if (!p) return null; const b = await window.mh.idb.meta('dfile:' + id + ':' + p.k); return b && b.bytes ? b.bytes.byteLength : null; }", loc["id"] if loc else "")
        check(loc and loc["dirty"] and loc["pending"] == ["offline.pdf"] and blob == 18, f"{E}: a file attached with the hub unreachable is kept on this device, its bytes in IndexedDB ({loc}, {blob} B)")
        ctx.add_init_script(restore_script(page.evaluate(DUMP), True)); page.reload(); page.wait_for_function(READY, timeout=20000); preview.settle(page, 600)
        page.evaluate("(id) => window.mh.openDraft(id)", loc["id"]); preview.settle(page, 800)
        got = page.evaluate("[...document.querySelector('#cfiles').files].map((f) => f.name + ':' + f.size)")
        check(got == ["offline.pdf:18"] and "train" in page.input_value("#ctext"), f"{E}: after a restart, still offline, the draft opens with its file from this device ({got})")
        page.evaluate("window.__mock.drafts.fail = false"); page.evaluate("mh.syncDrafts()"); preview.settle(page, 1500)
        hub = [d for d in page.evaluate(HUB_LIVE) if d["subject"] == "Offline file"]; loc = page.evaluate(LOCAL, "Offline file")
        check(len(hub) == 1 and hub[0]["files"] == ["offline.pdf"] and loc and loc["pending"] == [] and not loc["dirty"], f"{E}: with the hub back, the text and the file go up and nothing is left waiting ({hub}, {loc})")
        page.click("#ccancel"); preview.settle(page, 300)
        # 684b8c8ea5: a sent draft's delete not answered by the hub is sent on the next launch
        compose(page, "dan@utility.example", "Send me", "Going out now."); preview.settle(page, 1900)
        sid = page.evaluate(LOCAL, "Send me")["id"]
        page.evaluate("window.__mock.drafts.fail = true")   # the hub stays unreachable until the restart (a sync right after the send would otherwise deliver the owed delete at once, which is right)
        page.click("#csend"); page.wait_for_function("document.querySelector('#toast').innerText.includes('Sending in')", timeout=8000); preview.settle(page, 400)
        live_hub = any(d["id"] == sid for d in page.evaluate(HUB_LIVE)); owed = page.evaluate("(id) => { const d = window.mh.draftStore.map.get(id); return d ? { deleted: d.deleted, dirty: d.dirty } : null; }", sid)
        ctx.add_init_script(restore_script(page.evaluate(DUMP), False)); page.reload(); page.wait_for_function(READY, timeout=20000); preview.settle(page, 1200)
        after = page.evaluate("(id) => { const r = window.__mock.drafts.rows.get(id); return r ? r.deleted : 'gone'; }", sid)
        check(live_hub and owed == {"deleted": True, "dirty": True} and after is True, f"{E}: a sent draft whose delete the hub did not answer is owed on this device and deleted on the next launch ({live_hub}, {owed}, deleted {after})")
        # eb70bfe2ec: a stale copy that is exactly what was sent is dropped; newer text is kept as a NEW draft
        compose(page, "a@x.example", "Stale same", "Exactly this."); preview.settle(page, 1900); page.click("#ccancel"); preview.settle(page, 300)
        compose(page, "a@x.example", "Stale newer", "The original."); preview.settle(page, 1900); page.click("#ccancel"); preview.settle(page, 300)
        same, newer = page.evaluate(LOCAL, "Stale same")["id"], page.evaluate(LOCAL, "Stale newer")["id"]
        page.evaluate(GONE, same); page.evaluate(GONE, newer)
        page.evaluate("(ids) => { const [a, b] = ids; window.mh.draftStore.map.get(a).dirty = true; const d = window.mh.draftStore.map.get(b); d.dirty = true; d.content = { ...d.content, text: 'The original, and what I added offline.' }; }", [same, newer])
        page.evaluate("mh.syncDrafts()"); preview.settle(page, 1500)
        hub = page.evaluate(HUB_LIVE); toast = page.inner_text("#toast")
        check(not any(d["id"] == same for d in hub) and not any((d["text"] or "") == "Exactly this." for d in hub) and page.evaluate("(id) => !window.mh.draftStore.map.has(id)", same), f"{E}: a stale copy that is exactly what another device sent is dropped, not brought back")
        kept = [d for d in hub if (d["text"] or "").endswith("what I added offline.")]
        check(len(kept) == 1 and kept[0]["id"] != newer and page.evaluate("(id) => window.__mock.drafts.rows.get(id).deleted", newer) and "kept as a new draft" in toast, f"{E}: a copy with newer text is kept as a new draft and the sent one stays gone ({kept}, {toast[:70]!r})")
        page.evaluate("mh.syncDrafts()"); preview.settle(page, 700); page.evaluate("mh.syncDrafts()"); preview.settle(page, 700)
        again = [d for d in page.evaluate(HUB_LIVE) if (d["text"] or "").endswith("what I added offline.")]
        check(len(again) == 1 and not page.evaluate("(id) => window.mh.draftStore.map.has(id)", newer), f"{E}: and later syncs do not fork it again: one copy after two more ({len(again)})")
        # 95f2cb8d7b: a hub reply sent with Send later leaves no draft
        page.click('#nav a[data-view="inbox"]'); preview.settle(page, 400)
        k1 = page.evaluate("[...mh.state.threads.values()].filter((t) => t.kind === 'hub' && t.state === 'inbox').map((t) => t.key)[0]")
        page.evaluate("(k) => mh.openThread(k)", k1); preview.settle(page, 700); page.click("#rtext"); page.keyboard.type("Later, please. ")
        preview.settle(page, 1900); had = any(d["key"] == k1 for d in page.evaluate(HUB_LIVE))
        page.click("#rlater"); preview.settle(page, 300); page.click('#tcard button[data-i="0"]'); preview.settle(page, 1200)
        check(had and not any(d["key"] == k1 for d in page.evaluate(HUB_LIVE)), f"{E}: a hub reply sent with Send later leaves no draft behind (it had one: {had})")
        # 8ba0d5919c: a sync during a discard's Undo window deletes nothing. (The message queued above is sent first: its "Sent" toast
        # would otherwise replace the Undo toast mid-check.)
        page.wait_for_function("!window.mh.queue || window.mh.queue.mem.size === 0", timeout=20000); preview.settle(page, 1200)
        compose(page, "b@x.example", "Discard window", "Maybe not."); preview.settle(page, 1900); page.click("#ccancel"); preview.settle(page, 300)
        did = page.evaluate(LOCAL, "Discard window")["id"]; page.click('#nav a[data-view="drafts"]'); preview.settle(page, 400)
        n0 = page.evaluate("window.__mock.drafts.deletes || 0")
        page.click(f'#threads [data-ddel="{did}"]'); preview.settle(page, 150); page.evaluate("mh.syncDrafts()"); preview.settle(page, 600)
        n1 = page.evaluate("window.__mock.drafts.deletes || 0"); page.click("#toast button"); preview.settle(page, 7200)
        check(n1 == n0 and any(d["id"] == did for d in page.evaluate(HUB_LIVE)) and page.evaluate("(id) => !window.mh.draftStore.map.get(id).deleted", did), f"{E}: a sync inside a discard's Undo window deletes nothing, and Undo keeps the draft ({n0} -> {n1} deletes)")
        # 2b18c975fe: an unreadable draft is not opened
        page.evaluate("""() => { const D = window.__mock.drafts; D.rows.set("dddddddd-0000-4000-8000-000000000001", { id: "dddddddd-0000-4000-8000-000000000001", rev: 1, seq: ++D.seq, kind: "new", subject: "Locked", to: "c@x.example", snippet: "", n_files: 0, deleted: false, content: null, error: "this draft could not be opened", updated_at: new Date().toISOString() }); }""")
        page.evaluate("mh.syncDrafts()"); preview.settle(page, 500); page.click('#nav a[data-view="drafts"]'); preview.settle(page, 300)
        row = page.evaluate("(() => { const r = document.querySelector('#threads [data-draft=\"dddddddd-0000-4000-8000-000000000001\"]'); return r ? r.textContent : null; })()")
        page.click('#threads [data-draft="dddddddd-0000-4000-8000-000000000001"]'); preview.settle(page, 400)
        opened = page.evaluate("document.querySelector('#cmodal').classList.contains('on')")
        check(row and "could not be opened" in row and not opened and not page.evaluate("window.__mock.drafts.rows.get('dddddddd-0000-4000-8000-000000000001').deleted"), f"{E}: a draft that cannot be opened is listed as such, not opened, and not deleted (opened {opened})")
        # Of two reply drafts for one conversation, the one picked opens
        k2 = page.evaluate("[...mh.state.threads.values()].filter((t) => t.kind === 'hub' && t.state === 'inbox').map((t) => t.key)[1]")
        page.evaluate(f"""() => {{ const D = window.__mock.drafts; const mk = (id, text, at) => D.rows.set(id, {{ id, rev: 1, seq: ++D.seq, kind: "reply", thread_key: {k2!r}, from: "sam@yourdomain.example", subject: "Re: x", snippet: text, n_files: 0, deleted: false, updated_at: at, content: {{ kind: "reply", key: {k2!r}, from: "sam@yourdomain.example", text, files: [] }} }}); mk("eeeeeeee-0000-4000-8000-000000000001", "The older copy.", "2026-11-01T10:00:00.000Z"); mk("eeeeeeee-0000-4000-8000-000000000002", "The newer copy.", "2026-11-02T10:00:00.000Z"); }}""")
        page.evaluate("mh.syncDrafts()"); preview.settle(page, 500); page.click('#nav a[data-view="drafts"]'); preview.settle(page, 300)
        page.click('#threads [data-draft="eeeeeeee-0000-4000-8000-000000000001"]'); preview.settle(page, 900)
        check(page.input_value("#rtext") == "The older copy.", f"{E}: of two reply drafts for one conversation, the one picked in Drafts opens ({page.input_value('#rtext')!r})")
        # 3fea183994: text typed while a draft's file comes down is saved; the file stays
        page.evaluate("""() => { const D = window.__mock.drafts; const fid = "ffffffff-0000-4000-8000-000000000001", id = "ffffffff-0000-4000-8000-0000000000aa"; D.files.set(fid, { id: fid, name: "slow.txt", type: "text/plain", size: 9, draft: id, blob: new Blob(["slow file"], { type: "text/plain" }) }); D.rows.set(id, { id, rev: 1, seq: ++D.seq, kind: "new", subject: "Slow file", to: "d@x.example", snippet: "Base", n_files: 1, deleted: false, updated_at: new Date().toISOString(), content: { kind: "new", from: "sam@yourdomain.example", to: "d@x.example", subject: "Slow file", text: "Base", files: [{ id: fid, name: "slow.txt", type: "text/plain", size: 9 }] } }); D.fileDelay = 900; }""")
        page.evaluate("mh.syncDrafts()"); preview.settle(page, 400)
        page.evaluate("mh.openDraft('ffffffff-0000-4000-8000-0000000000aa')"); preview.settle(page, 150)
        page.click("#ctext"); page.keyboard.press("End"); page.keyboard.type(" and more, typed while the file came down")
        preview.settle(page, 2800); page.evaluate("window.__mock.drafts.fileDelay = 0")
        sf = page.evaluate("(() => { const r = window.__mock.drafts.rows.get('ffffffff-0000-4000-8000-0000000000aa'); return { text: r.content.text, files: r.content.files.map((f) => f.name) }; })()")
        check(sf["text"].endswith("typed while the file came down") and sf["files"] == ["slow.txt"], f"{E}: text typed while the draft's file came down is saved, and the file stays ({sf})")
        page.click("#ccancel"); preview.settle(page, 300)
        # 3b62de3e1f: closed while its send is queued, and another message opened meanwhile
        compose(page, "e@x.example", "Capture A", "Message A."); preview.settle(page, 1900)
        aid = page.evaluate(LOCAL, "Capture A")["id"]
        page.click("#csend"); preview.settle(page, 250); page.click("#ccancel"); preview.settle(page, 250)
        compose(page, "f@x.example", "Capture B", "Message B, opened while A was being queued.")
        page.wait_for_function("document.querySelector('#toast').innerText.includes('Sending in')", timeout=8000); preview.settle(page, 2200)
        a_live = any(d["id"] == aid for d in page.evaluate(HUB_LIVE)); b_text = page.input_value("#ctext"); b_hub = [d for d in page.evaluate(HUB_LIVE) if d["subject"] == "Capture B"]
        check(not a_live and "opened while A" in b_text and page.input_value("#csub") == "Capture B" and len(b_hub) == 1, f"{E}: a message closed while its send is queued leaves no draft, and the one opened meanwhile is kept, on screen and in Drafts ({a_live}, {page.input_value('#csub')!r}, {len(b_hub)})")
        check(not errs, f"{E}: no page errors ({errs[:2]})")
        b.close()
    srv.shutdown()

for engine in ("webkit", "chromium"): run(engine)
if fails: print(f"\n{len(fails)} FAILED"); sys.exit(1)
print("\nall drafts-path checks passed")
