#!/usr/bin/env python3
"""Trash rules in the app (about a "Webmail" phish that came from three domains in a month:
a rule on that subject should trash both, for sam@domain5.example or the whole domain5.example domain). Covered here:
- the conversation menu offers "Trash mail like this…";
- its card: the sender's name and the subject as word chips (digits start off), where it applies (this address, its domain, every
  account), a live count of what in the inbox matches, and nothing to save until a word is chosen;
- saving sends the chosen words and scope, trashes the matching conversations on screen, and Undo brings them back;
- ⌘K offers it for the open conversation;
- Settings → Sender rules lists the rules with what each trashed, removes one, and adds one from its form.
The hub side (arrival on the three paths, the API) is test/trashrules.mjs, test/mention.mjs and test/imapsync.mjs.
Usage: python3 test/trashrules.py"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
SPY = """() => { const sent = window.__trSent = []; const f = window.fetch;
  window.fetch = (url, o = {}) => { if (String(url).includes('/api/trash-rules')) sent.push({ method: (o.method || 'GET').toUpperCase(), url: String(url), body: o.body ? JSON.parse(o.body) : null }); return f(url, o); };
  window.__mock.routes['POST /api/trash-rules'] = { rule: { id: 'aaaaaaaa-0000-0000-0000-000000000001', scope: '*@yourdomain.example', name: 'webmail', subject: 'please review your messages', hits: 0 } }; }"""
# Three hub conversations in the inbox: two phish under the one name from two domains, and one that only shares the subject's words.
ROWS = """() => { const rows = [...window.mh.state.threads.values()].filter((x) => x.kind === 'hub' && !x.out);
  const set = (t, from, subject) => Object.assign(t, { from, fromAddr: from.replace(/^.*<|>$/g, ''), fromName: from.replace(/\\s*<.*$/, ''), subject, identity: 'sam@yourdomain.example', state: 'inbox' });
  set(rows[0], 'Webmail <support@phish-one.example>', 'Please review your encrypted messages');
  set(rows[1], 'Webmail <ldap@thaiplace.example>', 'Please review your quarantined messages');
  set(rows[2], 'Grace <grace@example.com>', 'Please review your messages before Friday');
  window.mh.render?.(); return rows.slice(0, 3).map((t) => t.key); }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1000)
        page.evaluate(SPY)
        keys = page.evaluate(ROWS)
        page.evaluate("(k) => window.mh.openThread(k)", keys[0]); preview.settle(page, 500)
        page.evaluate("(k) => window.mh.openMenuFor(window.mh.state.threads.get(k))", keys[0]); preview.settle(page, 200)
        item = page.query_selector('#menu [data-m="trashrule"]')
        check(item is not None, f"{name}: the conversation menu offers Trash mail like this ({item and item.inner_text().strip()})")
        item.click(); preview.settle(page, 300)
        chips = lambda k: page.eval_on_selector_all(f"#tcard [data-{k}]", "(bs) => bs.map((b) => [b.textContent, b.classList.contains('on')])")
        what = lambda: page.eval_on_selector("#trwhat", "(e) => e.textContent")
        check(chips("n") == [["Webmail", True]], f"{name}: the sender's name is a chip, chosen ({chips('n')})")
        check(chips("s") == [["Please", True], ["review", True], ["your", True], ["encrypted", True], ["messages", True]], f"{name}: so are the subject's words ({chips('s')})")
        check(chips("sc") == [["sam@yourdomain.example", True], ["Anything @yourdomain.example", False], ["Every account", False]], f"{name}: where: this address first, then its domain, then every account ({chips('sc')})")
        check("1 conversation in your inbox now matches" in what(), f"{name}: name and subject together match the one open ({what()})")
        page.click('#tcard [data-s="3"]'); page.wait_for_timeout(100)   # "encrypted" off: the quarantined one matches too
        check("2 conversations in your inbox now match" in what() and "“webmail”" in what() and "“please review your messages”" in what(), f"{name}: tapping a word out widens it, and the count follows ({what()})")
        page.click('#tcard [data-n="0"]'); page.wait_for_timeout(100)    # the name off too: Grace's mail shares the subject's words
        check("3 conversations" in what(), f"{name}: without the name, the subject alone catches Grace's mail as well — shown before saving ({what()})")
        page.click('#tcard [data-n="0"]')
        for i in ("0", "1", "2", "4"): page.click(f'#tcard [data-s="{i}"]')
        page.click('#tcard [data-n="0"]'); page.wait_for_timeout(100)
        check(page.eval_on_selector('#tcard [data-tr="save"]', "(b) => b.disabled") and "Choose at least one word" in what(), f"{name}: with no word chosen there is nothing to save ({what()})")
        page.click('#tcard [data-n="0"]')
        for i in ("0", "1", "2", "4"): page.click(f'#tcard [data-s="{i}"]')
        page.click('#tcard [data-sc="*@yourdomain.example"]'); page.wait_for_timeout(100)
        check("to anything @yourdomain.example" in what(), f"{name}: choosing the domain says so ({what()})")
        page.click('#tcard [data-tr="save"]'); preview.settle(page, 600)   # well inside the 3 s bulk() can wait for the service worker
        sent = page.evaluate("() => window.__trSent.filter((x) => x.method === 'POST')")
        check(len(sent) == 1 and sent[0]["body"] == {"scope": "*@yourdomain.example", "name": "webmail", "subject": "please review your messages"}, f"{name}: saving sends the chosen words and the domain ({sent})")
        states = page.evaluate("(ks) => ks.map((k) => window.mh.state.threads.get(k).state)", keys)
        check(states == ["trash", "trash", "inbox"], f"{name}: the two matching conversations go to Trash; Grace's stays ({states})")
        toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
        check("Rule added" in toast and "2 trashed now" in toast, f"{name}: and the toast says what it did ({toast[:110]})")
        page.click("#toast button"); preview.settle(page, 600)
        states = page.evaluate("(ks) => ks.map((k) => window.mh.state.threads.get(k).state)", keys)
        check(states == ["inbox", "inbox", "inbox"], f"{name}: Undo brings them back ({states})")
        page.evaluate("(k) => window.mh.openThread(k)", keys[1]); preview.settle(page, 400)   # the open one left with the trash
        page.keyboard.press("Meta+k" if name == "webkit" else "Control+k"); preview.settle(page, 300)
        page.fill("#pq", "trash mail"); preview.settle(page, 200)
        cmd = page.evaluate("() => document.querySelector('#plist')?.textContent || ''")
        check("Trash mail like this" in cmd, f"{name}: ⌘K offers it for the open conversation")
        page.keyboard.press("Escape"); preview.settle(page, 200)
        page.evaluate("""() => { window.__mock.routes['GET /api/trash-rules'] = { rules: [{ id: '11111111-2222-3333-4444-555555555555', scope: '*@domain5.example', name: 'webmail', subject: '', hits: 3, last_hit_at: '2026-10-21T20:09:39.966Z' }] };
          window.__mock.routes['DELETE /api/trash-rules/11111111-2222-3333-4444-555555555555'] = { ok: true, removed: 1 }; window.__trSent.length = 0; }""")
        page.evaluate("() => window.mh.openSettings('rules')"); preview.settle(page, 800)
        txt = page.evaluate("() => document.querySelector('#scard')?.innerText || ''")
        check("trash by sender name or subject" in txt.lower() and "sender named “webmail”" in txt and "anything @domain5.example" in txt and "trashed 3, the last 2026-10-21" in txt, f"{name}: Settings lists the rule, where it applies and what it trashed")
        opts = page.eval_on_selector_all("#trscope option", "(os) => os.map((o) => o.value)")
        check(opts[:2] == ["*", "*@yourdomain.example"] and "sam@yourdomain.example" in opts, f"{name}: the form offers every account, each domain and each address ({opts[:4]})")
        page.click('[data-trdel="11111111-2222-3333-4444-555555555555"]'); preview.settle(page, 500)
        dels = page.evaluate("() => window.__trSent.filter((x) => x.method === 'DELETE')")
        check(len(dels) == 1, f"{name}: the X removes it ({dels})")
        page.evaluate("() => window.mh.openSettings('rules')"); preview.settle(page, 600)
        page.click("#tradd"); preview.settle(page, 300)
        toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
        check(not page.evaluate("() => window.__trSent.some((x) => x.method === 'POST')") and "Give words" in toast, f"{name}: Add with nothing filled in sends nothing and says why ({toast[:80]})")
        page.fill("#trname", "Webmail"); page.select_option("#trscope", "*@yourdomain.example"); page.click("#tradd"); preview.settle(page, 600)
        sent = page.evaluate("() => window.__trSent.filter((x) => x.method === 'POST')")
        check(len(sent) == 1 and sent[0]["body"] == {"name": "Webmail", "subject": "", "scope": "*@yourdomain.example"}, f"{name}: the form adds a rule ({sent})")
        unmocked = page.evaluate("() => window.__mock.errors.filter((e) => /trash-rules/.test(e))")
        check(not errs and not unmocked, f"{name}: no page errors {errs[:2]} {unmocked[:2]}")
        b.close()
srv.shutdown()
print("all trash-rule app checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
