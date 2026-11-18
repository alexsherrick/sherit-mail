#!/usr/bin/env python3
"""The list's look, on WebKit (the Mac app) and Chromium, on a phone (three lines a row) and a desktop (one line):
- the inbox a row came to is named in the time's cell, just before the time, and the names end at one x down the list whatever the
  time, date, paperclip or pin; a long subject or sender never hides it; a single inbox's view shows none;
- the name and its colour are the sidebar entry's the conversation is listed under: a work mailbox's own name and
  colour, never its domain's; domain mail by its domain, in the Domains colour while it is under Domains; a default domain is shown without its
  suffix, a name from Settings > Accounts wins, and a long name is cut, not the time;
- every sidebar entry has a colour picker beside its name, and a colour picked there reaches its rows; Email accounts has none;
- the paperclip and the pin sit at the end of the subject line, and such a row is exactly as tall as a plain one;
- a business (Notifications, Newsletters) is a rounded square, a person a circle, in the list and in the open mail's header;
- a tile is a pale tint with the letter in its hue: at least 4.5:1 contrast for every hue, light and dark.
CONTROL: APP_JS_SRC=<app.js before the change> APP_HTML_SRC=<app.html before it> fails the label, slot, mark and tile checks.
Usage: python3 test/rowlook.py (exit 1 on any failed check)"""
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

# Two domains, and four conversations made to cover the cases: three in the hub, today with a paperclip and a long subject (a
# business), two days ago with a pin (a person), yesterday with both (a business); one from Gmail, today, plain, with a long sender.
SETUP = """(names) => { const S = window.mh.state;
  S.me.identities = [{ email: 'sam@yourdomain.example', display_name: 'Sam', domain: 'yourdomain.example' }, { email: 'sam@domain2.example', display_name: 'Sam', domain: 'domain2.example' }];
  S.prefs.acctNames = names; S.prefs.splitDomains = true; S.prefs.acctColors = {};
  const all = [...S.threads.values()], now = Date.now(), H = 3600e3;
  const hub = [...all.filter((t) => t.kind === 'hub' && t.state === 'inbox' && !t.out).slice(0, 3), all.find((t) => t.kind === 'gmail' && t.state === 'inbox' && !t.out)];
  const set = [
    { identity: 'sam@yourdomain.example', date: now - 0.2 * H, cat: 'notifications', hasAtt: true, starred: false, subject: 'Your statement is ready '.repeat(12) },
    { identity: 'sam@domain2.example', date: now - 50 * H, cat: 'personal', hasAtt: false, starred: true },
    { identity: 'sam@yourdomain.example', date: now - 26 * H, cat: 'newsletters', hasAtt: true, starred: true },
    { date: now - 0.4 * H, cat: 'personal', hasAtt: false, starred: false, fromName: 'Bartholomew Featherstonehaugh-Wolstenholme' } ];
  hub.forEach((t, i) => Object.assign(t, set[i]));
  prerendered.clear();   // pages built before the categories above were set would keep the old ones
  window.mh.setView('inbox'); window.mh.render(); return { keys: hub.map((t) => t.key), gmail: hub[3].account, gmailLabel: accountOf(hub[3].account)?.label }; }"""
GEO = """(keys) => keys.map((k) => { const r = document.querySelector(`#threads .t[data-key="${CSS.escape(k)}"]`); if (!r) return null;
  const b = (e) => e ? e.getBoundingClientRect() : null, acl = r.querySelector('.when .acl'), tm = r.querySelector('.when .tm'), av = r.querySelector('.av'), who = r.querySelector('.who');
  return { h: b(r).height, right: b(r).right, acl: acl ? { text: acl.textContent, right: b(acl).right, cut: acl.scrollWidth > acl.clientWidth + 1 } : null,
    tm: tm ? { left: b(tm).left, right: b(tm).right } : null, whoW: b(who).width, oldChip: !!r.querySelector('.sub .badge'),
    clipInSub: !!r.querySelector('.sub .ic use[href="#i-attach"]'), pinInSub: !!r.querySelector('.sub .ic use[href="#i-pin"]'),
    markInWhen: !!r.querySelector('.when use'), biz: av.classList.contains('biz'), radius: getComputedStyle(av).borderTopLeftRadius, w: b(av).width }; })"""
PLAIN_H = """() => { const hs = [...document.querySelectorAll('#threads > .t[data-key]:not(.grp)')].slice(0, 12).map((r) => Math.round(r.getBoundingClientRect().height * 10) / 10); return hs; }"""
# Every hue through the real stylesheet: the letter's contrast on its tile (WCAG ratio), the minimum over 24 hues.
CONTRAST = """() => { const box = document.createElement('div'); box.className = 't'; box.style.cssText = 'position:fixed;left:-500px;top:0'; document.body.appendChild(box);
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgb = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  let min = 99, at = -1, white = 0;
  for (let h = 0; h < 360; h += 15) { const av = document.createElement('div'); av.className = 'av'; av.style.setProperty('--h', h); av.textContent = 'A'; box.appendChild(av);
    const s = getComputedStyle(av), bg = lum(s.backgroundColor), fg = lum(s.color), ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
    if (ratio < min) { min = ratio; at = h; } if (rgb(s.color).every((v) => v > 245)) white++; }
  box.remove(); return { min: Math.round(min * 100) / 100, at, white }; }"""
WORK = """(k) => { const S = window.mh.state, W = 'sam@work.example';
  S.me.imap_accounts = [{ email: W, label: 'Work co', color: '#ff8c82', ready: true, source: 'app', host: 'mail.work.example' }];
  S.prefs.acctNames = { ...S.prefs.acctNames, [W]: 'active' }; S.threads.get(k).identity = W; window.mh.render();
  const a = document.querySelector(`#threads .t[data-key="${CSS.escape(k)}"] .when .acl`); return a ? { text: a.textContent, ac: a.style.getPropertyValue('--ac').trim() } : null; }"""
WHOLE = """() => { const S = window.mh.state; S.prefs.splitDomains = false; S.prefs.acctNames = { hub: 'business' }; S.prefs.acctColors = { hub: '#123456' }; window.mh.render();
  const rows = [...document.querySelectorAll('#threads > .t[data-key]')].map((r) => [window.mh.state.threads.get(r.dataset.key), r.querySelector('.when .acl')]).filter(([t, a]) => t && a);
  return { hub: rows.filter(([t]) => t.kind === 'hub' && !S.me.imap_accounts?.some((x) => x.email === t.identity)).map(([, a]) => [a.textContent, a.style.getPropertyValue('--ac').trim()]) }; }"""
SLOT = """() => { const r = document.querySelector('#threads .t[data-key] .when'); const tm = r && r.querySelector('.tm'); if (!tm) return null;
  const probe = (txt) => { const s = document.createElement('span'); s.className = 'tm'; s.style.cssText = 'min-width:0;position:absolute;visibility:hidden'; s.textContent = txt; r.appendChild(s); const w = s.getBoundingClientRect().width; s.remove(); return w; };
  return { slot: tm.getBoundingClientRect().width, time: probe('12:59 PM'), date: probe('Sep 30') }; }"""

def ready(page):
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 500)

def run(engine, name, ctx_opts):
    b = engine.launch(); errs = []
    ctx = b.new_context(**ctx_opts); page = ctx.new_page(); page.on("pageerror", lambda e: errs.append(str(e))); ready(page)
    su = page.evaluate(SETUP, {}); keys = su["keys"]; preview.settle(page, 300)
    g = page.evaluate(GEO, keys)
    check(all(g), f"{name}: the four rows are on screen")
    if not all(g): b.close(); return
    acl = [x["acl"] for x in g]
    check(all(acl), f"{name}: every row names its inbox in the time's cell ({[a and a['text'] for a in acl]})")
    if all(acl):
        check([a["text"] for a in acl] == ["yourdomain", "domain2", "yourdomain", su["gmailLabel"]] and su["gmailLabel"],
              f"{name}: by default a domain without its suffix, a Gmail account by its name ({[a['text'] for a in acl]})")
        rights = [a["right"] for a in acl]
        check(max(rights) - min(rights) <= 1, f"{name}: the names end at one x whatever the time, date, paperclip or pin (spread {max(rights) - min(rights):.1f} px)")
        check(all(not a["cut"] for a in acl[:3]), f"{name}: a domain's default name is shown whole")
        check(all(a["right"] <= x["right"] for a, x in zip(acl, g)), f"{name}: a long subject or sender leaves the name on the line")
    tms = [x["tm"] for x in g]
    if all(tms): check(max(t["right"] for t in tms) - min(t["right"] for t in tms) <= 1, f"{name}: the times end at one x")
    check(not any(x["oldChip"] for x in g), f"{name}: no inbox chip after the subject")
    check(g[0]["clipInSub"] and g[2]["clipInSub"] and g[1]["pinInSub"] and g[2]["pinInSub"] and not g[3]["clipInSub"] and not g[3]["pinInSub"],
          f"{name}: the paperclip and the pin at the end of the subject line ({[(x['clipInSub'], x['pinInSub']) for x in g]})")
    check(not any(x["markInWhen"] for x in g), f"{name}: no mark left in the time's cell")
    check(g[3]["whoW"] > 60, f"{name}: a long sender keeps room for its name ({g[3]['whoW']:.0f} px)")
    hs = page.evaluate(PLAIN_H)
    check(len(set(hs)) == 1, f"{name}: a row with a paperclip or pin is exactly as tall as a plain one ({sorted(set(hs))})")
    check(g[0]["biz"] and g[2]["biz"] and not g[1]["biz"] and not g[3]["biz"], f"{name}: businesses are marked, people are not ({[x['biz'] for x in g]})")
    check(g[0]["radius"] not in ("50%",) and float(g[0]["radius"].rstrip("px%") or 0) < g[0]["w"] / 2 - 2 and g[1]["radius"] in ("50%", f"{g[1]['w'] / 2:g}px"),
          f"{name}: a business is a rounded square, a person a circle ({g[0]['radius']}, {g[1]['radius']})")
    s = page.evaluate(SLOT)
    check(s and s["time"] <= s["slot"] + 0.5 and s["date"] <= s["slot"] + 0.5, f"{name}: the slot fits a time and a date ({s})")
    c = page.evaluate(CONTRAST)
    check(c["min"] >= 4.5 and c["white"] == 0, f"{name}: every hue's letter reads on its tile, light (min {c['min']}:1 at hue {c['at']}, white letters {c['white']})")
    # a name from Settings wins; a long one is cut and the time stays
    page.evaluate(SETUP, {"hub:domain2.example": "Brand Two", "hub:yourdomain.example": "An inbox with a very long name indeed"}); preview.settle(page, 300)
    g2 = page.evaluate(GEO, keys); a2 = [x["acl"] for x in g2]
    check(all(a2) and a2[1]["text"] == "Brand Two" and a2[0]["cut"] and g2[0]["tm"]["right"] <= g2[0]["right"], f"{name}: a given name wins, a long one is cut and the time stays ({[a and a['text'][:12] for a in a2]})")
    page.evaluate("(g) => { window.mh.setView('inbox', g); }", su["gmail"]); preview.settle(page, 300)
    check(page.evaluate("() => document.querySelectorAll('#threads .t .when .acl').length") == 0, f"{name}: one inbox's own view names no inbox")
    # a work mailbox's mail reads the mailbox's sidebar name and colour, never its domain
    page.evaluate(SETUP, {})
    w = page.evaluate(WORK, keys[2])
    check(w == {"text": "active", "ac": "#ff8c82"}, f"{name}: a work mailbox's row reads its sidebar name in its colour ({w})")
    # Domains whole: its rows read the Domains name and colour, as the sidebar does
    whole = page.evaluate(WHOLE)
    check(whole and len(whole["hub"]) >= 2 and all(x[1] == "#123456" for x in whole["hub"]) and {x[0] for x in whole["hub"]} == {"yourdomain", "domain2"},
          f"{name}: with Domains whole, domain mail reads its domain in the Domains colour ({whole})")
    # Settings: a colour beside every sidebar name, none left under Email accounts; one picked there reaches the rows
    page.evaluate("() => window.mh.openSettings('accounts')"); preview.settle(page, 400)
    pk = page.evaluate("() => ({ side: document.querySelectorAll('#scard [data-side]').length, pick: document.querySelectorAll('#scard [data-side] [data-scolor]').length, old: document.querySelectorAll('[data-gcolor],[data-icolor]').length })")
    check(pk["side"] >= 3 and pk["pick"] == pk["side"] and pk["old"] == 0, f"{name}: every sidebar entry has a colour beside its name, Email accounts none ({pk})")
    if page.query_selector('#scard [data-scolor="hub"]'):   # absent in the control: then the check below fails rather than the run stopping
        page.fill('#scard [data-scolor="hub"]', "#22aa66"); page.dispatch_event('#scard [data-scolor="hub"]', "change"); preview.settle(page, 500)
    page.evaluate("() => window.mh.closeSettings()"); preview.settle(page, 300)
    got = page.evaluate("() => ({ pref: (window.mh.state.prefs.acctColors || {}).hub, rows: [...document.querySelectorAll('#threads .t .when .acl')].filter((a) => ['yourdomain', 'domain2'].includes(a.textContent)).map((a) => a.style.getPropertyValue('--ac').trim()) })")
    check(got["pref"] == "#22aa66" and got["rows"] and all(c == "#22aa66" for c in got["rows"]), f"{name}: a colour picked in Settings is saved and shows on its rows ({got})")
    # the open mail's header: a square for the business the conversation is from, a circle for a person
    page.evaluate(SETUP, {}); preview.settle(page, 300)
    for k, want in ((keys[0], True), (keys[1], False)):
        page.evaluate("(k) => window.mh.openThread(k)", k)
        try: page.wait_for_selector("#msgs .m .hav", timeout=8000)
        except Exception: pass
        preview.settle(page, 500)
        hv = page.evaluate("() => { const h = document.querySelector('#msgs .m .hav'); return h ? h.classList.contains('biz') : null; }")
        check(hv is want, f"{name}: the open mail's header tile is {'a square' if want else 'a circle'} ({hv})")
    ctx.close()
    dctx = b.new_context(**{**ctx_opts, "color_scheme": "dark"}); dp = dctx.new_page(); dp.on("pageerror", lambda e: errs.append(str(e))); ready(dp); dp.evaluate(SETUP, {})
    c = dp.evaluate(CONTRAST)
    check(c["min"] >= 4.5 and c["white"] == 0, f"{name}: every hue's letter reads on its tile, dark (min {c['min']}:1 at hue {c['at']})")
    dctx.close()
    check(not errs, f"{name}: page errors {errs[:2]}"); b.close()

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        en = engine.name
        run(engine, f"{en} phone", dict(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True))
        run(engine, f"{en} desktop", dict(viewport={"width": 1440, "height": 900}))
srv.shutdown()
print(f"\n{len(fails)} failed" if fails else "\nall passed"); sys.exit(1 if fails else 0)
