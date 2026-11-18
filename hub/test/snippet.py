#!/usr/bin/env python3
"""Gmail previews ("Angelclub Q&A &lt;&gt; Acme Space"). Gmail's snippet is HTML-escaped and the client
decoded &#39; &quot; &amp; but not &lt; &gt;. This pins the decode, and the one-time repair of previews already saved on a device:
the conversation row AND its saved messages, since a conversation is rebuilt from those. Usage: python3 test/snippet.py"""
import sys
sys.path.insert(0,"test")
import preview
from playwright.sync_api import sync_playwright
srv=preview.serve(); base=f"http://127.0.0.1:{srv.server_address[1]}/"
fails=[]
def check(c,m):
    print(("ok   " if c else "FAIL ")+m); (c or fails.append(m))
ACCT="sam.owner.sxsw@gmail.com"; TK=f"{ACCT}|zzsnip"; MK=f"{ACCT}|zzsnipmsg"
with sync_playwright() as pw:
    b=pw.chromium.launch(); ctx=b.new_context(viewport={"width":411,"height":918},has_touch=True,is_mobile=True)
    page=ctx.new_page(); errs=[]; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 1500)
    d=page.evaluate("() => [gmailSnippet('Angelclub Q&amp;A &lt;&gt; Acme Space'), gmailSnippet('it&#39;s &quot;5 &lt; 6&quot;'), gmailSnippet('a literal &amp;lt;b&amp;gt; stays'), gmailSnippet(undefined)]")
    check(d[0]=="Angelclub Q&A <> Acme Space", f"&lt; and &gt; are decoded ({d[0]!r})")
    check(d[1]=='it\'s "5 < 6"', f"with the others ({d[1]!r})")
    check(d[2]=="a literal &lt;b&gt; stays", f"once, not twice: an escaped literal stays literal ({d[2]!r})")
    check(d[3]=="", "a missing snippet is empty")
    # a device that saved previews before the fix: a conversation row and its message, and no repair flag yet
    page.evaluate("""([tk, mk, acct]) => { const t = { ...[...window.mh.state.threads.values()].find((x) => x.kind === 'gmail'), key: tk, id: tk.split('|')[1], snippet: 'Angelclub Q&A &lt;&gt; Acme Space', updatedAt: Date.now() };
      return Promise.all([window.mh.idb.putAll('threads', [t]), window.mh.idb.putAll('messages', [{ key: mk, threadKey: tk, account: acct, id: 'zzsnipmsg', threadId: 'zzsnip', snippet: 'Q&A &lt;&gt; Acme', date: Date.now(), labels: ['INBOX'] }]), window.mh.idb.del('meta', 'snipfix1')]); }""", [TK, MK, ACCT])
    page.reload(); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000); preview.settle(page, 2500)
    r=page.evaluate("""async ([tk, mk]) => { const t = await window.mh.idb.get('threads', tk), m = await window.mh.idb.get('messages', mk); return [window.mh.state.threads.get(tk)?.snippet, t && t.snippet, m && m.snippet, await window.mh.idb.meta('snipfix1')]; }""", [TK, MK])
    check(r[0]=="Angelclub Q&A <> Acme Space", f"the saved conversation shows the repaired preview ({r[0]!r})")
    check(r[1]=="Angelclub Q&A <> Acme Space", f"and is saved repaired ({r[1]!r})")
    check(r[2]=="Q&A <> Acme", f"its saved message is repaired, so a rebuild cannot bring the old text back ({r[2]!r})")
    check(r[3]==1, f"the repair is recorded, so it runs once ({r[3]!r})")
    check(not errs, f"page errors {errs[:3]}")
    ctx.close(); b.close()
srv.shutdown()
print(("FAILED: "+"; ".join(fails)) if fails else "all preview checks passed")
sys.exit(1 if fails else 0)
