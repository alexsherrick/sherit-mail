#!/usr/bin/env python3
"""A forward the app builds looks like the mail you got. It carried only text: a forward from a Gmail account (or of a
Gmail mail) flattened the original, and its buttons arrived as words with no link behind them (A concert invitation forwarded
to a friend, whose "Sign Up" went nowhere). In WebKit and Chromium, with the app's fake network (test/mock-fetch.js), a hub mail with a
styled button, an inline logo and a file, forwarded from a Gmail account through the compose window, and the raw message the app would
hand Gmail parsed as any mail app would:
  - its HTML part is the original's: the button with its link, its <style> in the head, under the note and a "Forwarded message" header;
  - the inline logo goes inline, under the Content-ID the HTML names, beside the HTML (multipart/related); the file goes as a file;
  - its text part keeps each link's address beside its words;
  - when the forwarded block was edited in the box, the forward goes as that text alone, without the original's HTML or pictures;
  - a hub forward from a hub address with an edited block asks the hub to send it as typed;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the HTML, inline-picture and link checks.
Usage: python3 test/forwardlook.py"""
import os, sys, base64, email
from email import policy
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
TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID; GMAIL = "sam.owner.sxsw@gmail.com"
RICH = ('<!DOCTYPE html><html><head><style>.btn{background:#111;color:#fff;padding:12px 24px}</style></head><body bgcolor="#f4f1ea">'
        '<img src="cid:logo1" alt="Venue" width="120"><h1>Join us at the hall</h1><p>Sign up for each show you are attending.</p>'
        '<a class="btn" href="https://tickets.example/signup?show=42&amp;src=mail">Sign Up</a> <a href="https://tickets.example/app">View in app</a></body></html>')
PNG = base64.b64encode(bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4])).decode()
PDF = base64.b64encode(b"%PDF-1.4 the menu").decode()
SETUP = """([tid, rich, png, pdf]) => { const r = window.__mock.routes['GET /api/threads/' + tid];
  r.messages.forEach((m) => { m.body_html = rich; m.body_text = null; m.attachments = [{ id: 'att-logo', filename: 'logo.png', content_type: 'image/png', size_bytes: 12, content_id: '<logo1>', disposition: 'inline' }, { id: 'att-menu', filename: 'menu.pdf', content_type: 'application/pdf', size_bytes: 17, disposition: 'attachment' }]; });
  window.__mock.routes['GET /api/att/att-logo'] = { __b64: png }; window.__mock.routes['GET /api/att/att-menu'] = { __b64: pdf }; }"""
CAPTURE = "() => { window.__rows = []; const q = window.mh.queue; q.__add = q.__add || q.add.bind(q); q.add = async (row) => { window.__rows.push(JSON.parse(JSON.stringify(row))); return { key: 'cap' + window.__rows.length }; }; }"
OPEN = """async (k) => { window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key)); await window.mh.openThread(k); }"""
# the forward window, From set, the note above the block, and the block edited when asked
FORWARD = """async ([from, edit]) => { document.querySelector('#actions [data-act=forward]').click(); await new Promise((r) => setTimeout(r, 300));
  const f = document.querySelector('#cfrom'); f.value = from; f.dispatchEvent(new Event('change')); document.querySelector('#cto').value = 'pat@friend.example';
  const t = document.querySelector('#ctext'); t.value = 'This one is for you two' + t.value.replace(/^[\\s\\S]*?(---------- Forwarded message)/, '\\n\\n$1');
  if (edit) t.value = t.value.replace('Sign up for each show you are attending.', 'Sign up (my seat number removed).');
  await new Promise((r) => setTimeout(r, 200)); document.querySelector('#csend').click(); await new Promise((r) => setTimeout(r, 1500));
  const row = window.__rows.find((x) => x.op === 'send'); window.__rows = [];
  if (!row) return null;
  const d = row.args.draft; const raw = d.raw || (row.args.gmail ? window.mh.buildMime(d) : null);
  return { gmail: row.args.gmail || null, forwardOf: row.args.forwardOf || null, asTyped: !!d.as_typed, text: d.text || null, raw: raw ? new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))) : null }; }"""

def parts(raw):
    m = email.message_from_string(raw, policy=policy.default); out = {"html": "", "text": "", "inline": [], "files": [], "related": False}
    for p in m.walk():
        ct = p.get_content_type()
        if ct == "multipart/related": out["related"] = True
        if p.is_multipart(): continue
        disp = (p.get("Content-Disposition") or "").split(";")[0].strip().lower(); cid = (p.get("Content-ID") or "").strip("<> ")
        if ct == "text/html" and not disp: out["html"] = p.get_content()
        elif ct == "text/plain" and not disp: out["text"] = p.get_content()
        elif disp == "inline": out["inline"].append((p.get_filename(), cid))
        else: out["files"].append(p.get_filename())
    return out

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(SETUP, [TID, RICH, PNG, PDF]); page.evaluate(CAPTURE); page.evaluate(OPEN, KEY); preview.settle(page, 500)
        # 1. a hub mail forwarded from a Gmail account
        r = page.evaluate(FORWARD, [GMAIL, False]) or {}
        p = parts(r["raw"]) if r.get("raw") else {"html": "", "text": "", "inline": [], "files": [], "related": False}
        h = p["html"]
        check(r.get("gmail") == GMAIL and 'href="https://tickets.example/signup?show=42&amp;src=mail"' in h and ">Sign Up</a>" in h, f"{name}: the forward's HTML carries the original's button with its link ({len(h)} chars of HTML)")
        check(0 <= h.find("<style>.btn") < h.find("<body") and "This one is for you two" in h and "---------- Forwarded message ---------" in h and "background-color:#f4f1ea" in h, f"{name}: the original's style in the head, under the note and a Forwarded header, its colour kept")
        check(p["related"] and ("logo.png", "logo1") in p["inline"] and 'src="cid:logo1"' in h, f"{name}: the inline logo goes inline beside the HTML, under the Content-ID it names ({p['inline']}, related {p['related']})")
        check("menu.pdf" in p["files"], f"{name}: the original's file goes as a file ({p['files']})")
        check("Sign Up <https://tickets.example/signup?show=42&src=mail>" in p["text"] and p["text"].startswith("This one is for you two"), f"{name}: its text part keeps each link's address ({p['text'][:200]!r})")
        # 2. the forwarded block edited: that text alone
        page.evaluate(OPEN, KEY); preview.settle(page, 300)
        r2 = page.evaluate(FORWARD, [GMAIL, True]) or {}
        p2 = parts(r2["raw"]) if r2.get("raw") else {"html": "", "text": "", "inline": [], "files": [], "related": False}
        check("my seat number removed" in p2["text"] and "tickets.example" not in p2["html"] and not p2["inline"], f"{name}: an edited block goes as the text typed, without the original's HTML or pictures ({p2['text'][:120]!r}, inline {p2['inline']})")
        # 3. a hub forward from a hub address with the block edited: the hub is asked to send it as typed
        page.evaluate(OPEN, KEY); preview.settle(page, 300)
        hub_from = page.evaluate("() => (window.mh.state.me.identities[0] || {}).email || 'sam@yourdomain.example'")
        r3 = page.evaluate(FORWARD, [hub_from, True]) or {}
        check(r3.get("forwardOf") and r3.get("asTyped") and "my seat number removed" in (r3.get("text") or ""), f"{name}: a hub forward with an edited block is sent as typed ({ {k: r3.get(k) for k in ('forwardOf', 'asTyped')} })")
        page.evaluate(OPEN, KEY); preview.settle(page, 300)
        r4 = page.evaluate(FORWARD, [hub_from, False]) or {}
        check(r4.get("forwardOf") and not r4.get("asTyped") and (r4.get("text") or "").startswith("This one is for you") and "Forwarded message" not in (r4.get("text") or ""), f"{name}: and one left as written sends only the note, the hub adding the original ({(r4.get('text') or '')[:60]!r})")
        # 4. a Gmail mail's inline picture comes from Gmail's attachment API
        g = page.evaluate("""async ([rich, gmail, png]) => { window.__mock.routes['GET gmail:messages/g9/attachments/ga1'] = { data: png.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') };
          const m = { id: 'g9', html: rich, text: '', from: 'The Venue <noreply@venue.example>', to: gmail, date: Date.now(), subject: 'Join us', attachments: [{ id: 'ga1', name: 'logo.png', mime: 'image/png', cid: '<logo1>', msgId: 'g9' }] };
          const d = await window.mh.forwardDraft({ from: gmail, to: ['pat@friend.example'], subject: 'Fwd: Join us', text: '', attachments: [] }, { t: { kind: 'gmail', account: gmail }, m }, 'For you', false);
          return { inline: (d.attachments || []).filter((a) => a.disposition === 'inline').map((a) => [a.filename, a.contentId, a.content.length > 0]), link: /href="https:\\/\\/tickets\\.example\\/signup/.test(d.html || '') }; }""", [RICH, GMAIL, PNG])
        check(g["link"] and g["inline"] == [["logo.png", "logo1", True]], f"{name}: a Gmail mail's forward carries its HTML and its inline picture from Gmail ({g})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all forward checks passed")
sys.exit(1 if fails else 0)
