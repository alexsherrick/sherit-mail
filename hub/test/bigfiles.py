#!/usr/bin/env python3
"""Files too big for the way a message goes out are sent as links, as Apple's Mail Drop. In WebKit and Chromium with
the app's fake network (test/mock-fetch.js) answering the hub's /api/drops:
  - a 6 MiB file on a hub address (whose sends stop at 5 MiB): the files label says it goes as a link; at Send it is uploaded in the
    hub's parts and the message goes without it, its text carrying the file's name, size, link and the date it is kept until;
  - a small file beside it still goes attached;
  - the same file from a Gmail account (room for 18 MiB) goes attached, nothing uploaded;
  - the reply box does the same;
  - a file too big to keep with the draft (18 MB) is never uploaded to it; a small one beside it is;
  - an upload that fails sends nothing and says so; one whose send is declined is deleted again;
  - the message's own text counts against the room;
  - moving to another conversation while a send warning is open sends nothing;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the link checks.
Usage: python3 test/bigfiles.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
DID = "44444444-4444-4444-8444-444444444444"; GMAIL = "sam.owner.sxsw@gmail.com"
SETUP = """window.__mockSetup = (mk) => { const exp = new Date(Date.now() + 30 * 864e5).toISOString();
  mk.routes['POST /api/drops'] = { id: '%s', part: 4194304, parts: 2 };
  mk.routes['PUT /api/drops/%s/parts/1'] = { partNumber: 1, etag: 'e1' }; mk.routes['PUT /api/drops/%s/parts/2'] = { partNumber: 2, etag: 'e2' };
  mk.routes['POST /api/drops/%s/complete'] = { url: 'https://mail.example/f/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', expires_at: exp, name: 'walk.mov', size: 6291456 }; };""" % (DID, DID, DID, DID)
CAPTURE = "() => { window.__rows = []; const q = window.mh.queue; q.add = async (row) => { window.__rows.push(JSON.parse(JSON.stringify(row))); return { key: 'cap' + window.__rows.length }; }; }"
COMPOSE = """async ([from, files]) => { window.__rows = []; window.__mock.calls.length = 0; window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200));
  const f = document.querySelector('#cfrom'); f.value = from; f.dispatchEvent(new Event('change'));
  document.querySelector('#cto').value = 'pat@friend.example'; document.querySelector('#csub').value = 'The walk'; document.querySelector('#ctext').value = 'Here is the video from the walk.';
  const dt = new DataTransfer(); for (const [name, size] of files) dt.items.add(new File([new Uint8Array(size)], name, { type: 'video/quicktime' }));
  const inp = document.querySelector('#cfiles'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 100));
  const label = document.querySelector('#cfilesn').textContent;
  document.querySelector('#csend').click(); await new Promise((r) => setTimeout(r, 1500));
  const row = window.__rows.find((x) => x.op === 'send'); const d = row ? row.args.draft : null;
  return { label, sent: !!row, text: d ? d.text : null, atts: d ? (d.attachments || []).map((a) => a.filename) : null, calls: window.__mock.calls.filter((c) => /drops/.test(c)) }; }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(SETUP)
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(CAPTURE)
        hub_from = page.evaluate("() => window.mh.state.me.identities[0].email")
        r = page.evaluate(COMPOSE, [hub_from, [["walk.mov", 6291456], ["notes.txt", 2000]]])
        check("as a link" in r["label"], f"{name}: the files label says the big one goes as a link ({r['label']!r})")
        check(r["sent"] and r["atts"] == ["notes.txt"] and "walk.mov (6.0 MB): https://mail.example/f/ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" in (r["text"] or "") and "download until" in (r["text"] or ""), f"{name}: the big file goes as a link in the text, the small one attached ({r['atts']}, {(r['text'] or '')[-140:]!r})")
        check(r["calls"][:4] == ["POST /api/drops", f"PUT /api/drops/{DID}/parts/1", f"PUT /api/drops/{DID}/parts/2", f"POST /api/drops/{DID}/complete"], f"{name}: uploaded in the hub's parts, then completed ({r['calls']})")
        page.evaluate("() => document.querySelector('#cmodal').classList.remove('on')")
        g = page.evaluate(COMPOSE, [GMAIL, [["walk.mov", 6291456]]])
        check(g["sent"] and g["atts"] == ["walk.mov"] and not g["calls"] and "as a link" not in g["label"], f"{name}: from Gmail, with room for it, the file goes attached and nothing is uploaded ({g['atts']}, {g['calls']})")
        page.evaluate("() => document.querySelector('#cmodal').classList.remove('on')")
        # an upload that fails: nothing sent, and it says so
        page.evaluate(f"() => {{ window.__mock.routes['PUT /api/drops/{DID}/parts/2'] = undefined; window.__mock.failNext = {{ match: /PUT \\/api\\/drops\\/.*\\/parts\\/1/, status: 413, body: {{ error: 'too big' }} }}; }}")
        f = page.evaluate(COMPOSE, [hub_from, [["walk.mov", 6291456]]])
        toast = page.evaluate("() => (document.querySelector('#toast') || document.querySelector('.toast') || {}).textContent || ''")
        check(not f["sent"] and "Nothing was sent" in toast and page.evaluate("() => document.querySelector('#cmodal').classList.contains('on')"), f"{name}: an upload that fails sends nothing, says so, and leaves the message open ({toast!r})")
        page.evaluate(f"() => {{ window.__mock.routes['PUT /api/drops/{DID}/parts/2'] = {{ partNumber: 2, etag: 'e2' }}; document.querySelector('#cmodal').classList.remove('on'); }}")
        # the reply box
        key = page.evaluate("() => [...window.mh.state.threads.values()].find((t) => t.kind === 'hub').key")
        page.evaluate("async (k) => { await window.mh.openThread(k); }", key); preview.settle(page, 600)
        rr = page.evaluate("""async () => { window.__rows = []; const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(6291456)], 'walk.mov', { type: 'video/quicktime' }));
          const inp = document.querySelector('#rfiles'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); document.querySelector('#rtext').value = 'The video.';
          const label = document.querySelector('#rfilesn').textContent; document.querySelector('#rsend').click(); await new Promise((r) => setTimeout(r, 1500));
          const row = window.__rows.find((x) => x.op === 'send'); return { label, text: row ? row.args.draft.text : null, atts: row ? (row.args.draft.attachments || []).length : null }; }""")
        check("as a link" in rr["label"] and rr["atts"] == 0 and "walk.mov (6.0 MB): https://mail.example/f/" in (rr["text"] or ""), f"{name}: the reply box sends it as a link too ({rr['label']!r}, {(rr['text'] or '')[-80:]!r})")
        # a file too big to keep with the draft is never sent to it (the hub read it whole before refusing it)
        dr = page.evaluate("""async () => { document.querySelector('#cmodal').classList.remove('on'); window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200)); window.__mock.calls.length = 0;
          document.querySelector('#cto').value = 'pat@friend.example'; const t = document.querySelector('#ctext'); t.value = 'Big one'; t.dispatchEvent(new Event('input'));
          const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(20 * 1048576)], 'huge.mov', { type: 'video/quicktime' })); dt.items.add(new File([new Uint8Array(3000)], 'small.txt', { type: 'text/plain' }));
          const inp = document.querySelector('#cfiles'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); await window.mh.draftFlush('c'); await new Promise((r) => setTimeout(r, 1500));
          const ups = window.__mock.calls.filter((c) => /POST \/api\/drafts\/[^/]+\/files/.test(c)); return { ups: ups.length, kept: [...window.__mock.drafts.files.values()].map((f) => f.name) }; }""")
        check(dr["ups"] == 1 and "small.txt" in dr["kept"] and "huge.mov" not in dr["kept"], f"{name}: the draft keeps the small file; one too big to keep is never sent to it ({dr})")
        # two big files, the second's upload failing: the first is taken back, nothing sent
        two = page.evaluate("""async ([from]) => { window.__rows = []; window.__mock.calls.length = 0; let n = 0; const real = window.fetch;
          window.fetch = (u, o) => { if (/\\/api\\/drops$/.test(String(u)) && ++n === 2) return Promise.resolve({ ok: false, status: 507, json: async () => ({ error: 'full' }), text: async () => '', headers: new Map() }); return real(u, o); };
          window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200)); const f = document.querySelector('#cfrom'); f.value = from; f.dispatchEvent(new Event('change'));
          document.querySelector('#cto').value = 'pat@friend.example'; document.querySelector('#ctext').value = 'Two videos.';
          const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(6291456)], 'a.mov', { type: 'video/quicktime' })); dt.items.add(new File([new Uint8Array(6291456)], 'b.mov', { type: 'video/quicktime' }));
          const inp = document.querySelector('#cfiles'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); document.querySelector('#csend').click(); await new Promise((r) => setTimeout(r, 1800));
          window.fetch = real; return { sent: !!window.__rows.find((x) => x.op === 'send'), del: window.__mock.calls.filter((c) => /^DELETE \\/api\\/drops\\//.test(c)).length }; }""", [hub_from])
        check(not two["sent"] and two["del"] == 1, f"{name}: a second upload failing takes the first back and sends nothing ({two})")
        page.evaluate("() => document.querySelector('#cmodal').classList.remove('on')")
        # the message's own text counts: a 3 MiB file beside 2 MiB of words no longer fits a hub send
        page.evaluate("() => document.querySelector('#cmodal').classList.remove('on')")
        lbl = page.evaluate("""async ([from]) => { window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200)); const f = document.querySelector('#cfrom'); f.value = from; f.dispatchEvent(new Event('change'));
          document.querySelector('#ctext').value = 'x'.repeat(2 * 1048576); const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(3 * 1048576)], 'report.pdf', { type: 'application/pdf' }));
          const inp = document.querySelector('#cfiles'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); const l = document.querySelector('#cfilesn').textContent; document.querySelector('#cmodal').classList.remove('on'); return l; }""", [hub_from])
        check("as a link" in lbl, f"{name}: the message's own text counts against the room ({lbl!r})")
        # a send declined at "may already have gone out" takes its uploaded files away again
        page.evaluate("() => { window.mh.state.maybeSent = { at: Date.now() }; }")
        dc = page.evaluate("""async ([from]) => { window.__rows = []; window.__mock.calls.length = 0; window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200));
          const f = document.querySelector('#cfrom'); f.value = from; f.dispatchEvent(new Event('change')); document.querySelector('#cto').value = 'pat@friend.example'; document.querySelector('#ctext').value = 'The video.';
          const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(6291456)], 'walk.mov', { type: 'video/quicktime' })); const inp = document.querySelector('#cfiles'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
          document.querySelector('#csend').click(); for (let i = 0; i < 40 && !/may already have gone out/.test(document.querySelector('#ask').textContent || ''); i++) await new Promise((r) => setTimeout(r, 100));
          const asked = document.querySelector('#ask').textContent; document.querySelector('#ask .btns button').click(); await new Promise((r) => setTimeout(r, 800));
          return { asked: /may already have gone out/.test(asked), sent: !!window.__rows.find((x) => x.op === 'send'), del: window.__mock.calls.filter((c) => /^DELETE \/api\/drops\//.test(c)) }; }""", [hub_from])
        check(dc["asked"] and not dc["sent"] and dc["del"] == [f"DELETE /api/drops/{DID}"], f"{name}: a send declined after its upload deletes the upload ({dc})")
        page.evaluate("() => { window.mh.state.maybeSent = null; document.querySelector('#cmodal').classList.remove('on'); }")
        # the reply box: moving to another conversation while the warning is open sends nothing
        keys = page.evaluate("() => [...window.mh.state.threads.values()].filter((t) => t.kind === 'hub').slice(0, 2).map((t) => t.key)")
        page.evaluate("async (k) => { await window.mh.openThread(k); }", keys[0]); preview.settle(page, 500)
        mv = page.evaluate("""async (other) => { window.__rows = []; document.querySelector('#rtext').value = 'The report is attached.'; document.querySelector('#rsend').click();
          for (let i = 0; i < 30 && !document.querySelector('#ask').classList.contains('on'); i++) await new Promise((r) => setTimeout(r, 100));
          const warned = document.querySelector('#ask').classList.contains('on'); await window.mh.openThread(other); await new Promise((r) => setTimeout(r, 300));
          const bs = [...document.querySelectorAll('#ask .btns button')]; if (bs.length) bs[bs.length - 1].click(); await new Promise((r) => setTimeout(r, 800));
          return { warned, sent: !!window.__rows.find((x) => x.op === 'send') }; }""", keys[1])
        check(mv["warned"] and not mv["sent"], f"{name}: moving to another conversation while the warning is open sends nothing ({mv})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all large-file sending checks passed")
sys.exit(1 if fails else 0)
