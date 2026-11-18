#!/usr/bin/env python3
"""Done marks the conversation read, wherever it is pressed (An unread conversation marked Done stayed
unread until Done was pressed again). It used to archive only, outside the Unread view. Covered, on WebKit (the Mac app)
and Chromium (Windows):
- the row's Done button, the toolbar's Done, the `e` key and Done on a selection all send "done" (archive AND read), and the row is
  read at once;
- Undo puts back exactly what Done changed, as one "put" to the state before:
  an unread inbox conversation comes back unread, a read one comes back read (the old "undone" made it unread), and an archived
  unread one in the Unread view comes back archived and unread (it used to land in the inbox).
Usage: python3 test/done.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
G1, H2, H3, H4, H1, G3 = ("sam.owner.sxsw@gmail.com|g1", "hub|22222222-2222-2222-2222-222222222222", "hub|33333333-3333-3333-3333-333333333333",
                          "hub|44444444-4444-4444-4444-444444444444", "hub|11111111-1111-1111-1111-111111111111", "sam.owner.sxsw@gmail.com|g3")
CAPTURE = "() => { window.__rows = []; const q = window.mh.queue; q.add = async (row) => { window.__rows.push(JSON.parse(JSON.stringify(row))); return { key: 'cap' + window.__rows.length }; }; }"
LAST = "() => { const r = window.__rows[window.__rows.length - 1]; return r ? { op: r.op, action: r.args.action, undo: !!r.args.undo, keys: r.args.keys || null, target: r.args.target ? { state: r.args.target.state, unread: !!r.args.target.unread } : null } : null; }"
DONE_ROW = "() => window.__rows.some((r) => r.op === 'thread' && r.args.action === 'done')"
T = "(k) => { const t = window.mh.state.threads.get(k); return { state: t.state, unread: t.unread }; }"
def undo(page): page.click("#toast button"); preview.settle(page, 300)
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(CAPTURE)
        # the row's Done button on an unread Gmail conversation, never opened
        check(page.evaluate(T, G1) == {"state": "inbox", "unread": True}, f"{name}: the Gmail conversation starts unread in the inbox")
        page.evaluate("(k) => document.querySelector(`.t[data-key=\"${k}\"] .quick [data-q=archive]`).click()", G1); preview.settle(page, 300)
        last = page.evaluate(LAST)
        check(last["op"] == "thread" and last["action"] == "done" and not last["undo"] and page.evaluate(T, G1) == {"state": "archived", "unread": False},
              f"{name}: the row's Done archives it AND marks it read ({last}, {page.evaluate(T, G1)})")
        undo(page); last = page.evaluate(LAST)
        check(last["action"] == "put" and last["undo"] and last["target"] == {"state": "inbox", "unread": True} and page.evaluate(T, G1) == {"state": "inbox", "unread": True}, f"{name}: Undo brings an unread one back unread ({last}, {page.evaluate(T, G1)})")
        # the toolbar's Done on a conversation already read
        page.evaluate("(k) => window.mh.openThread(k)", H2); preview.settle(page, 400); page.evaluate(CAPTURE)
        page.click('#actions button[data-act="archive"]'); preview.settle(page, 300); last = page.evaluate(LAST)
        check(last["action"] == "done" and page.evaluate(T, H2) == {"state": "archived", "unread": False}, f"{name}: the toolbar's Done sends done ({last})")
        undo(page); last = page.evaluate(LAST)
        check(last["action"] == "put" and last["target"] == {"state": "inbox", "unread": False} and page.evaluate(T, H2) == {"state": "inbox", "unread": False}, f"{name}: Undo brings a read one back READ, to the inbox ({last}, {page.evaluate(T, H2)})")
        # the e key
        page.evaluate("(k) => window.mh.openThread(k)", H3); preview.settle(page, 400); page.evaluate(CAPTURE)
        page.evaluate("() => document.activeElement && document.activeElement.blur()"); page.keyboard.press("e"); preview.settle(page, 300)
        check(page.evaluate(DONE_ROW), f"{name}: the e key sends done ({page.evaluate(LAST)})")   # the next conversation then opens, and its read is queued after
        # Done on a selection
        page.evaluate(CAPTURE)
        page.evaluate("([a, c]) => { window.mh.state.checked = new Set([a, c]); document.querySelector('#selbar [data-bulk=archive]').click(); }", [H4, H1]); preview.settle(page, 500)
        last = page.evaluate(LAST)
        check(bool(last) and last["op"] == "bulk" and last["action"] == "done" and page.evaluate(T, H4)["unread"] is False and page.evaluate(T, H1)["unread"] is False,
              f"{name}: Done on a selection sends done and both are read ({last})")
        # the Unread view lists archived mail: Done then Undo there puts it back archived and unread, not in the inbox
        page.evaluate("(k) => { const t = window.mh.state.threads.get(k); t.state = 'archived'; t.unread = true; }", G3)
        page.evaluate("() => window.mh.setView('unread')"); preview.settle(page, 500); page.evaluate(CAPTURE)
        shown = page.evaluate("(k) => !!document.querySelector(`.t[data-key=\"${k}\"]`)", G3)
        if not shown: check(False, f"{name}: the archived unread conversation is listed in Unread")
        else:
            page.evaluate("(k) => document.querySelector(`.t[data-key=\"${k}\"] .quick [data-q=archive]`).click()", G3); preview.settle(page, 300)
            last = page.evaluate(LAST)
            check(last["action"] == "done" and page.evaluate(T, G3)["unread"] is False, f"{name}: in Unread, Done marks it read ({last})")
            undo(page); last = page.evaluate(LAST)
            check(last["action"] == "put" and last["target"] == {"state": "archived", "unread": True} and page.evaluate(T, G3) == {"state": "archived", "unread": True}, f"{name}: Undo there makes it unread again and leaves it archived ({last}, {page.evaluate(T, G3)})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print("all done checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
