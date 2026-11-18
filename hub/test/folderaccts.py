#!/usr/bin/env python3
"""Unread and every folder list each account under them; an account's row shows that folder for it alone.

Trash, Spam and then every folder list their accounts under them, as in Spark's
desktop sidebar (an arrow on the folder opens a list of accounts under it), so one account's folder can be opened on its own.
An account is listed only where its mail can be: Spam is Gmail's alone, Held
the hub's alone. Set aside, Reply later and Feed rebuilt their rows after the account filter, so one account's showed every account's
(checked here by going straight to the view).

Seeded in the page: a second Gmail account (Biz), a second domain with the domains split, and conversations for each account in
Trash, Spam, Archive, Held, Set aside, Reply later and Unread. WebKit and Chromium at a 1400 x 860 Mac window:
  - Unread, the ten folders and More carry the arrow (Held too, with two domains), and their rows are no taller for it; Trash starts
    closed; its arrow lists every account without leaving the view;
  - Biz's Trash alone, "Biz · Trash" first above the list, Biz's row lit; the chip's × shows every account's Trash again;
  - Spam lists the Gmail accounts only and SXSW's row shows SXSW's Spam alone; Held lists the two domains only and the first
    domain's row its held mail alone; Biz's Archive, Set aside and Unread hold Biz's conversations alone, each with its chip;
  - the open folders are still open after a reload; closed over one account's list, the folder's own row stays lit;
  - Cmd+K lists no per-account folder until something is typed, offers "Go to Biz Archive" once it is, and lands there with the
    folder open;
and at 390 x 844 as a touch phone, in the side menu: Archive's arrow opens the list and the menu stays; Biz's row closes the menu,
the title reads "Biz · Archive" and the list holds Biz's Archive alone.
CONTROL: APP_JS_SRC=<the app.js before the change> APP_HTML_SRC=<its app.html> fails the checks the change is for.
Usage: python3 test/folderaccts.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):   # the control: the same page with another app.js
    preview.BUNDLE = "\n".join((preview.CLIENT / f).read_text() for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js"]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
if os.environ.get("APP_HTML_SRC"):
    preview.SHELL = Path(os.environ["APP_HTML_SRC"]).read_text().replace("__VERSION__", "test").replace(
        '<script src="/app.js?v=test"></script>', '<script src="/mock-fetch.js"></script><script src="/app.js"></script>')
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
BIZ = "biz.account@example.com"
DOM1, DOM2 = "hub:yourdomain.example", "hub:second.example"
# Feed is the Newsletters chip's Cards switch and the folders past Archive sit under More, opened first here
FOLDERS = sorted(["unread", "starred", "replylater", "aside", "snoozed", "sent", "archived", "held", "spam", "trash", "all", "more"])
SEED = """(biz) => { const mh = window.mh, st = mh.state; st.gmail.push({ email: biz, status: 'active', label: 'Biz', color: '#2b8a3e' });
  st.me.identities.push({ email: 'team@second.example', display_name: 'Team', domain: 'second.example' }); st.prefs = { ...(st.prefs || {}), splitDomains: true };
  const all = [...st.threads.values()], g = all.find((t) => t.kind === 'gmail'), h = all.find((t) => t.kind !== 'gmail');
  const mk = (src, over) => { const t = { ...src, unread: false, ...over }; if (t.kind !== 'gmail') t.identity = 'sam@yourdomain.example';
    t.key = (t.kind === 'gmail' ? t.account : 'hub') + '|' + t.id; st.threads.set(t.key, t); return t.key; };
  const k = window.__k = { sxsw: g.account,
    sxswTrash: mk(g, { id: 'ft1', subject: 'SXSW trash', state: 'trash' }), bizTrash: mk(g, { id: 'ft2', account: biz, subject: 'Biz trash', state: 'trash' }),
    hubTrash: mk(h, { id: 'ft3', subject: 'Domain trash', state: 'trash' }), sxswSpam: mk(g, { id: 'fs1', subject: 'SXSW spam', state: 'spam' }),
    bizSpam: mk(g, { id: 'fs2', account: biz, subject: 'Biz spam', state: 'spam' }),
    bizArch: mk(g, { id: 'fa1', account: biz, subject: 'Biz archived', state: 'archived', labels: [] }),
    hubHeld: mk(h, { id: 'fh1', subject: 'Held at the door', state: 'archived', labels: ['blocked'] }),
    sxswAside: mk(g, { id: 'fd1', subject: 'SXSW aside', state: 'inbox', labels: ['INBOX'] }), bizAside: mk(g, { id: 'fd2', account: biz, subject: 'Biz aside', state: 'inbox', labels: ['INBOX'] }),
    bizUnread: mk(g, { id: 'fu1', account: biz, subject: 'Biz unread', state: 'inbox', labels: ['INBOX', 'UNREAD'], unread: true }) };
  st.prefs.setAside = [k.sxswAside, k.bizAside]; st.prefs.replyLater = [k.sxswAside, k.bizAside]; mh.render(); return k; }"""
STATE = """() => { const v = window.mh.state.view, lit = [...document.querySelectorAll('#nav a.on')].map((a) => (a.dataset.view || '') + '/' + (a.dataset.account || ''));
  const rows = [...document.querySelectorAll('#nav a')], subs = {};
  rows.forEach((a, i) => { if (a.dataset.view && !a.dataset.account) { const out = []; for (let j = i + 1; j < rows.length && rows[j].dataset.view === a.dataset.view && rows[j].dataset.account; j++) out.push(rows[j].dataset.account); subs[a.dataset.view] = out; } });
  return { kind: v.kind, account: v.account, shown: window.mh.visibleThreads().map((t) => t.key).sort(), lit, subs,
    arrows: [...document.querySelectorAll('#nav [data-exp]')].map((b) => b.dataset.exp).sort(), chip: document.querySelector('#acctonly')?.textContent || '',
    title: document.querySelector('#ptitle')?.textContent || '', menu: document.querySelector('#app').classList.contains('menu') }; }"""
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
def ready(page):
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
    return page.evaluate(SEED, BIZ)
def st(page): preview.settle(page, 250); return page.evaluate(STATE)
def tap(page, sel):   # a click through the DOM, so a missing element is a failed check, not a crash
    return page.evaluate("(s) => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }", sel)
def go(page, k, acct):   # open the folder's list if it is closed, then tap the account's row under it
    if not page.evaluate("(a) => !!document.querySelector(`#nav a[data-view=\"${a[0]}\"][data-account=\"${a[1]}\"]`)", [k, acct]): tap(page, f'#nav [data-exp="{k}"]'); preview.settle(page, 150)
    tap(page, f'#nav a[data-view="{k}"][data-account="{acct}"]'); return st(page)

def mac(b, name):
    ctx = b.new_context(viewport={"width": 1400, "height": 860}); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    k = ready(page); tap(page, '#nav a[data-more]'); s = st(page)
    check(s["arrows"] == FOLDERS, f"{name}: Unread and every folder carry the arrow {s['arrows']}")
    check(s["subs"].get("trash") == [], f"{name}: Trash starts closed {s['subs'].get('trash')}")
    hs = page.evaluate("() => ['drafts', 'starred', 'unread', 'trash'].map((k) => document.querySelector(`#nav a[data-view=\"${k}\"]:not([data-account])`).getBoundingClientRect().height)")
    check(len(set(hs)) == 1, f"{name}: a row with the arrow is as tall as one without {hs}")
    tap(page, '#nav [data-exp="trash"]'); s = st(page)
    check(sorted(s["subs"].get("trash", [])) == sorted([DOM1, DOM2, k["sxsw"], BIZ]) and s["kind"] == "inbox", f"{name}: Trash's arrow lists every account and leaves the view alone {s['subs'].get('trash')} ({s['kind']})")
    s = go(page, "trash", BIZ)
    check(s["kind"] == "trash" and s["account"] == BIZ and s["shown"] == [k["bizTrash"]], f"{name}: Biz's Trash alone {s['shown']}")
    check(s["chip"] == "Biz · Trash" and s["lit"] == [f"trash/{BIZ}"], f"{name}: the chip says whose ({s['chip']!r}) and Biz's row is lit {s['lit']}")
    tap(page, "#chips [data-allacct]"); s = st(page)
    check(s["kind"] == "trash" and not s["account"] and s["shown"] == sorted([k["sxswTrash"], k["bizTrash"], k["hubTrash"]]) and s["lit"] == ["trash/"],
          f"{name}: the chip's × shows every account's Trash {s['shown']} {s['lit']}")
    s = go(page, "spam", k["sxsw"])
    check(sorted(s["subs"].get("spam", [])) == sorted([BIZ, k["sxsw"]]) and s["shown"] == [k["sxswSpam"]], f"{name}: Spam lists the Gmail accounts only, SXSW's alone {s['subs'].get('spam')} {s['shown']}")
    s = go(page, "held", DOM1)
    check(sorted(s["subs"].get("held", [])) == sorted([DOM1, DOM2]) and s["shown"] == [k["hubHeld"]], f"{name}: Held lists the domains only, yourdomain.example's alone {s['subs'].get('held')} {s['shown']}")
    for f, key, chip in [("archived", "bizArch", "Biz · Archive"), ("aside", "bizAside", "Biz · Set aside"), ("unread", "bizUnread", "Biz · Unread")]:
        s = go(page, f, BIZ)
        check(s["kind"] == f and s["shown"] == [k[key]] and s["chip"] == chip, f"{name}: Biz's {f} alone with its chip {s['shown']} {s['chip']!r}")
    for f in ("aside", "replylater"):   # straight to the view, not through the sidebar: the account filter itself, which these two lists used to skip
        page.evaluate("(a) => window.mh.setView(a[0], a[1])", [f, BIZ]); s = st(page)
        check(s["shown"] == [k["bizAside"]], f"{name}: Biz's {f}, however it is reached, holds Biz's alone {s['shown']}")
    page.reload(); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800); page.evaluate(SEED, BIZ); s = st(page)
    opened = sorted(f for f in FOLDERS if s["subs"].get(f))
    check(opened == sorted(["trash", "spam", "held", "archived", "aside", "unread", "replylater"]), f"{name}: the folders opened are still open after a reload {opened}")
    page.evaluate("(a) => window.mh.setView('trash', a)", BIZ); preview.settle(page, 200); tap(page, '#nav [data-exp="trash"]'); s = st(page)
    check(s["subs"].get("trash") == [] and s["lit"] == ["trash/"] and s["account"] == BIZ, f"{name}: closed over Biz's Trash, the Trash row stays lit {s['lit']}")
    page.evaluate("() => window.mh.setView('inbox')"); page.keyboard.press("Meta+k"); preview.settle(page, 200)
    first = page.evaluate("() => document.querySelector('#plist')?.textContent || ''")
    check("Go to Inbox" in first and "Go to Biz inbox" in first and not any(f"Go to Biz {t}" in first for t in ("Archive", "Trash", "Spam", "Sent", "Unread")),
          f"{name}: Cmd+K lists no per-account folder before anything is typed (the account inboxes, as before, it does)")
    page.keyboard.type("go to biz archive"); preview.settle(page, 150)
    top = page.evaluate("() => document.querySelector('#plist [data-i=\"0\"]')?.textContent || ''")
    page.keyboard.press("Enter"); s = st(page)
    check("Go to Biz Archive" in top and s["kind"] == "archived" and s["account"] == BIZ and s["lit"] == [f"archived/{BIZ}"], f"{name}: typed, it offers Go to Biz Archive ({top!r}) and lands there with the folder open {s['lit']}")
    check(not errs, f"{name}: no page errors {errs[:2]}")
    ctx.close()

def phone(b, name):
    touch = name == "chromium"
    ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=touch, is_mobile=touch); page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    k = ready(page); tap(page, "#menuBtn"); s = st(page)
    check(s["menu"], f"{name} phone: the side menu opens")
    tap(page, '#nav [data-exp="archived"]'); s = st(page)
    check(s["menu"] and BIZ in s["subs"].get("archived", []), f"{name} phone: Archive's arrow opens the account list and the menu stays open")
    tap(page, f'#nav a[data-view="archived"][data-account="{BIZ}"]'); s = st(page)
    check(not s["menu"] and s["title"] == "Biz · Archive" and s["shown"] == [k["bizArch"]], f"{name} phone: Biz's row closes the menu, title {s['title']!r}, {s['shown']}")
    check(not errs, f"{name} phone: no page errors {errs[:2]}")
    ctx.close()

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        try: b = engine.launch()
        except Exception as e: check(False, f"{engine.name}: browser not installed ({str(e).splitlines()[0]})"); continue
        mac(b, engine.name); phone(b, engine.name); b.close()
srv.shutdown()
print(f"{len(fails)} failed" if fails else "all folderaccts checks passed")
sys.exit(1 if fails else 0)
