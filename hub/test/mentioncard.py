#!/usr/bin/env python3
""""Delete unless it mentions…" from a Gmail conversation (the rules, made where the mail is; 2026-10-22: rules needed a way to be
added and removed, chosen as a menu item). Covered here:
- the menu offers it on a Gmail conversation, and on a domain one with the scope "Your domains and work mailbox";
- its card: the sender as this address or its organisation's domain (updates.bandsintown.com offers bandsintown.com; a gmail.com sender
  offers only the address), the words (from the rule it would replace, else the account's latest rule), the account or every Gmail
  account, what it will do, and nothing to save until the words are valid;
- the rules already covering the sender are listed, and Remove deletes one;
- saving sends the sender, words and account; the same sender and account is an update;
- ⌘K offers it.
Settings' own group and the hub side are test/mention-page.cjs and test/mention.mjs.
Usage: python3 test/mentioncard.py"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
ACCT = "sam.owner.sxsw@gmail.com"
R_UBER, R_BIT = "aaaaaaaa-0000-0000-0000-00000000000a", "aaaaaaaa-0000-0000-0000-00000000000b"
SPY = """(acct) => { const sent = window.__mSent = []; const f = window.fetch;
  window.fetch = (url, o = {}) => { if (String(url).includes('/api/mention-rules') && !String(url).includes('/api/mention-rules/check')) sent.push({ method: (o.method || 'GET').toUpperCase(), url: String(url), body: o.body ? JSON.parse(o.body) : null }); return f(url, o); };
  const words = ['SXSW', 'South by Southwest'];
  window.__mock.routes['GET /api/mention-rules'] = { rules: [
    { id: 'aaaaaaaa-0000-0000-0000-00000000000a', pattern: '*@uber.com', scope: acct, words, kept: 2, dropped: 31, created_at: '2026-10-16T22:00:02Z' },
    { id: 'aaaaaaaa-0000-0000-0000-00000000000b', pattern: '*@bandsintown.com', scope: acct, words, kept: 0, dropped: 5, created_at: '2026-10-16T22:00:01Z' }], recent: [] };
  window.__mock.routes['DELETE /api/mention-rules/aaaaaaaa-0000-0000-0000-00000000000b'] = { ok: true, removed: 1 };
  window.__mock.routes['POST /api/mention-rules'] = { ok: true, rule: { id: 'aaaaaaaa-0000-0000-0000-00000000000b', pattern: '*@bandsintown.com', scope: acct, words: ['SXSW', 'City Fest'], kept: 0, dropped: 5 } }; }"""
# Two of the fake Gmail account's conversations, re-dressed: a Bandsintown mail from a subdomain, and the pptx mail from a gmail.com address.
ROWS = """() => { const g = (id) => window.mh.state.threads.get('sam.owner.sxsw@gmail.com|' + id);
  const set = (t, from, subject) => Object.assign(t, { from, fromAddr: from.replace(/^.*<|>$/g, ''), fromName: from.replace(/\\s*<.*$/, ''), subject, state: 'inbox' });
  set(g('g2'), 'Bandsintown <notifications@updates.bandsintown.com>', 'Upcoming Live Shows');
  set(g('g1'), 'Kai T <kai.t@gmail.com>', 'Team slides for review');
  window.mh.render?.(); const hub = [...window.mh.state.threads.values()].find((x) => x.kind === 'hub' && !x.out);
  return [g('g2').key, g('g1').key, hub.key]; }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4 && window.mh.state.threads.has('sam.owner.sxsw@gmail.com|g2')", timeout=30000); preview.settle(page, 1000)
        page.evaluate(SPY, ACCT)
        bit, kai, hub = page.evaluate(ROWS)
        def menu(k):
            page.evaluate("(k) => window.mh.openThread(k)", k); preview.settle(page, 400); page.evaluate(ROWS)   # opening reloads it from the mock
            page.evaluate("(k) => window.mh.openMenuFor(window.mh.state.threads.get(k))", k); preview.settle(page, 200)
            return page.query_selector('#menu [data-m="mentionrule"]')
        hi = menu(hub)
        check(hi is not None, f"{name}: a domain conversation's menu offers it too")
        if hi is not None:
            hi.click(); preview.settle(page, 500)
            hs = page.eval_on_selector_all("#tcard [data-mc]", "(bs) => bs.map((b) => [b.textContent, b.classList.contains('on')])")
            ht = page.eval_on_selector("#tcard", "(e) => e.textContent")
            check(hs == [["Your domains and work mailbox", True]] and "goes to Trash, which keeps it 30 days" in ht, f"{name}: its card is for your domains and work mailbox, and says Trash, not Gmail's ({hs})")
            page.click('#tcard [data-mr="cancel"]'); preview.settle(page, 200)
        page.keyboard.press("Escape"); page.mouse.click(5, 790); preview.settle(page, 200)
        item = menu(bit)
        check(item is not None and "Delete unless it mentions" in item.inner_text(), f"{name}: a Gmail conversation's menu offers Delete unless it mentions… ({item and item.inner_text().strip()})")
        item.click(); preview.settle(page, 600)
        chips = lambda k: page.eval_on_selector_all(f"#tcard [data-{k}]", "(bs) => bs.map((b) => [b.textContent, b.classList.contains('on')])")
        what = lambda: page.eval_on_selector("#mwhat", "(e) => e.textContent")
        have = lambda: page.eval_on_selector("#mhave", "(e) => e.textContent")
        words = lambda: page.eval_on_selector("#mcwords", "(e) => e.value")
        btn = lambda: page.eval_on_selector('#tcard [data-mr="save"]', "(b) => [b.textContent, b.disabled]")
        check(chips("ms") == [["Only notifications@updates.bandsintown.com", False], ["Anything @bandsintown.com", True]], f"{name}: from: the address, or the organisation's domain, which the rule covering it already uses ({chips('ms')})")
        check(chips("mc") == [["SXSW", True], ["Every Gmail account", False]], f"{name}: in: this account (by its name) or every Gmail account ({chips('mc')})")
        check(words() == "SXSW, South by Southwest", f"{name}: the words are that rule's ({words()})")
        check("*@bandsintown.com" in have() and "kept 0, deleted 5" in have() and "*@uber.com" not in have(), f"{name}: the rule covering this sender is listed, and only it ({have()[:120]})")
        check(btn() == ["Update rule", False] and "replaces the words" in what(), f"{name}: the same sender and account is an update, and says so ({btn()}, {what()[:150]})")
        page.fill("#mcwords", ""); page.wait_for_timeout(100)
        check(btn()[1] and "Give at least one word" in what(), f"{name}: no words, nothing to save ({what()})")
        page.fill("#mcwords", "SXSW, x"); page.wait_for_timeout(100)
        check(btn()[1] and "2 to 60 characters" in what(), f"{name}: a one-letter word is refused before sending ({what()})")
        page.fill("#mcwords", "SXSW, City Fest, sxsw"); page.wait_for_timeout(100)
        check(not btn()[1] and "New mail from anything @bandsintown.com in SXSW goes to Gmail's trash unless it mentions “SXSW” or “City Fest”" in what(), f"{name}: it says what it will do, each word once ({what()[:160]})")
        page.click('#tcard [data-mr="save"]'); preview.settle(page, 500)
        sent = page.evaluate("() => window.__mSent.filter((x) => x.method === 'POST')")
        check(len(sent) == 1 and sent[0]["body"] == {"pattern": "*@bandsintown.com", "words": ["SXSW", "City Fest"], "scope": ACCT}, f"{name}: saving sends the sender, the words and the account ({sent})")
        toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
        check("Rule added" in toast and "anything @bandsintown.com" in toast and "“City Fest”" in toast, f"{name}: and the toast says what it does ({toast[:120]})")
        check(not page.evaluate("() => document.querySelector('#tmodal').classList.contains('on')"), f"{name}: the card closes")
        gets = page.evaluate("() => window.__mSent.filter((x) => x.method === 'GET').length")
        check(gets == 1, f"{name}: the rules were fetched once, for the first card ({gets})")
        item = menu(kai); item.click(); preview.settle(page, 500)
        check(chips("ms") == [["Only kai.t@gmail.com", True]], f"{name}: a gmail.com sender offers only its address, never all of gmail.com ({chips('ms')})")
        check(words() == "SXSW, City Fest" and have() == "" and btn() == ["Add rule", False], f"{name}: a new sender starts with the account's latest words, nothing listed, Add ({words()}, {btn()})")
        page.click('#tcard [data-mc="*"]'); page.wait_for_timeout(100)
        check("in every Gmail account" in what(), f"{name}: choosing every Gmail account says so ({what()[:120]})")
        page.click('#tcard [data-mr="cancel"]'); preview.settle(page, 200)
        check(len(page.evaluate("() => window.__mSent.filter((x) => x.method === 'POST')")) == 1, f"{name}: Cancel sends nothing")
        item = menu(bit); item.click(); preview.settle(page, 500)
        page.click(f'#mhave [data-mdelc="{R_BIT}"]'); preview.settle(page, 500)
        dels = page.evaluate("() => window.__mSent.filter((x) => x.method === 'DELETE').map((x) => x.url)")
        check(len(dels) == 1 and dels[0].endswith(R_BIT), f"{name}: Remove deletes the rule covering this sender ({dels})")
        check(have() == "" and btn()[0] == "Add rule", f"{name}: and the card shows it gone ({have()[:60]}, {btn()})")
        toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
        check("Rule removed" in toast and "*@bandsintown.com" in toast, f"{name}: the toast says so ({toast[:90]})")
        page.keyboard.press("Escape"); preview.settle(page, 200)
        page.keyboard.press("Meta+k" if name == "webkit" else "Control+k"); preview.settle(page, 300)
        page.fill("#pq", "delete unless"); preview.settle(page, 200)
        cmd = page.evaluate("() => document.querySelector('#plist')?.textContent || ''")
        check("Delete unless it mentions" in cmd, f"{name}: ⌘K offers it for the open Gmail conversation")
        page.keyboard.press("Escape"); preview.settle(page, 200)
        unmocked = page.evaluate("() => window.__mock.errors.filter((e) => /mention-rules/.test(e))")
        check(not errs and not unmocked, f"{name}: no page errors {errs[:2]} {unmocked[:2]}")
        b.close()
srv.shutdown()
print("all delete-unless-it-mentions card checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
