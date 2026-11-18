#!/usr/bin/env python3
"""No word in a mail's table is broken between its letters; only a long run with no space may break anywhere.
WebKit and Chromium, at a Mac window and a phone.

A Stripe receipt drew its price a character per line ("$", "2", "4", "9", ".", "0", "0", the cell 10 px wide and 168 px
tall), and on the phone a gallery newsletter drew its titles two letters a line. The frame's `body{overflow-wrap:anywhere}`
 let every word break at any character, and CSS Text 3 counts those breaks in a
box's min-content width, so a table cell beside a `width:100%` one, or beside a button that cannot wrap, was given one character's
width. Now only each run of MAIL_LONG_RUN or more non-space characters is wrapped in a span[data-mh-wrap] that may break anywhere.

The fixtures are stand-ins with the same structure as those two mails, with nothing taken from them:
  - RECEIPT: a description cell at width:100%, an 8 px gap cell, a right-aligned amount cell with no width (Stripe's receipt row);
  - GALLERY: a cell holding a 96 px thumbnail and a date, a title and a name, beside a cell whose button is white-space:nowrap;
  - LONG: a word and a 60-character tracking number in one cell beside a width:100% cell, and a <style> holding a long run.
Each word is measured with a Range: the distinct line tops of its client rects; a word split between letters spans more than one.
Checks: every word of RECEIPT and GALLERY is on one line, and the price cell is one line tall; in LONG the number alone is wrapped
(one span), the word beside it is whole, the mail is not shrunk, and the <style> is untouched; no page errors.
CONTROL=1 also runs the client at 0c2f6c7 (body-wide anywhere), which splits the price at both widths and the titles on the phone.
"""
import subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

FILES = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]
def src(rev, f): return subprocess.run(["git", "show", f"{rev}:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=True).stdout if rev else (preview.CLIENT / f).read_text()
def bundle(rev=None): return "\n".join(src(rev, f) for f in FILES).replace("__VERSION__", "test")

TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
RECEIPT = """<table align="center" width="600" style="min-width:600px"><tr><td style="padding:0 16px">
<table style="padding-left:5px;padding-right:5px" width="100%"><tr>
<td class="desc" style="font-size:15px;line-height:24px;width:100%">Example Lamp | Deposit &times; 1</td>
<td width="8" style="font-size:1px;line-height:1px">&nbsp;</td>
<td class="amt" align="right" valign="top" style="font-size:15px;line-height:24px">$249.00</td>
</tr></table></td></tr></table>"""
ROW = lambda d, t, a: f"""<tr><td style="padding:12px;border-top:1px solid #eee" valign="middle"><table role="presentation"><tr>
<td width="96" style="padding-right:14px"><div style="width:96px;height:96px;background:#ddd;border-radius:8px"></div></td>
<td valign="middle"><div class="w" style="font-size:12px;font-weight:700;padding-bottom:4px">{d}</div><div class="w" style="font-size:14px;font-weight:700;line-height:18px">{t}</div><div class="w" style="font-size:13px;padding-top:2px">{a}</div></td>
</tr></table></td><td align="right" style="padding:12px 16px;border-top:1px solid #eee"><a href="https://example.com/remind" style="display:inline-block;padding:8px 13px;border:1.5px solid #66f;border-radius:40px;font-size:12px;font-weight:700;white-space:nowrap">&#128276;&nbsp;Remind&nbsp;me</a></td></tr>"""
GALLERY = f"""<div style="padding:0 22px"><table width="100%" style="border:1px solid #e7e7ee">{ROW("Thu 19 Nov", "Happy Hour", "Example Painter")}{ROW("Sun 22 Nov", "I Even Dream About You", "Another Artist")}</table></div>"""
TRK = "1Z" + "9" * 56 + "01"
LONG = f"""<style>.bg{{background:url(data:image/png;base64,{"A" * 80})}}</style><table width="100%"><tr><td style="width:100%">Your order</td>
<td class="trk">Tracking: {TRK}</td></tr></table>"""

OPEN = """async ([k, tid, html]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k); await new Promise((res) => setTimeout(res, 700));
  const fr = document.querySelector('#msgs iframe'); const d = fr.contentDocument;
  const lines = (sel) => { const out = []; for (const el of d.querySelectorAll(sel)) { const w = d.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.parentElement.closest('[data-mh-wrap]')) continue;
      for (const m of n.data.matchAll(/\\S+/g)) { const g = d.createRange(); g.setStart(n, m.index); g.setEnd(n, m.index + m[0].length);
        out.push([m[0], new Set([...g.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size]); } } } return out; };
  const amt = d.querySelector('td.amt'); const st = d.querySelector('style.bg, style');
  return { scale: fr._fit && fr._fit.scale, words: lines('td.desc, td.amt, div.w, td.trk'), amtH: amt ? Math.round(amt.getBoundingClientRect().height) : null,
    spans: [...d.querySelectorAll('[data-mh-wrap]')].map((s) => s.textContent), styleText: [...d.querySelectorAll('style')].map((s) => s.textContent).join('') }; }"""

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
split = lambda r: [w for w, n in r["words"] if n > 1]

def run(engine, tag, control=False):
    out = {}; b = engine.launch()
    for label, vp in (("Mac window", {"width": 1000, "height": 740}), ("phone", {"width": 390, "height": 844})):
        page = b.new_page(viewport=vp); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        rc, ga, lo = (page.evaluate(OPEN, [KEY, TID, h]) for h in (RECEIPT, GALLERY, LONG))
        out[label] = {"receipt": rc, "gallery": ga, "long": lo, "errs": errs}
        if not control:
            check(not split(rc) and rc["words"], f"{tag} {label}: no word of the receipt row is split between letters (split: {split(rc)})")
            check(rc["amtH"] is not None and rc["amtH"] <= 36, f"{tag} {label}: the price cell is one line tall ({rc['amtH']} px)")
            check(not split(ga) and ga["words"], f"{tag} {label}: no word of the gallery rows is split between letters (split: {split(ga)})")
            check(lo["spans"] == [TRK], f"{tag} {label}: only the long tracking number may break anywhere ({lo['spans']})")
            check(not split(lo), f"{tag} {label}: the word beside it stays whole (split: {split(lo)})")
            check(lo["scale"] == 1, f"{tag} {label}: the mail is not shrunk to the long run (scale {lo['scale']})")
            check(("A" * 80) in lo["styleText"], f"{tag} {label}: a long run inside <style> is left as it is")
            check(not errs, f"{tag} {label}: no page errors {errs[:2]}")
        page.close()
    b.close(); return out

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        preview.BUNDLE = bundle(); run(engine, engine.name)
    if preview.CONTROL:   # 0c2f6c7: overflow-wrap:anywhere on the whole body
        preview.BUNDLE = bundle("0c2f6c7"); r = run(pw.chromium, "0c2f6c7", control=True)
        got = {"price split on the Mac": bool(split(r["Mac window"]["receipt"])), "price split on the phone": bool(split(r["phone"]["receipt"])), "titles split on the phone": bool(split(r["phone"]["gallery"]))}
        check(all(got.values()), f"CONTROL: the client at 0c2f6c7 fails {got} (price {r['Mac window']['receipt']['amtH']} px tall on the Mac)")
    else:
        preview.control_skipped("cellwrap")
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all cell-wrap checks passed")
sys.exit(1 if fails else 0)
