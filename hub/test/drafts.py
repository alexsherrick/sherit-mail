#!/usr/bin/env python3
"""Drafts in the page, against the mock hub's drafts table (test/mock-fetch.js), on WebKit and Chromium.

Asked for 2026-11-06: drafts that save as you type and follow you between devices, as Spark and Superhuman do.
Before this a closed message lived 8 seconds in memory and opening another conversation emptied the reply.

Checks:
  - typing in a new message saves it to the hub about a second later, and the window says Saved;
  - closing it says "Saved to Drafts"; Drafts in the sidebar counts it and lists it with its subject and recipient;
  - opening it from Drafts brings every field back; an edit saves from the revision it read;
  - sending it takes it out of Drafts; Undo puts the message back in the window and back in Drafts;
  - a reply typed in a conversation is saved under that conversation; opening another conversation keeps it; the row says Draft; the
    reply box has it again when the conversation is opened again;
  - a reply draft written on another device shows on its row and fills the reply box;
  - edited here and on another device from the same revision: the hub refuses this save, and both versions end up in Drafts;
  - a file attached to a draft goes up once and comes back with it after a reload;
  - after a reload the drafts are still listed;
  - Discard hides a draft at once, Undo brings it back, and without Undo it is deleted on the hub;
  - CONTROL: the client at 6de14a5 keeps nothing (no drafts request is ever made).
Usage: python3 test/drafts.py"""
import sys, subprocess, socketserver, threading, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

def at_head(f): return subprocess.run(["git", "show", f"6de14a5:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=HISTORY).stdout
HISTORY = subprocess.run(["git", "cat-file", "-e", "6de14a5^{commit}"], cwd=preview.HUB, capture_output=True).returncode == 0; OLD_BUNDLE = "\n".join(at_head(f) for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]).replace("__VERSION__", "test")
OLD_SHELL = at_head("app.html").replace("__VERSION__", "test").replace('<script src="/app.js?v=test"></script>', '<script src="/mock-fetch.js"></script><script src="/app.js"></script>')

def server(bundle, shell):
    class H(preview.H):
        def do_GET(self):
            p = self.path.split("?")[0]
            if p == "/app.js": return self._send(bundle, "text/javascript; charset=utf-8")
            if p in ("/", "/index.html"): return self._send(shell, "text/html; charset=utf-8", {"x-app-shell": "1"})
            return super().do_GET()
    srv = preview.TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv   # threaded

READY = "window.mh && window.mh.state && window.mh.state.threads.size >= 4 && window.mh.state.me && window.mh.state.me.identities.length"
ROWS = "() => [...document.querySelectorAll('#threads [data-draft]')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())"
LIVE = "() => [...window.__mock.drafts.rows.values()].filter((r) => !r.deleted).map((r) => ({ id: r.id, rev: r.rev, kind: r.kind, key: r.thread_key, text: r.content && r.content.text, subject: r.subject, files: (r.content && r.content.files || []).map((f) => f.name) }))"

fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (None if c else fails.append(m))

def run(engine):
    srv = server(preview.BUNDLE, preview.SHELL); base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as pw:
        b = getattr(pw, engine).launch(); ctx = b.new_context(viewport={"width": 1280, "height": 860}); page = ctx.new_page(); errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function(READY, timeout=20000); preview.settle(page, 500)
        E = engine
        # 1. a new message saves itself
        page.click("#composeBtn"); preview.settle(page, 200)
        page.fill("#cto", "dan@utility.example"); page.fill("#csub", "Project plan"); page.click("#ctext"); page.keyboard.type("Dan, the queue moved. ")
        preview.settle(page, 1900)
        live = page.evaluate(LIVE)
        check(len(live) == 1 and live[0]["subject"] == "Project plan" and "the queue moved" in (live[0]["text"] or "") and page.inner_text("#cdstat") == "Saved", f"{E}: typing saves the message to the hub a moment later, and it says Saved ({live}, {page.inner_text('#cdstat')!r})")
        # 2. close: Saved to Drafts, counted and listed
        page.click("#ccancel"); preview.settle(page, 400)
        toast = page.inner_text("#toast"); nav = page.evaluate("(() => { const a = document.querySelector('#nav a[data-view=\"drafts\"]'); return a ? a.textContent.trim() : null; })()")
        check("Saved to Drafts" in toast and nav and nav.endswith("1"), f"{E}: closing says Saved to Drafts and the sidebar's Drafts counts 1 ({toast!r}, {nav!r})")
        page.click('#nav a[data-view="drafts"]'); preview.settle(page, 300); rows = page.evaluate(ROWS)
        check(len(rows) == 1 and "Project plan" in rows[0] and "dan@utility.example" in rows[0], f"{E}: Drafts lists it with its subject and recipient ({rows})")
        # 3. open from Drafts, edit from the revision read
        page.click("#threads [data-draft]"); preview.settle(page, 400)
        f = page.evaluate("({ to: document.querySelector('#cto').value, sub: document.querySelector('#csub').value, text: document.querySelector('#ctext').value, title: document.querySelector('#ctitle').textContent, on: document.querySelector('#cmodal').classList.contains('on') })")
        check(f["on"] and f["to"] == "dan@utility.example" and f["sub"] == "Project plan" and "the queue moved" in f["text"] and f["title"] == "Draft", f"{E}: opening it from Drafts brings every field back ({f})")
        page.click("#ctext"); page.keyboard.press("End"); page.keyboard.type("Call me."); preview.settle(page, 1900)
        puts = page.evaluate("window.__mock.drafts.puts.slice(-1)[0]"); live = page.evaluate(LIVE)
        check(puts and puts["base"] == 1 and live[0]["rev"] == 2 and "Call me." in live[0]["text"], f"{E}: the edit saves from revision 1, making revision 2 ({puts}, rev {live[0]['rev']})")
        # 4. send: out of Drafts; Undo: back
        page.click("#csend"); page.wait_for_function("document.querySelector('#toast').innerText.includes('Sending in')", timeout=8000); preview.settle(page, 300)   # the queue's durable write comes first (up to 3 s here, with no service worker)
        gone = page.evaluate(LIVE); undo_btn = page.query_selector("#toast button")
        check(gone == [] and not page.evaluate("document.querySelector('#cmodal').classList.contains('on')"), f"{E}: sending takes it out of Drafts at once ({gone})")
        if undo_btn: undo_btn.click()
        preview.settle(page, 1900)
        back = page.evaluate(LIVE); reopened = page.evaluate("({ on: document.querySelector('#cmodal').classList.contains('on'), text: document.querySelector('#ctext').value })")
        check(undo_btn is not None and reopened["on"] and "Call me." in reopened["text"] and len(back) == 1 and "Call me." in back[0]["text"], f"{E}: Undo puts the message back in the window and back in Drafts ({reopened['on']}, {len(back)} in Drafts)")
        page.click("#ccancel"); preview.settle(page, 300)
        # 5. a reply belongs to its conversation
        page.click('#nav a[data-view="inbox"]'); preview.settle(page, 400)
        keys = page.evaluate("[...mh.state.threads.values()].filter((t) => t.kind === 'hub' && t.state === 'inbox').map((t) => t.key)")
        k1, k2 = keys[0], keys[1]
        page.evaluate(f"mh.openThread({k1!r})"); preview.settle(page, 700)
        page.click("#rtext"); page.keyboard.press("Control+Home" if E != "webkit" else "Meta+ArrowUp"); page.keyboard.type("Thanks, I will look tonight. ")
        page.evaluate(f"mh.openThread({k2!r})"); preview.settle(page, 700)
        live = page.evaluate(LIVE); rd = [d for d in live if d["kind"] == "reply"]
        check(len(rd) == 1 and rd[0]["key"] == k1 and "look tonight" in rd[0]["text"], f"{E}: opening another conversation saves the reply under its own conversation at once ({rd})")
        tag = page.evaluate(f"(() => {{ const r = document.querySelector('#threads .t[data-key=\"{k1}\"] .drafttag'); return r ? r.textContent : null; }})()")
        box2 = page.input_value("#rtext")
        check(tag == "Draft" and "look tonight" not in box2, f"{E}: its row says Draft, and the other conversation's reply box does not have it ({tag!r})")
        page.evaluate(f"mh.openThread({k1!r})"); preview.settle(page, 700)
        check("look tonight" in page.input_value("#rtext"), f"{E}: opening the conversation again brings the reply back ({page.input_value('#rtext')[:40]!r})")
        # 6. a reply draft from another device
        page.evaluate(f"""() => window.__mock.drafts.put("bbbbbbbb-2222-4222-8222-000000000002", {{ kind: "reply", thread_key: {k2!r}, from: "sam@yourdomain.example", to: "x", subject: "Re: x", snippet: "From the phone", content: {{ kind: "reply", key: {k2!r}, from: "sam@yourdomain.example", from_name: "Sam", all: false, text: "From the phone, on the bus.", files: [] }} }})""")
        page.evaluate("mh.syncDrafts()"); preview.settle(page, 600)
        tag2 = page.evaluate(f"(() => {{ const r = document.querySelector('#threads .t[data-key=\"{k2}\"] .drafttag'); return r ? r.textContent : null; }})()")
        page.evaluate(f"mh.openThread({k2!r})"); preview.settle(page, 700)
        check(tag2 == "Draft" and "on the bus" in page.input_value("#rtext"), f"{E}: a reply written on another device shows on its row and fills the reply box ({tag2!r}, {page.input_value('#rtext')[:30]!r})")
        # 7. the same draft changed here and on another device from the same revision: both kept
        page.click("#rtext"); page.keyboard.press("End")
        page.evaluate("""() => { const r = window.__mock.drafts.rows.get("bbbbbbbb-2222-4222-8222-000000000002"); window.__mock.drafts.put(r.id, { ...r, content: { ...r.content, text: "Rewritten on the PC." } }); }""")
        page.keyboard.type(" And one more line from here."); preview.settle(page, 2200)
        live = page.evaluate(LIVE); texts = sorted(d["text"] or "" for d in live if d["kind"] == "reply" and d["key"] == k2)
        check(len(texts) == 2 and any("Rewritten on the PC." == t for t in texts) and any("one more line from here" in t for t in texts) and "Both versions are in Drafts" in page.inner_text("#toast"), f"{E}: edited here and on another device, both versions end up in Drafts and it says so ({texts}, {page.inner_text('#toast')[:60]!r})")
        # 8. a file goes up with a draft and comes back after a reload
        page.click("#composeBtn"); preview.settle(page, 200); page.fill("#cto", "kim@grid.example"); page.fill("#csub", "Queue file")
        page.set_input_files("#cfiles", files=[{"name": "project-notes.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.7 test file"}])
        preview.settle(page, 1900); page.click("#ccancel"); preview.settle(page, 400)
        withf = [d for d in page.evaluate(LIVE) if d["subject"] == "Queue file"]
        check(len(withf) == 1 and withf[0]["files"] == ["project-notes.pdf"] and page.evaluate("window.__mock.drafts.files.size") >= 1, f"{E}: a file attached to a draft goes up with it ({withf})")
        # 9. reload with the hub unreachable: the drafts are still listed, from this device's own copy; with the hub back, the file comes
        # back with its draft. (The mock hub lives in the page, so its table is carried across the reload, as the real hub keeps it.)
        dump = page.evaluate("""async () => { const D = window.__mock.drafts; const files = []; for (const [k, f] of D.files) files.push({ k, f: { ...f, blob: null }, b64: btoa(String.fromCharCode(...new Uint8Array(await f.blob.arrayBuffer()))) }); return JSON.stringify({ rows: [...D.rows.values()], seq: D.seq, files }); }""")
        ctx.add_init_script("window.__mockSetup = (m) => { const x = " + dump + "; m.drafts.rows = new Map(x.rows.map((r) => [r.id, r])); m.drafts.seq = x.seq; for (const it of x.files) m.drafts.files.set(it.k, { ...it.f, blob: new Blob([Uint8Array.from(atob(it.b64), (c) => c.charCodeAt(0))], { type: it.f.type }) }); m.drafts.fail = true; };")
        page.reload(); page.wait_for_function(READY, timeout=20000); preview.settle(page, 600)
        page.click('#nav a[data-view="drafts"]'); preview.settle(page, 500); rows = page.evaluate(ROWS)
        check(len(rows) >= 3 and any("Queue file" in r for r in rows), f"{E}: after a reload with the hub unreachable the drafts are still listed, from this device's copy ({len(rows)} rows)")
        page.evaluate("window.__mock.drafts.fail = false"); page.evaluate("mh.syncDrafts()"); preview.settle(page, 500)
        page.click("#threads [data-draft]:has-text('Queue file')"); preview.settle(page, 800)
        got = page.evaluate("[...document.querySelector('#cfiles').files].map((f) => f.name + ':' + f.size)")
        check(got == ["project-notes.pdf:18"], f"{E}: with the hub back, the draft opens with its file ({got})")
        page.click("#ccancel"); preview.settle(page, 300); page.click('#nav a[data-view="drafts"]'); preview.settle(page, 400); rows = page.evaluate(ROWS)
        # 10. discard, undo, discard for good
        n0 = len(rows); page.click("#threads [data-ddel]"); preview.settle(page, 200); n1 = len(page.evaluate(ROWS))
        page.click("#toast button"); preview.settle(page, 300); n2 = len(page.evaluate(ROWS))
        check(n1 == n0 - 1 and n2 == n0, f"{E}: Discard hides a draft at once, Undo brings it back ({n0} -> {n1} -> {n2})")
        r_before = page.evaluate("window.__mock.drafts.calls = window.__mock.calls.filter((c) => /^DELETE \\/api\\/drafts/.test(c)).length")
        page.click("#threads [data-ddel]"); preview.settle(page, 7200)
        r_after = page.evaluate("window.__mock.calls.filter((c) => /^DELETE \\/api\\/drafts/.test(c)).length")
        check(len(page.evaluate(ROWS)) == n0 - 1 and r_after == r_before + 1, f"{E}: without Undo it is deleted on the hub when the toast goes ({r_before} -> {r_after} deletes)")
        check(not errs, f"{E}: no page errors ({errs[:2]})")
        b.close()
    srv.shutdown()

def control():
    srv = server(OLD_BUNDLE, OLD_SHELL); base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as pw:
        b = pw.chromium.launch(); page = b.new_context(viewport={"width": 1280, "height": 860}).new_page()
        page.goto(base); page.wait_for_function(READY, timeout=20000); preview.settle(page, 400)
        page.click("#composeBtn"); preview.settle(page, 200); page.fill("#cto", "dan@utility.example"); page.fill("#csub", "Project plan"); page.fill("#ctext", "Dan, the queue moved.")
        preview.settle(page, 1900); page.click("#ccancel"); preview.settle(page, 9000)
        calls = page.evaluate("window.__mock.calls.filter((c) => /\\/api\\/drafts/.test(c)).length"); has_nav = page.evaluate("!!document.querySelector('#nav a[data-view=\"drafts\"]')")
        check(calls == 0 and not has_nav, f"CONTROL: the client at 6de14a5 makes no drafts request and has no Drafts folder; the closed message is gone ({calls} calls)")
        b.close()
    srv.shutdown()

for engine in ("webkit", "chromium"): run(engine)
if preview.CONTROL: control()
else: preview.control_skipped("drafts.py")
if fails: print(f"\n{len(fails)} FAILED"); sys.exit(1)
print("\nall drafts checks passed")
