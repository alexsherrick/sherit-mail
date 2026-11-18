#!/usr/bin/env python3
"""A row whose preview is nothing but invisible characters shows its newest message's first visible text once the body is here.
 WebKit and Chromium, at a Mac window.

A newsletter's row had an empty second line. Its sender wrote no preview text and sent the padding marketing mail puts
after one (zero-width spaces, joiners and direction marks between spaces), so Gmail's snippet, the first ~200 characters, was all
padding. The app showed it as it came. Now such a row reads the first visible text of the newest message from the body cache, or from
cacheThread when the body arrives; the snippet itself is kept.

Checks, on the mock's hub conversations:
  - a padded snippet with no body here leaves the line blank, as before (nothing invented);
  - opening the conversation (the body fetched and cached) fills the row with the message's first visible text, less a heading
    that only repeats the subject (the mail of 2026-11-18 opened with one);
  - a padded snippet whose newest message's body is already cached is filled from the cache;
  - when a newer message arrives, padded and not yet here, the row goes blank again, never showing the older message's text;
  - a snippet with visible text, including one carrying right-to-left marks, is shown exactly as it came;
  - no page errors.
CONTROL=1 also runs the client at 0c2f6c7, whose row stays blank after the conversation is opened.
"""
import subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

FILES = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]
def src(rev, f): return subprocess.run(["git", "show", f"{rev}:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=True).stdout if rev else (preview.CLIENT / f).read_text()
def bundle(rev=None): return "\n".join(src(rev, f) for f in FILES).replace("__VERSION__", "test")

PAD = " ".join(["‌​‍‎‏﻿"] * 28)
K1, T1 = "hub|11111111-1111-1111-1111-111111111111", "11111111-1111-1111-1111-111111111111"
K2 = "hub|22222222-2222-2222-2222-222222222222"
SENT1 = "I'm glad to share a few notes from the trip."
SENT2 = "Three new prints are out this week."
BODY = lambda h, s: f'<div style="display:none;max-height:0;overflow:hidden">{PAD}</div><table><tr><td><h1>{h}</h1><p>{s} More below.</p></td></tr></table>'

RUN = """async ([K1, T1, K2, PAD, BODY1, BODY2, rtl]) => {
  const mh = window.mh, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (k) => { const el = document.querySelector(`.t[data-key="${CSS.escape(k)}"] .snip`); return el ? el.textContent.replace(/[\\u00ad\\u034f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]/g, '').replace(/\\s+/g, ' ').trim() : null; };
  const raw = (k) => document.querySelector(`.t[data-key="${CSS.escape(k)}"] .snip`)?.textContent;
  const out = {};
  // conversation 1: a padded snippet, its body not here
  // (the route is withheld while it is checked: the app fetching it ahead would fill the row, which is the other path)
  const route = 'GET /api/threads/' + T1, r = window.__mock.routes[route]; r.messages.forEach((m) => { m.body_text = ''; m.body_html = BODY1; });
  delete window.__mock.routes[route];
  await mh.idb.delAll('bodies', (await mh.idb.getByIndex('bodies', 'threadKey', K1)).map((x) => x.key)); mh.prerendered.delete(K1);
  const t1 = mh.state.threads.get(K1); t1.snippet = PAD; mh.render(); await wait(400);
  out.blank = vis(K1);
  window.__mock.routes[route] = r;
  await mh.openThread(K1); await wait(600);
  out.opened = vis(K1);
  // conversation 2: a padded snippet, its newest message's body already in the cache
  const t2 = mh.state.threads.get(K2);
  await mh.idb.putAll('bodies', [{ key: 'hub|' + t2.lastMsgId, threadKey: K2, id: t2.lastMsgId, date: t2.date, at: Date.now(), m: { id: t2.lastMsgId, date: t2.date, from: 'News', text: '', html: BODY2, attachments: [] } }]);
  t2.snippet = PAD; mh.render(); await wait(500);
  out.cached = vis(K2);
  // conversation 1 again: a newer message, padded, whose body is not here
  t1.lastMsgId = 'm-newer'; t1.date = Date.now(); mh.render(); await wait(500);
  out.newer = vis(K1);
  // visible snippets are left as they came
  t2.snippet = rtl; mh.render(); await wait(200);
  out.rtl = raw(K2);
  return out; }"""

fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

def run(engine, tag, control=False):
    b = engine.launch(); page = b.new_page(viewport={"width": 1000, "height": 740}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    rtl = "‏שלום ‎and hello"
    r = page.evaluate(RUN, [K1, T1, K2, PAD, BODY("Hello there", SENT1), BODY("Notes", SENT2), rtl]); r["errs"] = errs
    if not control:
        check(r["blank"] == "", f"{tag}: a padded preview with no body here stays blank ({r['blank']!r})")
        check(r["opened"] == f"{SENT1} More below.", f"{tag}: opening the conversation fills the row with its first visible text, less a heading that repeats the subject ({r['opened']!r})")
        check(r["cached"] == f"Notes {SENT2} More below.", f"{tag}: a padded preview whose body is cached is filled from the cache ({r['cached']!r})")
        check(r["newer"] == "", f"{tag}: a newer padded message not yet here blanks the row, never the older text ({r['newer']!r})")
        check(r["rtl"] == rtl, f"{tag}: a visible preview with right-to-left marks is shown as it came ({r['rtl']!r})")
        check(not errs, f"{tag}: no page errors {errs[:2]}")
    b.close(); return r

srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        preview.BUNDLE = bundle(); run(engine, engine.name)
    if preview.CONTROL:   # 0c2f6c7: the row shows Gmail's snippet as it came
        preview.BUNDLE = bundle("0c2f6c7"); r = run(pw.chromium, "0c2f6c7", control=True)
        check(r["opened"] == "" and r["cached"] == "", f"CONTROL: the client at 0c2f6c7 leaves both padded rows blank (opened {r['opened']!r}, cached {r['cached']!r})")
    else:
        preview.control_skipped("blanksnip")
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all blank-preview checks passed")
sys.exit(1 if fails else 0)
