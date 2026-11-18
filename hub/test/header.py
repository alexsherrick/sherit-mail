#!/usr/bin/env python3
"""The message header and plain-text links. 2026-10-10, from the approved mockup of a vendor's reply: the sender's
full address shows on a tap, word-wrapped to fit the card. The old header
was the whole "Name <address>" in bold, and a long address ran off the card on a phone. Covered here, in WebKit (the Mac app) and
Chromium, at 390 x 844:
- the header is the sender's initial, name and short date on one line, "to me · time" under it, and nothing overflows the card;
- tapping the name shows the full address and date, word-wrapped inside the card, without collapsing; tapping again hides it;
  tapping the avatar still collapses the message;
- URLs in a plain-text mail are links that open once, through openExternal, with trailing punctuation outside and nothing from the
  mail able to reach an attribute.
Usage: python3 test/header.py (exit 1 on any failed check)"""
import sys, json
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

ADDR = "pat.example-longname@averyveryverylongvendorname-interconnect.example"
SHARE = "https://share.vendor.example/s/_0000000000000000000000000000000_0000-000000"
TEXT = f"""Sam,

Please send the files through the secure link:

{SHARE}

Background (https://en.wikipedia.org/wiki/Foo_(bar)). See "https://x.example/a"<script>window.__pwned=1</script> and https://x.example/page.

Pat"""
INIT = """(() => { let m; Object.defineProperty(window, "__mock", { configurable: true, get() { return m; }, set(v) { m = v;
  v.routes["GET /api/threads/11111111-1111-1111-1111-111111111111"] = { thread: { id: "1111", state: "inbox", starred: 0, unread: 1, labels: "[]" }, messages: [{ id: "h1", direction: "in", from_addr: %s, from_name: "Pat Example-Longname", identity: "sam@yourdomain.example", to_addrs: [{ address: "sam@yourdomain.example" }], cc_addrs: [], created_at: "2026-10-09T16:32:47Z", message_id: "<h1@x>", labels: "[]", subject: "RFQ", body_text: %s, body_html: "", attachments: [{ id: "ha1", filename: "Vendor NDA.pdf", size_bytes: 210044, content_type: "application/pdf" }] }] };
} }); })();""" % (json.dumps(ADDR), json.dumps(TEXT))

with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 390, "height": 844}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(INIT)
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        page.evaluate("() => document.querySelector('.t[data-key=\"hub|11111111-1111-1111-1111-111111111111\"]').click()")
        page.wait_for_function("() => document.querySelector('#msgs .m .who2')", timeout=15000); preview.settle(page, 300)
        GEO = """() => { const m = document.querySelector('#msgs .m'), r = (e) => e.getBoundingClientRect(), mr = r(m), h = m.querySelector('.h');
          const over = [...m.querySelectorAll('.h *, .hdet *')].filter((e) => r(e).width && r(e).right > mr.right + 1).map((e) => e.className || e.tagName);
          const l1 = m.querySelector('.l1'), d = m.querySelector('.hdet');
          return { name: m.querySelector('.l1 .from').textContent, when: m.querySelector('.l1 .when').textContent, l2: m.querySelector('.l2').textContent, l1h: r(l1).height,
            fits: m.scrollWidth <= m.clientWidth + 1 && !over.length, over, detShown: !d.hidden && r(d).height > 0, collapsed: m.classList.contains('collapsed'),
            det: d.textContent, detRight: r(d).right, cardRight: mr.right, addrH: d.querySelector('div span:last-child') ? r(d.querySelector('div span:last-child')).height : 0 }; }"""
        g = page.evaluate(GEO)
        check(g["name"] == "Pat Example-Longname" and g["when"] and g["l1h"] < 30, f"{name}: one header line: the sender's name and a short date ({g['name']!r}, {g['when']!r}, {g['l1h']} px)")
        check(g["l2"].startswith("to me · "), f"{name}: under it, who it went to and the time ({g['l2']!r})")
        check(g["fits"], f"{name}: nothing in the header runs off the card, however long the address ({g['over']})")
        check(not g["detShown"] and ADDR not in g["l2"], f"{name}: the full address is not on screen until asked for")
        page.click("#msgs .m .l1 .from"); preview.settle(page, 150)
        g = page.evaluate(GEO)
        check(g["detShown"] and ADDR in g["det"] and "Pat Example-Longname" in g["det"] and not g["collapsed"], f"{name}: tapping the name shows the full address and does not collapse the message ({g['det'][:80]!r})")
        check(g["fits"] and g["detRight"] <= g["cardRight"] + 1 and g["addrH"] > 25, f"{name}: the address is word-wrapped inside the card ({g['addrH']} px tall, right {g['detRight']} <= {g['cardRight']}, {g['over']})")
        check("2026" in g["det"], f"{name}: and the full date")
        page.click("#msgs .m .l2"); preview.settle(page, 150)
        check(not page.evaluate(GEO)["detShown"], f"{name}: tapping the to-line hides it again")
        page.click("#msgs .m .hav"); preview.settle(page, 150)
        check(page.evaluate(GEO)["collapsed"], f"{name}: tapping the avatar still collapses the message")
        page.click("#msgs .m .h"); preview.settle(page, 300)
        check(not page.evaluate(GEO)["collapsed"], f"{name}: and tapping the header opens it again")
        # plain-text links
        links = page.evaluate("() => [...document.querySelectorAll('#msgs .m .b pre a.tl')].map((a) => a.getAttribute('href'))")
        check(links[:1] == [SHARE], f"{name}: the secure-share link is a link ({links[:1]})")
        check("https://en.wikipedia.org/wiki/Foo_(bar)" in links, f"{name}: a URL that opens a bracket keeps its closing one; the sentence's does not ({links})")
        check("https://x.example/a" in links and "https://x.example/page" in links and not any('"' in u or "<" in u or u.endswith(".") for u in links), f"{name}: quotes and trailing punctuation stay outside every link ({links})")
        check(not page.evaluate("() => window.__pwned || document.querySelector('#msgs pre script')"), f"{name}: markup in a plain-text mail stays text")
        page.evaluate("() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; }")
        page.click("#msgs .m .b pre a.tl"); preview.settle(page, 200)
        op = page.evaluate("() => ({ opened: window.__opened, url: location.href, collapsed: document.querySelector('#msgs .m').classList.contains('collapsed') })")
        check(op["opened"] == [SHARE] and op["url"].startswith(base) and not op["collapsed"], f"{name}: tapping it opens it once, outside the app ({op})")
        # Mail we sent : the list names where it went, the header says which of our addresses it went from.
        row = page.evaluate("""() => { const r = document.querySelector('.t[data-key="hub|33333333-3333-3333-3333-333333333333"]');
          return { who: r.querySelector('.who span:nth-child(2)').textContent, av: r.querySelector('.av').firstChild.textContent }; }""")
        check(row == {"who": "→ perry@powerparts.example", "av": "P"}, f"{name}: a conversation we wrote last is listed under who it went to, not 'You' ({row})")
        peers = page.evaluate("""() => [
          { out: true, to: '"Lane, Perry M" <perry.lane@aeroco.example>, b@x.example, c@y.example', fromName: "You" },
          { out: true, to: "sam@yourdomain.example, sales@pcbvendor.example", fromName: "You" },
          { out: true, to: "sam@yourdomain.example", fromName: "You" },
          { out: true, to: "", fromName: "You", fromAddr: "sam@yourdomain.example" },
          { out: false, to: "sam@yourdomain.example", fromName: "Bob", fromAddr: "bob@example.com" },
        ].map((t) => rowPeer(t).label)""")
        check(peers == ["→ Lane, Perry M +2", "→ sales@pcbvendor.example", "→ sam@yourdomain.example", "You", "Bob"],
              f"{name}: the To line's name, else the address; our own address skipped unless it is the only one; no To still 'You'; received mail unchanged ({peers})")
        page.evaluate("() => openThread('hub|33333333-3333-3333-3333-333333333333')")
        page.wait_for_function("() => [...document.querySelectorAll('#msgs .m .l1 .from')].some((e) => e.querySelector('.fid'))", timeout=15000); preview.settle(page, 300)
        mine = page.evaluate("""() => { const r = (e) => e.getBoundingClientRect(), f = [...document.querySelectorAll('#msgs .m .l1 .from')], o = f.find((e) => e.querySelector('.fid')), m = o.closest('.m'), mr = r(m);
          return { names: f.map((e) => e.textContent), when: m.querySelector('.l1 .when').textContent, whenIn: r(m.querySelector('.l1 .when')).right <= mr.right + 1,
            fits: m.scrollWidth <= m.clientWidth + 1 && ![...m.querySelectorAll('.h *')].some((e) => r(e).width && r(e).right > mr.right + 1), l1h: r(m.querySelector('.l1')).height }; }""")
        check("Sam (You) · sam@yourdomain.example" in mine["names"] and "Perry" in mine["names"], f"{name}: our message reads '<the name it went out under> (You) · <the address>', theirs keeps the name ({mine['names']})")
        check(mine["when"] and mine["whenIn"] and mine["fits"] and mine["l1h"] < 30, f"{name}: on one line, the date still on the card ({mine})")
        sent = page.evaluate("""() => { const base = { direction: "out", identity: "sam@yourdomain.example", to_addrs: [{ address: "sharon@hillside.example" }], cc_addrs: [], created_at: "2026-10-12T17:57:00Z", body_text: "Hi Sharon", body_html: "", labels: "[]" };
          const [a, b] = hub.normalize({ thread: {}, messages: [{ ...base, id: "s1", from_name: "Sam Owner" }, { ...base, id: "s2", from_name: "" }] }).messages;
          const head = (m) => { const d = document.createElement("div"); d.innerHTML = messageHead(m, false, 0); return { name: d.querySelector(".l1 .from").textContent, av: d.querySelector(".hav").textContent, det: d.querySelector(".hdet").textContent }; };
          return { from: [a.from, b.from], heads: [head(a), head(b)], quote: quote(a).split("\\n")[2] }; }""")
        check(sent["from"] == ["Sam Owner <sam@yourdomain.example>", "sam@yourdomain.example"], f"{name}: a sent message's from is the From it went out with ({sent['from']})")
        check([h["name"] for h in sent["heads"]] == ["Sam Owner (You) · sam@yourdomain.example", "You · sam@yourdomain.example"] and [h["av"] for h in sent["heads"]] == ["S", "Y"],
              f"{name}: 'Sam Owner (You) · …' with its initial; with no name stored, 'You · …' ({sent['heads']})")
        check("Sam Owner <sam@yourdomain.example>" in sent["heads"][0]["det"] and "You (" not in sent["heads"][0]["det"], f"{name}: the details row shows the real From ({sent['heads'][0]['det'][:60]!r})")
        check(sent["quote"].endswith("Sam Owner <sam@yourdomain.example> wrote:"), f"{name}: a reply quoting our message names us as the recipient will see it, not 'You (…)' ({sent['quote']!r})")
        cache = page.evaluate("""async () => { const t = state.threads.get('hub|33333333-3333-3333-3333-333333333333'), rows = await idb.getByIndex("bodies", "threadKey", t.key);
          const fresh = !!(await cachedThread(t)); await idb.putAll("bodies", rows.map((r) => r.m.out ? { ...r, m: { ...r.m, from: "You (sam@yourdomain.example)" } } : r));
          const old = !!(await cachedThread(t)); await idb.putAll("bodies", rows); return { n: rows.length, fresh, old }; }""")
        check(cache["n"] == 2 and cache["fresh"] and not cache["old"], f"{name}: a conversation cached in the old 'You (…)' form is fetched again rather than served ({cache})")
        check(not errs, f"{name}: page errors {errs[:3]}")
        b.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all header checks passed")
sys.exit(1 if fails else 0)
