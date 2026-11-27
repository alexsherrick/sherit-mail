#!/usr/bin/env python3
"""Mail you sent that got no answer comes back above the inbox, as Apple Mail's follow-up suggestions do: "If you send
a message and don't receive a response in 3 days, the sent email automatically resurfaces to the top of your inbox". In WebKit and
Chromium with the app's fake network (test/mock-fetch.js), conversations whose newest message is yours:
  - one asking something of someone else, 4 days old, is raised in a Follow up box above the inbox, whatever folder it is in;
  - not at 2 days, nor at 20; not a thank-you or "sounds good" (nor one whose question is only in the message quoted under it), not a
    note that asks nothing nor an answer telling someone what to do, not one to a no-reply address or to yourself, not one in Trash, snoozed or set aside;
  - one still in the inbox is raised and not listed twice; j/k and select-all leave the box out;
  - a Gmail one names its recipient from the To header, "+1" for a second;
  - Done sets it aside (and saves it as a pref, for every device) until you write in it again; Done with all, all of them;
  - Follow up opens the conversation with the reply box ready;
  - the account picked narrows the box; the Settings switch turns it off; an empty inbox still shows it;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> fails the box's checks.
Usage: python3 test/followups.py"""
import os, sys, json
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
GMAIL = "sam.owner.sxsw@gmail.com"; DAY = 864e5
# key -> (kind, state, days ago, to, snippet); every one's newest message is yours
ROWS = {
    "ask":      ("hub", "archived", 4, "bob@friend.example", "Hi Bob, can you send me the signed lease by Friday? Thanks"),
    "young":    ("hub", "archived", 2, "bob@friend.example", "Are you free on Tuesday?"),
    "old":      ("hub", "archived", 20, "bob@friend.example", "Are you free on Tuesday?"),
    "thanks":   ("hub", "archived", 5, "bob@friend.example", "Thanks so much, see you then"),
    "quoted":   ("hub", "archived", 5, "bob@friend.example", "Sounds good. On Mon, Nov 2, 2026 at 9:00 AM Bob <bob@friend.example> wrote: Can you come?"),
    "fyi":      ("hub", "archived", 5, "bob@friend.example", "Here are the slides from today's meeting."),
    "answer":   ("hub", "archived", 5, "cust@client.example", "Hi Sam, thanks for reaching out. Please go to Settings and pick your plan there."),
    "request":  ("hub", "archived", 5, "orders@shop.example", "Please cancel the rest of my order if it will not ship this week."),
    "noreply":  ("hub", "archived", 5, "no-reply@shop.example", "Where is my order?"),
    "self":     ("hub", "archived", 5, "sam@yourdomain.example", "Did I remember the milk?"),
    "trash":    ("hub", "trash", 5, "bob@friend.example", "Can you call me?"),
    "snoozed":  ("hub", "snoozed", 5, "bob@friend.example", "Can you call me?"),
    "inbox":    ("hub", "inbox", 6, "carol@friend.example", "Could you look over the draft when you get a chance?"),
    "gm":       ("gmail", "archived", 5, '"Smith, Dana" <dana@work.example>, Eve <eve@work.example>', "Let me know which date works for the two of you."),
}
SETUP = """([rows, gmail, day]) => { const st = window.mh.state, now = Date.now();
  st.view = { kind: 'inbox' }; st.search = '';
  for (const [k, [kind, state, days, to, snippet]] of Object.entries(rows)) {
    const key = (kind === 'gmail' ? gmail : 'hub') + '|fu-' + k;
    st.threads.set(key, { key, kind, account: kind === 'gmail' ? gmail : 'hub', id: 'fu-' + k, subject: 'Subject ' + k, snippet, from: 'sam@yourdomain.example', fromAddr: kind === 'gmail' ? gmail : 'sam@yourdomain.example', fromName: 'You', to, identity: kind === 'gmail' ? gmail : 'sam@yourdomain.example', out: true, date: now - days * day - 60000, unread: false, starred: false, state, labels: kind === 'gmail' ? ['SENT'] : [], cat: 'personal', count: 1, lastMsgId: 'm-' + k, msgIds: [], msgIdHdr: '', hasAtt: false, unsub: '', unsubPost: '', unsubKnown: true });
  }
  window.mh.render(); }"""
BOX = """() => { const b = document.querySelector('#threads .fubox'); if (!b) return null;
  return { rows: [...b.querySelectorAll('.t')].map((d) => d.dataset.key), who: [...b.querySelectorAll('.t .who')].map((d) => d.textContent.trim()), head: b.querySelector('.day').textContent,
    note: (b.querySelector('.t .snip span') || {}).textContent || '', listed: [...document.querySelectorAll('#threads > .t')].map((d) => d.dataset.key) }; }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate("() => { window.__puts = []; const f = window.fetch; window.fetch = (u, o) => { if (/\\/api\\/prefs$/.test(String(u)) && o && o.method === 'PUT') window.__puts.push(o.body); return f(u, o); }; }")
        page.evaluate(SETUP, [ROWS, GMAIL, DAY]); preview.settle(page, 200)
        box = page.evaluate(BOX) or {"rows": [], "who": [], "head": "", "note": "", "listed": []}
        raised = sorted(k.split("|fu-")[1] for k in box["rows"])
        check(raised == ["ask", "gm", "inbox", "request"], f"{name}: the box raises the four that asked and got no answer ({raised})")
        check(box["head"].startswith("Follow up") and "4" in box["head"] and "No reply in 4 days" in page.evaluate("() => document.querySelector('#threads .fubox').textContent"), f"{name}: a Follow up box with its count, each row saying how long it has waited ({box['head']!r})")
        check("hub|fu-inbox" not in box["listed"], f"{name}: one still in the inbox is raised, not listed twice")
        gm = [w for k, w in zip(box["rows"], box["who"]) if k.endswith("fu-gm")]
        check(gm == ["To Smith, Dana +1"], f"{name}: a Gmail one names its recipient from the To header, +1 for the second ({gm})")
        keys = page.evaluate("() => { window.mh.selectAll && window.mh.selectAll(); return [...window.mh.state.checked]; }")
        check(not any("fu-" in k for k in keys), f"{name}: select-all leaves the box's rows out ({[k for k in keys if 'fu-' in k]})")
        page.evaluate("() => { window.mh.state.checked.clear(); window.mh.render(); }")
        # Done: set aside, saved as a pref, until you write again
        page.click('#threads .fubox [data-fu="done"][data-key="hub|fu-ask"]'); preview.settle(page, 300)
        box = page.evaluate(BOX) or {"rows": []}
        saved = [json.loads(p) for p in page.evaluate("() => window.__puts") if p and "followDone" in p]
        check("hub|fu-ask" not in box["rows"] and saved and saved[-1]["followDone"].get("hub|fu-ask") == "m-ask", f"{name}: Done sets it aside and saves which message it was ({saved[-1] if saved else None})")
        page.evaluate("() => { const t = window.mh.state.threads.get('hub|fu-ask'); t.lastMsgId = 'm-ask-2'; window.mh.render(); }")
        box = page.evaluate(BOX) or {"rows": []}
        check("hub|fu-ask" in box["rows"], f"{name}: writing in it again (a newer message of yours) brings it back once that one waits")
        # the account picked narrows it
        page.evaluate("([g]) => { window.mh.state.view = { kind: 'inbox', account: g }; window.mh.render(); }", [GMAIL])
        box = page.evaluate(BOX) or {"rows": []}
        check([k.split("|fu-")[1] for k in box["rows"]] == ["gm"], f"{name}: one account picked, only its mail is raised ({box['rows']})")
        page.evaluate("() => { window.mh.state.view = { kind: 'inbox' }; window.mh.render(); }")
        # Follow up: the conversation open, the reply box ready (a conversation the fake hub has)
        mock_key = page.evaluate("""([day]) => { const st = window.mh.state; const t = [...st.threads.values()].find((x) => x.kind === 'hub' && !x.key.includes('fu-'));
          Object.assign(t, { out: true, date: Date.now() - 5 * day, to: 'dan@friend.example', snippet: 'Could you confirm the time?', state: 'archived', lastMsgId: 'm-real' }); window.mh.render(); return t.key; }""", [DAY])
        page.click(f'#threads .fubox [data-fu="reply"][data-key="{mock_key}"]'); preview.settle(page, 900)
        opened = page.evaluate("() => ({ cur: window.mh.state.cur, focus: document.activeElement && document.activeElement.id })")
        check(opened["cur"] == mock_key and opened["focus"] == "rtext", f"{name}: Follow up opens the conversation with the reply box ready ({opened})")
        # Done with all
        preview.settle(page, 200)
        page.evaluate("() => { window.mh.state.view = { kind: 'inbox' }; window.mh.render(); }")
        btn = page.query_selector('#threads .fubox [data-fu="doneall"]')
        if btn: btn.click(); preview.settle(page, 300)
        check(btn is not None and page.evaluate(BOX) is None, f"{name}: Done with all clears the box")
        # off in Settings; and an empty inbox still shows the box
        page.evaluate("() => { const st = window.mh.state; st.prefs.followDone = {}; st.prefs.followUps = false; window.mh.render(); }")
        check(page.evaluate(BOX) is None, f"{name}: the Settings switch turns it off")
        page.evaluate("() => { const st = window.mh.state; st.prefs.followUps = true; for (const t of st.threads.values()) if (t.state === 'inbox') t.state = 'archived'; window.mh.render(); }")
        box = page.evaluate(BOX) or {"rows": []}
        check(len(box["rows"]) >= 2, f"{name}: an empty inbox still shows what is waiting ({len(box['rows'])} raised)")
        page.evaluate("() => window.mh.openSettings('inbox')"); preview.settle(page, 500)
        sw = page.evaluate("() => { const c = document.querySelector('#fus'); if (!c) return null; c.checked = false; c.dispatchEvent(new Event('change')); return window.mh.state.prefs.followUps; }")
        check(sw is False, f"{name}: Settings has the switch, and it turns the box off ({sw})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all follow-up checks passed")
sys.exit(1 if fails else 0)
