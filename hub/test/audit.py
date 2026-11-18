#!/usr/bin/env python3
"""The client half of the 2026-10-07 audit, on WebKit (the Mac app) and Chromium (Windows). Each check failed on the
client before it:
- declining "Send anyway?" leaves the message where it was (it emptied the compose window and the reply box);
- a send that fails for good while another reply is being written waits instead of replacing it;
- Reply unticks a Reply all left from before;
- Gmail: Undo of Trash takes the conversation out of Gmail's Trash (untrash); Undo of Trash from Archive puts it back archived;
- Done on a snoozed conversation cancels the snooze (DELETE ?keep=1), and Undo snoozes it again;
- opening an unread conversation marks it read through the queue; hub reads by prefetch never mark read (keep_unread=1);
- a hub forward sends only the note above the forwarded block, with Bcc, and stays a forward;
- a quote of an HTML-only message is not empty;
- closing the compose window with a message in it keeps it, in Drafts now (it was an 8 s Reopen toast), and it opens from there.
Usage: python3 test/audit.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
H1, H2, H3, H4 = ("hub|11111111-1111-1111-1111-111111111111", "hub|22222222-2222-2222-2222-222222222222", "hub|33333333-3333-3333-3333-333333333333", "hub|44444444-4444-4444-4444-444444444444")
G1 = "sam.owner.sxsw@gmail.com|g1"
CAPTURE = "() => { window.__rows = []; const q = window.mh.queue; q.__add = q.__add || q.add.bind(q); q.add = async (row) => { window.__rows.push(JSON.parse(JSON.stringify(row))); return { key: 'cap' + window.__rows.length }; }; }"
RELEASE = "() => { const q = window.mh.queue; if (q.__add) q.add = q.__add; }"
T = "(k) => { const t = window.mh.state.threads.get(k); return { state: t.state, unread: t.unread }; }"
def calls(page): return page.evaluate("() => window.__mock.calls.slice()")
def open_thread(page, k): page.evaluate("(k) => window.mh.openThread(k)", k); page.wait_for_function("() => !!window.mh.state.replyTo", timeout=10000); preview.settle(page, 300)
def cancel_ask(page): page.wait_for_selector("#ask button", timeout=3000); page.evaluate("() => [...document.querySelectorAll('#ask button')].find((b) => b.textContent === 'Cancel').click()"); preview.settle(page, 300)
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        # hub reads that are not the user opening a conversation never mark it read
        plain = [c for c in calls(page) if c.startswith("GET /api/threads/") and len(c.split("/api/threads/")[1]) == 36]
        check(not plain and any("keep_unread=1" in c for c in calls(page)), f"{name}: prefetched hub conversations are read with keep_unread=1 ({len(plain)} plain reads)")
        # opening an unread conversation marks it read through the queue
        page.evaluate(CAPTURE); open_thread(page, H1)
        rows = page.evaluate("() => window.__rows.map((r) => r.op + ':' + r.args.action)")
        check("thread:read" in rows and page.evaluate(T, H1)["unread"] is False, f"{name}: opening an unread conversation queues its read ({rows})")
        page.evaluate(RELEASE)
        # declining "Send anyway?" leaves the reply where it was
        page.fill("#rtext", "Draft A"); page.evaluate("() => { window.mh.state.maybeSent = { at: Date.now() }; }")
        page.click("#rsend"); cancel_ask(page)
        check(page.input_value("#rtext") == "Draft A", f"{name}: declining 'Send anyway?' keeps the reply ({page.input_value('#rtext')!r})")
        page.click("#composeBtn"); preview.settle(page, 200); page.fill("#cto", "x@example.com"); page.fill("#csub", "Kept"); page.fill("#ctext", "Body kept")
        page.evaluate("() => { window.mh.state.maybeSent = { at: Date.now() }; }"); page.click("#csend"); cancel_ask(page)
        check(page.evaluate("() => document.querySelector('#cmodal').classList.contains('on')") and page.input_value("#csub") == "Kept" and page.input_value("#ctext") == "Body kept", f"{name}: and keeps the new message, open")
        page.evaluate("() => { window.mh.state.maybeSent = null; }")
        # closing the compose window with a message in it keeps it: in Drafts, opened from there as it was
        page.click("#ccancel"); preview.settle(page, 300)
        shut = not page.evaluate("() => document.querySelector('#cmodal').classList.contains('on')"); said = page.inner_text("#toast")
        page.evaluate("() => { const d = [...window.mh.draftStore.map.values()].find((x) => !x.deleted && x.subject === 'Kept'); if (d) window.mh.openDraft(d.id); }"); preview.settle(page, 500)
        check(shut and "Saved to Drafts" in said and page.evaluate("() => document.querySelector('#cmodal').classList.contains('on')") and page.input_value("#csub") == "Kept" and page.input_value("#ctext") == "Body kept", f"{name}: closing it keeps the message in Drafts, and it opens from there as it was ({said!r})")
        page.evaluate("() => { document.querySelector('#ctext').value = ''; document.querySelector('#csub').value = ''; document.querySelector('#cto').value = ''; }"); page.click("#ccancel"); preview.settle(page, 200)
        # Reply unticks a Reply all left from before
        page.evaluate("() => document.querySelector('#actions [data-act=replyall]').click()"); page.wait_for_timeout(100); was = page.is_checked("#rall")
        page.evaluate("() => document.querySelector('#actions [data-act=reply]').click()"); page.wait_for_timeout(100)
        check(was and not page.is_checked("#rall"), f"{name}: Reply unticks Reply all (was {was}, now {page.is_checked('#rall')})")
        # a send that fails for good while another reply is being written waits instead of replacing it
        page.fill("#rtext", "Reply A"); page.click("#rsend"); preview.settle(page, 200)
        page.evaluate("() => { window.__mock.failNext = { match: /^POST \\/api\\/messages\\/.*\\/reply/, status: 400, body: { error: 'message exceeds the 5 MiB limit' } }; }")
        open_thread(page, H4); page.fill("#rtext", "B in progress"); preview.settle(page, 7000)
        cur = page.evaluate("() => window.mh.state.cur"); waiting = page.evaluate("() => (window.mh.state.unsent || []).length")
        check(cur == H4 and page.input_value("#rtext") == "B in progress" and waiting == 1, f"{name}: a failed send waits while another reply is being written (cur {cur == H4}, box {page.input_value('#rtext')!r}, waiting {waiting})")
        page.fill("#rtext", ""); page.evaluate("() => { window.mh.state.unsent = []; }")
        # a hub forward: only the note goes, with Bcc, and it is a forward
        page.evaluate(CAPTURE); open_thread(page, H2)
        page.evaluate("() => document.querySelector('#actions [data-act=forward]').click()"); preview.settle(page, 300)
        page.fill("#cto", "dave@example.com"); page.fill("#cbcc", "boss@example.com")
        page.evaluate("() => { const t = document.querySelector('#ctext'); t.value = 'Please look.' + t.value; }")
        page.click("#csend"); preview.settle(page, 500)
        fw = page.evaluate("() => { const r = window.__rows.find((x) => x.op === 'send'); return r && { fwd: !!r.args.forwardOf, text: r.args.draft.text, bcc: r.args.draft.bcc }; }")
        check(bool(fw) and fw["fwd"] and "Forwarded message" not in (fw["text"] or "") and (fw["text"] or "").startswith("Please look.") and "boss@example.com" in (fw["bcc"] or []), f"{name}: a hub forward sends only the note, with Bcc ({fw})")
        page.evaluate(RELEASE); page.evaluate("() => document.querySelector('#toast').style.display = 'none'")
        # Undo of Trash from Archive puts it back archived (it went to the inbox)
        page.evaluate("(k) => { const t = window.mh.state.threads.get(k); t.state = 'archived'; }", H3); page.evaluate("() => window.mh.setView('archived')"); preview.settle(page, 300)
        page.evaluate(CAPTURE); page.evaluate("(k) => window.mh.act(window.mh.state.threads.get(k), 'trash')", H3); preview.settle(page, 300); page.click("#toast button"); preview.settle(page, 300)
        last = page.evaluate("() => { const r = window.__rows[window.__rows.length - 1]; return r && { action: r.args.action, target: r.args.target && r.args.target.state }; }")
        check(last == {"action": "put", "target": "archived"} and page.evaluate(T, H3)["state"] == "archived", f"{name}: Undo of Trash from Archive puts it back archived ({last})")
        page.evaluate(RELEASE); page.evaluate("() => window.mh.setView('inbox')"); preview.settle(page, 300)
        # Gmail: Undo of Trash leaves Gmail's Trash (untrash)
        c0 = len(calls(page))
        page.evaluate("(k) => window.mh.act(window.mh.state.threads.get(k), 'trash')", G1); preview.settle(page, 600)
        page.evaluate("() => { const th = window.__mock.routes['GET gmail:threads/g1?']; if (th && th.messages) th.messages.forEach((m) => { m.labelIds = ['TRASH', 'UNREAD']; }); }")
        page.click("#toast button"); preview.settle(page, 1500)
        new = calls(page)[c0:]
        check("POST gmail:threads/g1/untrash" in new, f"{name}: Gmail Undo of Trash calls untrash ({[c for c in new if 'g1' in c]})")
        # Done on a snoozed conversation cancels the snooze; Undo snoozes it again
        page.evaluate("(k) => { const t = window.mh.state.threads.get(k); t.state = 'snoozed'; window.mh.state.schedules.push({ id: 'sch-test', kind: 'snooze', account: 'hub', ref: t.id, due_at: new Date(Date.now() + 86400e3).toISOString() }); window.__mock.routes['DELETE /api/schedule/sch-test?keep=1'] = { ok: true, kind: 'snooze', account: 'hub', ref: t.id }; window.__mock.routes['POST /api/schedule'] = { id: 'sch-again' }; }", H4)
        page.evaluate(CAPTURE); c1 = len(calls(page))
        page.evaluate("(k) => window.mh.act(window.mh.state.threads.get(k), 'archive')", H4); preview.settle(page, 400)
        check("DELETE /api/schedule/sch-test?keep=1" in calls(page)[c1:], f"{name}: Done on a snoozed conversation cancels its snooze, keeping the action's say ({[c for c in calls(page)[c1:] if 'schedule' in c]})")
        page.evaluate(RELEASE)
        # the hub has it archived now (Done); the put back and the new snooze are answered
        page.evaluate("(k) => { const id = window.mh.state.threads.get(k).id; const g = window.__mock.routes['GET /api/threads/' + id]; if (g && g.thread) g.thread.state = 'archived'; window.__mock.routes['PATCH /api/threads/' + id] = { ok: true }; }", H4)
        page.click("#toast button"); preview.settle(page, 1500)
        check("POST /api/schedule" in calls(page)[c1:] and page.evaluate(T, H4)["state"] == "snoozed", f"{name}: Undo snoozes it again ({page.evaluate(T, H4)})")
        # a quote of an HTML-only message is not empty
        q = page.evaluate("() => window.mh.plainOf({ html: '<div>Hello <b>there</b></div><p>Second line</p><style>p{}</style>' })")
        check("Hello there" in q and "Second line" in q and "p{}" not in q, f"{name}: an HTML-only message quotes as text ({q!r})")
        check(not [e for e in errs if "unmocked" not in e], f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print("all audit checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
