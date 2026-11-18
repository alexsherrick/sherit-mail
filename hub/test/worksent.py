#!/usr/bin/env python3
"""Sent lists every conversation the user wrote in, the work mailbox's included.

Work > Sent showed no work mail. The hub read only the work mailbox's Inbox, so no sent work
mail existed to list; and the page's Sent kept a domain or work conversation only while the user's message was its newest, so a
conversation that was answered afterwards left Sent. The hub now sends has_out on each conversation and the page reads it.

The page is the real client in the preview harness; the rows are what GET /api/threads returns, run through the page's own hub.norm.
Checks, on WebKit and Chromium:
  - work account > Sent lists the work conversation Jordan answered last (has_out 1) and not the work mail never answered;
  - Sent over every account lists it and the answered domain conversation, and neither unanswered one;
  - the row is drawn in the list, under its subject;
  - CONTROL: the client at 6de14a5 before this change leaves the answered conversations out of Sent.
Usage: python3 test/worksent.py"""
import sys, subprocess, socketserver, threading
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import preview
from playwright.sync_api import sync_playwright

HISTORY = subprocess.run(["git", "cat-file", "-e", "6de14a5^{commit}"], cwd=preview.HUB, capture_output=True).returncode == 0; OLD_APP = subprocess.run(["git", "show", "6de14a5:hub/src/client/app.js"], cwd=preview.HUB, capture_output=True, text=True, check=HISTORY).stdout
OLD_BUNDLE = "\n".join((preview.CLIENT / f).read_text() if f != "app.js" else OLD_APP for f in ["perf.js", "store.js", "sync.js", "queue.js", "search.js", "trust.js", "app.js"]).replace("__VERSION__", "test")
WORK = "sam@work.example"

def server(bundle):
    class H(preview.H):
        def do_GET(self):
            if self.path.split("?")[0] == "/app.js": return self._send(bundle, "text/javascript; charset=utf-8")
            return super().do_GET()
    srv = preview.TS(("127.0.0.1", 0), H); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv   # threaded

SETUP = """(work) => {
  const s = mh.state; s.me.imap_accounts = [{ email: work, label: "Work", ready: true, source: "config" }];
  const dom = (s.me.identities[0] || {}).email;
  const row = (id, subject, identity, lastDir, hasOut, from) => ({ id, subject_norm: subject.toLowerCase(), participants: "[]", last_message_at: "2026-11-05T15:00:00.000Z", message_count: 2,
    state: "archived", starred: 0, unread: 0, labels: "[]", category: null, has_in: 1, has_out: hasOut, has_att: 0, msg_ids: [],
    last: { id: id + "-m", direction: lastDir, from_addr: from, from_name: "Jordan Lee", identity, subject, snippet: "Thanks, see the attached schedule", created_at: "2026-11-05T15:00:00.000Z", message_id: "<" + id + "@x>", to_addrs: "[]" } });
  const rows = [row("aaaaaaaa-0000-0000-0000-000000000001", "Project queue", work, "in", 1, "kcole@grid.example"),
                row("aaaaaaaa-0000-0000-0000-000000000002", "Work newsletter", work, "in", 0, "news@news.example"),
                row("aaaaaaaa-0000-0000-0000-000000000003", "Domain answered", dom, "in", 1, "bob@example.org"),
                row("aaaaaaaa-0000-0000-0000-000000000004", "Domain unanswered", dom, "in", 0, "carol@example.org")];
  for (const r of rows) { const t = mh.hub.norm(r); s.threads.set(t.key, t); }
  const keys = (kind, acct) => { mh.setView(kind, acct); return mh.visibleThreads().map((t) => t.subject); };
  const work1 = keys("sent", work), all = keys("sent", null);
  mh.setView("sent", work); mh.render();
  const drawn = [...document.querySelectorAll("#threads .t")].map((e) => e.textContent).join(" | ");
  return { work: work1, all, drawn };
}"""

def run(bundle, engine):
    srv = server(bundle); base = f"http://127.0.0.1:{srv.server_address[1]}/"
    with sync_playwright() as pw:
        b = getattr(pw, engine).launch(); page = b.new_context(viewport={"width": 1280, "height": 860}).new_page(); errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(base); page.wait_for_function("window.mh && window.mh.state && window.mh.state.threads.size >= 4 && window.mh.state.me", timeout=20000); preview.settle(page, 500)
        r = page.evaluate(SETUP, WORK); r["errs"] = errs; b.close()
    srv.shutdown(); return r

fails = []
def check(c, m): print(("ok   " if c else "FAIL ") + m); (None if c else fails.append(m))

for engine in ("webkit", "chromium"):
    r = run(preview.BUNDLE, engine)
    check(r["work"] == ["Project queue"], f"{engine}: work > Sent lists the work conversation answered after the user wrote, only that ({r['work']})")
    check(set(r["all"]) >= {"Project queue", "Domain answered"} and not {"Work newsletter", "Domain unanswered"} & set(r["all"]), f"{engine}: Sent over every account lists both answered conversations and neither unanswered one ({r['all']})")
    check("Project queue" in r["drawn"], f"{engine}: the row is drawn in the list ({r['drawn'][:80]!r})")
    check(not r["errs"], f"{engine}: no page errors ({r['errs'][:2]})")

if preview.CONTROL:
    old = run(OLD_BUNDLE, "chromium")
    check("Project queue" not in old["work"] and "Domain answered" not in old["all"], f"CONTROL: the client before the change leaves both answered conversations out of Sent (work {old['work']}, all {old['all']})")
else: preview.control_skipped("worksent.py")

if fails: print(f"\n{len(fails)} FAILED"); sys.exit(1)
print("\nall Sent checks passed")
