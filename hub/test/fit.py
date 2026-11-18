#!/usr/bin/env python3
"""A mail written as one bare <pre> must read at full size, not be shrunk to fit its longest line (on WebKit and Chromium.

A mail rendered far too small) Google Cloud Support's quota reply is `<pre>` and nothing else. A browser never
wraps a <pre>, so every paragraph stayed one line, the body measured several times wider than the pane, and fitFrame scaled the whole
mail down until that line fitted. Plain-text mail already wraps (app.html: `.m.b pre{white-space:pre-wrap}`); the frame that holds an
HTML mail had no rule for <pre> at all. The control: a fixed 600 px newsletter on a phone must STILL be scaled, so the fit itself is
untouched. Usage: python3 test/fit.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
QUOTA = """<pre>Hello,

We have received your quota request for your-gcp-project.

Unfortunately, we are unable to grant you additional quota at this time. If this is a new project please wait 48h until you resubmit the request or until your Billing account has additional history.


If you have any further questions, please reply to this thread. https://console.cloud.google.com/iam-admin/quotas/details;servicem=gmail.googleapis.com;metricm=gmail.googleapis.com%2Fquota%2Fdefault?project=your-gcp-project

Thanks.

Sincerely,
Google Cloud Support
</pre>"""
# A <div>, not a <table>: the frame's own `table{max-width:100%}` lets Chromium narrow a 600 px table to the pane (WebKit keeps it at 600,
# measured in October 2026: 336 vs 600 px), so a table would only exercise the scaling on one engine. Nothing narrows a fixed-width div.
NEWSLETTER = """<div style="width:600px">A fixed-width newsletter column that is exactly six hundred pixels wide, as most marketing mail is.</div>"""
# USPS Informed Delivery (The mail kept switching between sizes): its <body> is `margin: 0 auto !important`.
# Forced wider than the pane, Chromium resolves that auto margin NEGATIVE, so the room measured while forced grew by the overflow, the
# scale fell back to 1, the body was freed, and the mail flipped between two sizes several times a second (WebKit never did).
CENTERED = """<body style="margin: 0 auto !important; max-width: 820px !important"><div style="width:600px">A fixed-width column inside a body centred with auto margins.</div></body>"""
# Three shop links in a Gmail <div> (The mail rendered tiny): up to 724 characters each, and the longest run
# with no break opportunity in it (both engines break a URL after a hyphen between letters and nowhere else) laid the body out 1461 px
# wide in a 525 px pane, so fitFrame scaled the whole mail to 0.35. A link carries no width of its own: the mail must read at full size,
# the link broken where it must be. The 600 px controls above prove the fit itself still scales fixed-width mail.
Q = "ref=sxin_13_pa_sp_search_thematic_sspa?content=amzn1.sym.00000000000000000000000000000000&crid=0000000000000&cv_ct_cx=blue+plain+test+products&keywords=blue+plain+test+products&pd_rd_i=B000000000&pd_rd_w=AAAAA&pd_rd_wg=BBBBB&qid=1700000000&sbo=AAAAA%2F%2FAAAA%2BAAAAAAAAAA%3D%3D&sprefix=blue+plain+test+products%2Caps%2C241&psc=1"
LINK = lambda n: f"https://www.example.com/Backdrop-Polyester-Backdrops-Background-Photoshoot-Decoration/dp/B00000000{n}/{Q}"
LINKS = f'<div dir="ltr">7x5 darker $10: <a href="{LINK(1)}">{LINK(1)}</a><br><br>7x5 lighter - $11: <a href="{LINK(2)}">{LINK(2)}</a><br><br>Wallpaper: 39 x 1.5 $28: <a href="{LINK(3)}">{LINK(3)}</a></div>'
SAMPLE = """async () => { const fr = document.querySelector('#msgs iframe'); const s = []; for (let i = 0; i < 25; i++) { s.push(+((fr._fit || {}).scale || 0).toFixed(3)); await new Promise((r) => setTimeout(r, 100)); } return s; }"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
OPEN = """async ([k, tid, html]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k); await new Promise((res) => setTimeout(res, 600));
  const fr = document.querySelector('#msgs iframe'); const d = fr && fr.contentDocument; const pre = d && (d.querySelector('pre') || d.querySelector('a'));
  return { fit: fr && fr._fit, pane: fr && fr.clientWidth, font: pre ? parseFloat(d.defaultView.getComputedStyle(pre).fontSize) : null }; }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        try: b = engine.launch()
        except Exception as e: check(False, f"{name}: browser not installed ({str(e).splitlines()[0]})"); continue
        for label, vp in (("Mac window", {"width": 1000, "height": 640}), ("phone", {"width": 390, "height": 844})):
            page = b.new_page(viewport=vp); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
            page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
            q = page.evaluate(OPEN, [KEY, TID, QUOTA]); f = q["fit"] or {}
            check(f.get("scale") == 1, f"{name} {label}: the <pre> mail is not shrunk (scale {f.get('scale')}, natural {f.get('natural')}, pane {q['pane']} px)")
            check((q["font"] or 0) >= 12, f"{name} {label}: its text renders at {q['font']} px")
            n = page.evaluate(OPEN, [KEY, TID, NEWSLETTER]); nf = n["fit"] or {}
            if label == "phone": check(0 < (nf.get("scale") or 1) < 1, f"{name} {label}: CONTROL — a 600 px newsletter is still scaled to fit (scale {nf.get('scale')})")
            else: check(nf.get("scale") == 1, f"{name} {label}: CONTROL — a 600 px newsletter fits the wide pane unscaled (scale {nf.get('scale')})")
            l = page.evaluate(OPEN, [KEY, TID, LINKS]); lf = l["fit"] or {}
            check(lf.get("scale") == 1, f"{name} {label}: a mail of long links is not shrunk (scale {lf.get('scale')}, natural {lf.get('natural')}, pane {l['pane']} px)")
            check((l["font"] or 0) >= 12, f"{name} {label}: its links render at {l['font']} px")
            c = page.evaluate(OPEN, [KEY, TID, CENTERED]); seen = page.evaluate(SAMPLE)
            flips = sum(1 for a, b2 in zip(seen, seen[1:]) if a != b2)
            if label == "phone": check(flips == 0 and 0 < seen[-1] < 1, f"{name} {label}: a wide mail in an auto-margin body is scaled once and stays put ({flips} flips in 2.5 s, scales {sorted(set(seen))})")
            else: check(flips == 0, f"{name} {label}: a wide mail in an auto-margin body stays put ({flips} flips, scales {sorted(set(seen))})")
            check(not errs, f"{name} {label}: no page errors {errs[:2]}")
            page.close()
        b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all fit checks passed")
sys.exit(1 if fails else 0)
