#!/usr/bin/env python3
"""A reply that goes out shows in the conversation that is open: on WebKit and Chromium.

Reported 2026-10-15: a reply sent from an open conversation did not show in it until the conversation was opened
again. The send handler refreshed the list only; the open conversation kept its old messages until it was opened again. Now, when a send
completes, the conversation is fetched again and redrawn (reloadOpenThread), unless the user moved on or is writing another reply.

The mock hub adds the sent message to the conversation when its reply route is called. Checks:
  - the sent reply is on screen, at the top, within a few seconds of the send, with the reply box empty;
  - the redraw is not an open: no new open-thread speed sample, no new history entry;
  - moved to another conversation: the screen stays there, and the first conversation shows the reply when opened again;
  - a second reply being written is not wiped by the redraw;
  - a Gmail conversation: the reply goes through Gmail and shows the same way; also in one with a message in Trash, whose list row
    names the messages it shows (shownIds) and does not yet name the reply;
  - CONTROL: the app at ccae005 leaves the sent reply off the screen, hub and Gmail.
Usage: python3 test/sentshows.py"""
import sys, subprocess, socketserver, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
TID2 = "22222222-2222-2222-2222-222222222222"; KEY2 = "hub|" + TID2
GMAIL = "sam.owner.sxsw@gmail.com"; GKEY = GMAIL + "|g1"
HISTORY = subprocess.run(["git", "cat-file", "-e", "ccae005^{commit}"], cwd=preview.HUB, capture_output=True).returncode == 0; OLD_APP = subprocess.run(["git", "show", "ccae005:hub/src/client/app.js"], cwd=preview.HUB, capture_output=True, text=True, check=HISTORY).stdout
OLD_BUNDLE = "\n".join((preview.CLIENT / f).read_text() if f != "app.js" else OLD_APP for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]).replace("__VERSION__", "test")

def server(bundle):
    class H(preview.H):
        def do_GET(self):
            if self.path.split("?")[0] == "/app.js": return self._send(bundle, "text/javascript; charset=utf-8")
            return super().do_GET()
    class TS(socketserver.ThreadingMixIn, socketserver.TCPServer): daemon_threads = True; allow_reuse_address = True
    srv = TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv

# The mock hub: the reply route answers, and from then on the conversation carries the sent message.
SETUP = """([tid]) => {
  window.__mock.routes['POST /api/messages/m1/reply'] = { id: 'm-out', thread_id: tid, message_id: '<out@yourdomain.example>' };
  const f = window.fetch;
  window.fetch = async (url, o = {}) => {
    const r = await f(url, o);
    if (/\\/api\\/messages\\/m1\\/reply$/.test(String(url)) && String(o.method || '').toUpperCase() === 'POST') {
      const tr = window.__mock.routes['GET /api/threads/' + tid], body = JSON.parse(o.body || '{}');
      tr.messages.push({ id: 'm-out', direction: 'out', from_addr: 'sam@yourdomain.example', from_name: 'Sam', identity: 'sam@yourdomain.example', to_addrs: [{ address: 'bob@example.com' }], cc_addrs: [], subject: 'Re: Hello there', body_text: body.text || '', body_html: null, created_at: new Date(Date.now() + 1000).toISOString(), attachments: [], message_id: '<out@yourdomain.example>' });
      window.__replied = (window.__replied || 0) + 1;
    }
    return r;
  };
  Q.undoMs = 300;   // the 5 s undo window, shortened for the test
}"""
# The mock Gmail: no earlier copy of the reply is found by its Message-ID, the send answers, and from then on the conversation carries it.
GSETUP = """([gmail]) => {
  const f = window.fetch, b64u = (x) => btoa(unescape(encodeURIComponent(x))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  window.fetch = async (url, o = {}) => {
    const u = String(url), post = String(o.method || '').toUpperCase() === 'POST';
    if (u.includes('/gmail/v1/users/me/messages?') && u.includes('rfc822msgid')) return { ok: true, status: 200, json: async () => ({ resultSizeEstimate: 0 }), text: async () => '{}', headers: new Map() };
    if (post && /\\/gmail\\/v1\\/users\\/me\\/messages\\/send$/.test(u)) {
      const tid = window.__gthread || 'g1', tr = window.__mock.routes['GET gmail:threads/' + tid + '?'];
      tr.messages.push({ id: 'gm-out-' + tid, threadId: tid, labelIds: ['SENT'], internalDate: String(Date.now() + 1000), snippet: window.__gtext, payload: { headers: [{ name: 'From', value: 'SXSW <' + gmail + '>' }, { name: 'To', value: 'Alice <alice@example.com>' }, { name: 'Subject', value: 'Re: Personal note' }, { name: 'Date', value: new Date().toUTCString() }, { name: 'Message-ID', value: '<gm-out-' + tid + '@mail.gmail.com>' }], mimeType: 'text/plain', body: { data: b64u(window.__gtext) } } });
      window.__gsent = (window.__gsent || 0) + 1;
      return { ok: true, status: 200, json: async () => ({ id: 'gm-out-' + tid, threadId: tid }), text: async () => '{}', headers: new Map() };
    }
    return f(url, o);
  };
}"""
OPEN = """async ([k]) => { await window.mh.openThread(k); await new Promise((r) => setTimeout(r, 400)); }"""
SAMPLES = """() => { const r = (perf.report().rows || []).find((x) => x.name === 'open-thread:visible'); return r ? r.n : 0; }"""
TOP = """() => { const m = document.querySelector('#msgs .m'); return m ? m.textContent : ''; }"""

def gmail_case(page, tid="g1", text="Gmail reply, on its way", trashed=False):
    key = GMAIL + "|" + tid
    page.wait_for_function("([k]) => window.mh.state.threads.has(k)", arg=[key], timeout=15000)
    if not page.evaluate("() => !!window.__gsetup"): page.evaluate(GSETUP, [GMAIL]); page.evaluate("() => { window.__gsetup = true; }")
    page.evaluate("([tid, text]) => { window.__gthread = tid; window.__gtext = text; }", [tid, text])
    if trashed:   # an older message of the conversation is in Trash: Gmail shows the rest, and the list row names them (shownIds)
        page.evaluate("""([tid]) => { const R = window.__mock.routes, tr = R['GET gmail:threads/' + tid + '?'], m0 = tr.messages[0];
          const m = { ...JSON.parse(JSON.stringify(m0)), id: 'gm-trash-' + tid, labelIds: ['TRASH'], internalDate: String(Number(m0.internalDate) - 60e3) };
          tr.messages.unshift(m); R['GET gmail:messages/' + m.id + '?'] = m; R['GET gmail:messages?'].messages.push({ id: m.id, threadId: tid }); }""", [tid])
        page.evaluate("([g]) => window.mh.refresh({ silent: true, accounts: [g] })", [GMAIL])
        page.wait_for_function("([k]) => (window.mh.state.threads.get(k).shownIds || []).length > 0", arg=[key], timeout=15000)
    page.evaluate(OPEN, [key])
    if page.input_value("#rfrom") != GMAIL: print(f"     (the reply box is from {page.input_value('#rfrom')!r}, not the Gmail account)")
    page.fill("#rtext", text); page.click("#rsend")
    try: page.wait_for_function("([text]) => (document.querySelector('#msgs .m') || {}).textContent?.includes(text)", arg=[text], timeout=6000); return True
    except Exception: return False

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def run(bundle, label, control=False):
    srv = server(bundle); base = f"http://127.0.0.1:{srv.server_address[1]}/"; out = {}
    with sync_playwright() as pw:
        for engine in ((pw.chromium,) if control else (pw.webkit, pw.chromium)):
            name = f"{engine.name}{' ' + label if label else ''}"
            b = engine.launch(); page = b.new_page(viewport={"width": 1100, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
            page.evaluate(SETUP, [TID])
            # 1. sitting on the conversation
            page.evaluate(OPEN, [KEY]); n0 = page.evaluate(SAMPLES); h0 = page.evaluate("() => history.length")
            page.fill("#rtext", "Friday works, see you then"); page.click("#rsend")
            try: page.wait_for_function("() => (document.querySelector('#msgs .m') || {}).textContent?.includes('Friday works, see you then')", timeout=6000); shown = True
            except Exception: shown = False
            out[name] = shown
            top, replied, box = page.evaluate(TOP), page.evaluate("() => window.__replied"), page.input_value("#rtext")
            sig = page.evaluate("() => window.mh.sigFor ? window.mh.sigFor($('#rfrom').value).trim() : ''"); n1, h1 = page.evaluate(SAMPLES), page.evaluate("() => history.length")
            gshown = gmail_case(page); gtop, gsent = page.evaluate(TOP), page.evaluate("() => window.__gsent")
            if control:
                check(not shown, f"{name}: CONTROL — the app at ccae005 leaves the sent reply off the open conversation (replied {replied})")
                check(not gshown, f"{name}: CONTROL — and off the open Gmail conversation (sent through Gmail {gsent})")
                b.close(); continue
            check(shown and replied == 1, f"{name}: the sent reply appears at the top of the open conversation ({top[:60]!r})")
            check(box.strip() in ("", sig), f"{name}: the reply box is empty after it ({box!r})")
            check(n1 == n0 and h1 == h0, f"{name}: the redraw adds no speed sample and no history entry ({n0} -> {n1}, {h0} -> {h1})")
            check(gshown and gsent == 1, f"{name}: a Gmail reply goes through Gmail and appears at the top of its conversation ({gtop[:60]!r})")
            tshown = gmail_case(page, "g2", "Reply where one message is in Trash", trashed=True); ttop = page.evaluate(TOP)
            check(tshown and page.evaluate("() => window.__gsent") == 2 and "gm-trash" not in page.evaluate("() => JSON.stringify(window.mh.state.curThread.messages.map((m) => m.id))"),
                  f"{name}: in a Gmail conversation with a message in Trash the reply appears too, and the trashed one stays out ({ttop[:60]!r})")
            # 2. moved on before it went: the screen stays where the user went, and the reply is there on return
            page.evaluate("([tid]) => { const tr = window.__mock.routes['GET /api/threads/' + tid]; tr.messages = tr.messages.filter((m) => m.id !== 'm-out'); }", [TID])
            page.evaluate("([k]) => { window.mh.prerendered.delete(k); }", [KEY]); page.evaluate(OPEN, [KEY])
            page.fill("#rtext", "Second reply, sent then left"); page.click("#rsend"); page.evaluate(OPEN, [KEY2]); preview.settle(page, 1500)
            stayed = page.evaluate("() => window.mh.state.cur")
            page.evaluate(OPEN, [KEY]); preview.settle(page, 300)
            check(stayed == KEY2 and "Second reply, sent then left" in page.evaluate(TOP), f"{name}: moved to another conversation, the screen stays there ({stayed}) and the reply is there on return")
            # 3. writing a second reply while the first goes: not wiped
            page.fill("#rtext", "Third reply"); page.click("#rsend"); page.wait_for_timeout(50); page.fill("#rtext", "a draft I am still writing"); preview.settle(page, 1500)
            check(page.input_value("#rtext") == "a draft I am still writing", f"{name}: a reply being written is not wiped when the previous one goes ({page.input_value('#rtext')!r})")
            check(not errs, f"{name}: no page errors {errs[:2]}")
            b.close()
    srv.shutdown(); return out

run(preview.BUNDLE, "")
if preview.CONTROL: run(OLD_BUNDLE, "(control)", control=True)
else: preview.control_skipped("sentshows.py")
print(f"{len(fails)} failed" if fails else "all sent-reply checks passed")
sys.exit(1 if fails else 0)
