#!/usr/bin/env python3
"""A reply shows what its sender wrote, and its files sit where they are seen. 2026-10-10, a vendor's
plain-text Outlook reply that showed the user's whole original, the vendor's signature and disclaimer above a small PDF chip:
the reply read badly and the file was easy to miss. Covered here, in WebKit (the Mac app) and Chromium, at phone size:
- quoteSplitText / quoteSplitHtml fold Outlook, Gmail, Apple and Thunderbird quoting, and never an inline answer, a forward or a
  message with nothing of its own;
- the open message shows the sender's words, a "•••" that shows and hides the rest, and the file as a card above the text, on screen;
- an HTML reply folds inside its frame and unfolds into a fresh, taller frame.
The fixtures have the real message's shape (plain text, Outlook "-----Original Message-----", banner, disclaimer) but invented words.
Usage: python3 test/quotes.py (exit 1 on any failed check)"""
import sys
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))

OUTLOOK_TEXT = """Sam,

Happy to help. Please find the attached NDA for your review.

Once that is done, send the files through our secure link and let me know the quantity.

Thanks for the opportunity!

Pat Example | Account Executive
pat@vendor.example
1 Main St, Anytown, ST | www.vendor.example


-----Original Message-----
From: Sam Owner <sam@yourdomain.example>
Sent: Thursday, October 8, 2026 10:45 PM
To: Info <info@vendor.example>
Subject: [External] - Quote request - 6 layer board

CAUTION: This email originated from outside of the organization.


Hi,

I'm looking for a small prototype run.

1. Can you build that stack-up?

Thanks,
Sam Owner

________________________________
Privileged And Confidential Communication. This electronic transmission is for the sole use of the intended recipient."""
OWN_END = "www.vendor.example"

TEXT_CASES = [
    ("Outlook plain reply", OUTLOOK_TEXT, "-----Original Message-----"),
    ("Gmail plain reply, attribution wrapped", "Thanks!\n\nOn Thu, Oct 8, 2026 at 10:45 PM Sam Owner <sam@yourdomain.example>\nwrote:\n\n> Hi,\n> can you quote this?\n>", "On Thu, Oct 8"),
    ("Outlook header block with its divider", "Sounds good.\n\n________________________________\nFrom: A <a@x.example>\nSent: Monday, October 5, 2026 9:00 AM\nTo: B <b@x.example>\nSubject: plan\n\nold body", "________"),
    ("trailing > block, no attribution", "Yes, Tuesday works.\n\n> Does Tuesday work?\n> Or Wednesday?\n", "> Does Tuesday"),
    ("inline answers stay whole", "See below.\n\nOn Mon, Oct 5, 2026 at 9:00 AM A <a@x.example> wrote:\n> Question one?\nAnswer one.\n> Question two?\nAnswer two.", None),
    ("bottom-posted answer stays whole", "> Does Tuesday work?\n\nYes it does.", None),
    ("quote only stays whole", "On Mon, Oct 5, 2026 at 9:00 AM A <a@x.example> wrote:\n> just this", None),
    ("a stray From: line is not a quote", "Hi,\nFrom: the lab, results are attached.\nSee you Monday.", None),
]
HTML_CASES = [
    ("Gmail reply", '<div dir="ltr">Sounds good, see you then.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Thu, Oct 8, 2026 at 10:45 PM A &lt;a@x.example&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">OLDTEXT</blockquote></div>', "see you then", True),
    ("Gmail forward stays whole", '<div dir="ltr">FYI</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: A</div>OLDTEXT</div>', None, False),
    ("Apple Mail reply", '<html><body><div>Works for me.</div><div><br><blockquote type="cite"><div>On Oct 8, 2026, at 10:45 PM, A &lt;a@x.example&gt; wrote:</div><div>OLDTEXT</div></blockquote></div></body></html>', "Works for me", True),
    ("Thunderbird reply", '<p>Agreed.</p><div class="moz-cite-prefix">On 10/8/26 10:45 PM, A wrote:<br></div><blockquote type="cite">OLDTEXT</blockquote>', "Agreed", True),
    ("Outlook on the web reply", '<div>Yes.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><b>From:</b> A<br><b>Sent:</b> Thursday<br><b>Subject:</b> x</div><div>OLDTEXT</div>', "Yes.", True),
    ("Outlook desktop reply", "<div class=WordSection1><p class=MsoNormal>Got it.</p><p>&nbsp;</p><div style='border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in'><p class=MsoNormal><b>From:</b> A <br><b>Sent:</b> Thursday<br><b>To:</b> B<br><b>Subject:</b> x</p></div><p class=MsoNormal>OLDTEXT</p></div>", "Got it.", True),
    ("inline answers stay whole", '<div>see below</div><blockquote type="cite">question one?</blockquote><div>OLDTEXT answer one</div>', None, False),
    ("quote only stays whole", '<div class="gmail_quote">On Mon A wrote:<blockquote class="gmail_quote">OLDTEXT</blockquote></div>', None, False),
    ("a newsletter with border-top stays whole", '<table><tr><td style="border-top:1px solid #eee">OLDTEXT sale</td></tr></table>', None, False),
]
GMAIL_REPLY = '<div dir="ltr">Sounds good, see you then.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Thu, Oct 8, 2026 at 10:45 PM A &lt;a@x.example&gt; wrote:<br></div><blockquote class="gmail_quote">' + "<p>OLDTEXT line</p>" * 30 + "</blockquote></div>"

INIT = """(() => { let m; Object.defineProperty(window, "__mock", { configurable: true, get() { return m; }, set(v) { m = v;
  const msg = (id, extra) => Object.assign({ id, direction: "in", from_addr: "pat@vendor.example", from_name: "Pat Example", identity: "sam@yourdomain.example", to_addrs: [{ address: "sam@yourdomain.example" }], cc_addrs: [], created_at: "2026-10-09T16:32:47Z", message_id: "<" + id + "@x>", labels: "[]", attachments: [] }, extra);
  v.routes["GET /api/threads/11111111-1111-1111-1111-111111111111"] = { thread: { id: "1111", state: "inbox", starred: 0, unread: 1, labels: "[]" }, messages: [msg("q1", { subject: "RFQ - 6 layer board", body_text: %s, body_html: "", attachments: [{ id: "qa1", filename: "Vendor NDA.pdf", size_bytes: 210044, content_type: "application/pdf" }] })] };
  v.routes["GET /api/threads/33333333-3333-3333-3333-333333333333"] = { thread: { id: "3333", state: "inbox", starred: 1, unread: 0, labels: "[]" }, messages: [msg("q3", { subject: "Re: plan", body_text: "", body_html: %s })] };
} }); })();"""

import json
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 390, "height": 844}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.add_init_script(INIT % (json.dumps(OUTLOOK_TEXT), json.dumps(GMAIL_REPLY)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 800)
        for label, text, at in TEXT_CASES:
            c = page.evaluate("(t) => window.mh.quoteSplitText(t)", text)
            want = -1 if at is None else text.index(at)
            check(c == want, f"{name} text, {label}: folds at {want} (got {c})")
        for label, html, keep, folds in HTML_CASES:
            r = page.evaluate("(h) => window.mh.quoteSplitHtml(h)", html)
            ok = (r is not None and "OLDTEXT" not in r and keep in r and "wrote:" not in r and "<hr" not in r) if folds else r is None
            check(ok, f"{name} html, {label}: {'folds' if folds else 'stays whole'} ({(r or 'null')[:90]!r})")
        # the fold parses the mail, and that parse must fetch nothing: no image, no preconnect, no script
        hits = []; page.on("request", lambda r: ("beacon" in r.url) and hits.append(r.url))
        trap = f'<link rel="preconnect" href="http://127.0.0.1:{srv.server_address[1]}/beacon-link"><div>mine</div><img src="http://127.0.0.1:{srv.server_address[1]}/beacon-img.png"><img src="x" onerror="window.__pwned=1"><script>window.__pwned=2</script><div class="gmail_quote">On Mon A wrote:<blockquote class="gmail_quote">OLDTEXT</blockquote></div>'
        r = page.evaluate("(h) => window.mh.quoteSplitHtml(h)", trap); preview.settle(page, 600)
        check(r is not None and not hits and not page.evaluate("() => window.__pwned"), f"{name}: folding a mail loads nothing and runs nothing ({hits}, {page.evaluate('() => window.__pwned')})")
        page.evaluate("(u) => { document.createElement('div').innerHTML = `<img src=\"${u}\">`; }", f"http://127.0.0.1:{srv.server_address[1]}/beacon-ctl.png"); preview.settle(page, 600)
        check(any("beacon-ctl" in u for u in hits), f"{name}: CONTROL — the same <img> in a live document is fetched, so the check above can see a request ({hits})")
        fwd = page.evaluate("(t) => { const d = document.createElement('div'); d.innerHTML = window.mh.messageHtml({ id: 'f', from: 'a', to: 'b', date: 0, subject: 'Fwd: plan', text: t, attachments: [] }, 0, 1, []); return !!d.querySelector('.qtog'); }", OUTLOOK_TEXT)
        check(not fwd, f"{name}: a forward (subject Fwd:) is never folded")

        # the real thing: open the plain-text Outlook reply on a phone
        page.evaluate("() => document.querySelector('.t[data-key=\"hub|11111111-1111-1111-1111-111111111111\"]').click()")
        page.wait_for_function("() => document.querySelector('#msgs .m .qtog')", timeout=15000); preview.settle(page, 300)
        st = page.evaluate("""() => { const m = document.querySelector('#msgs .m'), own = m.querySelector('.b pre:not(.qtail)'), tail = m.querySelector('.b pre.qtail'), q = m.querySelector('.qtog'), card = m.querySelector('.atts.files .att.card'), body = m.querySelector('.b');
          const r = (e) => e.getBoundingClientRect();
          return { own: own.textContent, tailHidden: tail.hidden && r(tail).height === 0, tailText: tail.textContent, label: q.getAttribute('aria-label'), card: !!card, tile: card && card.querySelector('.ft').textContent, pdf: card && card.querySelector('.ft').classList.contains('pdf'),
            name: card && card.querySelector('.an').textContent, size: card && card.querySelector('.as').textContent, dl: card && card.querySelector('.attdl')?.getAttribute('aria-label'),
            above: card && r(card).bottom <= r(body).top + 1, onScreen: card && r(card).top >= 0 && r(card).bottom <= innerHeight, bottomStrip: !!m.querySelector('.b ~ .atts') }; }""")
        check(st["own"].rstrip().endswith(OWN_END) and "Original Message" not in st["own"] and "CAUTION" not in st["own"], f"{name}: the reply shows the sender's own words, ending at his signature ({st['own'][-40:]!r})")
        check(st["tailHidden"] and st["tailText"].startswith("-----Original Message-----") and "Privileged" in st["tailText"], f"{name}: the quoted original, banner and disclaimer are folded, not lost")
        check(st["label"] == "Show quoted text", f"{name}: the fold says what it does ({st['label']!r})")
        check(st["card"] and st["tile"] == "PDF" and st["pdf"] and st["name"] == "Vendor NDA.pdf" and st["size"] == "205 KB" and st["dl"] == "Download Vendor NDA.pdf", f"{name}: the file is a card with a PDF tile, its name, its size and Download ({st})")
        check(st["above"] and st["onScreen"], f"{name}: the card sits above the text and on screen without scrolling, at phone size")
        check(not st["bottomStrip"], f"{name}: no second copy of the file at the bottom")
        page.click("#msgs .m .qtog"); preview.settle(page, 150)
        op = page.evaluate("() => { const m = document.querySelector('#msgs .m'), t = m.querySelector('.qtail'); return { shown: !t.hidden && t.getBoundingClientRect().height > 50, exp: m.querySelector('.qtog').getAttribute('aria-expanded'), collapsed: m.classList.contains('collapsed') }; }")
        check(op["shown"] and op["exp"] == "true" and not op["collapsed"], f"{name}: \"•••\" shows the quoted original, and does not collapse the message ({op})")
        page.click("#msgs .m .qtog"); preview.settle(page, 150)
        check(page.evaluate("() => document.querySelector('#msgs .m .qtail').hidden"), f"{name}: and hides it again")

        # an HTML reply folds inside its frame
        page.evaluate("() => window.mh.back && window.mh.back()"); preview.settle(page, 200)
        page.evaluate("() => document.querySelector('.t[data-key=\"hub|33333333-3333-3333-3333-333333333333\"]').click()")
        page.wait_for_function("() => document.querySelector('#msgs .m .qtog[data-full]')", timeout=15000); preview.settle(page, 700)
        FR = "() => { const f = document.querySelector('#msgs .m .b iframe'); return { text: f.contentDocument.body.textContent, h: f.getBoundingClientRect().height }; }"
        f1 = page.evaluate(FR)
        check("see you then" in f1["text"] and "OLDTEXT" not in f1["text"], f"{name}: the HTML reply's frame shows the reply without the quote ({f1['text'][:60]!r}, {f1['h']} px)")
        page.click("#msgs .m .qtog"); preview.settle(page, 900)
        f2 = page.evaluate(FR)
        check("see you then" in f2["text"] and "OLDTEXT" in f2["text"] and f2["h"] > f1["h"] + 100, f"{name}: \"•••\" puts the whole mail in a fresh frame, sized to it ({f1['h']} -> {f2['h']} px)")
        page.click("#msgs .m .qtog"); preview.settle(page, 900)
        f3 = page.evaluate(FR)
        check("OLDTEXT" not in f3["text"] and f3["h"] < f2["h"], f"{name}: and folds it again ({f3['h']} px)")
        check(page.evaluate("() => document.querySelectorAll('#msgs .m .b iframe').length") == 1, f"{name}: one frame per message, never a stale second one")
        check(not errs, f"{name}: page errors {errs[:3]}")
        b.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all quoted-text and file-card checks passed")
sys.exit(1 if fails else 0)
