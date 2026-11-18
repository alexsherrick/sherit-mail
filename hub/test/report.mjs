#!/usr/bin/env node
// The daily report, after the 2026-10-06 report that printed three false or broken lines:
//  1. "imap …: synced NaN min ago"; last_sync_at already ends in Z and the report appended another, so the stale-sync CHECK
//  could never fire;
//  2. "push devices: 0 … last push delivered NEVER <-- CHECK"; it counted only Web Push, which the native apps replaced;
//  3. "accepted but NOT YET INDEXED: 3 (… most attempts 0)"; duplicate copies the sweep had just queued and the drain retired
//  a minute later; the 09:00 job now drains before it writes the report, and retired duplicates get a calm line of their own.
// Drives the REAL exported functions against real migrations and real SQLite.
// Usage: node test/report.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

const fresh = () => {
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) {
    const sql = readFileSync(HUB + "migrations/" + f, "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    for (const stmt of sql.split(/;\s*$/m)) { try { if (stmt.trim()) sq.exec(stmt); } catch (_) {} }
  }
  return sq;
};
const d1 = (sq) => ({
  prepare(sql) {
    const mk = (params) => ({
      bind: (...a) => mk(a),
      all: async () => ({ results: sq.prepare(sql).all(...params) }),
      first: async () => sq.prepare(sql).get(...params) ?? null,
      run: async () => ({ meta: { changes: Number(sq.prepare(sql).run(...params).changes) } }),
    });
    return mk([]);
  },
  batch: async (xs) => Promise.all(xs.map((x) => x.run())),
});

const SRC = readFileSync(process.env.REPORT_SRC || HUB + "src/index.js", "utf8")   // REPORT_SRC: run against another copy (the pre-fix code)
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class {};")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets in the harness"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = `${HUB}test/_report.mjs`;
writeFileSync(tmp, SRC);
const mod = await import(tmp).finally(() => unlinkSync(tmp));
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ACCT = "sam@employer.example";

// ---------- 1. the work mailbox's sync age ----------
{
  const sq = fresh();
  sq.prepare("INSERT INTO imap_folders (account, folder, role, last_sync_at) VALUES (?, 'INBOX', 'inbox', ?)").run(ACCT, iso(3 * 60_000));
  const lines = (await mod.integrityLines(d1(sq), [ACCT])).filter((l) => l.includes(`imap ${ACCT}`));
  check(lines.length === 1 && /synced 3 min ago/.test(lines[0]), `a Z-suffixed sync time reads as minutes, not NaN (${lines[0]?.trim()})`);
  check(!/NaN/.test(lines.join("")) && !/CHECK/.test(lines.join("")), "a fresh sync raises no CHECK");
  sq.prepare("UPDATE imap_folders SET last_sync_at = ?").run(iso(5 * 3600_000));
  const stale = (await mod.integrityLines(d1(sq), [ACCT])).filter((l) => l.includes(`imap ${ACCT}`));
  check(/synced 300 min ago/.test(stale[0] || "") && /<-- CHECK/.test(stale[0] || ""), `a sync five hours old raises the CHECK again (${stale[0]?.trim()})`);
  sq.prepare("UPDATE imap_folders SET last_sync_at = ?").run(new Date(Date.now() - 10 * 60_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, ""));
  const legacy = (await mod.integrityLines(d1(sq), [ACCT])).filter((l) => l.includes(`imap ${ACCT}`));
  check(/synced 10 min ago/.test(legacy[0] || ""), `a zone-less sync time is still read as UTC (${legacy[0]?.trim()})`);
}

// ---------- 2. how notifications reach the devices ----------
{
  const sq = fresh();
  let s = await mod.pushSummary(d1(sq));
  check(/<-- CHECK/.test(s), `nothing registered anywhere is a CHECK (${s})`);
  sq.prepare("INSERT INTO fcm_devices (token, ua, last_ok_at) VALUES ('tok', 'SheritAndroid', ?)").run(iso(3600_000));
  sq.prepare("INSERT INTO notify_feed (kind, payload) VALUES ('hub', '{}')").run();
  s = await mod.pushSummary(d1(sq));
  check(/Android app \(FCM\) 1, last delivered \d{4}-/.test(s) && /browsers \(Web Push\) 0/.test(s) && /feed last item \d{4}-/.test(s), `the phone and the feed are counted (${s})`);
  check(!/CHECK/.test(s), "a working phone with no browser subscriptions is not an alarm (they were removed on purpose)");
  sq.prepare("UPDATE fcm_devices SET last_error = 'UNREGISTERED'").run();
  check(/1 erroring/.test(await mod.pushSummary(d1(sq))) && /<-- CHECK/.test(await mod.pushSummary(d1(sq))), "an erroring phone is a CHECK");
  sq.prepare("UPDATE fcm_devices SET last_error = NULL, last_ok_at = NULL").run();
  check(/last delivered NEVER/.test(await mod.pushSummary(d1(sq))) && /<-- CHECK/.test(await mod.pushSummary(d1(sq))), "a phone that never received a push is a CHECK");
  // While a demotion holds dismissals at NORMAL, the report says so and until when.
  sq.prepare("UPDATE fcm_devices SET last_ok_at = ?, demoted_at = ?").run(iso(60_000), iso(3600_000));
  const dem = await mod.pushSummary(d1(sq));
  check(/Firebase demoted a push .* dismissals NORMAL until \d{4}-\d\d-\d\d/.test(dem) && /<-- CHECK/.test(dem), `a recent demotion is reported with its end date (${dem})`);
  sq.prepare("UPDATE fcm_devices SET demoted_at = ?").run(iso(8 * 86_400_000));
  check(!/demoted/.test(await mod.pushSummary(d1(sq))) && !/CHECK/.test(await mod.pushSummary(d1(sq))), "a demotion older than seven days is no longer reported");
}

// ---------- 3. duplicate copies: drained, then a calm line ----------
{
  const sq = fresh();
  sq.prepare("INSERT INTO purged_keys (raw_key, reason, at) VALUES ('raw/2026/10/a.eml', 'duplicate', ?)").run(iso(60_000));
  sq.prepare("INSERT INTO purged_keys (raw_key, reason, at) VALUES ('raw/2026/09/old.eml', 'duplicate', ?)").run(iso(3 * 86_400_000));
  const lines = await mod.integrityLines(d1(sq), []);
  check(lines.some((l) => /duplicate copies retired last 24h: 1 \(the same mail was already indexed; nothing missing\)/.test(l)), "a duplicate retired today is reported, once, without an alarm");
  check(!lines.some((l) => /NOT YET INDEXED/.test(l)), "an empty queue prints no NOT YET INDEXED line");
  // The 09:00 job drains the queue between the sweep and the report (one line in scheduled()); pinned here as source text,
  // because the report reads the queue and a sweep-then-report order is exactly what printed three harmless rows as pending.
  const daily = SRC.split("\n").find((l) => l.includes("getUTCHours() === 9 && minute === 0")) || "";
  check(daily.indexOf("sweepUnindexedRaw") > -1 && daily.indexOf("reconcileInbound") > daily.indexOf("sweepUnindexedRaw") && daily.indexOf("dailyReport") > daily.indexOf("reconcileInbound"),
    "the daily job runs sweep, then the drain, then the report");
}

// ---------- 4. failures grouped by kind ----------
// 2026-10-07's report printed "failure events last 24h: 20" for 142, as 20 identical work-mailbox lines: the list was the newest 20
// failures of the newest 400 events, so one loud failure could push every other kind off the report.
{
  const sq = fresh(); const at = (ms) => new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 19);
  const ev = sq.prepare("INSERT INTO events (at, kind, message_id, detail) VALUES (?, ?, NULL, ?)");
  ev.run(at(20 * 3600e3), "scheduled_fail", "send_later hub 1234 message exceeds the 5 MiB limit");
  ev.run(at(19 * 3600e3), "imap_sync_fail", "work@corp.example imap connection closed");
  for (let i = 0; i < 141; i++) ev.run(at(18 * 3600e3 - i * 60e3), "imap_sync_fail", "work@corp.example imap AUTHENTICATE → NO [AUTHENTICATIONFAILED]");
  for (let i = 0; i < 500; i++) ev.run(at(60e3 + i * 1000), "resend_poll_ok", "[]");   // a busy day of routine events, all newer
  ev.run(at(30 * 3600e3), "push_fail", "yesterday, outside the window");
  const lines = await mod.failureLines(d1(sq)); const text = lines.join("\n");
  check(/^failure events last 24h: 143 in 2 kinds <-- CHECK$/.test(lines[0]), `the count is the real one, with the number of kinds (${lines[0]})`);
  check(/^  - imap_sync_fail ×142, /.test(lines[1]) && /^      141× work@corp\.example imap AUTHENTICATE/.test(lines[2]) && /^        1× |^      1× work@corp\.example imap connection closed/.test(lines[3]), `one loud failure is one group, its messages counted (${lines.slice(1, 4).join(" | ")})`);
  check(/scheduled_fail ×1/.test(text) && /exceeds the 5 MiB limit/.test(text), "a different failure, older than 500 routine events, is still on the report");
  check(!/push_fail/.test(text), "a failure outside the 24 hours is not");
  check(lines.total === 143, `the total is carried for the report's own log line (${lines.total})`);
  // the whole report, as the 09:00 job sends it: the grouped list is in it, and its own log line counts the real total
  const sent = []; const env = { DB: d1(sq), FORWARD_TO: "x@gmail.com", DOMAINS: "yourdomain.example", STORE: { list: async () => ({ objects: [], truncated: false }), get: async () => null, head: async () => null },
    EMAIL: { send: async (m) => { sent.push(m); return { messageId: "<r@x>" }; } } };
  let crashed = null; try { await mod.dailyReport(env, []); } catch (e) { crashed = e; }
  const body = sent[0]?.text || "";
  check(!crashed && /failure events last 24h: 143 in 2 kinds/.test(body) && /scheduled_fail ×1/.test(body), `the 09:00 report renders with the grouped list (${crashed ? crashed.message : body.split("\n").find((l) => l.startsWith("failure events")) || "no report sent"})`);
  // The report says how each account's Gmail mirror stands; an account with no mirror yet is called out
  sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, mirror_state, mirror_synced_at) VALUES ('ok@gmail.example', 'x', 'x', 's', 'active', '2026-10-07', 'ready', ?), ('new@gmail.example', 'x', 'x', 's', 'active', '2026-10-07', NULL, NULL)").run(new Date(Date.now() - 2 * 60e3).toISOString());
  sent.length = 0; await mod.dailyReport(env, []);
  const mirrorLine = (sent[0]?.text || "").split("\n").find((l) => l.startsWith("Gmail mirror")) || "";
  check(/ok@gmail\.example=ready 0 msgs, read Gmail 2 min ago(;|$)/.test(mirrorLine) && /new@gmail\.example=not started 0 msgs <-- CHECK/.test(mirrorLine), `the report shows each account's Gmail mirror and flags one not started (${mirrorLine})`);
  const logged = sq.prepare("SELECT detail FROM events WHERE kind = 'daily_report_sent' ORDER BY at DESC LIMIT 1").get();
  check(/143 fails/.test(logged?.detail || ""), `and logs the real failure count (${logged?.detail})`);
  const none = await mod.failureLines(d1(fresh()));
  check(none.length === 1 && none[0] === "failure events last 24h: 0", `a clean day prints one calm line (${none[0]})`);
}

// ---------- 5. Gmail push health: inbox mail with no push, not silence ----------
// The 2026-10-13 and -14 reports flagged sam.third, a mailbox with no mail since 10-07, every morning for 48 h of silence.
{
  const sq = fresh(); const H = 3600e3;
  const acct = (email, { exp = 6 * 24 * H, push, state = "ready", synced = 60e3 }) => sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, watch_expiration, last_push_at, mirror_state, mirror_synced_at) VALUES (?, 'x', 'x', 's', 'active', '2026-10-07', ?, ?, ?, ?)")
    .run(email, new Date(Date.now() + exp).toISOString(), push == null ? null : iso(push), state, synced == null ? null : iso(synced));
  const msg = (email, id, labels, ago) => sq.prepare("INSERT INTO gmail_messages (account, id, thread_id, labels, internal_date, meta, history_id, updated_at) VALUES (?, ?, ?, ?, ?, '{}', '1', ?)")
    .run(email, id, id, JSON.stringify(labels), Date.now() - ago, iso(ago));
  acct("quiet@g.example", { push: 144 * H }); msg("quiet@g.example", "q1", ["INBOX", "UNREAD"], 168 * H);
  acct("archived@g.example", { push: 144 * H }); msg("archived@g.example", "a1", ["CATEGORY_PROMOTIONS"], 2 * H);
  acct("missed@g.example", { push: 30 * H }); msg("missed@g.example", "m1", ["INBOX"], 40 * H); msg("missed@g.example", "m2", ["INBOX", "UNREAD"], 2 * H);
  acct("healthy@g.example", { push: 4 * 60e3 }); msg("healthy@g.example", "h1", ["INBOX"], 5 * 60e3);
  acct("slack@g.example", { push: H }); msg("slack@g.example", "s1", ["INBOX"], 40 * 60e3);
  acct("stale@g.example", { push: 72 * H, synced: 3 * H }); msg("stale@g.example", "t1", ["INBOX"], H);
  acct("stalefresh@g.example", { push: 2 * H, synced: 3 * H });
  acct("backfill@g.example", { push: 72 * H, state: "backfill" });
  acct("expired@g.example", { push: H, exp: -H });
  acct("never@g.example", { push: null });
  const lines = await mod.integrityLines(d1(sq), []);
  const line = (e) => lines.find((l) => l.startsWith(`  gmail ${e}:`)) || "";
  const flagged = (e) => /<-- CHECK/.test(line(e));
  check(!flagged("quiet@g.example") && /last push 144h ago, newest inbox mail 168h ago$/.test(line("quiet@g.example")), `an account whose last inbox mail is older than its last push is not an alarm, however long the silence (${line("quiet@g.example").trim()})`);
  check(!flagged("archived@g.example") && /newest inbox mail none$/.test(line("archived@g.example")), `mail that never reached the inbox sends no push and is not counted (${line("archived@g.example").trim()})`);
  check(flagged("missed@g.example") && /newest inbox mail 2h ago — it came after the last push/.test(line("missed@g.example")), `inbox mail newer than the last push is the CHECK, and says why (${line("missed@g.example").trim()})`);
  check(!flagged("healthy@g.example"), `mail with its push is not an alarm (${line("healthy@g.example").trim()})`);
  check(!flagged("slack@g.example"), `mail 20 min after the last push is inside the 30 min slack (${line("slack@g.example").trim()})`);
  check(flagged("stale@g.example") && /mirror not current/.test(line("stale@g.example")), `without a current mirror, 72 h of silence is the CHECK again (${line("stale@g.example").trim()})`);
  check(!flagged("stalefresh@g.example"), `without a current mirror, 2 h of silence is not (${line("stalefresh@g.example").trim()})`);
  check(flagged("backfill@g.example") && /mirror not current/.test(line("backfill@g.example")), `a mirror still backfilling is not evidence either (${line("backfill@g.example").trim()})`);
  check(flagged("expired@g.example") && /watch EXPIRED/.test(line("expired@g.example")), `an expired watch is still a CHECK (${line("expired@g.example").trim()})`);
  check(flagged("never@g.example") && /last push NEVER/.test(line("never@g.example")), `an account that never had a push is still a CHECK (${line("never@g.example").trim()})`);
  check(!lines.some((l) => /INTEGRITY QUERY/.test(l)), "the inbox read ran without a query failure");
}

// ---------- 6. time windows on the Worker's own columns ----------
// The 2026-10-16 report raised "1 in the last 7d <-- ALERT" for a message 7 days 7 hours old. The Worker writes "2026-10-09T02:13:15.613Z"
// and the queries compared it with SQLite's datetime(), "2026-10-09 09:02:51": the "T" sorts after the space, so the window's whole first
// day was inside it, and anything due earlier the same day was not yet due.
{
  const sq = fresh(); const day = 864e5;
  // the first instant of the calendar day a window starts on: inside the old windows, outside the real ones
  const dayStart = (ms) => { const d = new Date(Date.now() - ms); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };
  const msg = sq.prepare("INSERT INTO messages (id, thread_id, direction, ingest_source, gmail_copy, identity, from_addr, subject, created_at) VALUES (?, 't', 'in', ?, ?, 'sam@domain5.example', ?, 's', ?)");
  msg.run("old", "cloudflare", "none", "old@oldsender.example", dayStart(7 * day));
  msg.run("new", "cloudflare", "none", "fresh@example.com", iso(6 * day));
  msg.run("yday", "imap", "off", "y@example.com", dayStart(day));
  msg.run("today", "imap", "off", "t@example.com", iso(60e3));
  sq.prepare("INSERT INTO scheduled_actions (kind, account, due_at, created_at, status) VALUES ('send_later', 'hub', ?, ?, 'pending')").run(iso(1000), iso(3600e3));
  const pic = sq.prepare("INSERT INTO img_work (key, bytes, out_bytes, at, state, done_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)");
  pic.run("img/new", 900000, 100000, iso(2 * day), "done", iso(3600e3), null);
  pic.run("img/yday", 900000, 100000, iso(2 * day), "done", dayStart(day), null);
  pic.run("img/gif", 1446144, null, iso(2 * day), "skipped", iso(3600e3), "1600: too big (too many frames)");
  const sent = []; const env = { DB: d1(sq), FORWARD_TO: "x@gmail.com", DOMAINS: "yourdomain.example", STORE: { list: async () => ({ objects: [], truncated: false }), get: async () => null, head: async () => null },
    EMAIL: { send: async (m) => { sent.push(m); return { messageId: "<r@x>" }; } } };
  let crashed = null; try { await mod.dailyReport(env, []); } catch (e) { crashed = e; }
  const body = sent[0]?.text || "", line = (p) => body.split("\n").find((l) => l.startsWith(p)) || (crashed ? "CRASH " + crashed.message : "");
  check(/: 1 in the last 7d <-- ALERT \(\+1 older, known\)$/.test(line("Cloudflare-routed inbound WITHOUT")) && /fresh@example\.com/.test(body) && !/oldsender/.test(body),
    `a message past 7 days on the window's first calendar day is counted as older, not listed (${line("Cloudflare-routed inbound WITHOUT")})`);
  check(/^inbound last 24h: imap=1; outbound last 24h: 0$/.test(line("inbound last 24h")), `"last 24h" is 24 hours, not since yesterday's midnight (${line("inbound last 24h")})`);
  check(/^pictures shrunk last 24h: 1 \(0\.9 MB -> 0\.1 MB, both sizes\); left as sent 1; waiting 0; failed 0; pictures kept 0$/.test(line("pictures shrunk")),
    `the picture line counts 24 hours, and a refused picture is left as sent with no CHECK (${line("pictures shrunk")})`);
  const stuck = (await mod.integrityLines(d1(sq), [])).find((l) => l.includes("stuck work")) || "";
  check(/1 overdue scheduled/.test(stuck) && /<-- CHECK/.test(stuck), `a scheduled action due a second ago and still pending is overdue (${stuck.trim()})`);
  // every datetime('now' left in the Worker compares events.at, the one column written in SQLite's form; the ISO bound never does
  const code = SRC.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");   // the explanation above now() quotes both forms
  const at = (re) => [...code.matchAll(re)].map((x) => { const before = code.slice(Math.max(0, x.index - 400), x.index); const f = [...before.matchAll(/FROM (\w+)/g)].pop(); return f?.[1]; });
  const sqlite = at(/datetime\('now'/g), isoBound = at(/strftime\('%Y-%m-%dT%H:%M:%fZ','now'/g);
  check(sqlite.length === 11 && sqlite.every((t) => t === "events"),   // 11th: one sender's share of the day's pictures (prefetchDomainLeft)
    `datetime('now') is compared only with events.at (${sqlite.join(", ")})`);
  check(isoBound.length >= 19 && isoBound.every((t) => t && t !== "events"), `the ISO bound is used on the Worker's own columns only (${[...new Set(isoBound)].join(", ")})`);
}

if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("\nall report checks passed");
