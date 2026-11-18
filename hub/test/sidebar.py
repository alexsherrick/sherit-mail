#!/usr/bin/env python3
"""The slim sidebar, on WebKit (the Mac app) and Chromium, at a Mac window and a touch phone:
- the sidebar lists Inbox and its accounts, Unread, Pins, Sent, Drafts, Archive and More; no Smart inbox rows, no Feed row, no
  section heads; More opens Trash, Spam, All mail, Snoozed, Reply later, Set aside, Held and Snoozes & reminders, stays as it was left
  after a reload, and is lit while closed over one of its folders; going to one account's Trash opens it;
- the chips above an inbox list carry the unread counts the Smart inbox rows showed; Newsletters has a Cards switch that is Feed;
- domain mail names its domain in the unified inbox, in the Domains entry's colour, a short name two domains share in full;
- the business inbox: its rows name their domain; chips list the domains with mail in the list (none for a domain without), with
  their unread counts; a chip narrows the list to that domain and lights, the rows drop their names, the category chips keep it, the
  phone's title says which; tapped again, every domain;
- Settings > Domains: a switch gives a domain its own row (synced as ownRows); the Domains entry, its count and its list leave that
  domain out; the domain's rows read its own row's name and colour; switched off, it is back under Domains;
- the look: the selected row is a pale wash, not a solid fill with white text; a badge is a pale tile, its letter at least 4.5:1 on it
  for every colour tried, light and dark; the hub's badges are squares, the others circles; with a pointer a closed folder's arrow
  shows only under the pointer (More's always), on a phone all of them.
CONTROL: APP_JS_SRC=<app.js before the change> APP_HTML_SRC=<app.html before it> fails the checks the change is for.
Usage: python3 test/sidebar.py (exit 1 on any failed check)"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js and app.html
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
if os.environ.get("APP_HTML_SRC"):
    N = preview.NONCE
    preview.SHELL = Path(os.environ["APP_HTML_SRC"]).read_text().replace("__VERSION__", "test").replace("__NONCE__", N).replace(
        f'<script nonce="{N}" src="/app.js?v=test"></script>', f'<script nonce="{N}" src="/mock-fetch.js"></script><script nonce="{N}" src="/app.js"></script>')
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

DOMS = ["domain2.example", "yourdomain.example", "zone.example", "zone.test"]
# Four domains under Domains ("business", #123456): mail in the inbox for three of them (zone.example's is archived), two unread
# conversations at yourdomain.example, one each at domain2.example and zone.test; the mock's own hub mail goes to Archive so it cannot count.
SEED = """() => { const S = window.mh.state;
  S.me.identities = [['sam', 'yourdomain.example'], ['sam', 'domain2.example'], ['sam', 'zone.test'], ['hello', 'zone.example']].map(([u, d]) => ({ email: u + '@' + d, display_name: 'Sam', domain: d }));
  S.prefs.acctNames = { hub: 'business' }; S.prefs.acctColors = { hub: '#123456' }; delete S.prefs.ownRows; delete S.prefs.splitDomains; S.prefs.setAside = [];
  const all = [...S.threads.values()], h = all.find((t) => t.kind === 'hub' && !t.out);
  for (const t of all) if (t.kind === 'hub') t.state = 'archived';
  let i = 0; const now = Date.now(), mk = (id, dom, over) => { const t = { ...h, id, key: 'hub|' + id, identity: (dom === 'zone.example' ? 'hello@' : 'sam@') + dom, out: false, hasOut: false, date: now - 60000 * ++i, labels: [], fromAddr: id + '@sender.example', fromName: 'Sender ' + id, ...over }; S.threads.set(t.key, t); return t.key; };
  const k = window.__k = { sl1: mk('sb1', 'yourdomain.example', { state: 'inbox', unread: true, cat: 'personal', subject: 'SL one' }),
    sl2: mk('sb2', 'yourdomain.example', { state: 'inbox', unread: true, cat: 'notifications', subject: 'SL two' }),
    sl3: mk('sb3', 'yourdomain.example', { state: 'inbox', unread: false, cat: 'newsletters', subject: 'SL three' }),
    oe1: mk('sb4', 'domain2.example', { state: 'inbox', unread: true, cat: 'notifications', subject: 'OE one' }),
    sk1: mk('sb5', 'zone.test', { state: 'inbox', unread: true, cat: 'newsletters', subject: 'SK one' }),
    sc1: mk('sb6', 'zone.example', { state: 'archived', unread: false, cat: 'personal', subject: 'SC archived' }) };
  prerendered.clear(); window.mh.setView('inbox'); window.mh.render(); return k; }"""
NAV = """() => { const out = []; for (const a of document.querySelectorAll('#nav a')) out.push((a.dataset.view || (a.dataset.more ? 'MORE' : a.dataset.split ? 'split' : '?')) + (a.dataset.account ? '/' + a.dataset.account : '') + (a.classList.contains('on') ? '*' : ''));
  return { rows: out, heads: document.querySelectorAll('#nav .h').length }; }"""
CHIPS = """() => [...document.querySelectorAll('#chips button')].map((b) => ({ k: b.dataset.cat || (b.dataset.dom ? 'dom:' + b.dataset.dom : b.dataset.feed ? 'feed' : b.dataset.blanket ? 'b:' + b.dataset.blanket : '?'), text: b.textContent.trim(), n: b.querySelector('.cn')?.textContent || '', on: b.classList.contains('on') }))"""
ROWS = """() => [...document.querySelectorAll('#threads .t[data-key]')].map((r) => { const t = window.mh.state.threads.get(r.dataset.key), a = r.querySelector('.when .acl');
  return { key: r.dataset.key, kind: t && t.kind, dom: t && (t.identity || '').split('@')[1], tag: a ? a.textContent : null, ac: a ? a.style.getPropertyValue('--ac').trim() : null }; })"""
# The counts the sidebar's Smart inbox rows showed, from the app's own counter
OLD_COUNTS = "() => { const c = counts(); return { inbox: c.inbox, personal: c.personal, notifications: c.notifications, newsletters: c.newsletters }; }"
LOOK = """() => { const on = document.querySelector('#nav a.on'), s = on && getComputedStyle(on), acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim();
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgb = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const dots = [...document.querySelectorAll('#nav a[data-view="inbox"][data-account] .dot')].map((d) => ({ acct: d.closest('a').dataset.account, r: parseFloat(getComputedStyle(d).borderTopLeftRadius), w: d.getBoundingClientRect().width }));
  return { onBg: s && rgb(s.backgroundColor), acc: rgb(acc), onFg: s && rgb(s.color), dots }; }"""
# Every colour tried, through the real stylesheet: the letter's contrast on its badge (WCAG ratio), the worst one
DOT_CONTRAST = """(colors) => { const nav = document.createElement('nav'); nav.className = 'nav'; nav.style.cssText = 'position:fixed;left:-500px;top:0'; document.body.appendChild(nav);
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgb = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  let min = 99, at = '', solid = 0;
  for (const c of colors) { const a = document.createElement('a'), d = document.createElement('span'); d.className = 'dot'; d.style.setProperty('--c', c); d.textContent = 'A'; a.appendChild(d); nav.appendChild(a);
    const s = getComputedStyle(d), bg = lum(s.backgroundColor), fg = lum(s.color), ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    if (ratio < min) { min = ratio; at = c; } if (rgb(s.backgroundColor).join() === rgb(c).join()) solid++; }
  nav.remove(); return { min: Math.round(min * 100) / 100, at, solid }; }"""
COLORS = ["#123456", "#3b5bdb", "#2b8a3e", "#e03131", "#ff8c82", "#9c36b5", "#f97316", "#fab005", "#64748b", "#aa3366", "#22b8cf", "#000000", "#ffffff"]

def ready(page):
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 500)
    page.evaluate("() => { try { localStorage.removeItem('mh_nav_open'); } catch (_) {} }")
    return page.evaluate(SEED)
def nav(page): preview.settle(page, 150); return page.evaluate(NAV)
def tap(page, sel):   # a click through the DOM, so a missing element is a failed check, not a crash
    ok = page.evaluate("(s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }", sel); preview.settle(page, 200); return ok
def top(rows): return [r.rstrip("*") for r in rows if "/" not in r]

def desktop(b, name):
    ctx = b.new_context(viewport={"width": 1400, "height": 860}); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    k = ready(page); n = nav(page)
    check(top(n["rows"]) == ["inbox", "unread", "starred", "sent", "drafts", "archived", "MORE"] and n["heads"] == 0,
          f"{name}: the sidebar is Inbox, Unread, Pins, Sent, Drafts, Archive and More, with no section heads ({top(n['rows'])}, heads {n['heads']})")
    check(not any(r.split("/")[0].rstrip("*") in ("personal", "notifications", "newsletters", "feed") for r in n["rows"]), f"{name}: no Smart inbox rows and no Feed row")
    tap(page, '#nav a[data-more]'); n = nav(page)
    more = top(n["rows"])[top(n["rows"]).index("MORE") + 1:] if "MORE" in top(n["rows"]) else []
    check(more == ["trash", "spam", "all", "snoozed", "replylater", "aside", "held", "scheduled"], f"{name}: More opens Trash, Spam, All mail, Snoozed, Reply later, Set aside, Held, Snoozes & reminders ({more})")
    page.reload(); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 500); k = page.evaluate(SEED); n = nav(page)
    check("trash" in top(n["rows"]), f"{name}: More is still open after a reload")
    tap(page, '#nav a[data-more]'); page.evaluate("() => window.mh.setView('trash')"); n = nav(page)
    check("MORE*" in n["rows"] and "trash" not in top(n["rows"]), f"{name}: closed over Trash, More is lit ({[r for r in n['rows'] if r.endswith('*')]})")
    acct = page.evaluate("() => window.mh.state.gmail[0].email")
    page.evaluate("(a) => window.mh.setView('trash', a)", acct); n = nav(page)
    check(f"trash/{acct}*" in n["rows"], f"{name}: going to one account's Trash opens More and lights that account's row ({[r for r in n['rows'] if r.endswith('*')]})")
    # the chips carry the counts the Smart inbox rows showed; Newsletters has Cards, which is Feed
    page.evaluate("() => window.mh.setView('inbox')"); preview.settle(page, 200)
    want = page.evaluate(OLD_COUNTS); ch = {c["k"]: c for c in page.evaluate(CHIPS)}
    got = {kk: ch.get(kk, {}).get("n", "?") for kk in ("inbox", "personal", "notifications", "newsletters")}
    check(all(got[kk] == (str(want[kk]) if want[kk] else "") for kk in got), f"{name}: the category chips carry the unread counts ({got} vs {want})")
    check("feed" not in ch, f"{name}: no Cards switch outside Newsletters")
    tap(page, '#chips [data-cat="newsletters"]'); tap(page, '#chips [data-feed]'); ch = {c["k"]: c for c in page.evaluate(CHIPS)}
    v = page.evaluate("() => window.mh.state.view.kind")
    check(v == "feed" and ch.get("newsletters", {}).get("on") and ch.get("feed", {}).get("on") and page.evaluate("() => document.querySelectorAll('#threads .feed').length") > 0,
          f"{name}: Newsletters' Cards switch shows the newsletters as cards, Newsletters still lit ({v})")
    tap(page, '#chips [data-feed]'); check(page.evaluate("() => window.mh.state.view.kind") == "newsletters", f"{name}: and switches back to the list")
    # domain mail names its domain in the unified inbox, in the Domains colour; zone.test and zone.example would both be "supra"
    page.evaluate("() => window.mh.setView('inbox')"); preview.settle(page, 300); rows = page.evaluate(ROWS)
    hub = [r for r in rows if r["kind"] == "hub"]
    names = {"yourdomain.example": "yourdomain", "domain2.example": "domain2", "zone.test": "zone.test"}
    check(len(hub) == 5 and all(r["tag"] == names.get(r["dom"]) and r["ac"] == "#123456" for r in hub),
          f"{name}: each domain's mail names its domain in the Domains colour ({[(r['dom'], r['tag'], r['ac']) for r in hub]})")
    # the business inbox: rows keep their domain, chips for the domains with mail, a chip narrows the list
    page.evaluate("() => window.mh.setView('inbox', 'hub')"); preview.settle(page, 300); rows = page.evaluate(ROWS); ch = page.evaluate(CHIPS)
    doms = [(c["k"][4:], c["n"]) for c in ch if c["k"].startswith("dom:")]
    check(all(r["tag"] == names.get(r["dom"]) for r in rows) and len(rows) == 5, f"{name}: in the business inbox each row names its domain ({[(r['dom'], r['tag']) for r in rows]})")
    check(doms == [("domain2.example", "1"), ("yourdomain.example", "2"), ("zone.test", "1")], f"{name}: chips for the domains with mail, with their unread counts, none for zone.example ({doms})")
    tap(page, '#chips [data-dom="yourdomain.example"]'); rows = page.evaluate(ROWS); ch = {c["k"]: c for c in page.evaluate(CHIPS)}
    check(sorted(r["key"] for r in rows) == sorted([k["sl1"], k["sl2"], k["sl3"]]) and ch.get("dom:yourdomain.example", {}).get("on") and all(r["tag"] is None for r in rows),
          f"{name}: the yourdomain chip lists its mail alone, lit, the rows without a name ({[r['dom'] for r in rows]})")
    check(ch.get("inbox", {}).get("n") == "2", f"{name}: the All chip counts that domain's unread ({ch.get('inbox', {}).get('n')!r})")
    tap(page, '#chips [data-cat="notifications"]'); rows = page.evaluate(ROWS); v = page.evaluate("() => window.mh.state.view")
    check(v.get("dom") == "yourdomain.example" and [r["key"] for r in rows] == [k["sl2"]], f"{name}: a category chip keeps the domain ({v.get('dom')}, {[r['key'] for r in rows]})")
    tap(page, '#chips [data-dom="yourdomain.example"]'); rows = page.evaluate(ROWS)
    check(page.evaluate("() => window.mh.state.view.dom") is None and sorted(r["key"] for r in rows) == sorted([k["sl2"], k["oe1"]]), f"{name}: tapped again, every domain's notifications ({page.evaluate('() => window.mh.state.view')}, {[r['key'] for r in rows]})")
    # a domain's own row, from Settings
    page.evaluate("() => window.mh.setView('inbox')"); page.evaluate("() => window.mh.openSettings('accounts')"); preview.settle(page, 400)
    sw = page.evaluate("() => [...document.querySelectorAll('#scard [data-ownrow]')].map((i) => [i.dataset.ownrow, i.checked])")
    check(sw == [[d, False] for d in DOMS] and not page.query_selector("#splitdomains"), f"{name}: Settings has a switch per domain, all off, in place of the one switch ({sw})")
    if page.query_selector('#scard [data-ownrow="domain2.example"]'): page.click('#scard [data-ownrow="domain2.example"]'); preview.settle(page, 500)
    page.evaluate("() => window.mh.closeSettings()"); n = nav(page)
    accts = [r.rstrip("*").split("/", 1)[1] for r in n["rows"] if r.startswith("inbox/")]
    check(page.evaluate("() => window.mh.state.prefs.ownRows") == ["domain2.example"] and accts.index("hub:domain2.example") == accts.index("hub") + 1,
          f"{name}: domain2.example gets its own row under business, saved as ownRows ({accts})")
    cnt = page.evaluate("() => Object.fromEntries([...document.querySelectorAll('#nav a[data-view=\"inbox\"][data-account]')].map((a) => [a.dataset.account, a.querySelector('.n')?.textContent || '']))")
    check(cnt.get("hub") == "3" and cnt.get("hub:domain2.example") == "1", f"{name}: business counts 3 unread without domain2's 1 ({cnt.get('hub')}, {cnt.get('hub:domain2.example')})")
    page.evaluate("() => window.mh.setView('inbox', 'hub')"); preview.settle(page, 300); rows = page.evaluate(ROWS); ch = page.evaluate(CHIPS)
    check(sorted(r["dom"] for r in rows) == ["yourdomain.example"] * 3 + ["zone.test"] and not any(c["k"] == "dom:domain2.example" for c in ch),
          f"{name}: business lists and offers every domain but domain2.example ({sorted(r['dom'] for r in rows)})")
    page.evaluate("() => window.mh.setView('inbox', 'hub:domain2.example')"); preview.settle(page, 300); rows = page.evaluate(ROWS)
    check([r["key"] for r in rows] == [k["oe1"]], f"{name}: domain2.example's row lists its mail alone ({[r['key'] for r in rows]})")
    page.evaluate("() => window.mh.setView('inbox')"); preview.settle(page, 300)
    oe = [r for r in page.evaluate(ROWS) if r["dom"] == "domain2.example"]
    own_c = page.evaluate("() => sideOf('hub:domain2.example')?.color")
    check(oe and oe[0]["tag"] == "domain2" and oe[0]["ac"] == own_c and own_c != "#123456", f"{name}: its mail reads its own row's name and colour ({oe and (oe[0]['tag'], oe[0]['ac'])}, {own_c})")
    page.evaluate("() => window.mh.openSettings('accounts')"); preview.settle(page, 400)
    if page.query_selector('#scard [data-ownrow="domain2.example"]'): page.click('#scard [data-ownrow="domain2.example"]'); preview.settle(page, 500)
    page.evaluate("() => window.mh.closeSettings()"); n = nav(page)
    check(page.evaluate("() => window.mh.state.prefs.ownRows") == [] and not any(r.startswith("inbox/hub:") for r in n["rows"]), f"{name}: switched off, domain2.example is back under business")
    # the look
    page.evaluate("() => window.mh.setView('inbox', 'hub')"); preview.settle(page, 300); lk = page.evaluate(LOOK)
    check(lk["onBg"] and lk["onBg"] != lk["acc"] and lk["onFg"] != [255, 255, 255], f"{name}: the selected row is a pale wash with dark text, not the accent with white ({lk['onBg']} vs {lk['acc']}, text {lk['onFg']})")
    sq = {d["acct"]: d["r"] < d["w"] / 2 - 2 for d in lk["dots"]}
    check(sq.get("hub") is True and sq.get(acct) is False, f"{name}: business is a square badge, the Gmail account a circle ({sq})")
    for scheme in ("light", "dark"):
        page.emulate_media(color_scheme=scheme); preview.settle(page, 100); c = page.evaluate(DOT_CONTRAST, COLORS)
        check(c["min"] >= 4.5 and c["solid"] == 0, f"{name}: every badge's letter reads on its pale tile, {scheme} (min {c['min']}:1 at {c['at']}, solid fills {c['solid']})")
    page.emulate_media(color_scheme="light")
    # arrows: with a pointer, a closed folder's shows on hover only; More's always
    page.mouse.move(1300, 800); preview.settle(page, 250)
    op = page.evaluate("() => ({ sent: getComputedStyle(document.querySelector('#nav [data-exp=\"sent\"]')).opacity, more: getComputedStyle(document.querySelector('#nav [data-exp=\"more\"]')).opacity })")
    page.hover('#nav a[data-view="sent"]:not([data-account])'); preview.settle(page, 250)
    op2 = page.evaluate("() => getComputedStyle(document.querySelector('#nav [data-exp=\"sent\"]')).opacity")
    check(op["sent"] == "0" and op["more"] == "1" and op2 == "1", f"{name}: a closed folder's arrow shows under the pointer only, More's always ({op}, hovered {op2})")
    page.mouse.move(1300, 800); preview.settle(page, 250)
    ends = page.evaluate("() => ['inbox', 'unread'].map((k) => document.querySelector(`#nav a[data-view=\"${k}\"]:not([data-account]) .n`).getBoundingClientRect().right)")
    check(abs(ends[0] - ends[1]) <= 1, f"{name}: Unread's count ends where Inbox's does ({ends})")
    check(not errs, f"{name}: no page errors {errs[:2]}")
    ctx.close()

def phone(b, name):
    touch = name == "chromium"
    ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=touch, is_mobile=touch); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    ready(page); tap(page, "#menuBtn")
    check(page.evaluate("() => document.querySelector('#app').classList.contains('menu')"), f"{name} phone: the side menu opens")
    tap(page, '#nav a[data-view="inbox"][data-account="hub"]'); tap(page, '#chips [data-dom="domain2.example"]')
    t = page.evaluate("() => document.querySelector('#ptitle')?.textContent || ''")
    check(t == "business · domain2", f"{name} phone: the title says which domain ({t!r})")
    if touch:
        op = page.evaluate("() => getComputedStyle(document.querySelector('#nav [data-exp=\"sent\"]')).opacity")
        check(op == "1", f"{name} phone: a finger sees every arrow ({op})")
    check(not errs, f"{name} phone: no page errors {errs[:2]}")
    ctx.close()

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        try: b = engine.launch()
        except Exception as e: check(False, f"{engine.name}: browser not installed ({str(e).splitlines()[0]})"); continue
        desktop(b, engine.name); phone(b, engine.name); b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all sidebar checks passed")
sys.exit(1 if fails else 0)
