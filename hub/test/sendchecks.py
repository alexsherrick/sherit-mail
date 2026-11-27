#!/usr/bin/env python3
"""Before a send, the app catches a missing attachment and a missing recipient, as Apple Mail's missed-recipient and
attachment alerts do. In WebKit and Chromium with the app's fake network (test/mock-fetch.js), what the send queue would be handed:
  - "The lease is attached" with nothing attached, and "Hi Dana" where Dana Smith (a contact) is not on the email: one warning naming
    both; Go back sends nothing and leaves the message open;
  - with the file attached, the warning names Dana alone and offers "Add Dana and send", which sends to her as well;
  - "cc'ing Zed", someone the contacts do not know: warned that no one named Zed is on it; Send anyway sends;
  - no warning for a greeting of the recipient, a thank-you, a "Hi Bob" to robert.b@, or "see attached" inside the forwarded message;
  - the reply box: "Hi Dana, see the attached report" in a reply to someone else warns; Go back sends nothing;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the warning checks.
Usage: python3 test/sendchecks.py"""
import os, sys, json
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
SETUP = """window.__mockSetup = (mk) => { const iso = new Date(Date.now() - 864e5).toISOString();
  mk.routes['GET /api/contacts'] = { sent: [{ addr: 'dana@work.example', name: 'Dana Smith', n: 6, last: iso }, { addr: 'bob.jones@other.example', name: 'Bob Jones', n: 2, last: iso }], received: [] }; };"""
CAPTURE = "() => { window.__rows = []; const q = window.mh.queue; q.add = async (row) => { window.__rows.push(JSON.parse(JSON.stringify(row))); return { key: 'cap' + window.__rows.length }; }; }"
# open the compose window, fill it, press Send; what the dialog said and what was queued
COMPOSE = """async ([to, text, file]) => { window.__rows = []; window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200));
  const from = document.querySelector('#cfrom'); if (!from.value) { from.value = from.options[0].value; from.dispatchEvent(new Event('change')); }
  document.querySelector('#cto').value = to; document.querySelector('#csub').value = 'Lease'; document.querySelector('#ctext').value = text;
  if (file) { const dt = new DataTransfer(); dt.items.add(new File(['%PDF-1.4 lease'], 'lease.pdf', { type: 'application/pdf' })); const inp = document.querySelector('#cfiles'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 200)); }
  document.querySelector('#csend').click(); await new Promise((r) => setTimeout(r, 900));
  const a = document.querySelector('#ask'); return { asked: a.classList.contains('on') ? a.querySelector('.msg').textContent : null, alt: (a.querySelector('[data-alt]') || {}).textContent || null }; }"""
ANSWER = """async (which) => { const a = document.querySelector('#ask'); const bs = [...a.querySelectorAll('.btns button')];
  const b = which === 'alt' ? a.querySelector('[data-alt]') : which === 'ok' ? bs[bs.length - 1] : bs[0]; b.click(); await new Promise((r) => setTimeout(r, 900));
  const row = window.__rows.find((x) => x.op === 'send'); return { sent: !!row, to: row ? row.args.draft.to : null, open: document.querySelector('#cmodal').classList.contains('on') }; }"""
SENT = "() => { const row = (window.__rows || []).find((x) => x.op === 'send'); return { sent: !!row, to: row ? row.args.draft.to : null }; }"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(SETUP)
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(CAPTURE)
        # 1. both slips; Go back
        r = page.evaluate(COMPOSE, ["bob@friend.example", "Hi Dana,\n\nThe lease is attached. Let me know what you think.", False])
        check(r["asked"] and "(“The lease is attached”), but nothing is attached" in r["asked"] and "You greet Dana, but Dana Smith (dana@work.example) is not on this email" in r["asked"], f"{name}: a missing file and a greeted contact not on the email, in one warning ({r['asked']!r})")
        g = page.evaluate(ANSWER, "cancel")
        check(not g["sent"] and g["open"], f"{name}: Go back sends nothing and leaves the message open ({g})")
        page.evaluate("() => window.mh.closeCompose ? window.mh.closeCompose() : document.querySelector('#cmodal').classList.remove('on')"); preview.settle(page, 200)
        # 2. file attached: Dana alone, added in the same step
        r = page.evaluate(COMPOSE, ["bob@friend.example", "Hi Dana,\n\nThe lease is attached.", True])
        check(r["asked"] and "nothing is attached" not in r["asked"] and r["alt"] == "Add Dana and send", f"{name}: with the file attached, only Dana, with Add Dana and send ({r})")
        g = page.evaluate(ANSWER, "alt")
        check(g["sent"] and "dana@work.example" in (g["to"] or []) and "bob@friend.example" in (g["to"] or []), f"{name}: Add Dana and send sends to her as well ({g['to']})")
        # 2b. "Add and send" answered after the window became another message: that message's recipients stay as they were, nothing sent
        page.evaluate("() => { document.querySelector('#cmodal').classList.remove('on'); }")
        rr = page.evaluate("""async () => { window.__rows = []; window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200));
          document.querySelector('#cto').value = 'bob@friend.example'; document.querySelector('#ctext').value = 'Hi Dana,\\n\\nThe lease is here.';
          document.querySelector('#csend').click(); for (let i = 0; i < 30 && !document.querySelector('#ask [data-alt]'); i++) await new Promise((r) => setTimeout(r, 100));
          const alt = document.querySelector('#ask [data-alt]'); window.mh.closeCompose ? window.mh.closeCompose() : null; window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200));
          document.querySelector('#cto').value = 'other@friend.example'; if (alt) alt.click(); await new Promise((r) => setTimeout(r, 900));
          return { had: !!alt, to: document.querySelector('#cto').value, cc: document.querySelector('#ccc').value, sent: !!window.__rows.find((x) => x.op === 'send') }; }""")
        check(rr["had"] and rr["to"] == "other@friend.example" and "dana@" not in rr["cc"] and not rr["sent"], f"{name}: Add and send, answered after the window changed, touches no other message and sends nothing ({rr})")
        page.evaluate("() => document.querySelector('#cmodal').classList.remove('on')")
        # 3. someone unknown cc'd: warned, Send anyway sends
        r = page.evaluate(COMPOSE, ["bob@friend.example", "Hi Bob,\n\nI'm cc'ing Zed on this so he knows the plan.", False])
        check(r["asked"] and "no one named Zed is on this email" in r["asked"] and not r["alt"], f"{name}: cc'ing someone no one knows, on no recipient ({r['asked']!r})")
        g = page.evaluate(ANSWER, "ok")
        check(g["sent"], f"{name}: Send anyway sends")
        # 4. nothing to say
        quiet = []
        for to, text in [("dana@work.example", "Hi Dana,\n\nSee you Friday."), ("bob@friend.example", "Thanks Bob, see you Friday."),
                         ("robert.b@friend.example", "Hi Bob,\n\nAll set for Friday."),
                         ("bob@friend.example", "FYI\n\n---------- Forwarded message ----------\nFrom: Kim <kim@x.example>\n\nHi Dana, please see attached.")]:
            r = page.evaluate(COMPOSE, [to, text, False]); s = page.evaluate(SENT)
            if r["asked"] or not s["sent"]: quiet.append((text[:30], r["asked"]))
            page.evaluate("() => document.querySelector('#ask').classList.contains('on') && document.querySelector('#ask .btns button').click()")
        check(not quiet, f"{name}: no warning for the recipient greeted (by a short form too: Bob to robert.b@, though a Bob Jones is a contact), a thank-you, or the forwarded message's own words ({quiet})")
        # 5. the reply box
        page.evaluate("() => { window.__rows = []; document.querySelector('#cmodal').classList.remove('on'); }")
        key = page.evaluate("() => [...window.mh.state.threads.values()].find((t) => t.kind === 'hub').key")
        page.evaluate("async (k) => { await window.mh.openThread(k); }", key); preview.settle(page, 600)
        r = page.evaluate("""async () => { const t = document.querySelector('#rtext'); t.value = 'Hi Dana, see the attached report.'; document.querySelector('#rsend').click(); await new Promise((r) => setTimeout(r, 900));
          const a = document.querySelector('#ask'); return a.classList.contains('on') ? a.querySelector('.msg').textContent : null; }""")
        check(r and "(“Hi Dana, see the attached report”), but nothing is attached" in r and "Dana Smith" in r, f"{name}: the reply box warns too ({r!r})")
        g = page.evaluate("async () => { document.querySelector('#ask .btns button').click(); await new Promise((r) => setTimeout(r, 600)); return !!(window.__rows || []).find((x) => x.op === 'send'); }")
        check(not g, f"{name}: Go back in the reply box sends nothing")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all send-check checks passed")
sys.exit(1 if fails else 0)
