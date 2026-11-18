#!/usr/bin/env python3
"""Attachments: a click previews what cannot run code, Download is its own action, nothing opens by itself.
Nothing opens by itself: a file could carry a virus, and Gmail does the same. Covered here, in
WebKit (the Mac app) and Chromium, with real bytes:
- a PNG, a PDF (pdf.js, canvas only) and a text file preview; a text file full of markup stays text;
- a file whose name says.png but whose bytes do not is not previewed;
- programs and scripts are held behind a warning: no preview, no fetch, Download only through "Download anyway";
- archives and SVG get no preview and no fetch, with a note;
- Download is a separate action that hands the app or browser a download (never opens anything);
- the Mac app's "saved" and "failed" callbacks show a toast, and "Show in Finder" asks the app, nothing else;
- a name with a right-to-left override is shown without it, and still judged by its real extension.
Usage: python3 test/attview.py (exit 1 on any failed check)"""
import sys, base64, zlib, struct
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def png():
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * 4 for _ in range(4))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
def pdf():
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>"]
    stream = b"0 0 1 rg 20 20 160 160 re f"
    objs.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    out = b"%PDF-1.4\n"; offs = []
    for i, o in enumerate(objs, 1): offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out); out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
def pdf_pages(n):
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % (3 + 2 * k) for k in range(n)), n)]
    for k in range(n):
        stream = b"0 0 1 rg 20 20 160 %d re f" % (40 + k)
        objs += [b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 260] /Contents %d 0 R >>" % (4 + 2 * k), b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"]
    out = b"%PDF-1.4\n"; offs = []
    for i, o in enumerate(objs, 1): offs.append(len(out)); out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out); out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
B = lambda b: base64.b64encode(b).decode()
FILES = {
    "img": {"id": "x-img", "name": "photo.png", "mime": "image/png", "bytes": png()},
    "pdf": {"id": "x-pdf", "name": "spec sheet.pdf", "mime": "application/pdf", "bytes": pdf()},
    "txt": {"id": "x-txt", "name": "notes.txt", "mime": "text/plain", "bytes": b"<script>window.__pwned=1</script>\nline two"},
    "fake": {"id": "x-fake", "name": "holiday.png", "mime": "image/png", "bytes": b"just some words, not an image"},
    "exe": {"id": "x-exe", "name": "setup.exe", "mime": "application/octet-stream", "bytes": b"MZ"},
    "zip": {"id": "x-zip", "name": "files.zip", "mime": "application/zip", "bytes": b"PK\x03\x04"},
    "svg": {"id": "x-svg", "name": "logo.svg", "mime": "image/svg+xml", "bytes": b"<svg onload=alert(1)/>"},
    "rlo": {"id": "x-rlo", "name": "invoice‮fdp.exe", "mime": "application/pdf", "bytes": b"MZ"},
    "lrm": {"id": "x-lrm", "name": "evil.exe" + chr(0x200e), "mime": "application/octet-stream", "bytes": b"MZ"},
    "hidden": {"id": "x-hid", "name": "report.pdf", "mime": "application/pdf", "bytes": b"MZ\x90\x00 a Windows program"},
    "shebang": {"id": "x-sh", "name": "update", "mime": "text/plain", "bytes": b"#!/bin/sh\nrm -rf ~\n"},
    "big": {"id": "x-big", "name": "manual.pdf", "mime": "application/pdf", "bytes": pdf_pages(40)},
    "macro": {"id": "x-mac", "name": "budget.xlsm", "mime": "application/vnd.ms-excel.sheet.macroEnabled.12", "bytes": b"PK\x03\x04"},
}
def files(*keys): return [{"id": FILES[k]["id"], "name": FILES[k]["name"], "mime": FILES[k]["mime"], "size": len(FILES[k]["bytes"]), "url": f"/api/att/{FILES[k]['id']}"} for k in keys]
T = "() => window.mh.state.threads.get('hub|11111111-1111-1111-1111-111111111111')"
OPEN = "([fs, i]) => window.mh.attOpen(window.mh.state.threads.get('hub|11111111-1111-1111-1111-111111111111'), fs, i)"
BODY = "() => { const b = document.querySelector('#avbody'); const p = b.querySelector('.avpanel'); const fr = b.querySelector('iframe.avframe'); return { img: b.querySelector('img.avimg')?.naturalWidth || 0, frame: fr ? { sandbox: fr.getAttribute('sandbox'), pages: +(fr.dataset.pages || 0), drawn: +(fr.dataset.drawn || 0) } : null, text: b.querySelector('pre.avtext')?.textContent ?? null, panel: p ? p.querySelector('.avpt').textContent : null, danger: !!p?.classList.contains('danger'), note: p ? [...p.querySelectorAll('p')].map((x) => x.textContent).join(' | ') : '', go: p?.querySelector('.avgo')?.textContent || null, dlHidden: document.querySelector('#avdl').hidden, scripts: b.querySelectorAll('script').length }; }"
FETCHED = "(id) => window.__mock.calls.filter((c) => c.includes('/api/att/' + id)).length"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1280, "height": 900}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("() => window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1000)
        page.evaluate("(fs) => { for (const [id, b64] of fs) window.__mock.routes['GET /api/att/' + id] = { __b64: b64 }; window.__clicked = []; HTMLAnchorElement.prototype.click = function () { window.__clicked.push([this.getAttribute('href'), this.download]); }; }",
                      [[f["id"], B(f["bytes"])] for f in FILES.values()])
        # the chips: a preview button and a separate download button
        page.evaluate("(k) => document.querySelector(`.t[data-key=\"${k}\"]`).click()", "hub|11111111-1111-1111-1111-111111111111")
        page.wait_for_function("() => document.querySelector('.m .atts .att')", timeout=15000)
        chip = page.evaluate("() => { const c = document.querySelector('.m .atts .att'); return [!!c.querySelector('.attopen'), c.querySelector('.attdl')?.getAttribute('aria-label')]; }")
        check(chip[0] and chip[1] == "Download f.pdf", f"{name}: each file has a preview button and its own Download button ({chip})")
        # image
        page.evaluate(OPEN, [files("img", "pdf", "txt"), 0]); page.wait_for_function("() => document.querySelector('#avbody img.avimg')?.naturalWidth > 0", timeout=15000)
        r = page.evaluate(BODY); check(r["img"] == 4 and not r["dlHidden"], f"{name}: a PNG previews, with Download shown ({r['img']}px wide)")
        # pdf, by the arrow key
        page.keyboard.press("ArrowRight"); page.wait_for_function("() => +(document.querySelector('#avbody iframe.avframe')?.dataset.drawn || 0) >= 1", timeout=30000)
        r = page.evaluate(BODY); check(r["frame"] and r["frame"]["sandbox"] == "allow-scripts" and r["frame"]["pages"] == 1 and r["frame"]["drawn"] == 1, f"{name}: the next file, a PDF, renders through pdf.js inside a frame sandboxed to allow-scripts only ({r['frame']})")
        fh = page.query_selector("#avbody iframe.avframe"); fr = fh.content_frame() if fh else None
        iso = fr.evaluate("""async () => { const r = {}; try { r.parent = parent.document.title; } catch (e) { r.parent = 'blocked'; }
            try { r.cookie = document.cookie; } catch (e) { r.cookie = 'blocked'; } try { localStorage.length; r.storage = 'open'; } catch (e) { r.storage = 'blocked'; }
            try { await fetch('/api/threads'); r.net = 'open'; } catch (e) { r.net = 'blocked'; } r.origin = String(location.origin); r.canvas = document.querySelectorAll('canvas').length; return r; }""") if fr else None
        check(iso and iso["parent"] == "blocked" and iso["cookie"] in ("blocked", "") and iso["storage"] == "blocked" and iso["net"] == "blocked" and iso["origin"] == "null" and iso["canvas"] == 1,
              f"{name}: the PDF frame's origin is opaque: no app page, no cookie, no storage, no network ({iso})")
        check(page.evaluate("() => document.querySelector('#avmeta').textContent") == f"{len(FILES['pdf']['bytes']) // 1024 or 1} KB · 2 of 3".replace(f"{len(FILES['pdf']['bytes']) // 1024 or 1} KB", "1 KB"), f"{name}: the header says which file of how many")
        # text with markup stays text
        page.keyboard.press("ArrowRight"); page.wait_for_function("() => document.querySelector('#avbody pre.avtext')", timeout=15000)
        r = page.evaluate(BODY); check(r["text"].startswith("<script>") and r["scripts"] == 0 and not page.evaluate("() => !!window.__pwned"), f"{name}: a text file full of markup is shown as text, nothing runs")
        # a file that is not what its name says
        page.evaluate(OPEN, [files("fake"), 0]); page.wait_for_function("() => document.querySelector('#avbody .avpanel .avpt')?.textContent === 'No preview for this file'", timeout=15000)
        r = page.evaluate(BODY); check("not what its name says" in r["note"], f"{name}: a .png whose bytes are not an image is not previewed ({r['note']})")
        # a program: warning, no fetch, no Download button but the deliberate one
        page.evaluate(OPEN, [files("exe"), 0]); preview.settle(page, 300)
        r = page.evaluate(BODY)
        check(r["danger"] and r["go"] == "Download anyway" and r["dlHidden"] and page.evaluate(FETCHED, "x-exe") == 0, f"{name}: a program shows a warning, is never fetched for preview, and the bar's Download is hidden ({r['panel']}, {r['go']})")
        page.click("#avbody .avgo"); preview.settle(page, 200)
        clicked = page.evaluate("() => window.__clicked.slice(-1)[0]")
        check(clicked and clicked[0].startswith("/api/att/x-exe") and clicked[1] == "setup.exe", f"{name}: only 'Download anyway' downloads it, as a download ({clicked})")
        # the chip's own Download on a program goes to the warning, not to a download
        n0 = page.evaluate("() => window.__clicked.length")
        page.evaluate("(fs) => window.mh.attDownload(window.mh.state.threads.get('hub|11111111-1111-1111-1111-111111111111'), fs[0])", files("exe")); preview.settle(page, 200)
        check(page.evaluate("() => window.__clicked.length") == n0 and page.evaluate(BODY)["danger"], f"{name}: Download on a program's chip shows the warning first")
        # archive and svg: no preview, no fetch, a note
        for k, want in (("zip", "archive"), ("svg", "vector file")):
            page.evaluate(OPEN, [files(k), 0]); preview.settle(page, 250); r = page.evaluate(BODY)
            check(r["panel"] == "No preview for this file" and want in r["note"] and page.evaluate(FETCHED, FILES[k]["id"]) == 0 and r["go"] == "Download", f"{name}: {FILES[k]['name']} gets no preview and no fetch, a note and Download ({r['note']})")
        # download of a previewable file: a download, never an open
        page.evaluate(OPEN, [files("pdf"), 0]); preview.settle(page, 200); page.click("#avdl"); preview.settle(page, 200)
        clicked = page.evaluate("() => window.__clicked.slice(-1)[0]")
        check(clicked and clicked[0].startswith("/api/att/x-pdf") and clicked[1] == "spec sheet.pdf", f"{name}: Download hands the app a download of the file ({clicked})")
        # right-to-left override: shown without it, judged by the real extension
        page.evaluate(OPEN, [files("rlo"), 0]); preview.settle(page, 250)
        shown = page.evaluate("() => document.querySelector('#avname').textContent"); r = page.evaluate(BODY)
        check(shown == "invoicefdp.exe" and r["danger"], f"{name}: a name with a right-to-left override is shown without it and judged as a program ({shown!r})")
        # a 40-page PDF: every page laid out, only the pages near view drawn (memory stays bounded)
        page.evaluate(OPEN, [files("big"), 0]); page.wait_for_function("() => +(document.querySelector('#avbody iframe.avframe')?.dataset.pages || 0) === 40", timeout=30000); preview.settle(page, 2500)
        r = page.evaluate(BODY)
        check(r["frame"]["pages"] == 40 and 1 <= r["frame"]["drawn"] <= 8, f"{name}: a 40-page PDF lays out every page but draws only those near view ({r['frame']['drawn']} of 40 drawn)")
        bf = page.query_selector("#avbody iframe.avframe").content_frame()
        bf.evaluate("() => document.querySelectorAll('.pg')[25].scrollIntoView()"); preview.settle(page, 2500)
        live = bf.evaluate("() => ({ canvases: document.querySelectorAll('canvas').length, at25: !!document.querySelectorAll('.pg')[25].querySelector('canvas'), at0: !!document.querySelectorAll('.pg')[0].querySelector('canvas') })")
        check(live["at25"] and live["canvases"] <= 8, f"{name}: scrolling to page 26 draws it, and only a few canvases are alive at once ({live})")
        # invisible characters after the extension do not hide a program
        page.evaluate(OPEN, [files("lrm"), 0]); preview.settle(page, 250); r = page.evaluate(BODY)
        check(r["danger"], f"{name}: 'evil.exe' followed by an invisible U+200E is still a program ({r['panel']})")
        # program bytes behind a harmless name, and a script with no extension
        for k in ("hidden", "shebang"):
            page.evaluate(OPEN, [files(k), 0]); page.wait_for_function("() => document.querySelector('#avbody .avpanel.danger')", timeout=15000); r = page.evaluate(BODY)
            check(r["danger"] and r["go"] == "Download anyway" and r["dlHidden"], f"{name}: {FILES[k]['name']!r} turns out to be a program, so it gets the program warning ({r['panel']})")
        n0 = page.evaluate("() => window.__clicked.length"); page.click("#avbody .avgo"); preview.settle(page, 250)
        check(page.evaluate("() => window.__clicked.length") == n0 + 1, f"{name}: and only Download anyway downloads it")
        # a macro document: the chip's Download shows its caution first; Download there downloads
        n0 = page.evaluate("() => window.__clicked.length")
        page.evaluate("(fs) => window.mh.attDownload(window.mh.state.threads.get('hub|11111111-1111-1111-1111-111111111111'), fs[0])", files("macro")); preview.settle(page, 250); r = page.evaluate(BODY)
        check(page.evaluate("() => window.__clicked.length") == n0 and "macros" in r["note"], f"{name}: Download on a macro document's chip shows its caution first ({r['note']})")
        page.click("#avdl"); preview.settle(page, 250)
        check(page.evaluate("() => window.__clicked.length") == n0 + 1, f"{name}: and Download there downloads it")
        # an error answer is reported, not saved as the file
        n0 = page.evaluate("() => window.__clicked.length")
        page.evaluate("() => window.mh.attDownload(window.mh.state.threads.get('hub|11111111-1111-1111-1111-111111111111'), { id: 'gone', name: 'gone.pdf', size: 5, url: '/api/att/gone' })"); preview.settle(page, 300)
        t0 = page.evaluate("() => document.querySelector('#toast').textContent")
        check(page.evaluate("() => window.__clicked.length") == n0 and "Couldn't download gone.pdf (404)" in t0, f"{name}: a file the hub cannot serve is reported, not saved as an error page ({t0!r})")
        # the toast sits above the preview window
        zt, zm = page.evaluate("() => [+getComputedStyle(document.querySelector('#toast')).zIndex, +getComputedStyle(document.querySelector('#avmodal')).zIndex]")
        check(zt > zm, f"{name}: the toast is drawn above the open preview ({zt} > {zm})")
        # Esc closes the preview through the back stack
        page.keyboard.press("Escape"); preview.settle(page, 200)
        check(not page.evaluate("() => document.querySelector('#avmodal').classList.contains('on')"), f"{name}: Esc closes the preview")
        # the Mac app's callbacks
        page.evaluate("() => { window.__revealed = []; window.webkit = { messageHandlers: { reveal: { postMessage: (x) => window.__revealed.push(x) } } }; window.mhDownloaded({ ok: true, name: 'spec sheet.pdf', id: '7' }); }")
        t1 = page.evaluate("() => document.querySelector('#toast').textContent")
        page.evaluate("() => document.querySelector('#toast button')?.click()")
        check(t1 == "Saved to Downloads: spec sheet.pdfShow in Finder" and page.evaluate("() => window.__revealed") == ["7"], f"{name}: a finished Mac download says where it went, and Show in Finder asks the app ({t1!r})")
        page.evaluate("() => window.mhDownloaded({ ok: false, name: 'big.zip', error: 'The disk is full' })")
        t2 = page.evaluate("() => document.querySelector('#toast').textContent")
        check(t2 == "Couldn't save big.zip: The disk is full", f"{name}: a failed Mac download says so ({t2!r})")
        check(not errs, f"{name}: page errors {errs[:3]}")
        b.close()
srv.shutdown()
# The page and the Android app must hold the same lists: the page decides what Open is offered for, the app refuses the rest.
import re
js = open("src/client/app.js").read(); kt = open("../android/app/src/main/java/com/sheritlabs/mail/MainActivity.kt").read()
def words(seg): return set(w for chunk in re.findall(r'"([^"]*)"', seg) for w in chunk.split() if re.fullmatch(r"[a-z0-9_~-]+", w))
def between(src, start, end): i = src.index(start); return src[i:src.index(end, i)]
jsd = words(between(js, "const ATT_DANGER = new Set((", "].filter") if False else between(js, "const ATT_DANGER = new Set((", ".filter(Boolean)"))
ktd = words(between(kt, "private val dangerExt = (", ".filter {"))
jso = set().union(*[set(re.search(r'const ATT_%s = new Set\("([^"]*)"' % n, js).group(1).split()) for n in ("ARCHIVE", "MACRO", "ACTIVE")])
m = re.search(r'private val cautionExt = "([^"]*)"', kt); kto = set(m.group(1).split()) if m else set()
check(len(jsd) > 100 and jsd == ktd, f"the program lists in app.js and the Android app are identical ({len(jsd)} vs {len(ktd)}; only in JS: {sorted(jsd - ktd)[:6]}, only in Kotlin: {sorted(ktd - jsd)[:6]})")
check(bool(jso) and jso == kto, f"the archive, macro and page lists match too, so the app refuses Open for every class the page withholds it from ({len(jso)} vs {len(kto)})")
print(("FAILED: " + "; ".join(fails)) if fails else "all attachment-viewer checks passed")
sys.exit(1 if fails else 0)
