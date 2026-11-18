#!/usr/bin/env python3
"""One tap unsubscribes: the mail and the sender's other promotions leave at once, nothing opens, and the hub is told 5 s later.


Unsubscribing must be quick to roll through (5-15 s was too slow), and a sender's order mail must stay while
its promotions go. And before that: unsubscribing from the
list must not open the next mail, and a page that says "you've been unsubscribed" must never open.

WebKit and Chromium, a 390 x 844 phone (touch in Chromium) and a 1400 x 860 Mac window, a fresh browser profile per case:
  - phone, from the list after reading a mail: Unsubscribe in the long-press menu shows no card; the row is gone in the next frame,
    no mail opens, no page opens, nothing reaches the hub for 5 s, then exactly one job with the conversation and the sender;
  - phone: Undo within the 5 s puts every row back and the hub is never told;
  - phone: the sender's other promotion leaves with it; its order (a shipped subject), its mail without List-Unsubscribe, a Gmail
    row filed under Updates, and another sender's mail stay;
  - phone, inside the mail: the next conversation opens, skipping the sender's own;
  - phone: the app is closed 2 s after the tap; the job goes out when it is opened again;
  - phone: mail in Spam offers Block and tells the hub nothing;
  - Mac: Escape back to the list, the row's Unsubscribe button: no card, no mail opens, one job.
CONTROL: APP_JS_SRC=<an app.js before the change> fails the one-tap, the 5 s hold and the sweep cases. Usage: python3 test/unsubnext.py"""
import os, sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
LINK = "https://list.example/unsub?id=42"
# Every boot (a reload too): the job route answers, and every request body to /api/unsubscribe* is kept in sessionStorage.
INIT = """window.__mockSetup = (m) => { m.routes['POST /api/unsubscribe/job'] = { ok: true }; m.routes['POST /api/unsubscribe'] = { ok: true, status: 200, confirmed: true }; m.routes['GET /api/unsubscribes'] = { unsubscribes: [] }; };
  window.addEventListener('DOMContentLoaded', () => { const f = window.fetch; window.fetch = (u, o = {}) => { if (String(u).includes('/api/unsubscribe')) { const k = JSON.parse(sessionStorage.getItem('ub') || '[]'); k.push({ u: String(u), b: String(o.body || ''), at: Date.now() }); sessionStorage.setItem('ub', JSON.stringify(k)); } return f(u, o); }; });
  window.open = (u) => { const k = JSON.parse(sessionStorage.getItem('opens') || '[]'); k.push(String(u)); sessionStorage.setItem('opens', JSON.stringify(k)); return null; };"""
# rows whose trash routes the mock has, not the last one shown, not the user's own; each gets a one-click List-Unsubscribe
PICK = """(n) => { const ks = [...document.querySelectorAll('#threads .t[data-key]')].map((d) => d.dataset.key);
  const ok = (k) => (/\\|g[123]$/.test(k) || /\\|(1111|3333|4444)/.test(k)) && !window.mh.state.threads.get(k).out;
  const c = ks.map((k, j) => [k, ks[j + 1]]).filter(([k, nx]) => ok(k) && nx);
  for (const [k] of c) { const t = window.mh.state.threads.get(k); t.unsub = '<""" + LINK + """>'; t.unsubPost = 'List-Unsubscribe=One-Click'; t.unsubKnown = true; if (t.kind === 'gmail') t.labels = [...new Set([...(t.labels || []), 'CATEGORY_PROMOTIONS'])]; }
  return c.slice(0, n).map(([k, nx]) => ({ x: k, next: nx })); }"""
STATE = """(k) => ({ viewing: document.querySelector('#app').classList.contains('viewing'), cur: window.mh.state.cur, ask: !!document.querySelector('#ask.on'),
  layers: window.mh.layers.filter((l) => !l.spent).map((l) => l.name), listed: [...document.querySelectorAll('#threads .t[data-key]')].some((d) => d.dataset.key === k),
  state: window.mh.state.threads.get(k)?.state, opens: JSON.parse(sessionStorage.getItem('opens') || '[]'), bodies: JSON.parse(sessionStorage.getItem('ub') || '[]'),
  toast: document.querySelector('#toast')?.style.display === 'block' ? document.querySelector('#toast').textContent : '' })"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
def fresh(b, n, phone):
    touch = phone and n == "chromium"
    size = {"width": 390, "height": 844} if phone else {"width": 1400, "height": 860}
    ctx = b.new_context(viewport=size, has_touch=touch, is_mobile=touch); ctx.add_init_script(INIT); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    return ctx, page, errs
def open_row(page, k):   # a click on the row, as a finger or the mouse does it
    page.evaluate("k => [...document.querySelectorAll('#threads .t[data-key]')].find((d) => d.dataset.key === k).click()", k); preview.settle(page, 600)
# The long-press menu's Unsubscribe, and whether the row was gone at the next frame after the tap.
MENU_TAP = """async (k) => { window.mh.openMenuFor(window.mh.state.threads.get(k)); await new Promise((r) => setTimeout(r, 200));
  document.querySelector('#menu [data-m=unsubscribe]').click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { gone: ![...document.querySelectorAll('#threads .t[data-key]')].some((d) => d.dataset.key === k), ask: !!document.querySelector('#ask.on') }; }"""
def jobs(s): return [json.loads(x["b"]) for x in s["bodies"] if x["u"].endswith("/api/unsubscribe/job")]
def other_calls(s): return [x for x in s["bodies"] if x["u"].split("?")[0].endswith("/api/unsubscribe")]   # the old endpoint; the list's own GET /api/unsubscribes is not one

def phone_cases(b, n):
    # ---- from the list, after reading a mail ----
    ctx, page, errs = fresh(b, n, True); r = page.evaluate(PICK, 1)
    if not r: check(False, f"{n} phone: no row to act on"); ctx.close(); return
    x, nx = r[0]["x"], r[0]["next"]; t = page.evaluate("k => { const t = window.mh.state.threads.get(k); return { id: t.id, account: t.kind === 'gmail' ? t.account : 'hub', sender: t.fromAddr }; }", x)
    open_row(page, x); page.click("#back"); preview.settle(page, 400)
    tap = page.evaluate(MENU_TAP, x)
    check(not tap["ask"], f"{n} phone: no confirm card (ask shown: {tap['ask']})")
    check(tap["gone"], f"{n} phone: the row is gone at the next frame")
    preview.settle(page, 1500); s = page.evaluate(STATE, x)
    check(s["state"] == "trash" and not s["viewing"] and s["cur"] != nx and "thread" not in s["layers"], f"{n} phone, from the list: trashed, and no mail opens (viewing {s['viewing']}, cur {s['cur']}, layers {s['layers']})")
    check(s["toast"].startswith("Unsubscribed from") and "Undo" in s["toast"], f"{n} phone: one toast, with Undo ({s['toast']!r})")
    check(jobs(s) == [] and other_calls(s) == [], f"{n} phone: nothing reaches the hub inside the 5 s ({len(s['bodies'])} calls)")
    preview.settle(page, 5000); s = page.evaluate(STATE, x); j = jobs(s)
    check(len(j) == 1 and j[0].get("thread") == t["id"] and j[0].get("account") == t["account"] and j[0].get("sender") == t["sender"] and len(j[0].get("id", "")) >= 8,
          f"{n} phone: after the 5 s, one job: the conversation and the sender, no URL ({j})")
    check(not any("url" in x for x in j) and other_calls(s) == [], f"{n} phone: the app sends no unsubscribe link and calls no old endpoint")
    check(s["opens"] == [], f"{n} phone: no page opens ({s['opens']})")
    check(not errs, f"{n} phone: no page errors {errs[:2]}"); ctx.close()

    # ---- Undo inside the 5 s ----
    ctx, page, errs = fresh(b, n, True); r = page.evaluate(PICK, 1); x = r[0]["x"]
    page.evaluate(MENU_TAP, x); preview.settle(page, 2500)
    page.evaluate("() => document.querySelector('#toast button')?.click()"); preview.settle(page, 5000); s = page.evaluate(STATE, x)
    check(s["state"] == "inbox" and s["listed"] and jobs(s) == [], f"{n} phone: Undo at 2.5 s puts it back and the hub is never told ({s['state']}, listed {s['listed']}, jobs {jobs(s)})")
    ctx.close()

    # ---- the sweep: the sender's other promotion leaves, its order and the rest stay ----
    ctx, page, errs = fresh(b, n, True); r = page.evaluate(PICK, 4)
    if len(r) < 4: check(False, f"{n} phone: not enough rows for the sweep case ({len(r)})"); ctx.close(); return
    ks = [z["x"] for z in r]
    kinds = page.evaluate("""(ks) => { const [a, b, c, d] = ks.map((k) => window.mh.state.threads.get(k)); const s = a.fromAddr;
      b.fromAddr = s; b.subject = 'Buy 5, get 5 free'; c.fromAddr = s; c.subject = 'Your order #1234 has shipped'; d.fromAddr = s; d.subject = 'Weekend sale'; d.count = 2; d.labels = [...new Set([...(d.labels || []), 'CATEGORY_PROMOTIONS'])];
      window.mh.render(); return ks.map((k) => window.mh.state.threads.get(k).kind); }""", ks)
    # a Gmail row from the sender filed under Updates, added when the list has one (the mock's Gmail rows)
    upd = page.evaluate("""(s) => { const g = [...window.mh.state.threads.values()].find((t) => t.kind === 'gmail' && t.state === 'inbox' && !t.out && t.fromAddr !== s && /\\|g[123]$/.test(t.key));
      if (!g) return null; g.fromAddr = s; g.unsub = '<https://x.example/u>'; g.labels = (g.labels || []).filter((l) => l !== 'CATEGORY_PROMOTIONS').concat(['CATEGORY_UPDATES']); g.subject = 'Your next play could pay off'; return g.key; }""", page.evaluate("k => window.mh.state.threads.get(k).fromAddr", ks[0]))
    page.evaluate(MENU_TAP, ks[0]); preview.settle(page, 800)
    st = page.evaluate("ks => ks.map((k) => window.mh.state.threads.get(k)?.state)", ks + ([upd] if upd else []))
    check(st[0] == "trash" and st[1] == "trash", f"{n} phone: the mail and the sender's other promotion go ({st[:2]})")
    check(st[2] == "inbox" and st[3] == "inbox", f"{n} phone: the order stays, and so does a two-message conversation even when it reads as a promotion (the hub judges each of its messages) ({st[2:4]})")
    if upd: check(st[4] == "inbox", f"{n} phone: a Gmail row of theirs filed under Updates stays ({st[4]})")
    s = page.evaluate(STATE, ks[0]); check("1 more of their promotions trashed" in s["toast"], f"{n} phone: the toast says how many more went ({s['toast']!r})")
    page.evaluate("() => document.querySelector('#toast button')?.click()"); preview.settle(page, 150)
    st = page.evaluate("ks => ks.map((k) => window.mh.state.threads.get(k)?.state)", ks[:2])
    check(st == ["inbox", "inbox"], f"{n} phone: Undo at 0.8 s brings both back at once ({st})")
    preview.settle(page, 6000); s = page.evaluate(STATE, ks[0])
    check(jobs(s) == [], f"{n} phone: and the hub is never told ({jobs(s)})")
    ctx.close()

    # ---- inside the mail: the next conversation opens, never another from that sender ----
    ctx, page, errs = fresh(b, n, True); r = page.evaluate(PICK, 3)
    x, nx = r[0]["x"], r[0]["next"]
    nxt = page.evaluate("""([x, nx]) => { const a = window.mh.state.threads.get(x), b = window.mh.state.threads.get(nx); b.fromAddr = a.fromAddr; b.unsub = ''; window.mh.render();
      const ks = [...document.querySelectorAll('#threads .t[data-key]')].map((d) => d.dataset.key); const i = ks.indexOf(x);
      return ks.slice(i + 1).find((k) => window.mh.state.threads.get(k).fromAddr !== a.fromAddr) || null; }""", [x, nx])
    open_row(page, x); page.evaluate(MENU_TAP, x); preview.settle(page, 1200); s = page.evaluate(STATE, x)
    check(s["state"] == "trash" and s["viewing"] and s["cur"] == nxt and s["cur"] != nx, f"{n} phone, inside the mail: the next one from someone else opens (cur {s['cur']}, expected {nxt}, skipped {nx})")
    ctx.close()

    # ---- closed 2 s after the tap: the job goes out on the next launch ----
    ctx, page, errs = fresh(b, n, True); r = page.evaluate(PICK, 1); x = r[0]["x"]
    page.evaluate(MENU_TAP, x); preview.settle(page, 2000)
    page.goto("about:blank"); preview.settle(page, 4500)
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
    try: page.wait_for_function("() => JSON.parse(sessionStorage.getItem('ub') || '[]').some((x) => x.u.endsWith('/api/unsubscribe/job'))", timeout=12000)
    except Exception: pass
    s = page.evaluate(STATE, x)
    check(len(jobs(s)) == 1, f"{n} phone: closed inside the 5 s, the job goes out when the app opens again ({len(jobs(s))} job(s))")
    ctx.close()

    # ---- a long left swipe set to Unsubscribe slides the row off, as Trash does, and never snaps it back first (Chromium: real touch) ----
    if n == "chromium":
        ctx, page, errs = fresh(b, n, True); r = page.evaluate(PICK, 1); x = r[0]["x"]
        page.evaluate("""(k) => { const pr = window.mh.state.prefs; pr.swipes = { ...pr.swipes, leftLong: 'unsubscribe' };
          const el = [...document.querySelectorAll('#threads .t[data-key]')].find((d) => d.dataset.key === k); window.__tf = []; window.__released = false;
          new MutationObserver(() => { if (window.__released) window.__tf.push(el.isConnected ? (el.style.transform || 'none') : 'gone'); }).observe(el, { attributes: true, attributeFilter: ['style'] }); }""", x)
        box = page.evaluate("k => { const r = [...document.querySelectorAll('#threads .t[data-key]')].find((d) => d.dataset.key === k).getBoundingClientRect(); return { y: r.top + r.height / 2, w: r.width }; }", x)
        cdp = ctx.new_cdp_session(page); y = box["y"]; x0, x1 = box["w"] - 20, 40
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}]})
        for i in range(1, 15): cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / 14, "y": y}]}); page.wait_for_timeout(16)
        page.evaluate("() => { window.__released = true; }"); cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []}); preview.settle(page, 900)
        tf = page.evaluate("() => window.__tf"); s = page.evaluate(STATE, x)
        check(s["state"] == "trash" and not s["listed"], f"{n} phone: the long swipe unsubscribes ({s['state']}, listed {s['listed']})")
        check(any("-110%" in v for v in tf) and not any(v in ("none", "") or v.startswith("translateX(0") for v in tf), f"{n} phone: the row slides off and never snaps back first ({tf[:6]})")
        ctx.close()

    # ---- Spam: Block is offered, the hub is told nothing ----
    ctx, page, errs = fresh(b, n, True); r = page.evaluate(PICK, 1); x = r[0]["x"]
    page.evaluate("k => { const t = window.mh.state.threads.get(k); t.labels = [...(t.labels || []), 'SPAM']; t.state = 'spam'; }", x)
    page.evaluate("k => { window.mh.act(window.mh.state.threads.get(k), 'unsubscribe'); }", x); preview.settle(page, 700)
    s = page.evaluate(STATE, x); txt = page.evaluate("() => document.querySelector('#ask.on')?.textContent || ''")
    check(s["ask"] and "Spam" in txt and "Block" in txt, f"{n} phone: mail in Spam offers Block instead ({txt[:80]!r})")
    page.evaluate("() => document.querySelector('#ask.on button:not(.danger)')?.click()"); preview.settle(page, 5600); s = page.evaluate(STATE, x)
    check(jobs(s) == [], f"{n} phone: and no job is sent for it")
    ctx.close()

UNSUBS = [
  {"id": "u-needs-1", "created_at": "2026-10-21T15:00:00.000Z", "account": "me@gmail.com", "thread_id": "abc123", "sender": "hello@pagey.example", "status": "done", "outcome": "needs_you", "method": "page", "answer": "pagey.example's page (200) does not say it is done", "url": "https://pagey.example/u?id=9", "swept": 0, "kept": 0, "still_count": 0},
  {"id": "u-still-1", "created_at": "2026-09-01T15:00:00.000Z", "account": "me@gmail.com", "thread_id": "abc124", "sender": "no-reply@stilly.example", "status": "done", "outcome": "accepted", "method": "one-click", "answer": "stilly.example answered 200", "swept": 3, "kept": 1, "still_count": 2, "still_at": "2026-10-20T15:00:00.000Z", "still_subject": "Big sale"},
  {"id": "u-done-1", "created_at": "2026-10-21T16:00:00.000Z", "account": "me@gmail.com", "thread_id": "abc125", "sender": "news@fine.example", "status": "done", "outcome": "accepted", "method": "one-click", "answer": "fine.example answered 200", "swept": 2, "kept": 0, "still_count": 0},
]
def list_cases(b, n):
    ctx, page, errs = fresh(b, n, False)
    page.evaluate("(u) => { window.__mock.routes['GET /api/unsubscribes'] = { unsubscribes: u }; window.__mock.routes['POST /api/unsubscribes/u-needs-1'] = { ok: true }; }", UNSUBS)
    page.evaluate("() => window.mh.openSettings('unsubscribes')"); preview.settle(page, 900)
    badge = page.evaluate("() => document.querySelector('#settingsBtn .nbadge')?.textContent || ''")
    check(badge == "2", f"{n}: the Settings button counts the two that need you ({badge!r})")
    sec = page.evaluate("() => { const s = document.querySelector('#scard [data-sec=unsubscribes]'); return s && !s.hidden ? s.innerText : ''; }")
    check("hello@pagey.example" in sec and "no-reply@stilly.example" in sec and "news@fine.example" in sec, f"{n}: the list shows every unsubscribe ({sec[:120]!r})")
    check("Still mailing after 10 business days: 2" in sec and "Big sale" in sec, f"{n}: the sender still mailing says so, with its last subject")
    check("3 more of their promotions trashed" in sec and "1 of their mails kept" in sec, f"{n}: what the sweep took and what it kept are shown")
    s = page.evaluate(STATE, "x"); check(s["opens"] == [], f"{n}: no page opens on its own ({s['opens']})")
    page.evaluate("() => document.querySelector('[data-unopen=\"u-needs-1\"]').click()"); preview.settle(page, 300)
    s = page.evaluate(STATE, "x"); check(s["opens"] == ["https://pagey.example/u?id=9"], f"{n}: Open page opens that page, once, on the tap ({s['opens']})")
    page.evaluate("() => document.querySelector('[data-unanswer=done][data-unid=\"u-needs-1\"]').click()"); preview.settle(page, 600)
    s = page.evaluate(STATE, "x"); posted = [json.loads(x["b"]) for x in s["bodies"] if x["u"].endswith("/api/unsubscribes/u-needs-1")]
    check(posted == [{"answer": "done"}], f"{n}: Done tells the hub the page was finished by hand ({posted})")
    blocks0 = page.evaluate("() => window.__mock.calls.filter((c) => c === 'POST /api/senders').length")
    page.evaluate("() => document.querySelector('[data-unblock=\"u-still-1\"]').click()"); preview.settle(page, 400)
    txt = page.evaluate("() => document.querySelector('#ask.on')?.textContent || ''")
    check("receipts" in txt and "no-reply@stilly.example" in txt, f"{n}: Block warns that receipts go to Trash too ({txt[:90]!r})")
    page.evaluate("() => document.querySelector('#ask.on button.danger')?.click()"); preview.settle(page, 700)
    calls = page.evaluate("() => window.__mock.calls.filter((c) => c === 'POST /api/senders').length") - blocks0
    check(calls == 1, f"{n}: and blocks the sender only when that is confirmed ({calls} block call)")
    check(not errs, f"{n}: no page errors {errs[:2]}"); ctx.close()

def mac_cases(b, n):
    ctx, page, errs = fresh(b, n, False); r = page.evaluate(PICK, 2)
    if len(r) < 2: check(False, f"{n} Mac: not enough rows to act on {r}"); ctx.close(); return
    x, nx = r[0]["x"], r[0]["next"]
    open_row(page, x); page.keyboard.press("Escape"); preview.settle(page, 400); s = page.evaluate(STATE, x)
    check(not s["viewing"] and s["cur"] == x, f"{n} Mac: Escape closes the mail and leaves it the current one ({s['viewing']}, {s['cur']})")
    page.evaluate("k => [...document.querySelectorAll('#threads .t[data-key]')].find((d) => d.dataset.key === k).querySelector('.quick [data-q=unsubscribe]').click()", x); preview.settle(page, 700)
    s = page.evaluate(STATE, x)
    check(not s["ask"] and s["state"] == "trash" and not s["listed"] and not s["viewing"], f"{n} Mac, from the list: the row's Unsubscribe button, no card, no mail opens (ask {s['ask']}, viewing {s['viewing']}, cur {s['cur']})")
    preview.settle(page, 5300); s = page.evaluate(STATE, x)
    check(len(jobs(s)) == 1 and s["opens"] == [], f"{n} Mac: one job after the 5 s, and no page ({len(jobs(s))}, opens {s['opens']})")
    check(not errs, f"{n} Mac: no page errors {errs[:2]}"); ctx.close()

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        try: b = engine.launch()
        except Exception as e: check(False, f"{engine.name}: browser not installed ({str(e).splitlines()[0]})"); continue
        phone_cases(b, engine.name); mac_cases(b, engine.name); list_cases(b, engine.name); b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all unsubnext checks passed")
