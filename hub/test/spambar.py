#!/usr/bin/env python3
"""The action bar after a spam conversation (After one Not spam, every conversation opened next kept the Not spam
button). syncActionBar found the Restore button by its data-act and then rewrote that data-act to "notspam" on a spam conversation,
so the next conversation's lookup came back null and threw: the bar kept "Not spam", and openThread stopped before the body, so the
new title sat over the previous conversation's message. The data-act now stays "restore"; the click makes it notspam on spam. This test opens spam, then inbox, archived, trash and spam again, on WebKit
and Chromium, and checks after each:
- the button reads "Not spam" on spam only, "Restore" on archived and trash, and is hidden in the inbox;
- its data-act stays "restore", the key syncActionBar finds it by;
- the open conversation is the one asked for (openThread ran to the end);
- openThread does not throw, and there is no page error;
- clicked, it queues notspam on spam and restore on trash and archived (test/actions.py checks what each of those sends).
Usage: python3 test/spambar.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
STEPS = ["spam", "inbox", "archived", "trash", "spam", "inbox"]
WANT = {"spam": ("Not spam", True), "inbox": (None, False), "archived": ("Restore", True), "trash": ("Restore", True)}
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        keys = page.evaluate("() => [...window.mh.state.threads.keys()].slice(0, 6)")
        bad = []
        for i, st in enumerate(STEPS):
            key = keys[i % len(keys)]
            got = page.evaluate("""async ([k, st]) => {
              const t = window.mh.state.threads.get(k); t.state = st;
              let err = null; try { await window.mh.openThread(k); } catch (e) { err = String(e); }
              const bs = [...document.querySelectorAll('#actions button')].filter((x) => /Not spam|Restore/.test(x.textContent));
              const btn = bs[0];
              return { n: bs.length, label: btn ? btn.textContent.trim() : null, shown: btn ? btn.style.display !== 'none' : false,
                       act: btn ? btn.dataset.act : null, open: window.mh.state.curThread && window.mh.state.curThread.key, err };
            }""", [key, st])
            label, shown = WANT[st]
            ok = got["n"] == 1 and got["shown"] == shown and (not shown or got["label"] == label) and got["act"] == "restore" and got["open"] == key and not got["err"]
            if not ok: bad.append((i, st, got))
        check(not bad, f"{name}: spam -> inbox -> archived -> trash -> spam -> inbox: the button and the open conversation follow each one ({bad[:2]})")
        # the click: what it queues (test/actions.py checks what each queued action sends). Rows are captured, not sent: a row added while
        # an earlier drain is still running waits for the next kick, which made a network check here flaky.
        page.evaluate("() => { window.__rows = []; const q = window.mh.queue; q.__add = q.__add || q.add.bind(q); q.add = async (row) => { window.__rows.push(JSON.parse(JSON.stringify(row))); return { key: 'cap' + window.__rows.length }; }; }")
        clicks = {}
        for st in ("spam", "trash", "archived"):
            key = keys[1]
            clicks[st] = page.evaluate("""async ([k, st]) => {
              const t = window.mh.state.threads.get(k); t.state = st; try { await window.mh.openThread(k); } catch (_) {} window.__rows = [];
              document.querySelector('#actions [data-act="restore"]')?.click(); await new Promise((r) => setTimeout(r, 300));
              return { state: t.state, acts: window.__rows.filter((r) => r.threadKey === k).map((r) => r.args.action) };
            }""", [key, st])
        want = {"spam": "notspam", "trash": "restore", "archived": "restore"}
        bad = [(st, c) for st, c in clicks.items() if c["state"] != "inbox" or want[st] not in c["acts"] or ({"notspam", "restore"} - {want[st]}) & set(c["acts"])]
        check(not bad, f"{name}: the button queues notspam on spam and restore on trash and archived, and the conversation is back in the inbox ({bad[:2]})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print("all spam-bar checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
