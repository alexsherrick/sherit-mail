#!/usr/bin/env python3
"""The right-click menu on a row in the list (A few quick actions on a mail, such as Spam, without opening it,
for mail that should go at once). Covered here:
- right-clicking a row opens the menu at the pointer, not the mail, and the system's own menu is kept away;
- a domain (hub) row: Trash, Block, Trash all from, Trash mail like this…, More…; no Spam, no Delete unless it mentions…;
- a Gmail row adds Report spam and Delete unless it mentions…; a list mail adds Unsubscribe;
- Trash and Spam act on that row (Gmail is told), with Undo for Trash; Block asks first, then blocks;
- More… opens the full menu; Escape and a click elsewhere close it;
- on a row in a selection of several it acts on all of them;
- a touch's contextmenu (a long press) does not open it.
Usage: python3 test/quickmenu.py"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
G = "sam.owner.sxsw@gmail.com|"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4 && window.mh.state.threads.has('sam.owner.sxsw@gmail.com|g3')", timeout=30000); preview.settle(page, 1200)
        hub = page.evaluate("() => [...window.mh.state.threads.values()].filter((x) => x.kind === 'hub' && !x.out && x.state === 'inbox').map((x) => x.key)")
        row = lambda k: f'#threads .t[data-key="{k}"]'
        items = lambda: page.eval_on_selector_all("#menu [data-qm]", "(bs) => bs.map((b) => b.textContent.trim())")
        menu_on = lambda: page.evaluate("() => document.querySelector('#menu').classList.contains('on')")
        viewing = lambda: page.evaluate("() => document.querySelector('#app').classList.contains('viewing')")
        st = lambda k: page.evaluate("(k) => window.mh.state.threads.get(k)?.state", k)
        # a domain row
        box = page.locator(row(hub[0])).bounding_box()
        page.click(row(hub[0]), button="right", position={"x": 200, "y": 20}); preview.settle(page, 250)
        it = items()
        check(menu_on() and it[0] == "Trash" and any(x.startswith("Block ") for x in it) and any(x.startswith("Trash all from ") for x in it) and "Trash mail like this…" in it and it[-1] == "More…", f"{name}: right-click on a domain row opens the quick menu ({it})")
        check("Spam: trash it and block the sender" in it and "Delete unless it mentions…" in it, f"{name}: domain mail: Spam trashes and blocks, and Delete unless it mentions… ({it})")
        mb = page.locator("#menu").bounding_box()
        check(abs(mb["x"] - (box["x"] + 200)) < 4 and abs(mb["y"] - (box["y"] + 20)) < 4, f"{name}: it opens at the pointer ({round(mb['x'])},{round(mb['y'])} vs {round(box['x'] + 200)},{round(box['y'] + 20)})")
        check(not viewing(), f"{name}: and the mail is not opened")
        page.keyboard.press("Escape"); preview.settle(page, 150)
        check(not menu_on(), f"{name}: Escape closes it")
        page.click(row(hub[0]), button="right", position={"x": 200, "y": 20}); preview.settle(page, 200)
        page.mouse.click(1150, 30); preview.settle(page, 200)
        check(not menu_on(), f"{name}: so does a click elsewhere")
        page.click(row(hub[0]), button="right", position={"x": 200, "y": 20}); preview.settle(page, 200)
        page.click('#menu [data-qm="trash"]'); preview.settle(page, 500)
        toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
        check(st(hub[0]) == "trash" and not menu_on() and not viewing() and "Undo" in toast, f"{name}: Trash trashes that row, with Undo, and opens nothing ({st(hub[0])}, {toast[:60]})")
        page.click("#toast button"); preview.settle(page, 500)
        check(st(hub[0]) == "inbox", f"{name}: Undo brings it back ({st(hub[0])})")
        # a Gmail row
        page.click(row(G + "g3"), button="right", position={"x": 200, "y": 20}); preview.settle(page, 250)
        it = items()
        check("Report spam (Gmail)" in it and "Delete unless it mentions…" in it and any(x.startswith("Unsubscribe from ") for x in it), f"{name}: a Gmail list mail adds Spam, Delete unless it mentions… and Unsubscribe ({it})")
        page.click('#menu [data-qm="more"]'); preview.settle(page, 250)
        full = page.eval_on_selector_all("#menu [data-m]", "(bs) => bs.map((b) => b.textContent.trim())")
        check(menu_on() and any(x.startswith("Mute") for x in full) and any(x.startswith("Rename subject") for x in full), f"{name}: More… opens the full menu ({len(full)} items)")
        page.keyboard.press("Escape"); page.mouse.click(1150, 30); preview.settle(page, 200)
        before = page.evaluate("() => window.__mock.calls.length")
        page.click(row(G + "g2"), button="right", position={"x": 200, "y": 20}); preview.settle(page, 200)
        page.click('#menu [data-qm="spam"]'); preview.settle(page, 800)
        calls = page.evaluate("(n) => window.__mock.calls.slice(n)", before)
        check(st(G + "g2") == "spam" and any("g2/modify" in c or "batchModify" in c for c in calls), f"{name}: Spam reports that Gmail row, and Gmail is told ({st(G + 'g2')}, {[c for c in calls if 'gmail:' in c][:3]})")
        # Block asks, then blocks
        before = page.evaluate("() => window.__mock.calls.length")   # the app's start already posts /api/senders once
        page.click(row(G + "g1"), button="right", position={"x": 200, "y": 20}); preview.settle(page, 200)
        page.click('#menu [data-qm="block"]'); preview.settle(page, 250)
        asked = page.evaluate("() => document.querySelector('#ask.on .msg')?.textContent || ''")
        check("Block alice@example.com?" in asked, f"{name}: Block asks first ({asked[:60]})")
        page.click("#ask.on button.danger"); preview.settle(page, 600)
        after = page.evaluate("(n) => window.__mock.calls.slice(n)", before); blocked = after.count("POST /api/senders")
        check(blocked == 1 and "POST gmail:threads/g1/trash" in after and st(G + "g1") == "trash", f"{name}: then blocks the sender and trashes the mail ({blocked}, {st(G + 'g1')})")
        # a selection of several
        page.evaluate("(ks) => { for (const k of ks) window.mh.state.threads.get(k).state = 'inbox'; window.mh.render(); }", [G + "g1", G + "g2"])
        preview.settle(page, 300)
        page.click(row(hub[1]) + " .av"); page.click(row(G + "g3") + " .av"); preview.settle(page, 200)
        page.click(row(G + "g3"), button="right", position={"x": 200, "y": 20}); preview.settle(page, 200)
        it = items()
        check(it[:1] == ["Trash 2 conversations"] and "Spam: 2" in it, f"{name}: on a selected row it offers the whole selection ({it})")
        page.click('#menu [data-qm="trash"]'); preview.settle(page, 600)
        check(st(hub[1]) == "trash" and st(G + "g3") == "trash" and page.evaluate("() => window.mh.state.checked.size") == 0, f"{name}: and trashes both, clearing the selection ({st(hub[1])}, {st(G + 'g3')})")
        # a touch's long press is not a right-click
        page.evaluate("(sel) => document.querySelector(sel).dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: 300, clientY: 300 }))", row(hub[0]))
        preview.settle(page, 200)
        check(not menu_on(), f"{name}: a touch's contextmenu does not open it")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print("all quick-menu checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
