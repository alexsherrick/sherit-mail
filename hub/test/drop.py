#!/usr/bin/env python3
"""Drag files onto a draft, and send a blank reply (Dropping a file onto a reply did not attach it, and an
empty reply was refused). Covered, on WebKit (the Mac
app) and Chromium (Windows):
- a file dropped on the reading pane is attached to the reply, and a second drop adds to the first;
- a drag over a mail body lands on the page: the frames take no pointer events during a file drag (WebKit runs none of the page's
  listeners inside a sandboxed frame), and in Chromium the frame's own document forwards it as well;
- in Chromium, a REAL drag (DevTools Input.dispatchDragEvent: real hit testing, real drop effect, and the browser's own default if
  nothing claims the drop) onto a mail body attaches the file, and one onto the list with no draft open leaves the app in place;
- Send with nothing typed sends the reply with its files, and then the reply's files are emptied and the label reset;
- a drop with no draft to take it is refused (never left to the browser, which would replace the app with the file);
- with the compose window open, a drop goes to it, and a fresh compose starts with no files;
- on a phone, a drop on the conversation opens the reply sheet;
- Undo on a sent reply, a sent new message and a sent hub forward puts the draft back WITH its files, and a forward stays a forward;
 
- Undo on a Gmail reply gives the box back only what was typed, not the quote the send appended.
A DataTransfer made by script ignores writes to dropEffect (Chromium and WebKit both read back "none"), so the synthetic checks
assert the claim and the highlight, and the real Chromium drag asserts what the drop did.
Usage: python3 test/drop.py (exit 1 on any failed check)"""
import sys, os, tempfile
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
# Since drafts a conversation opened again brings back its unsent reply, files included. A fresh reply is an emptied one:
# emptied, the reply's draft is deleted, and the conversation then opens with nothing in the box.
FRESH = """async (k) => { const t = document.querySelector('#rtext'), i = document.querySelector('#rfiles'); t.value = ''; i.value = ''; i.dispatchEvent(new Event('change')); await window.mh.draftFlush('r'); await window.mh.openThread(k); }"""
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
# Fires dragover then drop at an element (in this document or in a frame's), with one file per name, as a drag from Finder does.
DROP = """([sel, names, inFrame, dropIt]) => {
  let el = document.querySelector(sel);
  if (inFrame) { const fr = document.querySelector('#msgs iframe'); if (!fr || !fr.contentDocument || !fr.contentDocument.body) return { noframe: true }; el = fr.contentDocument.body; }
  if (!el) return { missing: sel };
  const dt = new DataTransfer(); for (const n of names) dt.items.add(new File(['hello ' + n], n, { type: 'text/plain' }));
  const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }); el.dispatchEvent(over);
  const lit = !!document.querySelector('.dropping'), effect = dt.dropEffect;
  let dropPrevented = null;
  if (dropIt) { const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }); el.dispatchEvent(drop); dropPrevented = drop.defaultPrevented; }
  return { overPrevented: over.defaultPrevented, lit, effect, dropPrevented, litAfter: !!document.querySelector('.dropping') };
}"""
FILES = "(sel) => [...document.querySelector(sel).files].map((f) => f.name)"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        keys = page.evaluate("() => [...document.querySelectorAll('#threads .t')].map((d) => d.dataset.key)")
        # with no conversation open there is no draft: the drop is claimed (so the browser cannot navigate to the file) and refused
        r = page.evaluate(DROP, ["#threads", ["stray.pdf"], False, True])
        check(r["overPrevented"] and r["dropPrevented"] and not r["lit"] and page.evaluate("() => document.querySelector('#rfiles').files.length + document.querySelector('#cfiles').files.length") == 0, f"{name}: with no draft open a drop is claimed and refused ({r})")
        hub = next((k for k in keys if k.startswith("hub|")), keys[0])
        page.evaluate("(k) => window.mh.openThread(k)", hub); page.wait_for_function("() => !!window.mh.state.replyTo", timeout=10000); preview.settle(page, 500)
        check(page.evaluate(FILES, "#rfiles") == [] and page.text_content("#rfilesn") == "Attach", f"{name}: the reply starts with no files")
        r = page.evaluate(DROP, ["#msgs", ["drawing.pdf"], False, False])
        check(r["overPrevented"] and r["lit"], f"{name}: dragging over the conversation lights it as a drop target ({r})")
        passthru = page.evaluate("""() => { const fr = document.querySelector('#msgs iframe'); if (!fr) return null; const b = fr.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + Math.min(b.height / 2, 60);
          const hit = document.elementFromPoint(x, y); return { tag: hit && hit.tagName, inView: !!(hit && hit.closest('section.view')), drag: document.documentElement.classList.contains('filedrag') }; }""")
        check(bool(passthru) and passthru["drag"] and passthru["tag"] != "IFRAME" and passthru["inView"], f"{name}: during a file drag a point over a mail body hits the page, not the mail's frame ({passthru})")
        preview.settle(page, 400)
        check(not page.evaluate("() => !!document.querySelector('.dropping') || document.documentElement.classList.contains('filedrag')"), f"{name}: the highlight goes when the drag leaves, and the mails take clicks again")
        check(page.evaluate("""() => { const fr = document.querySelector('#msgs iframe'), b = fr.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 60)) === fr; }"""), f"{name}: and a point over the mail hits its frame again (links and selection work)")
        r = page.evaluate(DROP, ["#msgs", ["drawing.pdf"], False, True])
        check(r["dropPrevented"] and not r["litAfter"] and page.evaluate(FILES, "#rfiles") == ["drawing.pdf"], f"{name}: a file dropped on the conversation is attached to the reply ({page.evaluate(FILES, '#rfiles')})")
        check(page.text_content("#rfilesn") == "1 file", f"{name}: and the Attach label says so ({page.text_content('#rfilesn')!r})")
        page.evaluate(DROP, ["#rtext", ["a.txt", "b.txt"], False, True])
        check(page.evaluate(FILES, "#rfiles") == ["drawing.pdf", "a.txt", "b.txt"] and page.text_content("#rfilesn") == "3 files", f"{name}: a second drop adds to the first ({page.evaluate(FILES, '#rfiles')})")
        nfiles = 3
        if name == "chromium":   # WebKit runs no page listener inside the frame (the pass-through above covers it there)
            r = page.evaluate(DROP, [None, ["inframe.png"], True, True])
            check(not r.get("noframe") and r["overPrevented"] and page.evaluate(FILES, "#rfiles")[-1:] == ["inframe.png"], f"{name}: a drop delivered inside a mail's frame is attached too ({r})")
            nfiles = 4
        # Send with nothing typed: it goes, carrying the files
        page.evaluate("() => { window.__sent = null; const q = window.mh.queue, add = q.add.bind(q); q.add = async (row) => { if (row.op === 'send') { window.__sent = row; return { key: 'test' }; } return add(row); }; }")
        page.fill("#rtext", ""); page.click("#rsend"); preview.settle(page, 600)
        sent = page.evaluate("() => window.__sent && { text: window.__sent.args.draft.text, files: window.__sent.args.draft.attachments.map((a) => a.filename), replyTo: window.__sent.args.replyTo || null }")
        check(bool(sent) and sent["text"] == "" and len(sent["files"]) == nfiles, f"{name}: Send with nothing typed sends the reply and its files ({sent})")
        check(page.evaluate(FILES, "#rfiles") == [] and page.text_content("#rfilesn") == "Attach", f"{name}: after sending, the reply's files are emptied and the label reset ({page.evaluate(FILES, '#rfiles')})")
        check(not page.evaluate("() => [...document.querySelectorAll('.toast')].some((t) => /Empty reply/.test(t.textContent))"), f"{name}: no 'Empty reply' refusal")
        page.click("#toast button"); preview.settle(page, 800)
        check(page.evaluate(FILES, "#rfiles") == sent["files"] and page.input_value("#rtext") == "", f"{name}: Undo puts the reply back with its files ({page.evaluate(FILES, '#rfiles')})")
        check(page.text_content("#rfilesn") == f"{nfiles} files", f"{name}: and the label counts them ({page.text_content('#rfilesn')!r})")
        page.evaluate(FRESH, hub); preview.settle(page, 400)   # a fresh reply for what follows
        # compose takes every drop while it is open, and leaves the reply alone
        page.click("#composeBtn"); preview.settle(page, 300)
        r = page.evaluate(DROP, ["#cmodal", ["quote.xlsx"], False, True])
        check(r["dropPrevented"] and page.evaluate(FILES, "#cfiles") == ["quote.xlsx"] and page.evaluate(FILES, "#rfiles") == [], f"{name}: with compose open the drop goes to the new message ({page.evaluate(FILES, '#cfiles')})")
        check(page.text_content("#cfilesn") == "1 file", f"{name}: and compose's label says so")
        page.click("#ccancel"); preview.settle(page, 200)
        if page.is_visible("#ask"):
            btns = page.query_selector_all("#ask button")
            if btns: btns[-1].click(); preview.settle(page, 200)
        page.evaluate("() => { document.querySelector('#cmodal').classList.remove('on'); }")
        page.click("#composeBtn"); preview.settle(page, 300)
        check(page.evaluate(FILES, "#cfiles") == [] and page.text_content("#cfilesn") == "Attach", f"{name}: a fresh compose starts with no files and says 'Attach' ({page.text_content('#cfilesn')!r})")
        # Undo on a new message: back with its file
        page.fill("#cto", "someone@example.com"); page.fill("#csub", "the drawing"); page.evaluate(DROP, ["#cmodal", ["c.pdf"], False, True])
        page.click("#csend"); preview.settle(page, 600)
        csent = page.evaluate("() => window.__sent && window.__sent.args.draft.attachments.map((a) => a.filename)")
        check(csent == ["c.pdf"] and not page.evaluate("() => document.querySelector('#cmodal').classList.contains('on')"), f"{name}: a new message is sent with its dropped file ({csent})")
        page.click("#toast button"); preview.settle(page, 600)
        check(page.evaluate("() => document.querySelector('#cmodal').classList.contains('on')") and page.evaluate(FILES, "#cfiles") == ["c.pdf"] and page.input_value("#csub") == "the drawing", f"{name}: Undo puts the new message back with its file ({page.evaluate(FILES, '#cfiles')})")
        page.evaluate("() => { document.querySelector('#cmodal').classList.remove('on'); }")
        # Undo on a hub forward: still a forward (the hub attaches the original's files), with its subject and its own file
        page.click('#actions button[data-act="forward"]'); preview.settle(page, 300)
        page.fill("#cto", "someone@example.com"); page.evaluate(DROP, ["#cmodal", ["note.txt"], False, True]); subj = page.input_value("#csub")
        page.click("#csend"); preview.settle(page, 600)
        fwd = page.evaluate("() => window.__sent && window.__sent.args.forwardOf || null")
        page.click("#toast button"); preview.settle(page, 600)
        back = page.evaluate("() => ({ fwd: window.mh.state.fwd && window.mh.state.fwd.m.id, kind: window.mh.state.fwd && window.mh.state.fwd.t.kind })")
        check(bool(fwd) and back["fwd"] == fwd and back["kind"] == "hub" and page.evaluate(FILES, "#cfiles") == ["note.txt"] and page.input_value("#csub") == subj, f"{name}: Undo on a forward reopens it as the same forward, with its subject and file ({fwd}, {back}, {page.input_value('#csub')!r})")
        page.click("#csend"); preview.settle(page, 600)
        check(page.evaluate("() => window.__sent && window.__sent.args.forwardOf") == fwd, f"{name}: and sending it again forwards the original")
        page.evaluate("() => { document.querySelector('#cmodal').classList.remove('on'); document.querySelector('#toast').style.display = 'none'; }")
        gk = next((k for k in keys if not k.startswith("hub|")), None)
        if not gk: check(False, f"{name}: the mock has a Gmail conversation to reply to")
        else:
            page.evaluate("(k) => window.mh.openThread(k)", gk); page.wait_for_function("() => !!window.mh.state.replyTo", timeout=10000); preview.settle(page, 400)
            page.fill("#rtext", "Sounds good, thanks"); page.click("#rsend"); preview.settle(page, 600)
            g = page.evaluate("() => window.__sent && { gmail: window.__sent.args.gmail, text: window.__sent.args.draft.text }")
            check(bool(g) and g["gmail"] and g["text"].startswith("Sounds good, thanks") and "wrote:" in g["text"], f"{name}: a Gmail reply goes with the quote appended ({(g or {}).get('text', '')[:60]!r})")
            page.click("#toast button"); preview.settle(page, 800)
            check(page.input_value("#rtext") == "Sounds good, thanks", f"{name}: Undo gives the box back only what was typed ({page.input_value('#rtext')[:60]!r})")
            page.click("#rsend"); preview.settle(page, 600)
            g2 = page.evaluate("() => window.__sent && window.__sent.args.draft.text")
            check(g2 is not None and g2.count("wrote:") == 1, f"{name}: and sending it again quotes the original once ({(g2 or '').count('wrote:')})")
            page.evaluate("() => { document.querySelector('#toast').style.display = 'none'; }")
            page.evaluate(FRESH, hub); preview.settle(page, 400)
        if name == "chromium":
            real = os.path.join(tempfile.mkdtemp(), "real-drop.txt"); open(real, "w").write("dropped from the desktop")
            cdp = page.context.new_cdp_session(page); url0 = page.url
            def drag(x, y):
                data = {"items": [], "files": [real], "dragOperationsMask": 1}
                for kind in ("dragEnter", "dragOver"): cdp.send("Input.dispatchDragEvent", {"type": kind, "x": x, "y": y, "data": data})
                cdp.send("Input.dispatchDragEvent", {"type": "drop", "x": x, "y": y, "data": data}); preview.settle(page, 500)
            fb = page.evaluate("() => { const b = document.querySelector('#msgs iframe').getBoundingClientRect(); return [b.left + b.width / 2, b.top + Math.min(b.height / 2, 60)]; }")
            drag(*fb)
            check(page.evaluate(FILES, "#rfiles") == ["real-drop.txt"] and page.url == url0, f"{name}: a real drag onto a mail body attaches the file to the reply ({page.evaluate(FILES, '#rfiles')}, {page.url})")
            page.reload(); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 600)
            cdp = page.context.new_cdp_session(page)
            lb = page.evaluate("() => { const b = document.querySelector('#threads').getBoundingClientRect(); return [b.left + b.width / 2, b.top + 80]; }")
            drag(*lb)
            alive = page.evaluate("() => !!window.mh && location.href")
            check(alive == url0 and page.evaluate(FILES, "#rfiles") == [], f"{name}: a real drag onto the list with no draft open leaves the app in place ({alive})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
    # a phone: the reply is a sheet, closed until asked for; a drop on the conversation opens it
    b = pw.chromium.launch(); ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True); page = ctx.new_page()
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    keys = page.evaluate("() => [...document.querySelectorAll('#threads .t')].map((d) => d.dataset.key)")
    page.evaluate("(k) => window.mh.openThread(k)", next((k for k in keys if k.startswith("hub|")), keys[0])); page.wait_for_function("() => !!window.mh.state.replyTo", timeout=10000); preview.settle(page, 400)
    closed = not page.evaluate("() => document.querySelector('#app').classList.contains('replying')")
    page.evaluate(DROP, ["#msgs", ["photo.jpg"], False, True]); preview.settle(page, 300)
    check(closed and page.evaluate("() => document.querySelector('#app').classList.contains('replying')") and page.evaluate(FILES, "#rfiles") == ["photo.jpg"], "phone: a drop on the conversation opens the reply sheet with the file attached")
    b.close()
srv.shutdown()
print("all drop checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
