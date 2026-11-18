#!/usr/bin/env python3
"""Address locks in the app, on WebKit and Chromium against the fake network (test/mock-fetch.js):
- mail a lock kept out is in Held, with its locked-out tag, and in neither the inbox nor Archive;
- opened, it says whose address it is and where it came from, and offers "Let <domain> in", which asks the hub to let that domain in
  and brings the conversation back to the inbox on the spot;
- a kept-out message whose sender could not be verified gets no such button;
- Settings -> Sender rules lists the lock (claim, other domains let in, how many are kept out) with Close and Release, and "Lock a new
  address" sends the address typed;
- nothing overflows at phone width, and there is no page error.
Usage: python3 test/addrlock.py (exit 1 on any failed check)"""
import sys, json
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
A = "x-mybank@yourdomain.example"; T5 = "55555555-5555-5555-5555-555555555555"; T6 = "66666666-6666-6666-6666-666666666666"
SETUP = """window.__mockSetup = (mk) => {
  const A = %s, T5 = %s, T6 = %s;
  const row = (id, from, subj) => ({ id, subject_norm: subj.toLowerCase(), participants: "[]", last_message_at: "2026-10-14T10:00:00Z", message_count: 1, state: "archived", starred: 0, unread: 0, labels: '["locked-out"]', last: { id: "m" + id.slice(0, 2), direction: "in", from_addr: from, from_name: "Deals", identity: A, subject: subj, snippet: "a deal", created_at: "2026-10-14T10:00:00Z", message_id: "<" + id.slice(0, 4) + "@evil.com>", to_addrs: '[{"address":"' + A + '"}]' } });
  mk.hubThreads.push(row(T5, "deals@evil.com", "Big deal"), row(T6, "help@mybank.com", "Your card"));
  const msg = (id, from, subj, root) => ({ thread: { id, state: "archived", starred: 0, unread: 0, labels: '["locked-out"]' }, messages: [{ id: "m" + id.slice(0, 2), direction: "in", from_addr: from, from_name: "Deals", identity: A, to_addrs: [{ address: A }], cc_addrs: [], subject: subj, body_text: "a deal", body_html: "", created_at: "2026-10-14T10:00:00Z", attachments: [], message_id: "<" + id.slice(0, 4) + "@evil.com>", labels: '["locked-out"]', lock_kept: 1, lock_root: root, lock_claim: "mybank.com" }] });
  mk.routes["GET /api/threads/" + T5] = msg(T5, "deals@evil.com", "Big deal", "evil.com");
  mk.routes["GET /api/threads/" + T6] = msg(T6, "help@mybank.com", "Your card", null);
  mk.routes["POST /api/locks/" + encodeURIComponent(A) + "/allow"] = { ok: true, address: A, domain: "evil.com", released: 1, threads: [T5] };
  mk.routes["PATCH /api/locks/" + encodeURIComponent(A)] = { ok: true, address: A, state: "closed" };
  mk.routes["POST /api/locks"] = { ok: true, address: "bank@yourdomain.example" };
  mk.routes["DELETE /api/locks/" + encodeURIComponent(A) + "/allow/vendor.co.uk"] = { ok: true, address: A, domain: "vendor.co.uk", removed: 1 };
  mk.routes["GET /api/locks"] = { locks: [{ address: A, state: "active", claim: "mybank.com", source: "pattern", created_at: "2026-10-14T09:00:00Z", claimed_at: "2026-10-14T09:00:00Z", allows: [{ domain: "vendor.co.uk", source: "sent" }], kept: 2 }] };
  // The mock assigns window.fetch right after this hook returns; wrap it once that has happened, to see request bodies.
  window.__bodies = []; setTimeout(() => { const f = window.fetch; window.fetch = async (u, o = {}) => { if (o.body) window.__bodies.push({ url: String(u), method: o.method, body: String(o.body) }); return f(u, o); }; }, 0);
};""" % (json.dumps(A), json.dumps(T5), json.dumps(T6))
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 800}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(SETUP)
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 6", timeout=30000); preview.settle(page, 800)
        k5, k6 = f"hub|{T5}", f"hub|{T6}"
        views = page.evaluate("""async ([k5, k6]) => { const out = {};
          for (const v of ["inbox", "archived", "held", "all"]) { await window.mh.setView(v); await new Promise((r) => setTimeout(r, 100)); out[v] = window.mh.visibleThreads().map((t) => t.key).filter((k) => k === k5 || k === k6); }
          return out; }""", [k5, k6])
        check(views["inbox"] == [] and views["archived"] == [], f"{name}: kept-out mail is in neither the inbox nor Archive ({views['inbox']}, {views['archived']})")
        check(set(views["held"]) == {k5, k6}, f"{name}: both kept-out conversations are in Held ({views['held']})")
        page.evaluate("async () => { await window.mh.setView('held'); }"); preview.settle(page, 300)
        tag = page.evaluate("""(k) => { const row = [...document.querySelectorAll('#threads .t')].find((r) => (r.dataset.key || '') === k) || [...document.querySelectorAll('#threads .t')].find((r) => r.textContent.includes('Big deal')); return row ? [...row.querySelectorAll('.lbl.scam')].map((x) => x.textContent) : null; }""", k5)
        check(tag is not None and "locked-out" in tag, f"{name}: its row in Held carries the locked-out tag ({tag})")
        bar = page.evaluate("""async (k) => { await window.mh.openThread(k); await new Promise((r) => setTimeout(r, 300));
          const el = document.querySelector('#msgs .lockbar'); const btn = el && el.querySelector('[data-lockallow]');
          return el ? { text: el.textContent.replace(/\\s+/g, ' ').trim(), btn: btn ? btn.textContent.trim() : null } : null; }""", k5)
        check(bar is not None and "Kept out by an address lock" in bar["text"] and f"{A} is locked to mybank.com; this came from evil.com" in bar["text"], f"{name}: the open message says whose address it is and where this came from ({bar and bar['text'][:150]})")
        check(bar is not None and bar["btn"] == "Let evil.com in", f"{name}: and offers Let evil.com in ({bar and bar['btn']})")
        after = page.evaluate("""async (k) => { document.querySelector('#msgs [data-lockallow]').click(); await new Promise((r) => setTimeout(r, 600));
          const t = window.mh.state.threads.get(k); const sent = window.__bodies.find((x) => x.url.includes('/allow'));
          return { state: t.state, labels: t.labels, bar: !!document.querySelector('#msgs .lockbar'), sent, calls: window.__mock.calls.filter((c) => c.includes('/api/locks')) }; }""", k5)
        check(after["sent"] is not None and json.loads(after["sent"]["body"]) == {"domain": "evil.com"} and after["sent"]["method"] == "POST", f"{name}: the click asks the hub to let evil.com in to {A} ({after['sent']})")
        check(after["state"] == "inbox" and "locked-out" not in (after["labels"] or []) and not after["bar"], f"{name}: the conversation is back in the inbox at once, untagged, and the banner is gone ({after['state']}, {after['labels']}, bar {after['bar']})")
        inbox = page.evaluate("async (k) => { await window.mh.setView('inbox'); await new Promise((r) => setTimeout(r, 100)); return window.mh.visibleThreads().some((t) => t.key === k); }", k5)
        check(inbox, f"{name}: and the inbox view lists it")
        unv = page.evaluate("""async (k) => { await window.mh.openThread(k); await new Promise((r) => setTimeout(r, 300)); const el = document.querySelector('#msgs .lockbar');
          return el ? { text: el.textContent.replace(/\\s+/g, ' ').trim(), btn: !!el.querySelector('[data-lockallow]') } : null; }""", k6)
        check(unv is not None and "this sender could not be verified" in unv["text"] and not unv["btn"], f"{name}: a kept-out message from an unverified sender has the banner and no Let-in button ({unv})")
        # Settings -> Sender rules -> Address locks
        sec = page.evaluate("""async () => { await window.mh.openSettings(); await new Promise((r) => setTimeout(r, 300));
          document.querySelector('[data-sec-nav="rules"]')?.click(); await new Promise((r) => setTimeout(r, 400));
          const grp = [...document.querySelectorAll('.st-grp')].find((g) => (g.querySelector('.st-gt') || {}).textContent?.startsWith('Address locks'));
          const row = grp && [...grp.querySelectorAll('.st-row')].find((r) => r.textContent.includes('x-mybank@yourdomain.example'));
          return row ? { text: row.textContent.replace(/\\s+/g, ' ').trim(), btns: [...row.querySelectorAll('button')].map((x) => x.textContent.trim()), form: !!document.querySelector('#lkloc') && !!document.querySelector('#lkadd'), doms: [...document.querySelectorAll('#lkdom option')].map((o) => o.value) } : null; }""")
        check(sec is not None and "Belongs to mybank.com" in sec["text"] and "also lets in vendor.co.uk" in sec["text"] and "2 kept out (in Held)" in sec["text"], f"{name}: Settings lists the lock with its claim, the other domain let in and the kept-out count ({sec and sec['text'][:160]})")
        check(sec is not None and sec["btns"] == ["Close", "Release"] and sec["form"] and sec["doms"] == ["yourdomain.example"], f"{name}: with Close and Release, and a form to lock a new address on the user's domains ({sec and sec['btns']}, {sec and sec['doms']})")
        chip = page.evaluate("""async () => { const c = document.querySelector('[data-lkadel][data-lkadom="vendor.co.uk"]'); if (!c) return null; const label = c.textContent.trim();
          c.click(); await new Promise((r) => setTimeout(r, 400)); return { label, called: window.__mock.calls.includes('DELETE /api/locks/x-mybank%40yourdomain.example/allow/vendor.co.uk') }; }""")
        check(chip is not None and chip["label"] == "vendor.co.uk ✕" and chip["called"], f"{name}: each domain let in has a remove button, which asks the hub to stop letting it in ({chip})")
        page.evaluate("""async () => { await window.mh.openSettings(); await new Promise((r) => setTimeout(r, 300)); document.querySelector('[data-sec-nav="rules"]')?.click(); await new Promise((r) => setTimeout(r, 400)); }""")
        made = page.evaluate("""async () => { document.querySelector('#lkloc').value = 'Bank'; document.querySelector('#lkadd').click(); await new Promise((r) => setTimeout(r, 500));
          const s = window.__bodies.filter((x) => x.method === 'POST' && /\\/api\\/locks$/.test(x.url)).pop(); return s ? JSON.parse(s.body) : null; }""")
        check(made == {"address": "bank@yourdomain.example"}, f"{name}: Lock sends the address typed, lowercased, at the chosen domain ({made})")
        b.close()
        # phone width: the banner and the Settings rows fit
        b = engine.launch(); ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=(name == "chromium"), has_touch=True); page = ctx.new_page(); page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(SETUP); page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 6", timeout=30000); preview.settle(page, 600)
        ov = page.evaluate("""async (k) => { const w = () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
          await window.mh.openThread(k); await new Promise((r) => setTimeout(r, 400)); const a = w(); const bar = document.querySelector('#msgs .lockbar'); const br = bar ? bar.getBoundingClientRect() : null;
          await window.mh.openSettings(); await new Promise((r) => setTimeout(r, 300)); document.querySelector('[data-sec-nav="rules"]')?.click(); await new Promise((r) => setTimeout(r, 400));
          const add = document.querySelector('#lkadd'); const ar = add ? add.getBoundingClientRect() : null;
          return { thread: a, settings: w(), bar: br && br.right <= innerWidth + 1, add: ar && ar.right <= innerWidth + 1 }; }""", f"hub|{T5}")
        check(ov["thread"] <= 0 and ov["settings"] <= 0 and ov["bar"] and ov["add"], f"{name}: at 390 px nothing scrolls sideways and the banner and Lock button fit ({ov})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
srv.shutdown()
print(f"\n{len(fails)} FAILED" if fails else "\nall passed")
sys.exit(1 if fails else 0)
