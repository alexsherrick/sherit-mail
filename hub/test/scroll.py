#!/usr/bin/env python3
"""The list stays exactly where it was: on WebKit as well as Chromium.

Founder, 2026-10-03, in the Mac app: deleting a row further down jumped the list to the top; it should stay exactly where it
was. Three causes, each measured in a real WKWebView (macOS 26.5) before it was fixed:
  1. WebKit drops a scroller to the top when its children are cleared, so every rebuild of the list (render()) lost the offset.
  2. Opening a conversation narrows the list from the full width to 430 px; rows wrap from one line to three, and the same scrollTop
     then showed rows ~20 places earlier: the clicked email fell 1,800 px below the fold.
  3. Rows used content-visibility:auto with a 74 px size estimate. WebKit has no scroll anchoring (overflow-anchor unsupported), so a
     rebuild that swapped real row heights for the estimate moved everything on screen while scrollTop stayed the same.
Checked here by WHERE ROWS ARE ON SCREEN, not by scrollTop alone (cause 3 kept scrollTop identical while the rows moved 32 px).
Usage: python3 test/scroll.py (exit 1 on any failed check; needs `python3 -m playwright install webkit`)"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

ACCT = "sam.owner.sxsw@gmail.com"
SEED = """([acct, n]) => { const S = window.mh.state; const now = Date.now();
  for (let i = 0; i < n; i++) { const id = 'gs' + String(i).padStart(4, '0'); const key = acct + '|' + id;
    S.threads.set(key, { key, kind: 'gmail', account: acct, id, state: 'inbox', unread: true, starred: false, subject: 'row ' + i, fromAddr: 's' + i + '@example.com', fromName: 'Sender ' + i, date: now - (i + 1) * 3600e3 * 3, count: 1, labels: ['INBOX', 'UNREAD'], snippet: 'snippet ' + i });
    window.__mock.routes['POST gmail:threads/' + id + '/trash'] = {}; window.__mock.routes['POST gmail:threads/' + id + '/modify'] = {}; }
  window.mh.prefs().groupSenders = false; }"""
# key -> top of each row relative to the list's top edge, for every row in the DOM
TOPS = """() => { const el = document.querySelector('#threads'); const lt = el.getBoundingClientRect().top; const o = {};
  for (const d of el.querySelectorAll('.t[data-key]')) o[d.dataset.key] = Math.round(d.getBoundingClientRect().top - lt); return o; }"""
VISIBLE = """() => { const el = document.querySelector('#threads'); const lr = el.getBoundingClientRect();
  return [...el.querySelectorAll('.t[data-key]')].filter((d) => { const r = d.getBoundingClientRect(); return r.bottom > lr.top && r.top < lr.bottom; }).map((d) => d.dataset.key); }"""
FRAMES = "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))"   # two frames: late layout counts
MARK = "() => { let n = 0; for (const d of document.querySelectorAll('#threads .t[data-key]')) d.__mark = ++n; }"
SAME = "() => { const ds = [...document.querySelectorAll('#threads .t[data-key]')]; return { was: ds.filter((d) => d.__mark).length + (window.__dropped || 0), same: ds.filter((d) => d.__mark).length }; }"
ARRIVE = """([acct]) => { const id = 'gsnew' + Date.now(); const key = acct + '|' + id; window.mh.state.threads.set(key, { key, kind: 'gmail', account: acct, id, state: 'inbox', unread: true, starred: false, subject: 'just arrived', fromAddr: 'new@example.com', fromName: 'New', date: Date.now(), count: 1, labels: ['INBOX', 'UNREAD'], snippet: 'new' }); }"""
CHANGE_ABOVE = """() => { const el = document.querySelector('#threads'); const lt = el.getBoundingClientRect().top; const above = [...el.querySelectorAll('.t[data-key]')].filter((d) => d.getBoundingClientRect().bottom < lt - 300); const t = window.mh.state.threads.get(above[above.length >> 1].dataset.key); t.subject = t.subject + ' (edited)'; t.count = 3; }"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
def moved(before, after, keys):
    return [(k, before[k], after.get(k)) for k in keys if k in before and (after.get(k) is None or abs(after[k] - before[k]) > 1)]

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        page = b.new_page(viewport={"width": 1280, "height": 792}); errs = []   # the Mac app's window
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(SEED, [ACCT, 180])
        top = lambda: page.evaluate("() => document.querySelector('#threads').scrollTop")
        # 1. Unread with the pane closed: scroll down, click a row in the middle; the pane opens, the list narrows, and the clicked row
        #  stays where it was clicked instead of falling below the fold
        page.evaluate("() => window.mh.setView('unread')"); preview.settle(page, 200)
        page.mouse.move(700, 450); page.mouse.wheel(0, 2400); preview.settle(page, 600)
        key = page.evaluate("""() => { const el = document.querySelector('#threads'); const lr = el.getBoundingClientRect();
          return [...el.querySelectorAll('.t[data-key]')].find((d) => d.getBoundingClientRect().top > lr.top + lr.height / 2 - 40).dataset.key; }""")
        before = page.evaluate(TOPS)[key]
        page.click(f'#threads .t[data-key="{key}"]'); preview.settle(page, 700)
        after_open = page.evaluate(TOPS); vis = page.evaluate(VISIBLE)
        check(top() > 500, f"{name}: the list was scrolled down ({top()}px)")
        check(key in vis and abs(after_open[key] - before) <= 2, f"{name}: the clicked row stays where it was clicked as the pane opens ({before} -> {after_open.get(key)}px, visible: {key in vis})")
        # 2. Trash from the pane: the next row opens and every row above the deleted one is exactly where it was
        above = [k for k in vis if after_open[k] < after_open[key]]
        gone_h = page.evaluate("k => [...document.querySelectorAll('#threads .t[data-key]')].find((d) => d.dataset.key === k).offsetHeight", key)   # the deleted row itself, on screen
        day_h = page.evaluate("() => { const lr = document.querySelector('#threads').getBoundingClientRect(); const d = [...document.querySelectorAll('#threads .day')].find((x) => { const r = x.getBoundingClientRect(); return r.top >= lr.top && r.bottom <= lr.bottom; }); return d ? d.offsetHeight : 30; }")
        page.click('#actions button[data-act="trash"]'); preview.settle(page, 600)
        after_trash = page.evaluate(TOPS); cur = page.evaluate("() => window.mh.state.cur")
        check(page.evaluate("k => window.mh.state.threads.get(k).state", key) == "trash" and cur and cur != key, f"{name}: the row was trashed and the next one opened")
        check(above and not moved(after_open, after_trash, above), f"{name}: every row above the deleted one stays put ({len(above)} rows, moved: {moved(after_open, after_trash, above)[:3]})")
        # the rows below close the gap by exactly the deleted row's height (and a day heading's, if the row was alone under it); a heading
        # between the deleted row and the next one stays, so "takes its place" is only literal when they share a day (2026-10-04 flake)
        up = (after_open.get(cur, 0) - after_trash.get(cur, 0)) if cur in after_trash else None
        check(up is not None and (abs(up - gone_h) <= 1 or abs(up - gone_h - day_h) <= 1), f"{name}: the next row moves up by exactly the deleted row ({up}px; row {gone_h}px, heading {day_h}px)")
        # 3. a re-render of the same list (what every refresh does) moves nothing on screen and REUSES the rows that did not change
        vis = page.evaluate(VISIBLE); page.evaluate(MARK)
        page.evaluate("() => window.mh.render()"); page.evaluate(FRAMES)
        mv = moved(after_trash, page.evaluate(TOPS), vis); kept = page.evaluate(SAME)
        check(not mv, f"{name}: re-rendering the list moves no visible row (moved: {mv[:3]})")
        check(kept["same"] == kept["was"] and kept["was"] > 50, f"{name}: every unchanged row keeps its node ({kept['same']} of {kept['was']})")
        # 4. new mail lands at the top while reading far down, and a row above the viewport changes: nothing visible moves
        before = page.evaluate(TOPS); vis = page.evaluate(VISIBLE)
        page.evaluate(ARRIVE, [ACCT]); page.evaluate("() => window.mh.render()"); page.evaluate(FRAMES)
        mv = moved(before, page.evaluate(TOPS), vis); check(not mv, f"{name}: new mail arriving at the top moves no visible row (moved: {mv[:3]})")
        before = page.evaluate(TOPS); vis = page.evaluate(VISIBLE)
        page.evaluate(CHANGE_ABOVE); page.evaluate("() => window.mh.render()"); page.evaluate(FRAMES)
        mv = moved(before, page.evaluate(TOPS), vis); check(not mv, f"{name}: a row changing above the viewport moves no visible row (moved: {mv[:3]})")
        # 5. deep in the list, past the first 80-row window: a re-render keeps the rows already scrolled into and the place
        for _ in range(8): page.mouse.wheel(0, 2500); preview.settle(page, 250)
        preview.settle(page, 500); deep = page.evaluate(TOPS); vis = page.evaluate(VISIBLE); rows_before = len(deep)
        page.evaluate("() => window.mh.render()"); page.evaluate(FRAMES); deep2 = page.evaluate(TOPS)
        check(rows_before > 80, f"{name}: scrolled past the first window ({rows_before} rows rendered)")
        check(len(deep2) >= rows_before, f"{name}: a re-render deep in the list keeps every row already scrolled into ({rows_before} -> {len(deep2)} rows)")
        mv = moved(deep, deep2, vis); check(not mv, f"{name}: a re-render deep in the list keeps the place (moved: {mv[:2]})")
        # 6. scrolling back up past rows that were never drawn: each step moves the list by exactly the distance scrolled
        jumps = []
        for _ in range(6):
            t0 = page.evaluate(TOPS); k = page.evaluate(VISIBLE)[1]; page.evaluate("() => { document.querySelector('#threads').scrollTop -= 400; }"); page.evaluate(FRAMES); jumps.append(page.evaluate(TOPS)[k] - t0[k] - 400)
        check(all(abs(j) <= 1 for j in jumps), f"{name}: scrolling up moves the rows by exactly the distance scrolled (extra: {jumps})")
        # 6b. AT THE TOP the top is the place: mail arriving while the list is at the top is in view, not pushed above it (
        # back in the app, the newest mail was above the view)
        page.evaluate("() => { document.querySelector('#threads').scrollTop = 0; }"); page.evaluate(FRAMES)
        page.evaluate(ARRIVE, [ACCT]); page.evaluate("() => window.mh.render()"); page.evaluate(FRAMES)
        newest = page.evaluate("() => { const el = document.querySelector('#threads'), lr = el.getBoundingClientRect(), d = el.querySelector('.t[data-key*=\"gsnew\"]'); if (!d) return null; const r = d.getBoundingClientRect(); return { top: el.scrollTop, inView: r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1 }; }")
        check(newest and newest["top"] == 0 and newest["inView"], f"{name}: at the top, new mail arrives in view and the list stays at the top ({newest})")
        # 7. a different view is not handed the old offset (on WebKit it starts at the top, as it always did)
        page.evaluate("() => window.mh.setView('inbox')"); preview.settle(page, 200)
        if name == "webkit": check(top() == 0, f"{name}: switching views still starts at the top ({top()}px)")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
    # 8. Android's layout (Chromium, phone-sized, the list on its own): refreshes and arriving mail move nothing, scrolling up is exact
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=3); page = ctx.new_page()
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    page.evaluate(SEED, [ACCT, 180]); page.evaluate("() => window.mh.setView('unread')"); preview.settle(page, 300)
    for _ in range(10): page.evaluate("() => { document.querySelector('#threads').scrollTop += 1500; }"); preview.settle(page, 150)
    page.evaluate(FRAMES); before = page.evaluate(TOPS); vis = page.evaluate(VISIBLE); page.evaluate(MARK)
    page.evaluate("() => window.mh.render()"); page.evaluate(FRAMES); mv = moved(before, page.evaluate(TOPS), vis); kept = page.evaluate(SAME)
    check(len(before) > 80 and not mv and kept["same"] == kept["was"], f"phone: a refresh deep in the list moves nothing and keeps every row ({len(before)} rows, moved: {mv[:2]}, kept {kept['same']}/{kept['was']})")
    page.evaluate(ARRIVE, [ACCT]); page.evaluate("() => window.mh.render()"); page.evaluate(FRAMES); mv = moved(before, page.evaluate(TOPS), vis)
    check(not mv, f"phone: new mail arriving at the top moves no visible row (moved: {mv[:2]})")
    jumps = []
    for _ in range(6):
        t0 = page.evaluate(TOPS); k = page.evaluate(VISIBLE)[1]; page.evaluate("() => { document.querySelector('#threads').scrollTop -= 400; }"); page.evaluate(FRAMES); jumps.append(page.evaluate(TOPS)[k] - t0[k] - 400)
    check(all(abs(j) <= 1 for j in jumps), f"phone: scrolling up moves the rows by exactly the distance scrolled (extra: {jumps})")
    # at the top the top is the place: after the scroll-up checks, which need the list scrolled down
    page.evaluate("() => { document.querySelector('#threads').scrollTop = 0; }"); page.evaluate(FRAMES); page.evaluate(ARRIVE, [ACCT]); page.evaluate("() => window.mh.render()"); page.evaluate(FRAMES)
    newest = page.evaluate("() => { const el = document.querySelector('#threads'), lr = el.getBoundingClientRect(), ds = [...el.querySelectorAll('.t[data-key*=\"gsnew\"]')]; const d = ds.sort((a, b) => b.dataset.key.localeCompare(a.dataset.key))[0]; const r = d.getBoundingClientRect(); return { top: el.scrollTop, inView: r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1 }; }")
    check(newest["top"] == 0 and newest["inView"], f"phone: at the top, the newest mail arrives in view ({newest})")
    b.close()
srv.shutdown()
print(f"\n{len(fails)} failed" if fails else "\nall passed"); sys.exit(1 if fails else 0)
