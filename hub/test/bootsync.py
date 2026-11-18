#!/usr/bin/env python3
"""A start never waits for the hub's daily full pass (A Mac closed overnight held its first paint 3,392 ms for it, against
~200 ms for the change-feed delta). Checked on WebKit (the Mac app) and Chromium, through the real boot and refresh(), with two Gmail
accounts synced through the hub:
- (a) a device with a cursor and a full pass more than 24 h old starts on the delta alone: the start-up refresh resolves with no mirror
  and no box listing requested, and the pass is scheduled ~30 s on, once per window however many refreshes find it due;
- (b) the pass then runs once, in the background, through the shared hub sync: a refresh that starts while it runs waits on it instead of
  running its own; it writes its timestamp, and it never moves the cursor past the delta's (the box list reports a later one);
- (d) the mirror is asked for 1,000 rows a page and both accounts are read at once;
- (e) a mirror that fails for one account fails the pass: no timestamp, no cursor moved, and the next refresh schedules it again;
- a page closed before the pass ran finds it still due at the next start and defers it again, and the start history shows that start;
- (c) reset_required at start runs the full pass at once, inside the start-up refresh;
- each hub sync's kind reaches the speed report (POST /api/perf).
The deferred timer is held by the test (it is recognised by its function name, runDeferredHubFull) and released when a check wants it.
Usage: python3 test/bootsync.py (exit 1 on any failed check)"""
import sys, json
sys.path.insert(0, "test")
import preview
from playwright.sync_api import sync_playwright
srv = preview.serve(); base = f"http://127.0.0.1:{srv.server_address[1]}/"
fails = []
def check(c, m):
    print(("ok   " if c else "FAIL ") + m); (c or fails.append(m))
E, E2 = "sam.owner.sxsw@gmail.com", "second.account@gmail.com"
DAY = 24 * 3600 * 1000
INIT = r"""(() => {
  const E = 'sam.owner.sxsw@gmail.com', E2 = 'second.account@gmail.com';
  // the deferred pass's timer is held until the test releases it; every other timer runs as normal
  const st = window.setTimeout; let fake = 1e9;
  window.__deferAsked = []; window.__held = [];
  window.setTimeout = function (fn, ms, ...a) { if (typeof fn === 'function' && fn.name === 'runDeferredHubFull') { window.__deferAsked.push(ms); window.__held.push(fn); return ++fake; } return st.call(window, fn, ms, ...a); };
  window.__release = () => { const h = window.__held.splice(0); h.forEach((f) => f()); return h.length; };
  const gid = (n) => (Date.now() - 3600e3).toString(16) + String(n).padStart(5, '0');
  const mrow = (acct, id, subj) => ({ account: acct, id, thread_id: 't' + id, labels: '["INBOX"]', internal_date: Date.now() - 3600e3, history_id: '9',
    meta: JSON.stringify({ id, threadId: 't' + id, labelIds: ['INBOX'], internalDate: String(Date.now() - 3600e3), snippet: 'snippet ' + subj,
      payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Mirror <m@example.com>' }, { name: 'To', value: acct }, { name: 'Subject', value: subj }, { name: 'Message-ID', value: '<' + id + '@mail.gmail.com>' }] } }) });
  window.__ids = { [E]: gid(1), [E2]: gid(2) };
  window.__mockSetup = (mk) => {
    const s = (o = {}) => ({ state: 'ready', synced_at: new Date().toISOString(), owed: 0, ...o }), status = { [E]: s(), [E2]: s() };
    // the box list reports a later cursor (9) than the feed's (7): a pass over a live cursor must not jump to it
    mk.routes['GET /api/threads?limit=500&box=all'] = { threads: mk.hubThreads, cursor: 9 };
    mk.routes['GET /api/threads?limit=500&box=trash'] = { threads: [], cursor: 9 };
    mk.routes['GET /api/threads?limit=500&since_seq=7'] = sessionStorage.getItem('bs:reset') ? { reset_required: true, cursor: 9, gmail_status: status } : { threads: [], cursor: 7, deleted: [], more: false, gmail_status: status };
    mk.routes['GET /api/threads?limit=500&since_seq=9'] = { threads: [], cursor: 9, deleted: [], more: false, gmail_status: status };
    for (const acct of [E, E2]) mk.routes['GET /api/gmail/mirror?account=' + encodeURIComponent(acct) + '&limit=1000'] = { cursor: 9, complete: true, next: null, at: new Date().toISOString(), owed: [], status: status[acct], rows: [mrow(acct, window.__ids[acct], 'Mirrored for ' + acct)] };
  };
})();"""
# mirror requests are held 300 ms each and timed, so reads one after another cannot pass for reads at once; the speed report's body is kept
WRAP = r"""() => { window.__mlog = []; window.__perfBody = null; const f = window.fetch;
  window.fetch = async (u, o = {}) => { const s = String(u);
    if (s.includes('/api/perf') && (o.method || 'GET') === 'POST') window.__perfBody = JSON.parse(o.body);
    if (s.includes('/api/gmail/mirror')) { const q = new URL(s, location.origin).searchParams, e = { acct: q.get('account'), limit: q.get('limit'), t0: performance.now() }; window.__mlog.push(e);
      await new Promise((r) => setTimeout(r, 300)); try { return await f(u, o); } finally { e.t1 = performance.now(); } }
    return f(u, o); }; }"""
CALLS = "() => window.__mock.calls.slice()"
kinds = lambda calls: {"delta": sum("since_seq=" in c for c in calls), "all": sum("box=all" in c and "&q=" not in c for c in calls), "trash": sum("box=trash" in c for c in calls), "mirror": [c for c in calls if "/api/gmail/mirror" in c]}
with sync_playwright() as pw:
    for engine in (pw.webkit, pw.chromium):
        name = engine.name
        b = engine.launch(); ctx = b.new_context(viewport={"width": 1300, "height": 800}); ctx.add_init_script(INIT)
        page = ctx.new_page(); errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        booted = lambda: page.wait_for_function("window.mh && window.mh.perf.boot.networkDone != null && !window.mh.state.loading", timeout=30000)
        page.goto(base); page.wait_for_function("window.mh && window.mh.state.threads.size >= 4", timeout=30000)
        page.wait_for_function(f"(async () => {{ const s = await window.mh.idb.get('state', 'state|{E}'); return !!(s && s.filled); }})()", timeout=30000)
        booted()
        first = page.evaluate("() => window.mh.perf.boot.hubSync")
        check(first and first["kind"] == "full:nocursor", f"{name}: a device with no cursor mirrors in full at once, as before ({first and first['kind']})")
        # ---- a device that synced yesterday: a cursor, both accounts through the hub, the full pass 25 h old
        old = page.evaluate(f"""async () => {{ const at = Date.now() - 25 * {DAY} / 24; await window.mh.idb.meta('hubSeq', 7); await window.mh.idb.meta('hubFullAt', at);
            await window.mh.idb.meta('gmailHub', {{ '{E}': {{ at: Date.now() }}, '{E2}': {{ at: Date.now() }} }}); return at; }}""")
        page.reload(); booted()
        calls = page.evaluate(CALLS); k = kinds(calls)
        boot = page.evaluate("() => window.mh.perf.boot")
        check(k["delta"] >= 1 and k["all"] == 0 and k["trash"] == 0 and not k["mirror"], f"{name}: (a) the start-up refresh resolved on the delta alone: no mirror, no box listing before it answered ({k})")
        hs = boot.get("hubSync") or {}
        check(hs.get("kind") == "delta" and hs.get("deferred") == "full:daily" and (hs.get("lastFullH") or 0) >= 25 and hs.get("doneAt", 1e9) <= boot["networkDone"],
              f"{name}: (a) the start's hub sync is recorded: a delta that deferred the daily pass, finished by network done ({hs}, networkDone {boot['networkDone']})")
        check(page.evaluate("() => window.__deferAsked") == [30000], f"{name}: (a) the pass is scheduled once, 30 s on ({page.evaluate('() => window.__deferAsked')})")
        check(page.evaluate("() => window.mh.idb.meta('hubFullAt')") == old, f"{name}: (a) the timestamp is not written when the pass is only scheduled")
        page.evaluate("() => window.mh.refresh({ silent: true })"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        k = kinds(page.evaluate(CALLS))
        check(page.evaluate("() => window.__deferAsked.length") == 1 and not k["mirror"], f"{name}: (a) a second refresh while it is pending runs a delta and schedules nothing more ({k})")
        # ---- (b)/(d) release the timer; a refresh started while the pass runs joins it
        page.evaluate(WRAP)
        n0 = len(page.evaluate(CALLS))
        r = page.evaluate("""async () => { window.__release();
            for (let i = 0; i < 400 && !window.__mlog.length; i++) await new Promise((r) => setTimeout(r, 10));
            const joined = !!syncState.hubShared && syncHubShared() === syncState.hubShared;
            const t = performance.now(); await window.mh.refresh({ silent: true });
            return { joined, fullAt: await window.mh.idb.meta('hubFullAt'), waited: performance.now() - t, mlog: window.__mlog }; }""")
        page.wait_for_function("window.mh.perf.boot.hubFull != null", timeout=30000)
        later = page.evaluate(CALLS)[n0:]; k = kinds(later)
        check(r["joined"], f"{name}: (b) the deferred pass runs as the shared hub sync, so a sync asked for meanwhile is that same promise")
        check(r["fullAt"] > old and k["delta"] == 0, f"{name}: (b) a refresh started while it runs waits on it and runs no delta of its own (waited {round(r['waited'])} ms, {k})")
        check(k["all"] == 1 and k["trash"] == 1 and sorted(k["mirror"]) == sorted(f"GET /api/gmail/mirror?account={a.replace('@', '%40')}&limit=1000" for a in (E, E2)),
              f"{name}: (b)(d) the pass ran once: one box list each, each account's mirror once at limit=1000 ({k})")
        ml = r["mlog"]
        check(len(ml) == 2 and all(x["limit"] == "1000" for x in ml) and max(x["t0"] for x in ml) < min(x["t1"] for x in ml),
              f"{name}: (d) the two accounts are read at once: the second read started before the first answered ({[(x['acct'], round(x['t0']), round(x['t1'])) for x in ml]})")
        boot = page.evaluate("() => window.mh.perf.boot"); hf = boot.get("hubFull") or {}
        check(hf.get("kind") == "full:deferred" and hf.get("doneAt", 0) > boot["hubSync"]["doneAt"] and not hf.get("error"), f"{name}: (b) the background pass is recorded as full:deferred, after the start's delta ({hf})")
        held = page.evaluate(f"async () => [await window.mh.idb.meta('hubSeq'), !!(await window.mh.idb.get('messages', '{E}|' + window.__ids['{E}'])), !!(await window.mh.idb.get('messages', '{E2}|' + window.__ids['{E2}']))]")
        check(held == [7, True, True], f"{name}: (b) both mirrors were applied and the cursor stayed at the delta's 7, not the box list's 9 ([hubSeq, E row, E2 row] = {held})")
        page.evaluate("() => window.mh.refresh({ silent: true })"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        k = kinds(page.evaluate(CALLS)[n0:])
        check(page.evaluate("() => window.__deferAsked.length") == 1 and len(k["mirror"]) == 2 and k["all"] == 1, f"{name}: (b) once done it is not due again: the next refresh is a plain delta ({k})")
        # ---- the kind reaches the speed report the hub keeps
        page.evaluate("() => window.mh.sendSpeedReport(true)")
        rep = page.evaluate("() => window.__perfBody")
        rk = [x["kind"] for x in (rep or {}).get("hubSyncs", [])]
        check(rep and rep["boot"]["hubSync"]["kind"] == "delta" and rep["boot"]["hubFull"]["kind"] == "full:deferred" and rk[:2] == ["delta", "delta"] and "full:deferred" in rk and rep["starts"][-1]["hubFull"]["kind"] == "full:deferred",
              f"{name}: POST /api/perf carries each hub sync's kind and the start's ({rk})")
        # ---- (e) one account's mirror fails: the pass is not complete
        page.evaluate(f"() => window.mh.idb.meta('hubFullAt', {old})")
        page.evaluate("() => window.mh.refresh({ silent: true })"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        check(page.evaluate("() => window.__deferAsked.length") == 2, f"{name}: (e) due again, so the next refresh schedules it again")
        page.evaluate(f"() => {{ window.__mock.routes['GET /api/gmail/mirror?account=' + encodeURIComponent('{E2}') + '&limit=1000'] = {{ __status: 500, error: 'mirror unavailable (test)' }}; window.__mlog.length = 0; window.__release(); }}")
        page.wait_for_function("window.mh.perf.report().hubSyncs.some((x) => x.kind === 'full:deferred' && x.error)", timeout=30000)
        e = page.evaluate("async () => ({ fullAt: await window.mh.idb.meta('hubFullAt'), seq: await window.mh.idb.meta('hubSeq'), accts: window.__mlog.map((x) => x.acct), last: window.mh.perf.report().hubSyncs.slice(-1)[0] })")
        check(e["fullAt"] == old and e["seq"] == 7, f"{name}: (e) a mirror failure in one account marks nothing complete: timestamp and cursor unchanged ({e['fullAt'] == old}, hubSeq {e['seq']})")
        check(sorted(e["accts"]) == sorted([E, E2]) and "mirror unavailable" in (e["last"].get("error") or ""), f"{name}: (e) both accounts were read and the failure is recorded on the run ({e['accts']}, {e['last']})")
        page.evaluate("() => window.mh.refresh({ silent: true })"); page.wait_for_function("!window.mh.state.loading", timeout=30000)
        check(page.evaluate("() => window.__deferAsked.length") == 3, f"{name}: (e) and the next refresh schedules it again")
        # ---- a page closed before its pass ran: the next start defers it again, and the start history shows the skipped start
        preview.settle(page, 5500); page.reload(); booted()      # S1: defers; its timer is never released
        s1 = page.evaluate("() => ({ asked: window.__deferAsked, mirror: window.__mock.calls.filter((c) => c.includes('/api/gmail/mirror')).length, at: window.mh.perf.report().starts.slice(-1)[0].at })")
        preview.settle(page, 5500); page.reload(); booted()      # S2
        s2 = page.evaluate("async () => ({ asked: window.__deferAsked, fullAt: await window.mh.idb.meta('hubFullAt'), starts: window.mh.perf.report().starts })")
        prev = [s for s in s2["starts"] if s["at"] == s1["at"]]
        check(s1["asked"] == [30000] and s1["mirror"] == 0 and s2["asked"] == [30000] and s2["fullAt"] == old, f"{name}: a page closed before its pass ran finds it due at the next start and defers it again ({s1['asked']}, {s2['asked']}, timestamp unchanged {s2['fullAt'] == old})")
        check(len(prev) == 1 and prev[0]["hubSync"]["deferred"] == "full:daily" and prev[0]["hubFull"] is None, f"{name}: the start history keeps the start whose pass never ran ({prev[:1]})")
        # ---- (c) the feed forgot the cursor: the full pass runs at once, inside the start-up refresh
        page.evaluate("() => sessionStorage.setItem('bs:reset', '1')"); page.reload(); booted()
        k = kinds(page.evaluate(CALLS)); boot = page.evaluate("() => window.mh.perf.boot")
        c = page.evaluate("async () => ({ asked: window.__deferAsked, fullAt: await window.mh.idb.meta('hubFullAt'), seq: await window.mh.idb.meta('hubSeq') })")
        check(boot["hubSync"]["kind"] == "full:reset" and k["all"] == 1 and len(k["mirror"]) == 2 and c["asked"] == [], f"{name}: (c) reset_required runs the full pass at once, before the start-up refresh answers, nothing deferred ({boot['hubSync']['kind']}, {k}, {c['asked']})")
        check(c["fullAt"] > old and c["seq"] == 9, f"{name}: (c) and completes it: timestamp written, cursor from the full read ({c['seq']})")
        page.evaluate("() => sessionStorage.removeItem('bs:reset')")
        check(not errs, f"{name}: page errors {errs[:3]}")
        b.close()
srv.shutdown()
print(("FAILED: " + "; ".join(fails)) if fails else "all boot-sync checks passed")
sys.exit(1 if fails else 0)
