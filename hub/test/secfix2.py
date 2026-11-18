#!/usr/bin/env python3
# run_all: alone (it holds time limits; with other tests running, the CPU they take decides it)
"""The mail frame's second security review: on WebKit (the Mac app) and Chromium (Android, Windows).

  F1 a large HTML mail froze the app before it was opened: the prerender runs messageHtml for the 25 newest rows on the main thread,
      and its regular expressions (linkOut, labelLinks, proxyImages, the tracker rules, mailTheme, the text extractors) backtracked
      quadratically on a mail of repeated unclosed tags: 14 s for 200 KB in Chromium. Checked: messageHtml on 1 MB of each adversarial
      body (`<a `, `<img `, `<style`, `<`, `<meta `, a mix, and the shapes found while fixing it: url(a padded width, a run of srcset
      commas, a tracker URL repeating its prefix, 200,000 nested <div>s, 100,000 quoted lines) takes under LIMIT_MS each.
  F2 the link rule was bypassable: a `>` inside a quoted attribute ended the tag early (<a title=">" href="intent:…" target="_self">),
      and character references htmlUnent did not decode (javascript&colon;, &#106avascript:, jav&Tab;ascript:) hid the scheme; the
      <meta http-equiv=refresh> strip had both gaps. Checked, in the rendered docs AND in the frame as opened: no a/area/base keeps an
      href with a scheme other than http(s)/mailto (base: http(s)), no target survives, no meta refresh; a click on a smuggled
      target=_self web link leaves the frame where it is. In the frame only: an <a> inside <svg><style> (markup there, text to a string pass).
  F3 the Mac's only destination indicator, the tooltip, could be spoofed by a title inside the link. Checked: no element's tooltip names
      anything but the link's own destination (HTML title, SVG <title>, xlink:title), in the docs and in the frame.
  F5 bidi controls in a sender's name reversed the rest of the From line. Checked: the row and the header carry no bidi control in the
      name or address, the subject is isolated in a <bdi>, and the address is laid out left to right (a control drawn with the raw
      string first proves the geometric check sees the reversal).
  CONTROL a real-looking mail keeps its links (cleaned, titled), mailto and relative links untouched, its pictures proxied and lazy,
      its tracker blocked and named, and its <style> url() proxied.
Usage: python3 test/secfix2.py [--limit MS]"""
import os, sys, json, re
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
LIMIT_MS = 500
if "--limit" in sys.argv: LIMIT_MS = int(sys.argv[sys.argv.index("--limit") + 1])
sys.argv = sys.argv[:1]
import preview
preview.CSP = True   # served under the hub's own script policy
from playwright.sync_api import sync_playwright

TID = "11111111-1111-1111-1111-111111111111"; KEY = "hub|" + TID
fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m, flush=True); (c or fails.append(m))

LINKS = '''<meta data-x=">" http-equiv="refresh" content="0;url=https://evil.example/meta_gt"><meta http-equiv="&#114;efresh" content="0;url=https://evil.example/meta_ent">
<meta http-equiv="REFRESH" content="0;url=https://evil.example/meta_up"><base href="intent://evil/#Intent;end">
<p><a id="gt_intent" title=">" href="intent:#Intent;component=com.x/.Y;end" target="_self">gt_intent</a>
<a id="gt_self" title=">" href="https://evil.example/self" target="_self">gt_self</a>
<a id="gt_js" data-x='>' href="javascript:alert(1)" target=_top>gt_js</a> <a id="gt_data" title=">" href="data:text/html,hi">gt_data</a></p>
<p><a id="e_colon" href="javascript&colon;alert(1)">e_colon</a> <a id="e_nosemi" href="&#106avascript:alert(1)">e_nosemi</a>
<a id="e_tab" href="jav&Tab;ascript:alert(1)">e_tab</a> <a id="e_nl" href="java&NewLine;script:alert(1)">e_nl</a> <a id="e_hex" href="&#x6A;avascript:alert(1)">e_hex</a>
<a id="e_intent" href="intent&colon;#Intent;end">e_intent</a> <a id="e_data" href="data&colon;text/html,hi">e_data</a> <a id="e_dup" href="javascript:alert(5)" href="https://ok.example/dup">e_dup</a></p>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" usemap="#m" width="10" height="10"><map name="m"><area id="area_gt" title=">" href="javascript&colon;x" target="_self" shape="rect" coords="0,0,10,10"></map>
<svg width="200" height="30" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a id="svg_x" xlink:href="javascript&colon;alert(2)" target="_self"><text x="5" y="20">svg</text></a></svg>
<p><a id="rel_base" href="foo">rel_base</a> <a id="ok_web" href="https://ok.example/p?utm_source=x&amp;id=7">ok_web</a> <a id="ok_mail" href="mailto:bob@example.com">ok_mail</a> <a id="ok_rel" href="/local">ok_rel</a></p>'''
CTX = '''<svg width="10" height="10"><style><a id="ctx" href="javascript:alert(4)" target="_self">ctx</a></style></svg>'''
TIPS = '''<p><a id="t1" href="https://evil.example/login"><span id="s1" title="https://www.paypal.com/invoice/p/ABC123">Pay invoice</span></a></p>
<p><a id="t2" data-x=">" title="https://www.paypal.com/invoice/p/ABC123" href="https://evil.example/pay?utm_source=x">Pay</a></p>
<p><a id="t3" href="//evil.example/proto"><b id="b3" title="https://www.paypal.com/">Pay</b></a></p>
<div title="https://www.paypal.com/"><a id="t4" href="//evil.example/x">Pay</a></div>
<svg width="200" height="30" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a id="t5" href="https://evil.example/svg" xlink:title="https://www.paypal.com/"><title>https://www.paypal.com/</title><text id="x5" x="5" y="20">Pay</text></a></svg>'''
REAL = '''<html><head><style>.x{background:url(https://cdn.example.com/bg.png)}</style></head><body><table><tr><td background="https://cdn.example.com/td.png">
<a id="c1" href="https://shop.example/item?id=42&amp;utm_source=news">Shop</a> <a id="c2" href="mailto:bob@example.com">Mail</a> <a id="c4" href="/local/page">Here</a>
<img id="i1" src="https://cdn.example.com/hero.jpg" width="600" height="300" alt="Hero"> <img id="trk" src="https://u2.ct.sendgrid.net/wf/open?upn=abc" width="1" height="1"></td></tr></table>
<p class="x"><a id="c3" title="a > b" href="https://news.example/a?b=1">Quoted</a></p></body></html>'''

OPEN = """async ([k, tid, html, text, fromName, fromAddr]) => { const r = window.__mock.routes['GET /api/threads/' + tid]; r.messages.forEach((m) => { m.body_html = html; m.body_text = text; if (fromName !== null) { m.from_name = fromName; m.from_addr = fromAddr; } });
  window.mh.prerendered.delete(k); await window.mh.idb.delAll('bodies', (await window.mh.idb.getByIndex('bodies', 'threadKey', k)).map((x) => x.key));
  await window.mh.openThread(k); await new Promise((res) => setTimeout(res, 700)); return true; }"""
# What a document holds, by the browser's own reading: every link-bearing element's hrefs (resolved against the document's base),
# targets, meta refreshes, and each probe element's tooltip as the engine would choose it (the innermost title; SVG: a <title> child).
INSPECT = """(d) => { const SVG = 'http://www.w3.org/2000/svg', XL = 'http://www.w3.org/1999/xlink';
  const tip = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { if (n.namespaceURI === SVG) { const t = [...n.children].find((c) => c.localName === 'title' && c.namespaceURI === SVG); if (t) return t.textContent; const xt = n.getAttributeNS(XL, 'title'); if (xt) return xt; } else if (n.hasAttribute('title')) return n.getAttribute('title'); } return null; };
  const out = { links: {}, bad: [], targets: [], refresh: d.querySelectorAll('meta[http-equiv]').length ? [...d.querySelectorAll('meta[http-equiv]')].filter((m) => /refresh/i.test(m.getAttribute('http-equiv'))).length : 0, tips: {}, paypal: [] };
  for (const a of d.querySelectorAll('a, area, base')) {
    const hrefs = [...a.attributes].filter((x) => x.localName === 'href').map((x) => x.value);
    for (const v of hrefs) { let p; try { p = new URL(v, d.baseURI).protocol; } catch (e) { p = 'invalid'; } const ok = a.localName === 'base' ? /^https?:$/.test(p) : /^(https?|mailto):$/.test(p); if (!ok) out.bad.push((a.id || a.localName) + ' ' + v + ' (' + p + ')'); }
    if (a.hasAttribute('target') && a.parentNode !== d.head) out.targets.push((a.id || a.localName) + '=' + a.getAttribute('target'));
    if (a.id) out.links[a.id] = { href: a.getAttribute('href'), xhref: a.getAttributeNS(XL, 'href'), title: a.getAttribute('title'), resolved: (() => { try { return new URL(a.getAttribute('href') ?? a.getAttributeNS(XL, 'href'), d.baseURI).href; } catch (e) { return null; } })() };
  }
  for (const id of ['s1', 't1', 't2', 'b3', 't3', 't4', 'x5', 't5']) { const el = d.getElementById(id); if (el) out.tips[id] = tip(el); }
  for (const el of d.querySelectorAll('*')) { if ((el.getAttribute('title') || '').includes('paypal') || (el.getAttributeNS(XL, 'title') || '').includes('paypal') || (el.localName === 'title' && el.namespaceURI === SVG && el.textContent.includes('paypal'))) out.paypal.push(el.id || el.localName); }
  return out; }"""
DOC = "(html) => { const docs = []; window.mh.messageHtml({ id: 'x', html, text: '', from: 'a@b.c', fromAddr: 'a@b.c', to: 'me@x', date: Date.now(), subject: 's', attachments: [] }, 0, 1, docs); return (" + INSPECT + ")(new DOMParser().parseFromString(docs[0], 'text/html')); }"
FRAME = "() => (" + INSPECT + ")(document.querySelector('#msgs iframe').contentDocument)"
TIMING = """([kb, which]) => { const N = kb * 1000; const rep = (u) => u.repeat(Math.ceil(N / u.length)).slice(0, N);
  const C = { '<a ': rep('<a '), '<img ': rep('<img '), '<style': rep('<style'), '<': rep('<'), '<meta ': rep('<meta '), 'mix': rep('<a <img <style<meta <<a href=" url(//a <title x=\\' <!-- '),
    'quoted mix': rep('<a x="<a y=\\'<img src="'), 'url(//': rep('url(//a '), 'padded width': '<img src="https://x/" width="1' + ' '.repeat(N) + 'x">', 'srcset commas': '<img srcset="b' + ','.repeat(N) + 'c, d 1x">',
    'tracker prefix': '<img src="https://x/' + 'lt.php'.repeat(N / 6) + '">', 'nested div': '<div class="gmail_quote">' + rep('<div>'), 'nested table': rep('<table><tr><td>'),
    'quoted lines (text)': null, 'normal': rep('<p>Hi <a href="https://x.example/a?b=1&amp;c=2" title="t">link</a> <img src="https://cdn.x/y.png" width=10 height=10></p>\\n') };
  const m = { id: 'x', html: C[which], text: '', from: 'a@b.c', fromAddr: 'a@b.c', to: 'me@x', date: Date.now(), subject: 's', attachments: [] };
  if (which === 'quoted lines (text)') { m.html = ''; m.text = 'mine\\n' + rep('> \\n') + '\\nan inline answer'; }
  const t0 = performance.now(); window.mh.messageHtml(m, 0, 1, []); const t1 = performance.now(); window.mh.messageHtml(m, 4, 5, []); return [Math.round(t1 - t0), Math.round(performance.now() - t1)]; }"""
BODIES = ['<a ', '<img ', '<style', '<', '<meta ', 'mix', 'quoted mix', 'url(//', 'padded width', 'srcset commas', 'tracker prefix', 'nested div', 'nested table', 'quoted lines (text)', 'normal']
# The From line as laid out: the x of the address's first and last characters ("<" and ">"). Left to right, "<" is left of ">".
LTR = """(el) => { const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.data.includes('<')) || el.firstChild; const s = tn.data, r = document.createRange();
  const x = (i) => { r.setStart(tn, i); r.setEnd(tn, i + 1); return r.getBoundingClientRect().left; }; return { lt: x(s.indexOf('<')), gt: x(s.lastIndexOf('>')), text: s }; }"""
BIDI = "[؜‎‏‪-‮⁦-⁩]"

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); ctx = b.new_context(viewport={"width": 1000, "height": 700}); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        evil = []; ctx.route("https://evil.example/**", lambda route: (evil.append(route.request.url), route.fulfill(status=200, content_type="text/html", body="<title>evil</title>")))
        page.set_default_timeout(60000)
        page.goto(base); page.wait_for_function("() => window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate("() => { window.__opens = []; window.open = (u) => { window.__opens.push(String(u)); return null; }; }")

        # ---- F1 ----
        times = {}
        for body in BODIES: times[body] = page.evaluate(TIMING, [1000, body])
        worst = max(max(v) for v in times.values())
        print(f"     {name}: messageHtml on 1 MB, ms [open, collapsed]: " + json.dumps(times), flush=True)
        check(worst < LIMIT_MS, f"{name}: F1 messageHtml finishes each 1 MB adversarial body in under {LIMIT_MS} ms (worst {worst} ms)")
        deep = page.evaluate("() => { const docs = []; const h = window.mh.messageHtml({ id: 'x', html: '<div>'.repeat(5000) + 'deep text', text: '', from: 'a@b.c', to: 'me@x', date: 0, subject: 's' }, 0, 1, docs); return { docs: docs.length, shows: h.includes('deep text') }; }")
        check(deep["docs"] == 0 and deep["shows"], f"{name}: F1 a mail nested past the parser's depth is shown as its text, never parsed as HTML ({deep})")

        # ---- F2: the docs messageHtml writes ----
        D = page.evaluate(DOC, LINKS)
        check(not D["bad"], f"{name}: F2 docs — no a/area/base keeps a scheme other than http(s)/mailto ({D['bad'][:4]})")
        check(not D["targets"], f"{name}: F2 docs — no target survives ({D['targets'][:4]})")
        check(D["refresh"] == 0, f"{name}: F2 docs — no <meta http-equiv=refresh> survives a `>` in a value or an entity in its name ({D['refresh']})")
        L = D["links"]; g = lambda i: L.get(i) or {}
        check(g("gt_self").get("href") == "https://evil.example/self" and g("ok_mail").get("href") == "mailto:bob@example.com" and g("ok_rel").get("href") == "/local" and g("e_dup").get("href") == "https://ok.example/dup",
              f"{name}: F2 docs — web, mailto and relative links keep their href; of two hrefs the bad one goes ({g('gt_self').get('href')}, {g('ok_mail').get('href')}, {g('ok_rel').get('href')}, {g('e_dup').get('href')})")
        # ---- F2: the frame as opened ----
        page.evaluate(OPEN, [KEY, TID, LINKS + CTX, "", None, None]); F = page.evaluate(FRAME); L = F["links"]
        check(not F["bad"], f"{name}: F2 frame — no a/area/base keeps a scheme other than http(s)/mailto, the <svg><style> link included ({F['bad'][:4]})")
        check(not F["targets"], f"{name}: F2 frame — no target survives ({F['targets'][:4]})")
        check(F["refresh"] == 0, f"{name}: F2 frame — no meta refresh")
        check(g("rel_base").get("resolved", "").startswith(base), f"{name}: F2 frame — a relative link resolves to the hub, not through the mail's intent:// <base> ({g('rel_base').get('resolved')})")
        check(g("ok_web").get("href") == "https://ok.example/p?id=7" and g("ok_web").get("title") == "https://ok.example/p?id=7" and g("ok_mail").get("title") is None and g("ok_rel").get("title") is None,
              f"{name}: F2 frame — a web link is cleaned and titled; mailto and relative are untouched ({g('ok_web')}, {g('ok_mail').get('title')}, {g('ok_rel').get('title')})")
        before = page.evaluate("() => document.querySelector('#msgs iframe').contentDocument.URL"); n_evil = len(evil)
        if name == "chromium":
            page.evaluate("() => document.querySelector('#msgs iframe').contentDocument.getElementById('gt_self').click()"); preview.settle(page, 500)
            opens = page.evaluate("() => window.__opens")
            check(opens == ["https://evil.example/self"], f"{name}: F2 a click on the smuggled target=_self link opens it outside, once ({opens})")
        else:
            try:
                with ctx.expect_page(timeout=5000) as pi: page.evaluate("() => document.querySelector('#msgs iframe').contentDocument.getElementById('gt_self').click()")
                pop = pi.value; pop.wait_for_load_state("domcontentloaded", timeout=5000); check(pop.url == "https://evil.example/self", f"{name}: F2 a click on the smuggled target=_self link opens a new window — what the Mac shell is handed ({pop.url})"); pop.close()
            except Exception as e: check(False, f"{name}: F2 the click opened no new window ({str(e).splitlines()[0]})")
        after = page.evaluate("() => document.querySelector('#msgs iframe').contentDocument.URL")
        frames = [f.url for f in page.frames]
        check(after == before and not any("evil.example" in u for u in frames), f"{name}: F2 the message frame did not navigate ({before} -> {after}; frames {frames})")

        # ---- F3 ----
        D = page.evaluate(DOC, TIPS)
        check(not D["paypal"] and all(v is None or "evil.example" in v for v in D["tips"].values()), f"{name}: F3 docs — no title names anything but the link's destination ({D['paypal']}, {D['tips']})")
        page.evaluate(OPEN, [KEY, TID, TIPS, "", None, None]); F = page.evaluate(FRAME); T = F["tips"]
        sch = base.split(":")[0]   # a protocol-relative link takes the page's scheme (https in the app, http here)
        want = {"s1": "https://evil.example/login", "t2": "https://evil.example/pay", "b3": f"{sch}://evil.example/proto", "t4": f"{sch}://evil.example/x", "x5": "https://evil.example/svg"}
        check(not F["paypal"] and all(T.get(k) == v for k, v in want.items()), f"{name}: F3 frame — each tooltip is the link's own destination: a span's, a smuggled title's, a protocol-relative link's, an outer div's, an SVG <title>'s ({T}; paypal left on {F['paypal']})")

        # ---- F5 ----
        RAW = "Alice‮ <alice@evil.example>"
        ctl = page.evaluate("([s]) => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;top:0;left:0;font:16px sans-serif;white-space:nowrap'; d.textContent = s; document.body.appendChild(d); const r = (" + LTR + ")(d); d.remove(); return r; }", [RAW])
        check(ctl["gt"] < ctl["lt"], f"{name}: F5 control — drawn raw, U+202E puts the address's '>' left of its '<' (the check sees a reversal: {ctl['lt']:.0f} / {ctl['gt']:.0f})")
        row = page.evaluate("""([k, nm, subj]) => { const t = window.mh.state.threads.get(k); t.fromName = nm; t.subject = subj; window.mh.render(); const el = document.querySelector(`#threads .t[data-key="${k}"]`);
          return el ? { who: el.querySelector('.who').textContent, sub: el.querySelector('.sub bdi')?.textContent ?? null } : null; }""", [KEY, "Alice‮", "Invoice ‮fdp.exe"])
        check(row and not re.search(BIDI, row["who"]) and row["sub"] is not None and not re.search(BIDI, row["sub"]), f"{name}: F5 the row's name has no bidi control and its subject is in a <bdi> without one ({json.dumps(row)})")
        page.evaluate(OPEN, [KEY, TID, "<p>hi</p>", "", "Alice‮", "alice@evil.example"])
        hd = page.evaluate("() => { const m = [...document.querySelectorAll('#msgs .m')].pop(); const fr = m.querySelector('.hdet div span:last-child'); m.querySelector('.hdet').hidden = false; return { from: m.querySelector('.from').textContent, row: fr ? fr.textContent : null }; }")
        geo = page.evaluate("() => { const m = [...document.querySelectorAll('#msgs .m')].pop(); return (" + LTR + ")(m.querySelector('.hdet div span:last-child')); }")
        check(not re.search(BIDI, hd["from"]) and hd["row"] and not re.search(BIDI, hd["row"]) and geo["lt"] < geo["gt"], f"{name}: F5 the header's name and From line carry no bidi control and the address reads left to right ({json.dumps(hd)}, '<' at {geo['lt']:.0f}, '>' at {geo['gt']:.0f})")

        # ---- CONTROL ----
        page.evaluate(OPEN, [KEY, TID, REAL, "", "Bob", "bob@example.com"])
        R = page.evaluate("""() => { const d = document.querySelector('#msgs iframe').contentDocument, a = (i) => d.getElementById(i), im = d.getElementById('i1'), tr = d.getElementById('trk');
          return { c1: [a('c1').getAttribute('href'), a('c1').getAttribute('title')], c2: [a('c2').getAttribute('href'), a('c2').getAttribute('title')], c3: [a('c3').getAttribute('href'), a('c3').getAttribute('title')], c4: [a('c4').getAttribute('href'), a('c4').getAttribute('title')],
            img: [im.getAttribute('src'), im.getAttribute('loading')], trk: [tr.getAttribute('data-mh-tracker'), tr.getAttribute('src').slice(0, 14)], td: d.querySelector('td').getAttribute('background'),
            css: [...d.querySelectorAll('style')].map((s) => s.textContent).join(' ').includes('url(/api/img?u=' + encodeURIComponent('https://cdn.example.com/bg.png')), note: document.querySelector('#msgs .trk')?.textContent || '' }; }""")
        check(R["c1"] == ["https://shop.example/item?id=42", "https://shop.example/item?id=42"] and R["c3"] == ["https://news.example/a?b=1", "https://news.example/a?b=1"],
              f"{name}: CONTROL web links are cleaned and titled, one with a `>` in its own title too ({R['c1']}, {R['c3']})")
        check(R["c2"] == ["mailto:bob@example.com", None] and R["c4"] == ["/local/page", None], f"{name}: CONTROL mailto and relative links are untouched ({R['c2']}, {R['c4']})")
        check(R["img"][0].startswith("/api/img?u=" + "https%3A%2F%2Fcdn.example.com%2Fhero.jpg") and R["img"][1] == "eager" and (R["td"] or "").startswith("/api/img?u=") and R["css"],
              f"{name}: CONTROL pictures go through the proxy, the mail's first one asked for first: <img>, td background, <style> url() ({R['img']}, {R['td']}, css {R['css']})")
        check(R["trk"][0] == "SendGrid" and R["trk"][1] == "data:image/gif" and "SendGrid" in R["note"], f"{name}: CONTROL the tracker is disarmed and named ({R['trk']}, {R['note']!r})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        ctx.close(); b.close()
srv.shutdown()
print("all secfix2 checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
