#!/usr/bin/env python3
"""A link on a line of its own in what you write shows its page's preview, and the mail carries it as a card, as
Apple Mail's rich links. In WebKit and Chromium with the app's fake network (test/mock-fetch.js) answering the hub's /api/unfurl:
  - typing a link alone on a line in the compose window shows its title, site and description under the box;
  - a link inside a sentence, or in the quoted mail, gets none;
  - sent, the mail's HTML part has the card (a link to the page, the page's picture, title, description) where the link was, and its
    text part keeps the link as written;
  - × sends it without the card;
  - with Markdown on, the paragraph that is the link alone becomes the card;
  - the reply box does the same, its quote kept as a quote;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the preview checks.
Usage: python3 test/linkpreviews.py"""
import os, sys, json, urllib.parse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
URL = "https://news.example/story?id=7&src=mail"
PV = {"url": URL, "title": "Rates & the grid $& $` more", "description": "A look at peak pricing.", "image": "https://news.example/img/hero.jpg", "site": "The News"}
SETUP = "window.__mockSetup = (mk) => { mk.routes[%s] = { preview: %s }; mk.routes[%s] = { preview: null }; };" % (
    json.dumps("GET /api/unfurl?u=" + urllib.parse.quote(URL, safe="~()*!'-._")), json.dumps(PV), json.dumps("GET /api/unfurl?u=" + urllib.parse.quote("https://other.example/x", safe="~()*!'-._")))
CAPTURE = "() => { window.__rows = []; const q = window.mh.queue; q.add = async (row) => { window.__rows.push(JSON.parse(JSON.stringify(row))); return { key: 'cap' + window.__rows.length }; }; }"
TYPE = """async ([text, md]) => { window.__rows = []; window.mh.openCompose(); await new Promise((r) => setTimeout(r, 200));
  document.querySelector('#cto').value = 'pat@friend.example'; document.querySelector('#csub').value = 'Read this'; const md0 = document.querySelector('#cmd'); if (md0) md0.checked = !!md;
  const t = document.querySelector('#ctext'); t.value = text; t.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 1200));
  const strip = document.querySelector('#ctext').parentElement.querySelector(':scope > .lpv'); return strip ? strip.innerText : ''; }"""
SEND = """async () => { document.querySelector('#csend').click(); await new Promise((r) => setTimeout(r, 1200)); const row = window.__rows.find((x) => x.op === 'send'); const d = row ? row.args.draft : {};
  return { text: d.text || '', html: d.html || '' }; }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(SETUP)
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate(CAPTURE)
        strip = page.evaluate(TYPE, [f"Worth a read:\n{URL}\n\nAlso see https://other.example/x in passing.", False])
        check("Rates & the grid $& $` more" in strip and "The News" in strip and "A look at peak pricing." in strip, f"{name}: a link alone on a line shows its preview under the box ({strip!r})")
        check(strip.count("Rates & the grid") == 1 and "other.example" not in strip, f"{name}: a link inside a sentence gets none")
        s = page.evaluate(SEND)
        h = s["html"]
        check('<a href="https://news.example/story?id=7&amp;src=mail"' in h and 'src="https://news.example/img/hero.jpg"' in h and "Rates &amp; the grid $&amp; $` more" in h and "A look at peak pricing." in h and h.find("Worth a read:") < h.find("Rates &amp; the grid") and h.count("Worth a read:") == 1, f"{name}: the mail's HTML has the card where the link was ({len(h)} chars)")
        check(URL in s["text"] and "<table" not in s["text"], f"{name}: its text part keeps the link as written")
        page.evaluate("() => document.querySelector('#cmodal').classList.remove('on')")
        # × takes it off
        page.evaluate(TYPE, [f"Look:\n{URL}", False])
        page.evaluate("() => document.querySelector('#ctext').parentElement.querySelector(':scope > .lpv [data-lpx]').click()"); preview.settle(page, 300)
        s2 = page.evaluate(SEND)
        check("<table" not in s2["html"] and URL in s2["text"], f"{name}: × sends it without the card ({len(s2['html'])} chars of HTML)")
        page.evaluate("() => document.querySelector('#cmodal').classList.remove('on')")
        # Markdown on
        page.evaluate(TYPE, [f"**Read** this:\n\n{URL}\n\nThanks", True])
        s3 = page.evaluate(SEND)
        check("$&amp; $` more" in s3["html"] and s3["html"].count("<b>Read</b>") == 1, f"{name}: with Markdown, a title's \"$&\" is text, not a copy of the message ({s3['html'].count('<b>Read</b>')} bold)")
        check("<b>Read</b>" in s3["html"] and 'href="https://news.example/story?id=7&amp;src=mail"' in s3["html"] and "<table" in s3["html"], f"{name}: with Markdown on, the link's paragraph becomes the card ({s3['html'][:160]!r})")
        page.evaluate("() => document.querySelector('#cmodal').classList.remove('on')")
        # the reply box
        key = page.evaluate("() => [...window.mh.state.threads.values()].find((t) => t.kind === 'hub').key")
        page.evaluate("async (k) => { await window.mh.openThread(k); }", key); preview.settle(page, 600)
        rr = page.evaluate("""async (u) => { window.__rows = []; const t = document.querySelector('#rtext'); t.value = 'Here it is:\\n' + u; t.dispatchEvent(new Event('input')); await new Promise((r) => setTimeout(r, 1200));
          const strip = t.parentElement.querySelector(':scope > .lpv'); const shown = strip ? strip.innerText : '';
          document.querySelector('#rsend').click(); await new Promise((r) => setTimeout(r, 1200)); const row = window.__rows.find((x) => x.op === 'send'); return { shown, html: row ? row.args.draft.html || '' : '' }; }""", URL)
        check("Rates & the grid $& $` more" in rr["shown"] and "<table" in rr["html"] and "Here it is:" in rr["html"], f"{name}: the reply box shows it and sends the card ({len(rr['html'])} chars)")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all link-preview checks passed")
sys.exit(1 if fails else 0)
