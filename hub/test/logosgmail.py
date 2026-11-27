#!/usr/bin/env python3
"""Gmail rows show their sender's logo. The rows of a Gmail account are built by the sync path
(sync.js msgMetaFromGmail -> store.js deriveGmailThread), not by the adapter the first logo tests used, and that path kept no DMARC
verdict, so no Gmail row on any device ever showed a logo. Through the real path, in WebKit and Chromium:
  - each message record keeps Gmail's own verdict: a pass for the From's domain or its parent is proven, a fail is not, a pass planted
    below Gmail's real stamp is not, mail sent by the owner is not, and a record synced without the header is unknown;
  - a business row in the inbox proven so (with older mail from its domain) shows its logo; a failed one does not;
  - a newer message that fails takes the logo away: a row's proof never outlives the message it was for;
  - a row whose message was synced without the header learns it in the background (backfillProof): one request, for that message only,
    never for a person's mail or archived mail, and its logo then shows;
  - no page errors.
CONTROL: APP_JS_SRC=<an app.js from before the change> with SYNC_JS_SRC/STORE_JS_SRC of the same date fails the proof checks.
Usage: python3 test/logosgmail.py"""
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

if os.environ.get("APP_JS_SRC"):
    src = lambda f, env: Path(os.environ[env]).read_text() if os.environ.get(env) else (preview.CLIENT / f).read_text()
    preview.BUNDLE = "\n".join([src("perf.js", "-"), src("store.js", "STORE_JS_SRC"), src("sync.js", "SYNC_JS_SRC"), src("queue.js", "-"), src("search.js", "-"), src("trust.js", "-")]
                               ).replace("__VERSION__", "test") + "\n" + Path(os.environ["APP_JS_SRC"]).read_text().replace("__VERSION__", "test")
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa7b1d1f70000000049454e44ae426082")
SETUP = "try { localStorage.setItem('mh:ik', 'testkey'); } catch (_) {}"
G = "'mx.google.com; dkim=pass header.i=@x.example; spf=pass smtp.mailfrom=x.example; '"
COMMON = """const email = window.mh.state.gmail[0].email, now = Date.now();
  const msg = (id, tid, from, days, labels, ar, list = true) => ({ id, threadId: tid, labelIds: labels, internalDate: String(now - days * 864e5), snippet: 's', sizeEstimate: 10,
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Subject ' + id }, ...(list ? [{ name: 'List-Unsubscribe', value: '<mailto:u@list.example>' }] : []),
      ...[].concat(ar || []).map((v) => ({ name: 'Authentication-Results', value: v }))] } });
  const G = """ + G + ";"
UNIT = "() => { " + COMMON + """
  const p = (from, ar, labels = ['INBOX', 'CATEGORY_PROMOTIONS']) => msgMetaFromGmail(email, msg('u' + Math.random(), 'ut', from, 0, labels, ar)).proven;
  return { own: p('News <news@shop.example>', G + 'dmarc=pass (p=reject) header.from=shop.example'),
           parent: p('News <news@emails.shop.example>', G + 'dmarc=pass (p=quarantine) header.from=shop.example'),
           fail: p('News <news@shop.example>', G + 'dmarc=fail (p=reject) header.from=shop.example'),
           planted: p('News <news@shop.example>', [G + 'dmarc=fail (p=reject) header.from=shop.example', 'mx.google.com; dmarc=pass header.from=shop.example']),
           none: p('News <news@shop.example>', null),
           sent: p('Me <me@shop.example>', G + 'dmarc=pass header.from=shop.example', ['SENT']) }; }"""
APPLY = "async () => { " + COMMON + """
  window.__asked = [];
  window.gapi = async (acct, path) => { window.__asked.push(path);
    if (path.startsWith('messages/lge1?')) return { id: 'lge1', payload: { headers: [{ name: 'Authentication-Results', value: G + 'dmarc=pass (p=reject) header.from=older.example' }] } };
    if (path.startsWith('messages/lgc1?')) return { id: 'lgc1', payload: { headers: [{ name: 'Authentication-Results', value: G + 'dmarc=pass (p=reject) header.from=legacy.example' }] } };
    throw Object.assign(new Error('not found'), { status: 404 }); };
  await applyGmailMessages(email, [
    msg('lga1', 'lga', 'Shop <news@emails.shop.example>', 0, ['INBOX', 'CATEGORY_PROMOTIONS'], G + 'dmarc=pass (p=quarantine) header.from=shop.example'),
    msg('lgo1', 'lgo', 'Shop <news@shop.example>', 20, ['CATEGORY_PROMOTIONS'], G + 'dmarc=pass (p=quarantine) header.from=shop.example'),
    msg('lgb1', 'lgb', 'Claim <billing@claim.example>', 0, ['INBOX', 'CATEGORY_PROMOTIONS'], [G + 'dmarc=fail (p=reject) header.from=claim.example', 'mx.google.com; dmarc=pass header.from=claim.example']),
    msg('lgbo', 'lgbo', 'Claim <billing@claim.example>', 25, ['CATEGORY_PROMOTIONS'], G + 'dmarc=pass header.from=claim.example'),
    msg('lgd1', 'lgd', 'Store <deals@store.example>', 1, ['INBOX', 'CATEGORY_PROMOTIONS'], G + 'dmarc=pass (p=reject) header.from=store.example'),
    msg('lgdo', 'lgdo', 'Store <deals@store.example>', 30, ['CATEGORY_PROMOTIONS'], G + 'dmarc=pass (p=reject) header.from=store.example'),
    msg('lgc1', 'lgc', 'Legacy <news@legacy.example>', 0, ['INBOX', 'CATEGORY_PROMOTIONS'], null),
    msg('lgco', 'lgco', 'Legacy <news@legacy.example>', 40, ['CATEGORY_PROMOTIONS'], null),
    msg('lgp1', 'lgp', 'Pat <pat@person.example>', 0, ['INBOX'], null, false),
    msg('lge1', 'lge', 'Older <news@older.example>', 0, ['INBOX', 'CATEGORY_PROMOTIONS'], null),
    msg('lgeo', 'lgeo', 'Older <news@older.example>', 50, ['CATEGORY_PROMOTIONS'], null),
  ]);
  // a row this device built before the verdict was kept: no proven, no proofKnown at all
  { const t = window.mh.state.threads.get(email + '|lge'); delete t.proven; delete t.proofKnown; }
  const st = window.mh.state; st.view = { kind: 'inbox' }; st.search = ''; window.mh.render(); }"""
NEWER = "async () => { " + COMMON + """
  await applyGmailMessages(email, [msg('lgd2', 'lgd', 'Store <deals@store.example>', 0, ['INBOX', 'CATEGORY_PROMOTIONS'], G + 'dmarc=fail (p=reject) header.from=store.example')]);
  window.mh.render(); }"""
TILES = """() => { const email = window.mh.state.gmail[0].email;
  return Object.fromEntries(['lga', 'lgb', 'lgc', 'lgd', 'lgp', 'lge'].map((id) => { const key = email + '|' + id, t = window.mh.state.threads.get(key);
    const row = document.querySelector('#threads .t[data-key="' + key + '"]'), img = row && row.querySelector('img.logo');
    return [id, { row: !!row, biz: !!(row && row.querySelector('.av.biz')), proven: t ? t.proven : null, known: t ? t.proofKnown : null, img: img ? img.getAttribute('src') : null, drawn: !!(img && img.complete && img.naturalWidth > 0) }]; })); }"""
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); page = b.new_page(viewport={"width": 1300, "height": 900}); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        page.route("**/api/logo?**", lambda route: route.fulfill(status=200, body=PNG, headers={"content-type": "image/png"}))
        page.add_init_script(SETUP)
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4 && window.mh.state.gmail && window.mh.state.gmail.length", timeout=30000); preview.settle(page, 800)
        u = page.evaluate(UNIT)
        check(u == {"own": True, "parent": True, "fail": False, "planted": False, "none": None, "sent": False},
              f"{name}: a message record keeps Gmail's verdict: own domain or parent proven; a fail, a planted pass, mail sent by the owner not; no header unknown ({u})")
        page.evaluate(APPLY); preview.settle(page, 900)
        t = page.evaluate(TILES)
        check(t["lga"]["biz"] and t["lga"]["proven"] is True and t["lga"]["img"] and "d=shop.example" in t["lga"]["img"] and t["lga"]["drawn"],
              f"{name}: a proven business row from the sync path shows its organisation's logo ({t['lga']})")
        check(t["lgb"]["row"] and t["lgb"]["proven"] is False and t["lgb"]["known"] is True and t["lgb"]["img"] is None, f"{name}: a row that failed DMARC (a pass planted below) shows its letter ({t['lgb']})")
        check(t["lgd"]["img"] is not None, f"{name}: the store's row shows its logo before its newer message ({t['lgd']})")
        page.evaluate(NEWER); preview.settle(page, 600)
        d = page.evaluate(TILES)["lgd"]
        check(d["proven"] is False and d["known"] is True and d["img"] is None, f"{name}: a newer message that fails takes the logo away ({d})")
        # the legacy row: synced without the header, then learned in the background
        page.wait_for_function("() => { const e = window.mh.state.gmail[0].email, t = window.mh.state.threads.get(e + '|lgc'), o = window.mh.state.threads.get(e + '|lge'); if (t && t.proofKnown && o && o.proofKnown) return true; if (typeof backfillProof === 'function') backfillProof(); return false; }", timeout=20000, polling=500)
        preview.settle(page, 600)
        c = page.evaluate(TILES)["lgc"]; asked = [x for x in page.evaluate("() => window.__asked") if "Authentication-Results" in x]   # bodies are prefetched too; only proof requests count
        check(c["proven"] is True and c["img"] and "d=legacy.example" in c["img"], f"{name}: a row synced without the verdict learns it in the background and shows its logo ({c})")
        o = page.evaluate(TILES)["lge"]
        check(o["proven"] is True and o["img"] and "d=older.example" in o["img"], f"{name}: a row built before the change (no proofKnown at all) learns it too and shows its logo ({o})")
        check(sorted(asked) == ["messages/lgc1?format=metadata&metadataHeaders=Authentication-Results", "messages/lge1?format=metadata&metadataHeaders=Authentication-Results"], f"{name}: one request per row, for its message only; none for a person's mail or archived mail ({asked})")
        check(not errs, f"{name}: no page errors {errs[:2]}")
        b.close()
print(f"{len(fails)} failed" if fails else "all Gmail logo checks passed")
sys.exit(1 if fails else 0)
