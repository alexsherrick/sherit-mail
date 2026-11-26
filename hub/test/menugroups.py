#!/usr/bin/env python3
"""Spam within reach, the menu grouped, and "Delete unless it mentions…" on the mail already here. On a phone Report
spam could not be reached, Spam and Delete unless it mentions… are the actions used most and the categories least, and trashing a
sender's mail except what mentions some words took a rule for new mail plus a hunt through the old by hand. At 411 x 830
the old More menu was 23 rows, about 900 px, could not scroll, and Report spam was its last row, below the screen. Checked on WebKit and
Chromium:
- phone: the conversation's bar is Done, Trash, Spam, Snooze, Reply, More; on mail at your own domains Spam trashes it and blocks the
  sender without asking, and Undo brings it back and lifts the block;
- phone: More is a sheet that fits the screen and scrolls; This sender, This conversation, Sorting, in that order, This sender opening
  with Report spam and Delete unless it mentions…; every row can be scrolled into view, and Report spam reports;
- the categories are one row that opens in place, the menu staying open, and a chip sets the category;
- desktop: Spam beside Trash on all mail; More never runs past the window;
- the selection bar offers Spam: Gmail mail reported, mail at your own domains trashed and its sender blocked, one Undo for all;
- a swipe can be set to Report spam (on your own sent mail it trashes);
- the rule card, on Gmail mail and on mail at your own domains (scope "hub"), checks the mail already here from the sender (inbox or the last 90 days, never one you wrote in), lists those that
  mention none of the words, and with its box ticked trashes them with the rule, with Undo; unticked, or when the check fails, nothing.
- in Unread, Trash all from counts and trashes the open conversation, read once opened.
CONTROL=1 also runs the client and shell as of 2eb87b2, which fail the bar, the sheet, the selection bar and the card's checks, and as of
7ce12d3, which fail Spam and the rule on mail at your own domains and Trash all from on the open conversation.
Usage: python3 test/menugroups.py (exit 1 on any failed check)"""
import os, re, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

G = "sam.owner.sxsw@gmail.com"
FILES = ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]
def src(rev, f): return subprocess.run(["git", "show", f"{rev}:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=True).stdout if rev else (preview.CLIENT / f).read_text()
def bundle(rev=None): return "\n".join(src(rev, f) for f in FILES).replace("__VERSION__", "test")
def shell(rev=None):
    n = preview.NONCE
    return src(rev, "app.html").replace("__VERSION__", "test").replace("__NONCE__", n).replace(f'<script nonce="{n}" src="/app.js?v=test"></script>', f'<script nonce="{n}" src="/mock-fetch.js"></script><script nonce="{n}" src="/app.js"></script>')

SPY = """() => { const sent = window.__sent = []; const f = window.fetch;
  window.fetch = (url, o = {}) => { if (/\\/api\\/(mention-rules|sender-rules|senders$)/.test(String(url)) && (o.method || 'GET') !== 'GET') sent.push({ method: o.method, url: String(url), body: o.body ? JSON.parse(o.body) : null }); return f(url, o); };
  window.__mock.routes['POST /api/sender-rules'] = { ok: true, rule: null };
  window.__mock.routes['POST /api/mention-rules'] = { ok: true, rule: { id: 'aaaaaaaa-0000-0000-0000-0000000000c1', pattern: '*@lakeside.example', scope: 'sam.owner.sxsw@gmail.com', words: ['SXSW', 'South by Southwest'], kept: 0, dropped: 0 } };
  window.__mock.routes['GET /api/mention-rules'] = { rules: [{ id: 'aaaaaaaa-0000-0000-0000-0000000000c0', pattern: '*@uber.com', scope: 'sam.owner.sxsw@gmail.com', words: ['SXSW', 'South by Southwest'], kept: 0, dropped: 48 }], recent: [] }; window.mh.state.mention = null; /* the app loads Settings' data at boot; these are the hub's rules from here on */ }"""
VIS = """(sel) => [...document.querySelectorAll(sel)].filter((b) => getComputedStyle(b).display !== 'none' && b.offsetParent !== null).map((b) => { const r = b.getBoundingClientRect(); return [b.textContent.trim().split(/\s+/)[0], Math.round(r.left), Math.round(r.right)]; })"""   # the first word: a keyboard hint may follow

def tap(page, sel):   # a click that reports a missing or unreachable control as False instead of waiting out its timeout (the CONTROL pass)
    loc = page.locator(sel)
    if not loc.count(): return False
    try: loc.first.scroll_into_view_if_needed(timeout=2000); loc.first.click(timeout=3000); return True
    except Exception: return False

def run(engine, label, control=False):
    res, errs = {}, []
    st = lambda page, k: page.evaluate("(k) => window.mh.state.threads.get(k)?.state", k)
    keys = lambda page: page.evaluate("() => { const v = [...window.mh.state.threads.values()]; return { g: v.filter((t) => t.kind === 'gmail' && !t.out).map((t) => t.key), h: v.filter((t) => t.kind === 'hub' && !t.out && t.fromAddr).map((t) => t.key) }; }")
    def load(page):
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 500); page.evaluate(SPY)
    def opn(page, k): page.evaluate("(k) => window.mh.openThread(k)", k); preview.settle(page, 500)
    def close_menu(page): page.evaluate("() => document.querySelector('#menu').classList.remove('on')")

    # ---------------- phone ----------------
    b = engine.launch(); ctx = b.new_context(viewport={"width": 411, "height": 830}, is_mobile=True, has_touch=True); page = ctx.new_page(); load(page)
    K = keys(page); gk = next(k for k in K["g"] if page.evaluate("(k) => !!window.mh.state.threads.get(k).unsub", k)); hk = K["h"][0]
    opn(page, gk); bar = page.evaluate(VIS, "#actions button")
    res["phone_bar"] = [x[0] for x in bar] == ["Done", "Trash", "Spam", "Snooze", "Reply", "More"] and all(0 <= x[1] and x[2] <= 411 for x in bar)
    res["phone_bar_why"] = [x[0] for x in bar]
    tap(page, '#actions [data-act="more"]'); preview.settle(page, 300)
    m = page.evaluate("""() => { const m = document.querySelector('#menu'), r = m.getBoundingClientRect();
      return { sheet: m.classList.contains('sheet'), top: r.top, bottom: r.bottom, vh: innerHeight, heads: [...m.querySelectorAll('.mh')].map((h) => h.textContent.trim()),
        sender: [...m.querySelectorAll('.mh + .mg')].slice(0, 1).flatMap((g) => [...g.querySelectorAll('[data-m]')].map((b) => b.dataset.m)),
        tiles: [...m.querySelectorAll('.mtiles [data-m]')].map((b) => b.title), cats: m.querySelectorAll('[data-m^="cat:"]').length, catpick: m.querySelectorAll('[data-m="catpick"]').length }; }""")
    res["sheet"] = m["sheet"] and m["top"] >= 0 and m["bottom"] <= m["vh"] + 0.5
    res["groups"] = m["heads"] == ["This sender", "This conversation", "Sorting"] and m["sender"][:2] == ["spam", "mentionrule"]
    res["tiles"] = m["tiles"] == ["Reply all", "Forward", "Remind me", "Pin", "Mark unread", "Find in this conversation"]
    res["one_cat_row"] = m["cats"] == 0 and m["catpick"] == 1
    res["sheet_why"] = m
    # every row can be brought into view and lies inside the screen
    rows = page.evaluate("""() => [...document.querySelectorAll('#menu [data-m]')].map((b) => { b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return [b.dataset.m, r.top >= 0 && r.bottom <= innerHeight + 0.5]; })""")
    res["reachable"] = len(rows) >= 15 and all(ok for _, ok in rows)
    res["reachable_why"] = [k for k, ok in rows if not ok]
    tap(page, '#menu .mh'); preview.settle(page, 150)
    res["heading_keeps"] = page.evaluate("() => document.querySelector('#menu').classList.contains('on')")
    # categories: one row, opening in place
    tap(page, '#menu [data-m="catpick"]'); preview.settle(page, 200)
    chips = page.evaluate("() => [...document.querySelectorAll('#menu .mchips button')].map((b) => [b.textContent.trim(), b.classList.contains('on')])")
    res["cat_open"] = page.evaluate("() => document.querySelector('#menu').classList.contains('on')") and [c[0] for c in chips][:3] == ["Personal", "Notifications", "Newsletters"] and sum(1 for c in chips if c[1]) == 1
    tap(page, '#menu .mchips [data-m="cat:personal"]'); preview.settle(page, 400)
    sent = page.evaluate("() => window.__sent.filter((x) => x.url.endsWith('/api/sender-rules'))")
    res["cat_set"] = len(sent) == 1 and sent[0]["body"].get("category") == "personal" and not page.evaluate("() => document.querySelector('#menu').classList.contains('on')")
    # Report spam from the sheet
    opn(page, gk); tap(page, '#actions [data-act="more"]'); preview.settle(page, 300)
    before = page.evaluate("() => window.__mock.calls.length")
    tap(page, '#menu [data-m="spam"]'); preview.settle(page, 800)
    calls = page.evaluate("(n) => window.__mock.calls.slice(n)", before)
    res["sheet_spam"] = st(page, gk) == "spam" and any("modify" in c for c in calls)
    page.evaluate("(k) => window.mh.act(window.mh.state.threads.get(k), 'notspam', { quiet: true })", gk); preview.settle(page, 400)
    # mail at your own domains: Spam trashes it and blocks the sender, without asking; Undo brings both back
    opn(page, hk); bar = page.evaluate(VIS, "#actions button"); was = st(page, hk)
    addr = page.evaluate("(k) => window.mh.state.threads.get(k).fromAddr.toLowerCase()", hk)
    blocked = lambda: page.evaluate("(a) => window.mh.state.rules.some((r) => (r.pattern || '').toLowerCase() === a && r.action === 'block')", addr)
    statuses = lambda: page.evaluate("() => window.__sent.filter((x) => x.url.endsWith('/api/senders')).map((x) => x.body.status)")
    page.evaluate("() => { window.__sent.length = 0; }")
    tapped = [x[0] for x in bar][:3] == ["Done", "Trash", "Spam"] and tap(page, '#actions [data-act="spam"]'); preview.settle(page, 700)
    asked = page.evaluate("() => !!document.querySelector('#ask.on')"); toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
    res["phone_hub_spam"] = bool(tapped) and not asked and st(page, hk) == "trash" and statuses() == ["blocked"] and blocked() and "is blocked" in toast
    res["phone_hub_spam_why"] = [[x[0] for x in bar][:3], asked, st(page, hk), statuses(), toast[:80]]
    undone = tap(page, "#toast button"); preview.settle(page, 900)
    res["hub_spam_undo"] = undone and st(page, hk) == was and statuses()[-1:] == ["accepted"] and not blocked()
    res["hub_spam_undo_why"] = [undone, st(page, hk), was, statuses(), blocked()]
    # a swipe set to Report spam (the gesture needs Chrome's touch input)
    res["swipe_option"] = page.evaluate("() => typeof ACTIONS !== 'undefined' && ACTIONS.spam === 'Report spam' && typeof spamSwipe === 'function' && spamSwipe('spam', { kind: 'hub' }) === 'spam' && spamSwipe('spam', { kind: 'gmail' }) === 'spam' && spamSwipe('spam', { kind: 'gmail', out: true }) === 'trash'")
    if engine.name == "chromium" and res["swipe_option"]:
        page.evaluate("() => { window.mh.state.prefs = { ...(window.mh.state.prefs || {}), swipes: { left: 'spam', leftLong: 'trash', right: 'snooze', rightLong: 'block' } }; window.mh.setView ? window.mh.setView('inbox') : 0; }")
        page.evaluate("() => window.mh.back()"); preview.settle(page, 600)
        cdp = ctx.new_cdp_session(page)
        box = page.evaluate("(k) => { const r = document.querySelector(`#threads .t[data-key=\"${k}\"]`)?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null; }", gk)
        if box:
            y = box[1] + box[3] / 2; x0 = box[0] + box[2] * 0.8; x1 = box[0] + box[2] * 0.45
            cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}]})
            for i in range(1, 15): cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * i / 14, "y": y}]}); page.wait_for_timeout(16)
            cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []}); preview.settle(page, 800)
            res["swipe_spam"] = st(page, gk) == "spam"
        else: res["swipe_spam"] = False
    ctx.close()

    # ---------------- desktop ----------------
    page = b.new_page(viewport={"width": 1200, "height": 640}); load(page); K = keys(page)
    gk = next(k for k in K["g"] if page.evaluate("(k) => !!window.mh.state.threads.get(k).unsub", k)); hk = K["h"][0]
    opn(page, gk); names = [x[0].split(" ")[0] for x in page.evaluate(VIS, "#actions button")]
    opn(page, hk); hnames = [x[0].split(" ")[0] for x in page.evaluate(VIS, "#actions button")]
    res["desk_bar"] = names[:3] == ["Done", "Trash", "Spam"] and hnames[:3] == ["Done", "Trash", "Spam"] and "Block" in hnames
    res["desk_bar_why"] = [names, hnames]
    opn(page, gk); tap(page, '#actions [data-act="more"]'); preview.settle(page, 300)
    d = page.evaluate("() => { const m = document.querySelector('#menu'), r = m.getBoundingClientRect(); return [m.classList.contains('sheet'), r.top, r.bottom, innerHeight, m.querySelector('.mh')?.textContent.trim(), m.querySelector('.mg [data-m]')?.dataset.m]; }")
    res["desk_menu"] = not d[0] and d[1] >= 0 and d[2] <= d[3] + 0.5 and d[4] == "This sender" and d[5] == "spam"
    res["desk_menu_why"] = d
    close_menu(page)
    # the selection bar
    page.evaluate("() => window.mh.back()"); preview.settle(page, 300)
    page.evaluate("(k) => { window.mh.state.checked.clear(); window.mh.state.checked.add(k); syncChecks(); }", hk); preview.settle(page, 100)
    hub_only = page.evaluate("() => getComputedStyle(document.querySelector('#selbar [data-bulk=\"spam\"]') || document.body).display")
    page.evaluate("(k) => { window.mh.state.checked.add(k); syncChecks(); }", gk); preview.settle(page, 100)
    both = page.evaluate("() => { const b = document.querySelector('#selbar [data-bulk=\"spam\"]'); return b ? getComputedStyle(b).display : 'none'; }")
    if both != "none":
        tap(page, '#selbar [data-bulk="spam"]'); preview.settle(page, 800)
        try: page.wait_for_function("() => /as spam/.test(document.querySelector('#toast')?.textContent || '')", timeout=4000)
        except Exception: pass
    toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
    res["selbar"] = hub_only != "none" and both != "none" and st(page, gk) == "spam" and st(page, hk) == "trash" and "Reported 1 as spam" in toast and "trashed 1 and blocked the sender" in toast
    res["selbar_why"] = [hub_only, both, st(page, gk), st(page, hk), toast[:90]]
    undone = tap(page, "#toast button"); preview.settle(page, 1200)
    res["selbar_undo"] = undone and st(page, gk) == "inbox" and st(page, hk) == "inbox"
    res["selbar_undo_why"] = [undone, st(page, gk), st(page, hk)]
    try: page.wait_for_function("() => window.mh.queue.pending().length === 0", timeout=8000)   # the mock hub never shows the trash, so a queued Undo there ends in a late "Undo skipped" toast
    except Exception: pass
    preview.settle(page, 500); page.evaluate("() => { const t = document.querySelector('#toast'); t.textContent = ''; t.style.display = 'none'; }")

    # ---------------- the rule card on the mail already here ----------------
    DRESS = """() => { const g = (id) => window.mh.state.threads.get('sam.owner.sxsw@gmail.com|' + id), now = Date.now();
      const set = (t, o) => Object.assign(t, { from: 'Lakeside House <hello@lakeside.example>', fromAddr: 'hello@lakeside.example', fromName: 'Lakeside House', out: false, ...o });
      set(g('g2'), { subject: "Final hours: two-for-one passes", state: 'inbox', date: now - 3600e3, labels: ['INBOX', 'UNREAD'] });
      set(g('g1'), { subject: 'Our 2019 season in pictures', state: 'archived', date: now - 400 * 864e5, labels: [] });
      set(g('g3'), { subject: 'Re: our panel', state: 'archived', date: now - 5 * 864e5, labels: ['SENT'] });
      window.mh.render(); return [g('g2').key, g('g1').key, g('g3').key]; }"""
    CHECK = """(how) => { const seen = window.__checks = [];
      window.__mock.routes['POST /api/mention-rules/check'] = how === 'fail' ? { __status: 500, error: 'boom' } : { results: [{ account: 'sam.owner.sxsw@gmail.com', thread: 'g2', d: 'drop' }] };
      const f = window.fetch; if (!window.__cw) { window.__cw = true; window.fetch = (u, o = {}) => { if (String(u).includes('/api/mention-rules/check')) (window.__checks || []).push(JSON.parse(o.body)); return f(u, o); }; } }"""
    def card(k, how="drop"):
        page.evaluate(CHECK, how); page.evaluate("(k) => window.mh.openMenuFor(window.mh.state.threads.get(k))", k); preview.settle(page, 200)
        tap(page, '#menu [data-m="mentionrule"]'); preview.settle(page, 900)
        return page.evaluate("() => document.querySelector('#mold')?.textContent.trim() || ''")
    g2, g1, g3 = page.evaluate(DRESS)
    told = card(g2)
    asked = page.evaluate("() => window.__checks")
    res["card_asks"] = len(asked) >= 1 and asked[-1]["threads"] == [{"account": G, "thread": "g2"}] and asked[-1]["words"] == ["SXSW", "South by Southwest"]
    res["card_asks_why"] = asked[-1:] if asked else asked
    res["card_lists"] = "Also trash the one already here that doesn't mention “SXSW” or “South by Southwest”" in told and "two-for-one passes" in told
    res["card_lists_why"] = told[:200]
    tap(page, '#tcard [data-mr="save"]'); preview.settle(page, 900)
    toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
    res["card_trashes"] = st(page, g2) == "trash" and st(page, g1) == "archived" and st(page, g3) == "archived" and "went to Trash" in toast and "Undo" in toast
    res["card_trashes_why"] = [st(page, g2), toast[:140]]
    tap(page, "#toast button"); preview.settle(page, 700)
    res["card_undo"] = st(page, g2) == "inbox"
    page.evaluate(DRESS); card(g2)
    (page.locator("#moldbox").count() and page.locator("#moldbox").uncheck(timeout=3000)); tap(page, '#tcard [data-mr="save"]'); preview.settle(page, 900)
    res["card_untick"] = st(page, g2) == "inbox" and "Rule added" in page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
    page.evaluate(DRESS); told = card(g2, "fail"); tap(page, '#tcard [data-mr="save"]'); preview.settle(page, 900)
    res["card_fail_safe"] = "could not be checked" in told and st(page, g2) == "inbox"
    res["card_fail_why"] = told[:120]
    # ---------------- the rule on mail at your own domains, and Trash all from in Unread ----------------
    hid = page.evaluate("""(k) => { const t = window.mh.state.threads.get(k), now = Date.now(); Object.assign(t, { from: 'Lakeside House <hello@lakeside.example>', fromAddr: 'hello@lakeside.example', fromName: 'Lakeside House', subject: 'Final hours: two-for-one passes', state: 'inbox', date: now - 7200e3, out: false, hasOut: false });
      window.mh.render(); window.__checks = []; window.__mock.routes['POST /api/mention-rules/check'] = { results: [{ account: 'hub', thread: t.id, d: 'drop' }] }; return t.id; }""", hk)
    page.evaluate("(k) => window.mh.openMenuFor(window.mh.state.threads.get(k))", hk); preview.settle(page, 200)
    offered = tap(page, '#menu [data-m="mentionrule"]'); preview.settle(page, 900)
    told = page.evaluate("() => document.querySelector('#mold')?.textContent.trim() || ''"); asked = page.evaluate("() => window.__checks || []")
    page.evaluate("() => { window.__sent.length = 0; }")
    tap(page, '#tcard [data-mr="save"]'); preview.settle(page, 900)
    posted = page.evaluate("() => window.__sent.filter((x) => x.url.endsWith('/api/mention-rules')).map((x) => x.body)")
    res["hub_card"] = offered and asked[-1:] and asked[-1]["threads"] == [{"account": "hub", "thread": hid}] and "Also trash the one already here" in told and posted[-1:] and posted[-1]["scope"] == "hub" and st(page, hk) == "trash"
    res["hub_card_why"] = [offered, asked[-1:], told[:80], posted, st(page, hk)]
    uk = page.evaluate("""() => { const t = window.mh.state.threads.get('sam.owner.sxsw@gmail.com|g1'); Object.assign(t, { from: 'Solo <solo@one.example>', fromAddr: 'solo@one.example', state: 'inbox', unread: true, out: false, date: Date.now() - 600e3, labels: ['INBOX', 'UNREAD'] }); window.mh.setView('unread'); window.mh.render(); return t.key; }""")
    preview.settle(page, 300); opn(page, uk)
    page.evaluate("(k) => window.mh.openMenuFor(window.mh.state.threads.get(k))", uk); preview.settle(page, 200)
    lbl = page.evaluate("() => document.querySelector('#menu [data-m=\"trashall\"]')?.textContent.trim() || ''")
    tap(page, '#menu [data-m="trashall"]'); preview.settle(page, 700)
    res["trashall_open"] = "(1 " in lbl and not page.evaluate("(k) => window.mh.state.threads.get(k).unread", uk) is True and st(page, uk) == "trash"
    res["trashall_open_why"] = [lbl, st(page, uk)]
    res["no_errors"] = not errs; res["errors"] = errs[:3]
    b.close()
    return res

NAMES = {"phone_bar": "phone: the bar is Done, Trash, Spam, Snooze, Reply, More, all on screen", "phone_hub_spam": "phone: on mail at your own domains Spam trashes it and blocks the sender, without asking",
         "hub_spam_undo": "its Undo brings the conversation back and lifts the block",
         "sheet": "phone: More is a sheet inside the screen", "groups": "phone: This sender, This conversation, Sorting; This sender opens with Report spam, then Delete unless it mentions…",
         "tiles": "phone: the bar's other actions are one row of tiles", "reachable": "phone: every row of More can be scrolled into view", "heading_keeps": "a tap on a heading leaves the menu open",
         "one_cat_row": "the three categories are one row", "cat_open": "it opens the categories in place, the current one marked, the menu open", "cat_set": "a category chip sets it and closes the menu",
         "sheet_spam": "Report spam from the sheet reports it, and Gmail is told", "swipe_option": "a swipe can be set to Report spam, on any mail; on your own sent mail it trashes",
         "desk_bar": "desktop: Spam beside Trash on Gmail mail and on mail at your own domains", "desk_menu": "desktop: More fits the window, This sender first, Report spam its first row",
         "selbar": "the selection bar offers Spam: Gmail mail reported, mail at your own domains trashed and its sender blocked",
         "selbar_undo": "one Undo brings all of it back",
         "card_asks": "the rule card asks about the sender's mail here: in the inbox or the last 90 days, never one you wrote in",
         "card_lists": "it lists the one that mentions none of the words", "card_trashes": "saving trashes it with the rule, nothing else, with Undo", "card_undo": "Undo brings it back",
         "card_untick": "unticked, saving trashes nothing", "hub_card": "on domain mail the card checks it as the hub's, lists it, and the rule is saved for your domains and work mailbox, trashing it",
         "trashall_open": "in Unread, Trash all from counts the open conversation (read once opened) and trashes it", "card_fail_safe": "a check that fails trashes nothing, and says so", "no_errors": "no page errors"}
WHY = {"hub_card": "hub_card_why", "trashall_open": "trashall_open_why", "phone_hub_spam": "phone_hub_spam_why", "hub_spam_undo": "hub_spam_undo_why", "selbar_undo": "selbar_undo_why", "phone_bar": "phone_bar_why", "sheet": "sheet_why", "groups": "sheet_why", "tiles": "sheet_why", "reachable": "reachable_why", "desk_bar": "desk_bar_why", "desk_menu": "desk_menu_why", "selbar": "selbar_why",
       "card_asks": "card_asks_why", "card_lists": "card_lists_why", "card_trashes": "card_trashes_why", "card_fail_safe": "card_fail_why", "no_errors": "errors"}
fails = []
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        preview.BUNDLE, preview.SHELL = bundle(), shell()
        r = run(engine, engine.name)
        names = dict(NAMES, **({"swipe_spam": "a swipe set to Report spam reports a Gmail row"} if engine.name == "chromium" else {}))
        for k, m in names.items():
            ok = bool(r.get(k)); print(("ok   " if ok else "FAIL ") + f"{engine.name}: {m}" + ("" if ok or k not in WHY else f" ({r.get(WHY[k])})"))
            if not ok: fails.append(f"{engine.name}: {m}")
    if preview.CONTROL:   # 2eb87b2: before the menu and bar; 7ce12d3: Spam on Gmail mail only (earlier)
        for rev, want in (("2eb87b2", ["phone_bar", "sheet", "groups", "reachable", "desk_bar", "selbar", "card_lists"]), ("7ce12d3", ["phone_hub_spam", "hub_spam_undo", "desk_bar", "selbar", "hub_card", "trashall_open"])):
            preview.BUNDLE, preview.SHELL = bundle(rev), shell(rev)
            try: r = run(pw.chromium, rev, control=True)
            except Exception as e: r = {"threw": str(e)[:120]}
            missed = [k for k in want if r.get(k)]
            print(("ok   " if not missed else "FAIL ") + f"CONTROL: the client at {rev} fails {', '.join(k for k in want if not r.get(k))}" + (f" (but passes {missed})" if missed else "") + (f" [stopped: {r['threw']}]" if r.get("threw") else ""))
            if missed or r.get("threw"): fails.append("CONTROL " + rev)
    else:
        preview.control_skipped("menugroups")
srv.shutdown()
print(f"\n{len(fails)} failed" if fails else "\nall menu-group checks passed")
sys.exit(1 if fails else 0)
