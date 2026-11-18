#!/usr/bin/env python3
"""Don't-notify rules in the app (a one-step way to stop notifications for mail like this,
prompted by Venmo's daily password-reset mail). Covered here:
- the conversation menu offers "Don't notify me about mail like this…";
- its card offers this subject from this sender first, or anything from this sender, and sends the choice;
- ⌘K offers the same for the open conversation;
- Settings → Notifications lists the rules with how many notifications each stopped, and removes one.
The hub side (matching, counting, "Stop these" on a notification) is test/ingest.mjs. Usage: python3 test/quietrules.py"""
import sys, json
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
SPY = """() => { const sent = window.__quietSent = []; const f = window.fetch;
  window.fetch = (url, o = {}) => { if (String(url).includes('/api/quiet-rules')) sent.push({ method: (o.method || 'GET').toUpperCase(), url: String(url), body: o.body ? JSON.parse(o.body) : null }); return f(url, o); };
  window.__mock.routes['POST /api/quiet-rules'] = { rule: { id: 'q9', sender: 'grace@example.com', subject: 'lunch?', hits: 0 } }; }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1200, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1000)
        page.evaluate(SPY)
        t = page.evaluate("() => { const t = [...window.mh.state.threads.values()].find((x) => x.fromAddr && x.subject); window.mh.openThread(t.key); return { key: t.key, from: t.fromAddr, subject: t.subject }; }")
        preview.settle(page, 500)
        page.evaluate("(k) => window.mh.openMenuFor(window.mh.state.threads.get(k))", t["key"]); preview.settle(page, 200)
        item = page.query_selector('#menu [data-m="quiet"]')
        check(item is not None, f"{name}: the conversation menu offers Don't notify ({item and item.inner_text().strip()})")
        item.click(); preview.settle(page, 300)
        choices = page.eval_on_selector_all("#tcard [data-q]", "(bs) => bs.map((b) => [b.dataset.q, b.textContent.trim()])")
        check([c[0] for c in choices] == ["subject", "sender", "cancel"] and t["from"].lower() in choices[0][1].lower(), f"{name}: the card offers this subject from this sender first, then anything from the sender ({choices})")
        page.click('#tcard [data-q="subject"]'); preview.settle(page, 400)
        sent = page.evaluate("() => window.__quietSent.filter((x) => x.method === 'POST')")
        check(len(sent) == 1 and sent[0]["body"]["sender"] == t["from"].lower() and sent[0]["body"]["subject"], f"{name}: choosing it sends the sender and subject ({sent})")
        toast = page.evaluate("() => document.querySelector('#toast')?.textContent || ''")
        check("No more notifications" in toast, f"{name}: and says what it did ({toast[:90]})")
        page.keyboard.press("Meta+k" if name == "webkit" else "Control+k"); preview.settle(page, 300)
        page.fill("#pq", "notify"); preview.settle(page, 200)
        cmd = page.evaluate("() => document.querySelector('#plist')?.textContent || ''")
        check("Don't notify me about mail like this" in cmd, f"{name}: ⌘K offers it for the open conversation")
        page.keyboard.press("Escape"); preview.settle(page, 200)
        page.evaluate("""() => { window.__mock.routes['GET /api/quiet-rules'] = { rules: [{ id: '11111111-2222-3333-4444-555555555555', sender: 'venmo@venmo.com', subject: 'venmo - password reset', hits: 8, last_hit_at: '2026-10-06T16:37:00.000Z' }] };
          window.__mock.routes['DELETE /api/quiet-rules/11111111-2222-3333-4444-555555555555'] = { ok: true, removed: 1 }; }""")
        page.evaluate("() => window.mh.openSettings('notifications')"); preview.settle(page, 800)
        txt = page.evaluate("() => document.querySelector('#scard')?.innerText || ''")
        check("venmo@venmo.com" in txt and "venmo - password reset" in txt and "Stopped 8 notifications" in txt, f"{name}: Settings lists the rule and what it stopped")
        page.click('[data-qdel="11111111-2222-3333-4444-555555555555"]'); preview.settle(page, 500)
        dels = page.evaluate("() => window.__quietSent.filter((x) => x.method === 'DELETE')")
        check(len(dels) == 1, f"{name}: the X removes it ({dels})")
        # Uber's sign-in codes: the subject's words are chips, the code starts off, and taps change what the rule matches.
        page.evaluate("""() => { window.__quietSent.length = 0; const t = [...window.mh.state.threads.values()].find((x) => x.fromAddr && x.subject); t.fromAddr = 'admin@uber.com'; t.subject = 'Do not share: 3651'; window.mh.openMenuFor(t); }""")
        preview.settle(page, 200); page.click('#menu [data-m="quiet"]'); preview.settle(page, 300)
        chips = page.eval_on_selector_all("#tcard [data-w]", "(bs) => bs.map((b) => [b.textContent, b.classList.contains('on')])")
        label = lambda: page.eval_on_selector('#tcard [data-q="subject"]', "(b) => b.textContent")
        check(chips == [["Do", True], ["not", True], ["share", True], ["3651", False]] and label() == "“Do not share” from admin@uber.com", f"{name}: the subject's words are chips, the code starts off ({chips}; {label()})")
        page.click('#tcard [data-w="2"]'); page.wait_for_timeout(100)
        check(label() == "“Do not” from admin@uber.com", f"{name}: tapping a chip takes that word out ({label()})")
        for i in ("0", "1"): page.click(f'#tcard [data-w="{i}"]')
        page.wait_for_timeout(100)
        check(page.eval_on_selector('#tcard [data-q="subject"]', "(b) => b.disabled"), f"{name}: with no word chosen the subject choice waits ({label()})")
        for i in ("0", "1", "2"): page.click(f'#tcard [data-w="{i}"]')
        page.click('#tcard [data-q="subject"]'); preview.settle(page, 400)
        sent = page.evaluate("() => window.__quietSent.filter((x) => x.method === 'POST')")
        check(len(sent) == 1 and sent[0]["body"] == {"sender": "admin@uber.com", "subject": "Do not share"}, f"{name}: the rule is the chosen words, without the code ({sent})")
        unmocked = page.evaluate("() => window.__mock.errors.filter((e) => /quiet/.test(e))")
        check(not errs and not unmocked, f"{name}: no page errors {errs[:2]} {unmocked[:2]}")
        b.close()
srv.shutdown()
print("all don't-notify checks passed" if not fails else f"{len(fails)} failed"); sys.exit(1 if fails else 0)
