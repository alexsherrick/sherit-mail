#!/usr/bin/env python3
"""A notification for mail the device has not downloaded yet takes the open conversation off screen at once: WebKit and Chromium,
at a phone and a Mac window width.

Reported 2026-10-22: on Android, leaving the app with a conversation open and then tapping a notification left that
conversation on screen. handleParams opened a conversation already on the device at once, but one that was not (new mail, the usual case) loaded
first, and for domain mail nothing closed the conversation that was open: it stayed on screen for the whole load, and for good when
the load failed. Gmail's account switch (setView) already closed it.

With domain conversation A open, a notification for domain conversation N whose download takes 1.5 s:
  - at once, A is no longer on screen or the open conversation, and the list shows;
  - once N arrives it is the open conversation, on screen with its subject;
  - back closes N and ends at the list, and no back press is a no-op;
with a message being written over A: the composer stays on top and N opens beneath it;
with N's download failing: A is not left on screen, and the toast says the conversation could not be opened;
a notification for the conversation already open keeps it on screen throughout.
CONTROL: APP_JS_SRC=<the app.js before the change> fails the first check. Usage: python3 test/notifyopen.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
N = "55555555-5555-5555-5555-555555555555"
STATE = """() => { const app = document.querySelector('#app');
  return { viewing: app.classList.contains('viewing'), compose: document.querySelector('#cmodal').classList.contains('on'), cur: window.mh.state.cur,
    title: document.querySelector('#vtitle').textContent, toast: document.querySelector('#toast')?.textContent || '' }; }"""
# N exists only on the hub: its one-conversation download is held back 1.5 s, as a phone just woken would wait for it.
SLOW = """([id, ok]) => {
  if (ok) window.__mock.routes['GET /api/threads/' + id] = { thread: { id, state: 'inbox', starred: 0, unread: 1, labels: '[]' }, messages: [{ id: 'm5', direction: 'in',
    from_addr: 'carol@example.com', from_name: 'Carol', identity: 'sam@yourdomain.example', to_addrs: [{ address: 'sam@yourdomain.example' }], cc_addrs: [], subject: 'Fresh from the notification',
    body_text: 'new mail', body_html: '', created_at: new Date().toISOString(), attachments: [], message_id: '<n5@example.com>', labels: '[]' }] };
  const f = window.fetch; window.fetch = async (u, o) => { if (String(u).includes('/api/threads/' + id)) { await new Promise((r) => setTimeout(r, 1500)); if (!ok) throw new TypeError('Failed to fetch'); } return f(u, o); }; }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch()
        for label, vp in (("phone", {"width": 390, "height": 844}), ("Mac window", {"width": 1000, "height": 700})):
            for case in ("loads", "with a message being written", "fails", "already open"):
                tag = f"{name} {label} {case}"
                page = b.new_page(viewport=vp); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
                page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
                a = page.evaluate("() => [...window.mh.state.threads.values()].find((x) => x.kind === 'hub' && !x.out && x.state === 'inbox').key")
                page.evaluate("(k) => window.mh.openThread(k)", a); preview.settle(page, 500)
                a_title = page.evaluate(STATE)["title"]
                page.evaluate(SLOW, [N, case != "fails"])
                if case == "with a message being written":
                    page.evaluate("() => { document.querySelector('#composeBtn').click(); document.querySelector('#csub').value = 'Lunch'; document.querySelector('#ctext').value = 'See you at noon'; }"); preview.settle(page, 300)
                target = a.split("|", 1)[1] if case == "already open" else N
                page.evaluate("(u) => { window.mh.openUrl(u); }", f"/?account=hub&thread={target}"); preview.settle(page, 200)
                s = page.evaluate(STATE)
                if case == "already open":
                    check(s["viewing"] and s["cur"] == a and s["title"] == a_title, f"{tag}: the conversation it is for stays on screen ({s['cur']}, {s['title']})")
                    preview.settle(page, 1700); s = page.evaluate(STATE)
                    check(s["viewing"] and s["cur"] == a, f"{tag}: and is still open once everything settles ({s['cur']})")
                    check(not errs, f"{tag}: no page errors {errs[:2]}"); page.close(); continue
                check(s["cur"] != a and not (s["viewing"] and s["title"] == a_title), f"{tag}: at once, the conversation that was open is off screen (cur {s['cur']}, viewing {s['viewing']}, title {s['title']!r})")
                if case == "fails":
                    page.wait_for_function("() => /Couldn't open that conversation/.test(document.querySelector('#toast')?.textContent || '')", timeout=15000)
                    s = page.evaluate(STATE)
                    check(not s["viewing"] and s["cur"] is None, f"{tag}: when the download fails the list shows, not the old mail ({s['cur']}, viewing {s['viewing']})")
                    check(not errs, f"{tag}: no page errors {errs[:2]}"); page.close(); continue
                page.wait_for_function(f"() => window.mh.state.cur === 'hub|{N}'", timeout=8000); preview.settle(page, 300)
                s = page.evaluate(STATE)
                if case == "with a message being written":
                    check(s["compose"], f"{tag}: the composer with a message stays on top")
                    page.evaluate("() => window.mh.back()"); preview.settle(page, 350); s = page.evaluate(STATE)
                    check(not s["compose"] and s["viewing"] and s["cur"] == f"hub|{N}", f"{tag}: back closes the composer and shows the notification's conversation beneath it ({s['cur']})")
                check(s["viewing"] and s["cur"] == f"hub|{N}" and s["title"] == "Fresh from the notification", f"{tag}: once it arrives it is the open conversation, on screen ({s['cur']}, {s['title']!r})")
                dead = 0
                for _ in range(6):
                    before = page.evaluate(STATE); handled = page.evaluate("() => window.mh.back()"); preview.settle(page, 350); after = page.evaluate(STATE)
                    if not handled: break
                    if (before["viewing"], before["compose"], before["cur"]) == (after["viewing"], after["compose"], after["cur"]): dead += 1
                end = page.evaluate(STATE)
                check(dead == 0 and not end["viewing"] and not end["compose"], f"{tag}: back ends at the list, and no back press is a no-op ({dead} did nothing)")
                check(not errs, f"{tag}: no page errors {errs[:2]}")
                page.close()
        b.close()
srv.shutdown()
print("all notification-open checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
