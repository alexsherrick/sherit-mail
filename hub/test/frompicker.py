#!/usr/bin/env python3
"""The From list shows every address the moment it is touched.

The From list misbehaved while the To list worked well. From and
Reply as were an <input list> over a <datalist>: the engine draws that list its own way in each app and may filter it by what is in the
box, which is always the current address. Now they open the same kind of list the To field has.

The page is the real client in the preview harness, given the user's shape of accounts: four domain addresses on two domains, the work
mailbox and two Gmail accounts. Checks, on WebKit and Chromium:
  - New message > From: touching it lists all seven addresses, the current one ticked, each with its account; no <datalist> is left;
  - typing "gmail" narrows it to the two Gmail addresses; Down, Enter picks the second: From, the name and the signature follow, and
    the cursor moves to To;
  - letters that are no address are put back when the box is left; a new address on one of the domains is offered as itself;
  - Esc closes the list and leaves the message open;
  - Reply as, in an open conversation, opens the same list;
  - CONTROL: the client at 6de14a5 before this change opens no list (the inputs carry list="idents").
Usage: python3 test/frompicker.py"""
import sys, subprocess, socketserver, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

def at_head(f): return subprocess.run(["git", "show", f"6de14a5:hub/src/client/{f}"], cwd=preview.HUB, capture_output=True, text=True, check=HISTORY).stdout
HISTORY = subprocess.run(["git", "cat-file", "-e", "6de14a5^{commit}"], cwd=preview.HUB, capture_output=True).returncode == 0; OLD_BUNDLE = "\n".join(at_head(f) for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]).replace("__VERSION__", "test")
OLD_SHELL = at_head("app.html").replace("__VERSION__", "test").replace('<script src="/app.js?v=test"></script>', '<script src="/mock-fetch.js"></script><script src="/app.js"></script>')

def server(bundle, shell):
    class H(preview.H):
        def do_GET(self):
            p = self.path.split("?")[0]
            if p == "/app.js": return self._send(bundle, "text/javascript; charset=utf-8")
            if p in ("/", "/index.html"): return self._send(shell, "text/html; charset=utf-8", {"x-app-shell": "1"})
            return super().do_GET()
    srv = preview.TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv   # threaded

ACCOUNTS = """() => { const s = mh.state;
  s.me.identities = [{ email: "sam@yourdomain.example", display_name: "Sam Owner" }, { email: "sam@domain7.example", display_name: "Sam from Brandseven" },
    { email: "support@domain7.example", display_name: "Brandseven Support" }, { email: "hello@domain7.example", display_name: "Brandseven" }];
  s.me.imap_accounts = [{ email: "sam@work.example", label: "Work co", ready: true, source: "config" }];
  s.gmail = [{ email: "sam.owner.sxsw@gmail.com", status: "active", label: "SXSW", color: "#aa3366" }, { email: "sam.owner@gmail.com", status: "active", label: "sam", color: "#2b8a3e" }];
  s.prefs.signatures = { "sam.owner@gmail.com": "-- Sam (Gmail)" }; mh.render(); }"""
ROWS = "() => [...document.querySelectorAll('.fromsug .rs')].map((e) => ({ addr: e.querySelector('span').textContent, tag: e.querySelector('em').textContent, cur: e.classList.contains('cur'), on: e.classList.contains('on') }))"

# The click that focuses From selects its text twice: at once on mouseup, and a tick later (setTimeout 0, queued at focus). Typing at
# once raced that tick: the second select-all landed mid-word and the rest of the address replaced it ("com", "ofit.com"), and Enter
# took another address, 3 runs in 4. A timer of our own queued after the click runs after the app's, so the select
# is done before the first key, as it always is for a person.
def click_selected(page, sel):
    page.click(sel); page.evaluate("() => new Promise((r) => setTimeout(r, 0))")
    try: page.wait_for_function("(s) => { const i = document.querySelector(s); return document.activeElement === i && i.selectionStart === 0 && i.selectionEnd === i.value.length; }", arg=sel, timeout=2000)
    except Exception: pass   # the control's client (6de14a5) never selects on focus; its checks do not read what was typed
def run(bundle, shell, engine):
    srv = server(bundle, shell); base = f"http://127.0.0.1:{srv.server_address[1]}/"; r = {}
    with sync_playwright() as pw:
        b = getattr(pw, engine).launch(); page = b.new_context(viewport={"width": 1280, "height": 860}).new_page(); errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state && window.mh.state.threads.size >= 4 && window.mh.state.me", timeout=20000); preview.settle(page, 400)
        page.evaluate(ACCOUNTS)
        page.click("#threads .t"); preview.settle(page, 700)
        if page.evaluate("getComputedStyle(document.querySelector('#replybox')).display !== 'none'"):
            page.click("#rfrom"); preview.settle(page, 150); r["reply"] = page.evaluate(ROWS); page.keyboard.press("Escape"); page.wait_for_timeout(100)
        else: r["reply"] = "no reply box"
        page.click("#composeBtn"); preview.settle(page, 200); page.fill("#cfrom", "sam@yourdomain.example"); page.dispatch_event("#cfrom", "change")
        page.focus("#csub"); preview.settle(page, 200); page.click("#cfrom"); preview.settle(page, 150)
        r["datalist"] = page.evaluate("document.querySelectorAll('datalist option').length + document.querySelectorAll('#cfrom[list], #rfrom[list]').length")
        r["all"] = page.evaluate(ROWS)
        page.keyboard.type("gmail"); page.wait_for_timeout(100); r["gmail"] = page.evaluate(ROWS)
        page.keyboard.press("ArrowDown"); page.keyboard.press("Enter"); preview.settle(page, 150)
        r["picked"] = page.evaluate("({ from: document.querySelector('#cfrom').value, name: document.querySelector('#cname').value, sig: document.querySelector('#ctext').value, focus: document.activeElement && document.activeElement.id, open: !!document.querySelector('.fromsug') })")
        click_selected(page, "#cfrom"); page.keyboard.type("zzz"); page.focus("#csub"); preview.settle(page, 250)
        r["restored"] = page.evaluate("document.querySelector('#cfrom').value")
        click_selected(page, "#cfrom"); page.keyboard.type("billing@domain7.example"); page.wait_for_timeout(100); r["new"] = page.evaluate(ROWS)
        page.keyboard.press("Enter"); page.wait_for_timeout(100); r["newpicked"] = page.evaluate("document.querySelector('#cfrom').value")
        page.click("#cfrom"); page.wait_for_timeout(100); before = page.evaluate("({ list: !!document.querySelector('.fromsug'), focus: document.activeElement && document.activeElement.id })"); page.keyboard.press("Escape"); preview.settle(page, 150)
        r["esc"] = page.evaluate("({ list: !!document.querySelector('.fromsug'), compose: document.querySelector('#cmodal').classList.contains('on') })"); r["esc"]["before"] = before
        r["errs"] = errs; b.close()
    srv.shutdown(); return r

fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (None if c else fails.append(m))

for engine in ("webkit", "chromium"):
    r = run(preview.BUNDLE, preview.SHELL, engine); a = r["all"]
    check(r["datalist"] == 0, f"{engine}: From and Reply as carry no list= and no datalist is filled ({r['datalist']})")
    check(len(a) == 7 and [x["addr"] for x in a if x["cur"]] == ["sam@yourdomain.example"], f"{engine}: touching From lists all 7 addresses, the current one ticked ({len(a)}: {[x['addr'] for x in a]})")
    check({x["tag"] for x in a} == {"Work co", "Gmail · SXSW", "Gmail · sam", ""} and all(x["tag"] == "" for x in a if x["addr"].endswith(("yourdomain.example", "domain7.example"))), f"{engine}: the work and Gmail rows name their account; domain rows show just the address ({sorted({x['tag'] for x in a})})")
    check([x["addr"] for x in r["gmail"]] == ["sam.owner.sxsw@gmail.com", "sam.owner@gmail.com"], f"{engine}: typing gmail narrows it to the two Gmail addresses ({[x['addr'] for x in r['gmail']]})")
    p = r["picked"]
    check(p["from"] == "sam.owner@gmail.com" and p["focus"] == "cto" and not p["open"] and "-- Sam (Gmail)" in p["sig"], f"{engine}: Down, Enter picks the second: From, its signature, the cursor in To ({p})")
    check(r["restored"] == "sam.owner@gmail.com", f"{engine}: letters that are no address are put back on leaving the box ({r['restored']!r})")
    check(any(x["addr"] == "billing@domain7.example" and x["tag"].startswith("new on") for x in r["new"]) and r["newpicked"] == "billing@domain7.example", f"{engine}: a new address on a domain is offered as itself and taken ({r['newpicked']})")
    check(not r["esc"]["list"] and r["esc"]["compose"], f"{engine}: Esc closes the list and leaves the message open ({r['esc']})")
    check(isinstance(r["reply"], list) and len(r["reply"]) == 7, f"{engine}: Reply as opens the same list ({r['reply'] if not isinstance(r['reply'], list) else len(r['reply'])})")
    check(not r["errs"], f"{engine}: no page errors ({r['errs'][:2]})")

if preview.CONTROL:
    old = run(OLD_BUNDLE, OLD_SHELL, "chromium")
    check(old["datalist"] > 2 and not old["all"], f"CONTROL: the client at 6de14a5 has the datalist and opens no list ({old['datalist']}, {len(old['all'])} rows)")
else: preview.control_skipped("frompicker.py")

if fails: print(f"\n{len(fails)} FAILED"); sys.exit(1)
print("\nall From checks passed")
