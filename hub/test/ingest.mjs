#!/usr/bin/env node
// EXECUTION test for the R2-first inbound path: the real email() handler, real migrations, real SQLite, a fake R2.
//
// Requirement: inbound mail through Cloudflare must be extremely reliable; it must not lose a message.
// The path used to make five D1 reads before the bytes existed anywhere, so any D1 error threw before ingestRaw ran and
// the message was gone; `storeErr` was assigned and never read, so a failed store was answered with "delivered"; and
// every internal failure was answered with setReject, which Cloudflare documents as "a permanent SMTP error" -- a hard
// bounce wearing the words "temporary failure, please retry".
//
// The invariant this file exists to hold is ONE sentence: no D1 call may precede the R2 put, and nothing after that put
// may refuse the message. That is checked structurally (by recording call order) rather than by replaying old code, so
// it keeps holding as the handler changes. Usage: node test/ingest.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

const statements = (sql) => { // keep trigger bodies whole: "BEGIN...; END;" is ONE statement
  const out = []; let buf = "";
  for (const part of sql.split(";")) {
    buf += part + ";";
    if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; }
  }
  const t = buf.trim(); if (t && t !== ";") out.push(t); return out;
};
// Strip `--` comments to end of line, OUTSIDE string literals. Whole-line stripping was not enough: migrations 0005 and
// 0006 carry trailing comments that CONTAIN SEMICOLONS ("-- key = GMAIL_TOKEN_KEY secret;"), so the statement splitter cut
// their CREATE TABLE in half and `gmail_accounts` and `scheduled_actions` were NEVER CREATED in any test run: every suite
// here has been exercising a schema missing two tables, silently, because buildDb swallowed the errors. Found 2026-09-20
// while fixing the "all() swallows throws into []", which is the same defect one layer up.
const decomment = (sql) => {
  let out = "", q = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") { q = !q; out += c; continue; }
    if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; }
    out += c;
  }
  return out;
};
function buildDb() {
  buildDb.skipped = buildDb.skipped || [];
  const sq = new DatabaseSync(":memory:");
  for (const f of readdirSync(HUB + "migrations").sort()) {
    const sql = decomment(readFileSync(HUB + "migrations/" + f, "utf8"));
    for (const st of statements(sql)) { try { sq.exec(st); } catch (e) { buildDb.skipped.push(`${f}: ${String(e.message).slice(0, 70)}`); } }
  }
  return sq;
}
{ const sq = buildDb();
  const cols = sq.prepare("PRAGMA table_info(pending_ingest)").all().map((c) => c.name);
  check(cols.includes("raw_key") && cols.includes("attempts"), `the real migrations built pending_ingest (${cols.join(", ") || "MISSING"})`);
  // EVERY table, not just the one this file cares about. buildDb used to swallow failures, and two of them were real:
  // gmail_accounts and scheduled_actions never existed here at all.
  const tables = sq.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const t of ["messages", "threads", "pending_ingest", "gmail_accounts", "scheduled_actions", "imap_ops", "purged_keys", "push_subscriptions"])
    check(tables.includes(t), `the real migrations built ${t}`);
  check(buildDb.skipped.length === 0, `no migration statement was silently skipped (${buildDb.skipped.slice(0, 3).join(" | ") || "none"})`); }

// D1 face that records every statement, and can be switched to total failure mid-test.
function d1(sq, trace, state) {
  const run = (sql, params, kind) => {
    trace.push({ store: "d1", sql: sql.replace(/\s+/g, " ").trim().slice(0, 60) });
    if (state.d1Down) throw new Error("D1_UNAVAILABLE");
    if (state.failRulesOnce && /FROM rules\b/i.test(sql)) { state.failRulesOnce = false; throw new Error("RULES_READ_FAILED"); }
    if (state.poison && /^INSERT INTO messages/i.test(sql.trim())) throw new Error(state.poisonMsg || "POISON_PROJECTION");
    const st = sq.prepare(sql);
    return kind === "all" ? { results: st.all(...params) } : kind === "first" ? (st.get(...params) ?? null) : { meta: { changes: Number(st.run(...params).changes) } };
  };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
           batch: async (xs) => { sq.exec("SAVEPOINT b"); try { const out = []; for (const x of xs) out.push(await x.run()); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } } };   // like D1: one transaction, all or nothing
}
// R2 face, in memory.
function r2(trace, state) {
  const objs = new Map();
  return { _objs: objs,
    put: async (k, v, o) => { trace.push({ store: "r2", key: k }); if (state.r2Down) throw new Error("R2_UNAVAILABLE"); objs.set(k, { body: Buffer.from(v), customMetadata: (o || {}).customMetadata || {}, httpMetadata: (o || {}).httpMetadata || {} }); return {}; },
    get: async (k) => { const o = objs.get(k); return o ? { body: o.body, arrayBuffer: async () => o.body, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata } : null; },
    // Real R2 returns customMetadata from list() ONLY when `include` asks for it: Cloudflare's Workers API reference
    // says the include-is-ignored behaviour applies to compatibility dates before 2022-08-04, and this Worker is on
    // 2026-09-01. This double used to hand it over unconditionally, so the sweep looked correct here while in
    // production it enqueued 57 rows with an empty rcpt, an empty env_from and no Message-ID. A double that is more
    // generous than the real service cannot fail the way the real service fails.
    list: async ({ prefix, limit, cursor, include }) => ({ objects: [...objs.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ key: k, ...((include || []).includes("customMetadata") ? { customMetadata: v.customMetadata } : {}) })), truncated: false }),
    delete: async (k) => { objs.delete(k); } };
}

const SRC = readFileSync(process.env.INGEST_SRC || HUB + "src/index.js", "utf8")   // INGEST_SRC: run against another copy (the pre-fix code)
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.__from = f; this.__to = t; this.__raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = HUB + "test/_ingest_mod.mjs"; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

const MIME = (msgid, subject = "Quarterly notice") => [
  `From: Jason <jason@ticketco.example>`, `To: <sam@domain2.example>`, `Subject: ${subject}`,
  `Message-ID: <${msgid}>`, `Date: Fri, 18 Sep 2026 16:10:00 +0000`,
  `Content-Type: text/plain; charset=utf-8`, ``, `Body of ${msgid}.`, ``,
].join("\r\n");

// The real send binding refuses a raw message whose From: header is not the envelope sender: "From: header does not match mail from"
// (production, the failure test of 2026-10-09). The doubles here used to accept anything, which is how the emergency
// copy shipped broken and passed every test for three weeks. A structured send (the daily report's) has no raw and is not checked.
async function strictRaw(m) {
  if (!m || m.__raw === undefined) return "";
  const raw = typeof m.__raw === "string" ? m.__raw : Buffer.from(await new Response(m.__raw).arrayBuffer()).toString("latin1");
  const head = raw.split(/\r?\n\r?\n/)[0];
  const fromField = (head.match(/^From:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/mi) || [""])[0];
  const from = (fromField.match(/<([^>]+)>/) || [])[1] || (fromField.match(/^From:\s*(\S+@\S+)/i) || [])[1];
  if (!from || from.toLowerCase() !== String(m.__from).toLowerCase()) throw new Error("From: header does not match mail from");
  //...and its header allowlist (developers.cloudflare.com/email-service/reference/headers, read 2026-10-09): one platform-controlled or
  // unlisted header fails the whole send, "invalid headers set" in production. Date, Message-ID, MIME-Version and Content-Type are let
  // through because the hub's own raw sends (mimetext) carry them and are delivered.
  const OK = /^(from|to|cc|subject|reply-to|date|message-id|mime-version|content-type|content-transfer-encoding|in-reply-to|references|thread-index|thread-topic|list-[a-z-]+|precedence|auto-submitted|content-language|keywords|comments|importance|priority|sensitivity|organization|require-recipient-valid-since|expires|reply-by|archived-at|x-[a-z0-9_-]+)$/i;
  for (const line of head.split(/\r?\n/)) { if (/^[ \t]/.test(line) || !line.includes(":")) continue; const n = line.slice(0, line.indexOf(":")).trim(); if (!OK.test(n)) throw new Error(`invalid headers set (${n})`); }
  return raw;
}
// Deliver one message through the REAL email() entry point.
async function deliver({ sq, store, state, trace, msgid = "m1@e.ticketco.example", to = "sam@domain2.example", extraEnv = {}, mime = null }) {
  const rejects = [], forwards = [];
  const message = {
    to, from: "bounce@e.ticketco.example", rawSize: (mime || MIME(msgid)).length, raw: mime || MIME(msgid),
    headers: new Headers({ subject: "Quarterly notice", "message-id": `<${msgid}>`, from: "Jason <jason@ticketco.example>", date: "Fri, 18 Sep 2026 16:10:00 +0000" }),
    forward: async (addr) => { if (state.fwdDown) throw new Error("FORWARD_FAILED"); forwards.push(addr); },
    setReject: (r) => rejects.push(r),
  };
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", GMAIL_TOKEN_KEY: "k",
    EMAIL: { send: async (m) => { if (state.emailDown) throw new Error("EMAIL_SEND_FAILED"); state.sentRaw = await strictRaw(m); state.sent = (state.sent || 0) + 1; } }, ...extraEnv };
  let threw = null; try { await mod.default.email(message, env, { waitUntil: () => {} }); } catch (e) { threw = e; }
  return { rejects, forwards, threw };
}
// A swallowed SQL error is an assertion that passes for the wrong reason: `SELECT id FROM pending_ingest` (no such
// column) returned [] and made "the queue drained" true on a queue that had not drained. Surface the error instead.
const rows = (sq, q) => { try { return sq.prepare(q).all(); } catch (e) { throw new Error(`bad test query: ${q} -- ${e.message}`); } };

// ---------- 1. the invariant: nothing touches D1 before the bytes are durable ----------
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const { rejects } = await deliver({ sq, store, state, trace });
  const firstR2 = trace.findIndex((t) => t.store === "r2");
  const firstD1 = trace.findIndex((t) => t.store === "d1");
  check(firstR2 !== -1, "the raw message is written to R2");
  // One read is here anyway, deliberately: the hold rule decides
  // whether an address may reach Gmail, message.forward() must run BEFORE the raw stream is consumed, and forwarding
  // after consumption is undocumented. So the rule lookup stays in front, wrapped fail-closed: unknown means "do not
  // forward", and case 2 below proves it cannot gate durability. This check names that single exception rather than
  // being softened to nothing: a NEW D1 call sneaking in front of the put still fails it.
  const preR2 = trace.slice(0, firstR2).filter((x) => x.store === "d1");
  const allowed = (q) => /FROM rules\b/.test(q) || /FROM messages WHERE message_id = \? AND direction/.test(q);
  check(preR2.every((x) => allowed(x.sql)) && preR2.length <= 3,
    `the only D1 statements before the R2 put are the two advisory ones, both fail-closed (${preR2.length}: ${preR2.map((x) => x.sql.slice(0, 30)).join(" | ") || "none"})`);
  check([...store._objs.keys()][0]?.match(/^raw\/\d{4}\/\d{2}\/[0-9a-f]{64}\.eml$/) != null,
    `and its key is content-addressed, so a sender retry re-uses it  ->  ${[...store._objs.keys()][0]}`);
  check(rejects.length === 0, "the message is accepted");
  check(rows(sq, "SELECT id FROM messages WHERE direction='in'").length === 1, "and it is indexed in D1");
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 0, "with nothing left owing on the replay queue");
}

// ---------- 2. D1 entirely unavailable: the message must survive and must NOT be bounced ----------
{
  const sq = buildDb(), state = { d1Down: true }, trace = [], store = r2(trace, state);
  const { rejects } = await deliver({ sq, store, state, trace, msgid: "down@e.ticketco.example" });
  check(store._objs.size === 1, "with D1 completely down the message is STILL durable in R2");
  check(rejects.length === 0,
    "and it is NOT rejected — setReject is a PERMANENT bounce, so rejecting here would destroy mail we are holding");

  //...and once D1 comes back the message must actually APPEAR. Accepting mail we could not index is only honest because
  // this replay works, so it is checked, not assumed. Note pending_ingest is empty here: the outage was total, so even
  // the note saying a projection was owed could not be written. That is exactly what the daily sweep is under it for.
  state.d1Down = false;
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 0,
    "the outage was total, so nothing was even recorded as owing — the fast path is gone and only the sweep can save it");
  check(rows(sq, "SELECT id FROM messages").length === 0, "and the message is NOT yet in the inbox");
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example" };
  const found = await mod.sweepUnindexedRaw(env);
  check(found === 1, `the daily sweep finds the unindexed object by comparing R2 against messages.raw_key (${found})`);
  const replayed = await mod.reconcileInbound(env);
  check(replayed === 1, `the reconciler replays it from the stored bytes (${replayed})`);
  const got = rows(sq, "SELECT message_id FROM messages WHERE direction='in'");
  check(got.length === 1 && /down@e\.ticketco\.example/.test(got[0].message_id || ""),
    `and the message is now in the inbox — a D1 outage cost visibility, not mail (${got.map((r) => r.message_id).join(",") || "none"})`);
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 0, "with the replay queue drained again");
  check((await mod.reconcileInbound(env)) === 0, "and a second pass is a no-op rather than a duplicate");
}

// ---------- 3. R2 down but the Gmail copy went out: that copy is the record, so accept ----------
{
  const sq = buildDb(), state = { r2Down: true }, trace = [], store = r2(trace, state);
  const { rejects, forwards } = await deliver({ sq, store, state, trace, msgid: "r2down@e.ticketco.example" });
  check(forwards.length === 1, "the Gmail safety copy went out before the stream was consumed");
  check(rejects.length === 0, "so an R2 failure is accepted rather than bounced — Gmail is holding it");
}

// ---------- 4. R2 down AND no Gmail copy: refusing is the only honest answer, and only here ----------
{
  // EVERY route has to be closed for this: R2 down, the pre-stream Gmail forward down, and the EMAIL binding the
  // emergency copy uses down too. That it now takes all three is the point: it used to take only the first two.
  const sq = buildDb(), state = { r2Down: true, fwdDown: true, emailDown: true }, trace = [], store = r2(trace, state);
  const { rejects, threw } = await deliver({ sq, store, state, trace, msgid: "nowhere@e.ticketco.example" });
  // No longer a bounce. setReject is a PERMANENT SMTP error; a thrown handler is a TEMPORARY one, and the
  // sender retries. The bytes reached neither R2 nor Gmail, so the retry is the only way to keep it.
  check(rejects.length === 0 && threw?.name === "TempFail", `the bytes reached neither R2 nor Gmail: the sender is told to retry, not bounced (rejects ${rejects.length}, threw ${threw?.name}: ${threw?.message})`);
  check(/sender told to retry/.test(rows(sq, "SELECT detail FROM events WHERE kind='r2_write_fail'")[0]?.detail || ""), "and the record says so");
}

// ---------- 5. a sender retry of identical bytes is idempotent ----------
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  await deliver({ sq, store, state, trace, msgid: "again@e.ticketco.example" });
  await deliver({ sq, store, state, trace, msgid: "again@e.ticketco.example" });
  check(store._objs.size === 1, "the same bytes delivered twice occupy ONE R2 object (content-addressed key)");
  check(rows(sq, "SELECT id FROM messages WHERE direction='in'").length === 1, "and produce ONE message row, not two");
}

// ---------- 6. a message whose projection ALWAYS fails must never be abandoned ----------
// Five of seven reviewers found the same hole: `WHERE attempts < 8` put the row in a terminal state
// that the sweep also skipped, so the message was accepted with a 250, durable in R2, and invisible forever.
{
  const sq = buildDb(), state = { poison: true }, trace = [], store = r2(trace, state);
  const { rejects } = await deliver({ sq, store, state, trace, msgid: "poison@e.ticketco.example" });
  check(rejects.length === 0, "a projection that throws still accepts the message (the bytes are safe)");
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 1, "and records that an index is owed");

  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example" };
  // Three tries in the minute cron, then the hourly retry: a row that keeps failing must not take the minute cron with it.
  for (let i = 0; i < 3; i++) await mod.reconcileInbound(env);
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT attempts FROM pending_ingest")[0]?.attempts === 3, "after three failing minute passes the minute cron leaves the row alone (it moved to the hourly retry)");
  for (let i = 0; i < 9; i++) await mod.reconcileInbound(env, 1, { stuck: true });
  const row = rows(sq, "SELECT attempts FROM pending_ingest")[0];
  check(!!row, "after twelve failing passes the row is STILL QUEUED — no terminal state, so it cannot go silently missing");
  check((row?.attempts || 0) >= 10, `and it is still being retried, not skipped (${row?.attempts} attempts)`);

  // it is also visible: "retries forever" is only honest if someone is told
  const lines = await mod.integrityLines(env.DB);
  check(lines.some((l) => /NOT YET INDEXED/.test(l)) && lines.some((l) => /STUCK/.test(l)),
    "and the daily report calls it out as stuck rather than retrying quietly in the dark");
  // Every line of this report must actually be REACHABLE. One of them queried a column the events table does not have,
  // and because the helper swallows a throw into [], the loudest alert in the file could never have fired. A report
  // that cannot fire is worse than no report, so the whole thing is built here and required not to be silently empty.
  check(lines.length > 1 && lines.every((l) => typeof l === "string"), `integrityLines builds (${lines.length} lines)`);
  check(lines.some((l) => /orphan sweep/.test(l)), "including the sweep health lines, so a dead sweep is visible");

  // and when whatever was broken is fixed, it lands
  state.poison = false;
  check((await mod.reconcileInbound(env, 1, { stuck: true })) === 1, "once the projection works again the hourly retry indexes the message");
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 0, "and the queue drains");
}

// ---------- 6b. the loss alert must be able to fire ----------
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  await deliver({ sq, store, state, trace, msgid: "vanish@e.ticketco.example" });
  const key = rows(sq, "SELECT raw_key FROM messages")[0].raw_key;
  // accepted, then the bytes disappear from R2 and the projection is still owed
  sq.prepare("DELETE FROM messages").run();
  store._objs.delete(key);
  sq.prepare("INSERT INTO pending_ingest (raw_key, rcpt, env_from, message_id, at) VALUES (?,?,?,?,?)")
    .run(key, "sam@domain2.example", "b@e.ticketco.example", "<vanish@e.ticketco.example>", new Date().toISOString());
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example" };
  await mod.reconcileInbound(env);
  const lines = await mod.integrityLines(env.DB);
  check(lines.some((l) => /BYTES ARE GONE/.test(l)),
    "accepted mail whose bytes vanished is REPORTED — the query behind this line named a column the table does not have, so it had never once been able to fire");
}

// ---------- 7. the sweep really covers the previous CALENDAR month ----------
// It used to subtract 15 days, which from the 16th of a month resolved to the current month twice and quietly stopped
// covering the previous one, while its own comment claimed otherwise.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const d = new Date(), prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const key = `raw/${prev.getUTCFullYear()}/${String(prev.getUTCMonth() + 1).padStart(2, "0")}/${"c".repeat(64)}.eml`;
  store._objs.set(key, { body: Buffer.from(MIME("lastmonth@e.ticketco.example")), customMetadata: { rcpt: "sam@domain2.example", envFrom: "bounce@e.ticketco.example", at: prev.toISOString(), msgid: "<lastmonth@e.ticketco.example>" } });
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example" };
  check((await mod.sweepUnindexedRaw(env)) === 1,
    `an orphan written LAST calendar month is still found today (day ${d.getUTCDate()} of the month — the old 15-day window missed this from the 16th on)`);
  check((await mod.reconcileInbound(env)) === 1, "and it is replayed into the inbox");
}

// ---------- 8. the same bytes to two different local recipients are two messages, not one ----------
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  await deliver({ sq, store, state, trace, msgid: "multi@e.ticketco.example", to: "sam@domain2.example" });
  await deliver({ sq, store, state, trace, msgid: "multi@e.ticketco.example", to: "sam@yourdomain.example" });
  check(store._objs.size === 2,
    `identical bytes to two of the user's addresses are TWO objects — the key is hashed over recipient AND bytes (${store._objs.size})`);
}

// ---------- 9. a stream that ends early ----------
// The first version of this guard refused on ANY rawSize mismatch. That rests on semantics Cloudflare does not document,
// and if it is off by a byte in production it PERMANENTLY BOUNCES every held message and pushes the rest onto Gmail
// alone: a fix with a worse failure mode than the defect. So it observes by default and
// only enforces behind INBOUND_STRICT_RAWSIZE, while an EMPTY read, which is unambiguous, is always refused.
async function deliverShort({ sq, store, state, trace, declaredExtra, strict, bodyOverride }) {
  const rejects = []; const body = bodyOverride !== undefined ? bodyOverride : MIME("short@e.ticketco.example");
  const message = {
    to: "sam@domain2.example", from: "bounce@e.ticketco.example", raw: body, rawSize: body.length + declaredExtra,
    headers: new Headers({ subject: "x", "message-id": "<short@e.ticketco.example>", from: "Jason <jason@ticketco.example>" }),
    forward: async () => { throw new Error("no gmail for this case"); },
    setReject: (r) => rejects.push(r),
  };
  // A send binding is present, as in production: without one the emergency copy simply failed here, which hid that a short or empty
  // read was being COPIED (accepted with a truncated copy) once the routine copy was off.
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", GMAIL_COPY: "off", ...(strict ? { INBOUND_STRICT_RAWSIZE: "1" } : {}),
    EMAIL: { send: async (m) => { state.sentRaw = await strictRaw(m); state.sent = (state.sent || 0) + 1; } } };
  let threw = null; try { await mod.default.email(message, env, { waitUntil: () => {} }); } catch (e) { threw = e; }
  rejects.threw = threw;
  return rejects;
}
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const rejects = await deliverShort({ sq, store, state, trace, declaredExtra: 500 });
  check(rejects.length === 0 && store._objs.size === 1,
    "by default a rawSize mismatch does NOT bounce the message — an undocumented field must not be allowed to refuse real mail");
  const ev = rows(sq, "SELECT kind FROM events WHERE kind = 'rawsize_mismatch'");
  check(ev.length === 1, `but it is recorded so the real semantics can be watched before enforcing (${ev.length} event)`);
}
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const rejects = await deliverShort({ sq, store, state, trace, declaredExtra: 500, strict: true });
  check(rejects.length === 0 && rejects.threw?.name === "TempFail" && store._objs.size === 0 && !(state.sent > 0),
    `with INBOUND_STRICT_RAWSIZE=1 a short read is neither stored nor copied (a truncated copy would be accepted as the message) — the sender is asked to retry (threw ${rejects.threw?.name}, copies ${state.sent || 0})`);
}
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const rejects = await deliverShort({ sq, store, state, trace, declaredExtra: 0, bodyOverride: "" });
  check(rejects.length === 0 && rejects.threw?.name === "TempFail" && store._objs.size === 0 && !(state.sent > 0),
    `an EMPTY read is never stored and never copied, strict mode or not — the sender is asked to retry (threw ${rejects.threw?.name}, copies ${state.sent || 0})`);
}

// ---------- 10. losing the insert race is dedup succeeding, not a row to retry forever ----------
// ux_messages_raw_key (migration 0021) makes the SELECT-then-INSERT precheck safe, but a constraint violation means the
// OTHER projection won and the message IS indexed. Rethrowing left the queue row retrying a conflict that can never
// clear: the attempts-cap failure mode relocated one layer down.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  await deliver({ sq, store, state, trace, msgid: "race@e.ticketco.example" });
  const key = rows(sq, "SELECT raw_key FROM messages")[0].raw_key;
  // simulate the loser of a race: its precheck saw nothing, the winner has since inserted
  sq.prepare("DELETE FROM messages WHERE raw_key = ?").run(key); // pretend the precheck ran before the winner landed
  sq.prepare("INSERT INTO pending_ingest (raw_key, rcpt, env_from, message_id, at) VALUES (?,?,?,?,?)")
    .run(key, "sam@domain2.example", "bounce@e.ticketco.example", "<race@e.ticketco.example>", new Date().toISOString());
  sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, message_id, raw_key, created_at) VALUES ('winner','t','in','sam@domain2.example','jason@ticketco.example','<winner@x>',?,?)")
    .run(key, new Date().toISOString());
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example" };
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 0,
    "a raw_key already taken drains the queue row instead of retrying a conflict that can never clear");
}

// ---------- 11. a real failure that merely MENTIONS "constraint" must not be mistaken for a duplicate ----------
// The previous round decided "this was only a duplicate" by matching /UNIQUE|constraint/ against the error string, which
// classified any FK, CHECK or NOT NULL failure as success and drained the queue row while the message stayed unindexed.
// The question is answered by looking for the row now, not by reading the message.
{
  const sq = buildDb(), state = { poison: true, poisonMsg: "NOT NULL constraint failed: messages.thread_id" }, trace = [], store = r2(trace, state);
  await deliver({ sq, store, state, trace, msgid: "constraintword@e.ticketco.example" });
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example" };
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 1,
    "a genuine failure whose text contains \"constraint\" stays QUEUED — the row is not there, so it was not a duplicate");
  check(rows(sq, "SELECT id FROM messages").length === 0, "and the message is correctly still not indexed");
  state.poison = false;
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT id FROM messages").length === 1, "and it lands once the real fault is fixed");
}

// ---------- 12. the ordering invariant on the paths the happy case never reaches ----------
// On the forward-fail path
// logEvent's D1 INSERT precedes the put". That was true, and it was true AGAIN for the rawSize mismatch log added a
// round later. Both are now deferred until the bytes are safe, and both paths are exercised here so it cannot recur.
async function firstCalls({ fwdDown, declaredExtra }) {
  const sq = buildDb(), state = { fwdDown: !!fwdDown }, trace = [], store = r2(trace, state);
  const rejects = [], body = MIME("order@e.ticketco.example");
  const message = {
    to: "sam@domain2.example", from: "bounce@e.ticketco.example", raw: body, rawSize: body.length + (declaredExtra || 0),
    headers: new Headers({ subject: "x", "message-id": "<order@e.ticketco.example>", from: "Jason <jason@ticketco.example>" }),
    forward: async () => { if (state.fwdDown) throw new Error("FORWARD_FAILED"); },
    setReject: (r) => rejects.push(r),
  };
  await mod.default.email(message, { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example" }, { waitUntil: () => {} });
  const firstR2 = trace.findIndex((x) => x.store === "r2");
  const pre = trace.slice(0, firstR2).filter((x) => x.store === "d1");
  const allowed = (q) => /FROM rules\b/.test(q) || /FROM messages WHERE message_id = \? AND direction/.test(q);
  return { sq, bad: pre.filter((x) => !allowed(x.sql)) };
}
{
  const a = await firstCalls({ fwdDown: true });
  check(a.bad.length === 0, `WHEN THE GMAIL FORWARD FAILS, still no D1 write before the put (${a.bad.map((x) => x.sql.slice(0, 40)).join(" | ") || "none"})`);
  check(rows(a.sq, "SELECT id FROM events WHERE kind='forward_fail'").length === 1, "and the failure is still recorded, just after the message is safe");
  const b = await firstCalls({ declaredExtra: 500 });
  check(b.bad.length === 0, `WHEN rawSize DISAGREES, still no D1 write before the put (${b.bad.map((x) => x.sql.slice(0, 40)).join(" | ") || "none"})`);
  check(rows(b.sq, "SELECT id FROM events WHERE kind='rawsize_mismatch'").length === 1, "and that too is recorded afterwards");
}

// ---------- 13. held mail is no longer the one class with no backstop ----------
// Hold means "do not put this in Gmail" (a visibility preference, not secrecy) and it was the one class a single R2
// failure bounced permanently. The copy CANNOT go through message.forward(): by this point message.raw is consumed, and
// step 1's own comment says forward() must precede that, so the first version of this fix was a no-op dressed as a
// safety net. It goes through env.EMAIL.send with the bytes already in hand.
{
  const sq = buildDb(), state = { r2Down: true }, trace = [], store = r2(trace, state);
  // the real schema: rules match on rcpt_glob + sender_glob (migration 0003)
  sq.prepare("INSERT INTO rules (priority, rcpt_glob, sender_glob, action, label) VALUES (1, 'sam@domain2.example', '*', 'hold', 'trademark-scam')").run();
  const rejects = [], forwards = [], body = MIME("held@e.ticketco.example");
  const message = {
    to: "sam@domain2.example", from: "bounce@e.ticketco.example", raw: body, rawSize: body.length,
    headers: new Headers({ subject: "x", "message-id": "<held@e.ticketco.example>", from: "Jason <jason@ticketco.example>" }),
    forward: async (a) => { forwards.push(a); }, setReject: (r) => rejects.push(r),
  };
  // The stub records what the constructor was actually handed: EmailMessage takes a string or a ReadableStream, and the
  // first version of this passed an ArrayBuffer, which is not a documented argument type.
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
    EMAIL: { send: async (m) => { state.sentArg = m; state.sentRaw = await strictRaw(m); state.sent = (state.sent || 0) + 1; } } };
  await mod.default.email(message, env, { waitUntil: () => {} });
  check(forwards.length === 0, "the hold rule still keeps held mail out of Gmail on the normal path");
  check((state.sent || 0) === 1, "but an R2 failure sends it through the EMAIL binding, which does not need the consumed stream");
  check(rejects.length === 0, "so held mail is not permanently refused — the last no-copy class is closed");
  check(rows(sq, "SELECT id FROM events WHERE kind='emergency_forward'").length === 1,
    "and overriding a hold preference is recorded, not silent");
  const arg = state.sentArg && state.sentArg.__raw;
  check(typeof arg === "string" || (arg && typeof arg.getReader === "function"),
    `and the raw MIME is handed over as a string or ReadableStream, never an ArrayBuffer (${arg && arg.constructor ? arg.constructor.name : typeof arg})`);
}

// ---------- 13b. a redelivery whose first copy is still in the replay queue must not re-forward ----------
{
  const sq = buildDb(), state = { poison: true }, trace = [], store = r2(trace, state);
  await deliver({ sq, store, state, trace, msgid: "queued@e.ticketco.example" });      // first copy: projection fails, row queued
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 1 && rows(sq, "SELECT id FROM messages").length === 0,
    "the first copy is queued for replay and is NOT yet in messages");
  const r2nd = await deliver({ sq, store, state, trace, msgid: "queued@e.ticketco.example" });
  check(r2nd.forwards.length === 0,
    "a redelivery is recognised from the replay queue, so it does not send a second Gmail copy (checking only `messages` missed this)");
}

// ---------- 14. the weekly full sweep has no horizon ----------
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  store._objs.set("raw/2019/01/" + "d".repeat(64) + ".eml", { body: Buffer.from(MIME("ancient@e.ticketco.example")), customMetadata: { rcpt: "sam@domain2.example", envFrom: "bounce@e.ticketco.example", at: "2019-01-05T00:00:00.000Z", msgid: "<ancient@e.ticketco.example>" } });
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example" };
  check((await mod.sweepUnindexedRaw(env)) === 0, "the daily sweep does not see an object older than its four-month horizon");
  check((await mod.sweepUnindexedRaw(env, true)) === 1, "but the weekly FULL sweep does, so the real loss bound is seven days, not the horizon");
  const rec = rows(sq, "SELECT value FROM prefs WHERE key='last_raw_sweep_full'");
  check(rec.length === 1 && /complete/.test(rec[0].value),
    `the FULL run records itself under its own key, so a daily recent run cannot make a stale full sweep look healthy (${rec[0]?.value || "not recorded"})`);
}

// ---------- 15. a SECOND copy of already-indexed bytes must retire, not retry for ever ----------
// The shape that put 57 rows in pending_ingest at 154 attempts each: importResend wrote the bytes twice
// and repointed messages.raw_key at the second object, so the first referenced nothing and looked to the sweep exactly
// like accepted-but-unindexed mail. Its customMetadata carries no `msgid` (ingestRaw's own put never wrote one), so
// the Message-ID precheck was skipped, the insert collided on (message_id, direction, identity), and the "did the
// other side win?" test asked about raw_key, which could only ever be true for a row this same key had written.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
                EMAIL: { send: async () => {} } };
  await deliver({ sq, store, state, trace, msgid: "twin@e.ticketco.example" });
  check(rows(sq, "SELECT id FROM messages").length === 1, "the message is indexed once by the normal path");
  // the orphan: same bytes, a second key, and the metadata ingestRaw's put writes; rcpt but NO msgid
  store._objs.set("raw/2026/09/" + "a".repeat(8) + "-orphan.eml", {
    body: Buffer.from(MIME("twin@e.ticketco.example")),
    customMetadata: { rcpt: "sam@domain2.example", envFrom: "bounce@e.ticketco.example", at: "2026-09-19T09:01:08.713Z", source: "resend" } });
  check((await mod.sweepUnindexedRaw(env, true)) === 1, "the sweep finds the unreferenced copy");
  const q = rows(sq, "SELECT raw_key, rcpt, message_id FROM pending_ingest");
  check(q.length === 1 && q[0].rcpt === "sam@domain2.example",
    `and enqueues it WITH its recipient, because list() now asks for customMetadata (got rcpt ${JSON.stringify(q[0]?.rcpt)})`);
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 0,
    "one drain pass retires it — the identity is resolved from the bytes, so the duplicate is RECOGNISED rather than re-inserted");
  check(rows(sq, "SELECT id FROM messages").length === 1, "and no second row was created");
  const ev = rows(sq, "SELECT kind FROM events WHERE kind='duplicate_ignored'");
  check(ev.length >= 1, "it is recorded as a duplicate, not as a failure");
}

// ---------- 15b....but an orphan with NO recoverable recipient must stay queued, not become a row nobody can find ----------
// The fix above removes the collision that used to stop this case by accident. identity '' is outside the partial
// unique index, so a bogus row would be invisible to every later dedupe AND filed under no account.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
                EMAIL: { send: async () => {} } };
  store._objs.set("raw/2026/09/" + "b".repeat(8) + "-nometa.eml", { body: Buffer.from(MIME("nometa@e.ticketco.example")), customMetadata: {} });
  check((await mod.sweepUnindexedRaw(env, true)) === 1, "the sweep enqueues an object with no metadata at all");
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT id FROM messages").length === 0, "it is NOT projected under an empty identity");
  const pend = rows(sq, "SELECT attempts, error FROM pending_ingest");
  check(pend.length === 1 && pend[0].attempts === 1 && /recipient/i.test(pend[0].error || ""),
    `it stays queued with the reason recorded, so the daily report shows it (${JSON.stringify(pend[0]?.error || "").slice(0, 70)})`);
}

// ---------- 16. mail the user purged must not come back ----------
// On 2026-09-19 the reconciler re-created two August messages from R2 (events `reconciled` 09:07:26 and 09:09:24).
// The sweep cannot tell "never indexed" from "deliberately deleted" by key alone, and purge deletes only ONE key.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
                EMAIL: { send: async () => {} } };
  await deliver({ sq, store, state, trace, msgid: "purgeme@e.ticketco.example" });
  const key = rows(sq, "SELECT raw_key FROM messages")[0].raw_key;
  // a second copy of the bytes that purge will not know about: the pre-fix importResend shape
  store._objs.set("raw/2026/09/" + "c".repeat(8) + "-twin.eml", {
    body: Buffer.from(MIME("purgeme@e.ticketco.example")),
    customMetadata: { rcpt: "sam@domain2.example", envFrom: "bounce@e.ticketco.example", at: "2026-09-19T00:00:00.000Z", source: "resend" } });
  sq.exec("UPDATE threads SET state='trash', last_message_at='2020-01-01T00:00:00.000Z'");
  await mod.purgeTrash(env);
  check(rows(sq, "SELECT id FROM messages").length === 0, "purge removed the message");
  check(rows(sq, "SELECT raw_key FROM purged_keys").some((r) => r.raw_key === key),
    "and tombstoned its key rather than relying on the R2 delete having worked");
  const found = await mod.sweepUnindexedRaw(env, true);
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT id FROM messages").length === 0,
    `nothing is resurrected: the tombstoned key is skipped and the untombstoned twin cannot be filed either (sweep found ${found})`);
}

// ---------- 17. a MISLEADING Message-ID in R2 metadata must not rebuild the retry loop ----------
// Here the stashed metadata
// carries a WRONG msgid, which is the shape that made them disagree. The precedence now mirrors ingestRaw exactly (the parsed value wins over the caller's)
// so the precheck resolves the real identity from the bytes.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
                EMAIL: { send: async () => {} } };
  await deliver({ sq, store, state, trace, msgid: "real@e.ticketco.example" });
  store._objs.set("raw/2026/09/" + "e".repeat(8) + "-liar.eml", {
    body: Buffer.from(MIME("real@e.ticketco.example")),
    customMetadata: { rcpt: "sam@domain2.example", envFrom: "bounce@e.ticketco.example", at: "2026-09-19T09:00:00.000Z",
                      source: "resend", msgid: "<WRONG-does-not-match@example.com>" } });
  await mod.sweepUnindexedRaw(env, true);
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 0,
    "a stash whose metadata names the wrong Message-ID still retires — the identity comes from the bytes, not the label");
  check(rows(sq, "SELECT id FROM messages").length === 1, "and no second row was created");
}

// ---------- 18. a retired duplicate is not re-enqueued by the next full sweep ----------
// Without a disposition the orphan is unreferenced for ever: every weekly full sweep re-enqueues it and the drain
// re-retires it: the "could never finish" drain becomes an invisible steady-state loop.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
                EMAIL: { send: async () => {} } };
  await deliver({ sq, store, state, trace, msgid: "churn@e.ticketco.example" });
  store._objs.set("raw/2026/09/" + "f".repeat(8) + "-dup.eml", {
    body: Buffer.from(MIME("churn@e.ticketco.example")),
    customMetadata: { rcpt: "sam@domain2.example", envFrom: "bounce@e.ticketco.example", at: "2026-09-19T09:00:00.000Z", source: "resend" } });
  check((await mod.sweepUnindexedRaw(env, true)) === 1, "the first full sweep enqueues the duplicate copy");
  await mod.reconcileInbound(env);
  check(rows(sq, "SELECT raw_key FROM pending_ingest").length === 0, "the drain retires it");
  check(rows(sq, "SELECT raw_key FROM purged_keys WHERE reason='duplicate'").length === 1, "and records WHY it will never be owed again");
  check((await mod.sweepUnindexedRaw(env, true)) === 0,
    "so the NEXT full sweep does not enqueue it again — the weekly churn is ended, with the bytes left untouched");
}

// ---------- 19. purging your OWN sent mail must not refuse an inbound message quoting its Message-ID ----------
// purgeTrash tombstones every message in the thread, replies included. The identity arm is inbound-only for this
// reason.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
                EMAIL: { send: async () => {} } };
  sq.exec(`INSERT INTO purged_keys (raw_key, message_id, identity, direction, reason, at)
           VALUES ('purged:sent-1', '<shared@e.ticketco.example>', 'sam@domain2.example', 'out', 'purged', '2026-09-20T00:00:00.000Z')`);
  await deliver({ sq, store, state, trace, msgid: "shared@e.ticketco.example" });
  check(rows(sq, "SELECT id FROM messages WHERE direction='in'").length === 1,
    "inbound mail carrying a purged OUTBOUND Message-ID is still delivered");
  //...while a purged INBOUND one stays gone
  sq.exec(`INSERT INTO purged_keys (raw_key, message_id, identity, direction, reason, at)
           VALUES ('purged:in-1', '<gone@e.ticketco.example>', 'sam@domain2.example', 'in', 'purged', '2026-09-20T00:00:00.000Z')`);
  await deliver({ sq, store, state, trace, msgid: "gone@e.ticketco.example" });
  check(rows(sq, "SELECT id FROM messages WHERE direction='in'").length === 1,
    "but a purged INBOUND Message-ID is refused rather than resurrected");
  check(rows(sq, "SELECT kind FROM events WHERE kind='purged_not_reprojected'").length === 1,
    "and the refusal is recorded, because a silent refusal is indistinguishable from lost mail");
}

// ---------- 20. a deploy that lands BEFORE migration 0025 must degrade, not stop indexing mail ----------
// Unknown means "not disposed" instead.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  sq.exec("DROP TABLE purged_keys");
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
                EMAIL: { send: async () => {} } };
  const { rejects } = await deliver({ sq, store, state, trace, msgid: "nomigration@e.ticketco.example" });
  check(rejects.length === 0, "mail is still accepted with the table missing");
  check(rows(sq, "SELECT id FROM messages").length === 1, "and still INDEXED — a mis-ordered deploy costs the tombstone, not the mailbox");
  check(rows(sq, "SELECT kind FROM events WHERE kind='purged_keys_read_fail'").length >= 1,
    "and the missing table is recorded, so the mis-ordering is loud rather than silent");
}

// ---------- 21. importResend writes ONE object, and it is the one the row points at ----------
// If ingestRaw ignores rawKey, twin objects are still created and the 57-row shape
// regenerates." It was the ROOT CAUSE and nothing executed it. This does.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example",
                RESEND_KEY_DOMAIN2: "re_test", EMAIL: { send: async () => {} } };
  const RID = "8f2c1d00-1111-2222-3333-444455556666";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/emails/receiving?")) return { json: async () => ({ data: [{ id: RID, to: ["sam@domain2.example"], from: "jason@ticketco.example", created_at: "2026-09-19T10:00:00.000Z", subject: "Quarterly notice" }] }) };
    if (u.includes("/emails/receiving/")) return { json: async () => ({ id: RID, to: ["sam@domain2.example"], from: "jason@ticketco.example", created_at: "2026-09-19T10:00:00.000Z", subject: "Quarterly notice", message_id: "<resend-1@e.ticketco.example>", raw: { download_url: "https://example.invalid/raw.eml" } }) };
    if (u.includes("example.invalid")) return { arrayBuffer: async () => Buffer.from(MIME("resend-1@e.ticketco.example")) };
    throw new Error("unexpected fetch " + u);
  };
  let out;
  try { out = await mod.importResend(env, "domain2", { limit: 10 }); }
  finally { globalThis.fetch = realFetch; }
  check(out && out.imported === 1, `importResend imported the message (${JSON.stringify(out)})`);
  const keys = [...store._objs.keys()];
  check(keys.length === 1, `exactly ONE R2 object holds the bytes, not two (${JSON.stringify(keys)})`);
  check(keys[0] === `resend/domain2/${RID}.eml`, `and it is the resend/ key, so ingestRaw honoured the rawKey it was handed (${keys[0]})`);
  check(!keys.some((k) => k.startsWith("raw/")), "no raw/YYYY/MM/<uuid>.eml twin is created — the orphan source is closed at the root");
  const m = rows(sq, "SELECT raw_key FROM messages");
  check(m.length === 1 && m[0].raw_key === `resend/domain2/${RID}.eml`,
    `the row points at that same single object, with no repointing UPDATE (${m[0]?.raw_key})`);
  // and the object carries the metadata the sweep and the drain need, which ingestRaw's own put never wrote
  const meta = store._objs.get(keys[0]).customMetadata;
  check(meta.rcpt === "sam@domain2.example" && !!meta.msgid,
    `its customMetadata carries rcpt AND msgid, so a sweep of it enqueues a usable row (${JSON.stringify(meta)})`);
  // the full sweep now covers resend/, so a failed import cannot leave durable-but-invisible bytes
  check((await mod.sweepUnindexedRaw(env, true)) === 0,
    "and the full sweep, which now walks resend/ too, finds nothing owing because the row references it");
}

// ---------- 22. an integrity query that cannot run must never read as an all-clear ----------
// That is the same shape as the defect the report exists to catch, and it was
// still live on 2026-09-20 when the ledger reconciliation reached this finding.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store };
  const good = await mod.integrityLines(env.DB, []);
  check(!good.some((l) => /INTEGRITY QUERY\(S\) FAILED/.test(l)), "a healthy database produces no query-failure alert");
  sq.exec("DROP TABLE pending_ingest");          // make a real query impossible
  const bad = await mod.integrityLines(env.DB, []);
  check(bad.some((l) => /INTEGRITY QUERY\(S\) FAILED/.test(l) && /ALERT/.test(l)),
    "a query that cannot run raises an ALERT instead of printing an all-clear");
  check(bad.some((l) => /no such table/i.test(l)), "and the reason is printed, so it can be fixed rather than guessed at");
  check(bad.length > 3, "the rest of the report still renders — a broken query must not take the daily report down");
}

// ---------- sent-only conversations belong under Sent, not in the inbox  ----------
// A conversation the user STARTS holds only their own mail; the column default put it in the inbox. It is now created
// 'archived', the list says whether anyone else has written in it (has_in), and the first reply brings it to the inbox.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example,yourdomain.example", GMAIL_TOKEN_KEY: "k", CLI_TOKEN: "test-token", SESSION_SECRET: "test-secret",
    EMAIL: { send: async (m) => { state.lastSent = m; return { messageId: `<sent-${state.sends = (state.sends || 0) + 1}@yourdomain.example>` }; } } };   // unique per send, as the platform's are
  const ctx = { waitUntil: () => {} };
  const call = (method, path, body) => mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
  const sr = await call("POST", "/api/send", { from: "sam@yourdomain.example", to: ["us-info@partsupply.example"], subject: "Spec sheet question?", text: "Could you send the current spec sheet?" });
  const sj = await sr.json().catch(() => ({}));
  check(sr.status === 200 && !!sj.thread_id, `a new conversation is sent (${sr.status} ${JSON.stringify(sj).slice(0, 80)})`);
  const th = () => sq.prepare("SELECT state FROM threads WHERE id = ?").get(sj.thread_id);
  check(th()?.state === "archived", `a conversation the user starts is NOT filed in the inbox (state ${th()?.state})`);
  const listed = async () => ((await (await call("GET", "/api/threads?limit=50&box=all")).json()).threads || []).find((t) => t.id === sj.thread_id);
  const l1 = await listed();
  check(!!l1 && l1.has_in === 0, `and the list marks it as sent-only (has_in ${l1 && l1.has_in})`);
  const inboxIds = ((await (await call("GET", "/api/threads?limit=50&box=inbox")).json()).threads || []).map((t) => t.id);
  check(!inboxIds.includes(sj.thread_id), "and the inbox listing does not carry it");

  // the reply arrives: the existing inbound rule moves an archived thread to the inbox
  const reply = [`From: Parts Supply <us-info@partsupply.example>`, `To: <sam@yourdomain.example>`, `Subject: Re: Spec sheet question?`,
    `Message-ID: <reply-1@partsupply.example>`, `In-Reply-To: <sent-1@yourdomain.example>`, `References: <sent-1@yourdomain.example>`,
    `Date: Fri, 02 Oct 2026 18:00:00 +0000`, `Content-Type: text/plain; charset=utf-8`, ``, `The spec sheet is attached.`, ``].join("\r\n");
  await mod.default.email({ to: "sam@yourdomain.example", from: "us-info@partsupply.example", rawSize: reply.length, raw: reply,
    headers: new Headers({ subject: "Re: Spec sheet question?", "message-id": "<reply-1@partsupply.example>", "in-reply-to": "<sent-1@yourdomain.example>", from: "Parts Supply <us-info@partsupply.example>", date: "Fri, 02 Oct 2026 18:00:00 +0000" }),
    forward: async () => {}, setReject: () => {} }, env, ctx);
  const replyRow = sq.prepare("SELECT thread_id FROM messages WHERE message_id = '<reply-1@partsupply.example>'").get();
  check(replyRow?.thread_id === sj.thread_id, `the reply joins the same conversation (${replyRow ? replyRow.thread_id === sj.thread_id : "reply not stored"})`);
  check(th()?.state === "inbox", `and the reply brings the conversation to the inbox (state ${th()?.state})`);
  const l2 = await listed();
  check(!!l2 && l2.has_in === 1, `and the list no longer marks it sent-only (has_in ${l2 && l2.has_in})`);

  // a reply the user sends INTO an existing inbound conversation must not move it anywhere
  const inbound = sq.prepare("SELECT id FROM messages WHERE message_id = '<reply-1@partsupply.example>'").get();
  const rr = await call("POST", `/api/messages/${inbound.id}/reply`, { text: "Thanks!" });
  // the composer's suggestions: who the hub has heard from and who it has written to
  const cj = await (await call("GET", "/api/contacts")).json();
  const sentTo = (cj.sent || []).find((c) => c.addr === "us-info@partsupply.example"), heard = (cj.received || []).find((c) => c.addr === "us-info@partsupply.example");
  check(!!sentTo && sentTo.n >= 2 && !!heard && heard.n === 1 && heard.name === "Parts Supply", `/api/contacts reports the people the hub wrote to and heard from (sent ${sentTo && sentTo.n}, received ${heard && heard.n}, name ${heard && heard.name})`);
  check(!(cj.sent || []).some((c) => !c.addr || !c.addr.includes("@")), "and every suggested address is an address");
  // the native Mac app's notification feed: the reply's notification is in it, a fresh client starts from "now", and a
  // conversation handled elsewhere arrives as a dismissal
  const f0 = await (await call("GET", "/api/notify/feed")).json();
  const f1 = await (await call("GET", "/api/notify/feed?since=0")).json();
  check(f0.cursor >= 1 && (f0.items || []).length === 0, `a client with no cursor is handed "now" and no backlog (cursor ${f0.cursor})`);
  check((f1.items || []).some((i) => i.kind === "hub" && i.thread === sj.thread_id), `the reply's notification is in the feed (${JSON.stringify((f1.items || []).map((i) => i.kind))})`);
  await call("POST", "/api/notify/handled", { keys: [`hub|${sj.thread_id}`] });
  const f2 = await (await call("GET", `/api/notify/feed?since=${f1.cursor}`)).json();
  check((f2.items || []).some((i) => i.kind === "dismiss" && (i.dismiss || []).some((d) => d.k === `hub|${sj.thread_id}`)) && f2.cursor > f1.cursor,
    `a conversation handled on another device reaches the feed as a dismissal (${JSON.stringify(f2.items)})`);
  const f3 = await (await call("GET", `/api/notify/feed?since=${f2.cursor}`)).json();
  check((f3.items || []).length === 0 && f3.cursor === f2.cursor, "and reading past the end returns nothing and keeps the cursor");
  // the Windows app's toast buttons: the user's setting rides on an answer with mail in it, read when the feed is read
  check(JSON.stringify(f1.acts) === JSON.stringify(["done", "read", "quiet"]), `an answer with mail names the notification buttons, by default (${JSON.stringify(f1.acts)})`);
  check(!("acts" in f2) && !("acts" in f3), `an answer with no mail does not read them (${JSON.stringify([f2.acts, f3.acts])})`);
  await call("PUT", "/api/prefs", { notifyButtons: ["trash", "done"] });
  const f4 = await (await call("GET", "/api/notify/feed?since=0")).json();
  check(JSON.stringify(f4.acts) === JSON.stringify(["trash", "done"]), `a change applies to the next answer, in its order (${JSON.stringify(f4.acts)})`);
  sq.prepare("DELETE FROM prefs WHERE key = 'notifyButtons'").run();   // the default again, for the push checks further on

  // the native app's sign-in: a one-time code is worth a session only with the secret behind its challenge, and only once
  {
    const { createHash, randomBytes } = await import("node:crypto");
    const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
    const put = (code, rec) => sq.prepare("INSERT INTO prefs (key, value, updated_at) VALUES (?, ?, ?)").run(`applogin:${code}`, JSON.stringify(rec), new Date().toISOString());
    const ex = (body) => mod.default.fetch(new Request("https://mail.yourdomain.example/auth/app/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
    put("code-good-000000000000000000000000", { challenge, exp: Date.now() + 60_000 });
    const bad = await ex({ code: "code-good-000000000000000000000000", verifier: randomBytes(32).toString("base64url") });
    check(bad.status === 401, `a code presented with the wrong secret is refused (${bad.status})`);
    put("code-good-111111111111111111111111", { challenge, exp: Date.now() + 60_000 });
    const good = await ex({ code: "code-good-111111111111111111111111", verifier }); const gj = await good.clone().json();
    check(good.status === 200 && /^\d+\.\d+\./.test(gj.session || "") && /mh=/.test(good.headers.get("set-cookie") || ""), `the right secret turns the code into a session (${good.status})`);
    const again = await ex({ code: "code-good-111111111111111111111111", verifier });
    check(again.status === 401, `and the same code cannot be used twice (${again.status})`);
    const meOk = await mod.default.fetch(new Request("https://mail.yourdomain.example/api/me", { headers: { cookie: `mh=${gj.session}` } }), env, ctx);
    check(meOk.status === 200, `the session it returns opens the API (${meOk.status})`);
    put("code-old-2222222222222222222222222", { challenge, exp: Date.now() - 1 });
    check((await ex({ code: "code-old-2222222222222222222222222", verifier })).status === 401, "an expired code is refused");
  }
  const rj = await rr.clone().json().catch(() => ({})); check(rr.status === 200 && th()?.state === "inbox", `replying inside a conversation leaves it where it was (${rr.status} ${rj.error || ""}, state ${th()?.state})`);

  // A blank reply goes out (A reply with an empty body must be sendable), with a body
  // of one line break so the binding still gets a body. A new message with no body and nothing attached is still refused.
  const sentBefore = state.sends;
  const br = await call("POST", `/api/messages/${inbound.id}/reply`, { text: "" }); const bj = await br.clone().json().catch(() => ({}));
  check(br.status === 200 && state.sends === sentBefore + 1 && state.lastSent?.text === "\n", `a blank reply is sent, with a one-line-break body (${br.status} ${bj.error || ""}, text ${JSON.stringify(state.lastSent?.text)})`);
  check(state.lastSent?.headers?.["In-Reply-To"] === "<reply-1@partsupply.example>", `and it still answers the message it replies to (${JSON.stringify(state.lastSent?.headers)})`);
  const nb = await call("POST", "/api/send", { from: "sam@yourdomain.example", to: ["us-info@partsupply.example"], subject: "nothing" });
  check(nb.status >= 400 && state.sends === sentBefore + 1, `a new message with no body and no attachment is still refused (${nb.status})`);
  const ao = await call("POST", "/api/send", { from: "sam@yourdomain.example", to: ["us-info@partsupply.example"], subject: "the drawing", text: "", attachments: [{ filename: "a.txt", type: "text/plain", content: btoa("hello") }] });
  check(ao.status === 200, `a new message that is only an attachment is sent (${ao.status} ${(await ao.clone().json().catch(() => ({}))).error || ""})`);

  // A sent file is kept as itself. Its row pointed at the send's JSON summary, so opening it downloaded that summary
  // under the file's name, and its size was the base64 formula applied to bytes already decoded: a 351,220-byte.docx read 263,415.
  {
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const bin = Uint8Array.from({ length: 4099 }, (_, i) => (i * 37 + 11) & 255);   // every byte value, and not a multiple of 3
    let s = ""; for (const b of bin) s += String.fromCharCode(b);
    const sf = await call("POST", "/api/send", { from: "sam@yourdomain.example", to: ["us-info@partsupply.example"], subject: "the spec sheet", text: "Attached.",
      attachments: [{ filename: "Spec_Sheet.docx", type: DOCX, content: btoa(s) }, { filename: "a.txt", type: "text/plain", content: btoa("hello") }] });
    const sfj = await sf.clone().json().catch(() => ({}));
    const rows = sq.prepare("SELECT id, filename, size_bytes, r2_key FROM attachments WHERE message_id = ?").all(sfj.id || "");
    const docRow = rows.find((x) => x.filename === "Spec_Sheet.docx"), txtRow = rows.find((x) => x.filename === "a.txt");
    check(sf.status === 200 && !!docRow && !!txtRow, `a message with two files is sent and both are listed (${sf.status} ${rows.length})`);
    check(docRow?.size_bytes === 4099 && txtRow?.size_bytes === 5, `each sent file's size is its own byte count, not 75% of it (${docRow?.size_bytes}, ${txtRow?.size_bytes})`);
    const got = docRow ? await call("GET", `/api/att/${docRow.id}`) : null;
    const gotBytes = got ? new Uint8Array(await got.arrayBuffer()) : new Uint8Array();
    check(got?.status === 200 && gotBytes.length === 4099 && gotBytes.every((b, i) => b === bin[i]), `opening a sent file returns the file's own bytes (${got?.status}, ${gotBytes.length} bytes)`);
    const gotTxt = txtRow ? await (await call("GET", `/api/att/${txtRow.id}`)).text() : "";
    check(gotTxt === "hello" && docRow?.r2_key !== txtRow?.r2_key, `and the second file is its own, under its own key (${JSON.stringify(gotTxt.slice(0, 40))})`);
    const msgRow = sq.prepare("SELECT raw_key FROM messages WHERE id = ?").get(sfj.id || "");
    const raw = sfj.id ? await call("GET", `/api/raw/${sfj.id}`) : null; const rawText = raw ? await raw.text() : "";
    check(/\.eml$/.test(msgRow?.raw_key || "") && /message\/rfc822/.test(raw?.headers.get("content-type") || "") && /Spec_Sheet\.docx/.test(rawText) && rawText === state.lastSent?.__raw,
      `the copy under Sent is the MIME that went out (${msgRow?.raw_key}, ${raw?.headers.get("content-type")}, ${rawText.length} chars)`);

    // A file sent before that was never kept: it says so, rather than serve the summary under the file's name.
    const legacyKey = `out/2026/10/${sfj.id}.json`, legacyId = "00000000-0000-4000-8000-0000000000aa";
    await store.put(legacyKey, JSON.stringify({ subject: "old" }), { httpMetadata: { contentType: "application/json" } });
    sq.prepare("INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, r2_key, content_id, disposition) VALUES (?, ?, ?, ?, ?, ?, NULL, 'attachment')").run(legacyId, sfj.id, "old.docx", DOCX, 100, legacyKey);
    const lg = await call("GET", `/api/att/${legacyId}`); const lgj = await lg.clone().json().catch(() => ({}));
    check(lg.status === 410 && /not kept/.test(lgj.error || ""), `a file sent before files were kept answers 410 with the reason, not the summary (${lg.status} ${lgj.error || ""})`);
    sq.prepare("DELETE FROM attachments WHERE id = ?").run(legacyId);

    // Its files now travel with a forward of the sent message; the forward skipped them, because they had no bytes of their own.
    const fw = await call("POST", `/api/messages/${sfj.id}/forward`, { to: ["colleague@example.com"] });
    check(fw.status === 200 && /Spec_Sheet\.docx/.test(state.lastSent?.__raw || ""), `forwarding a sent message carries its files (${fw.status})`);

    // `mail reply --dry-run`: the same reply resolved, with nothing sent and nothing stored.
    sq.prepare("UPDATE messages SET reply_to = ? WHERE id = ?").run("rfq@partsupply.example", inbound.id);
    const sendsBefore = state.sends, count = () => sq.prepare("SELECT COUNT(*) n FROM messages").get().n, rowsBefore = count();
    const pv = await call("POST", `/api/messages/${inbound.id}/reply/preview`, { text: "Signed copy attached.", attachments: [{ filename: "Spec_Sheet.docx", type: DOCX, content: btoa(s) }] });
    const pvj = await pv.clone().json().catch(() => ({}));
    check(pv.status === 200 && pvj.dry_run === true && state.sends === sendsBefore && count() === rowsBefore, `a reply preview sends nothing and stores nothing (${pv.status} ${pvj.error || ""}, sends +${state.sends - sendsBefore}, rows +${count() - rowsBefore})`);
    check(JSON.stringify(pvj.to) === JSON.stringify(["rfq@partsupply.example"]) && /sam@yourdomain\.example>?$/.test(pvj.from || "") && pvj.subject === "Re: Spec sheet question?" && pvj.in_reply_to === "<reply-1@partsupply.example>",
      `and it shows the From, the To after Reply-To, the Subject and the message it answers (${JSON.stringify(pvj).slice(0, 220)})`);
    check(pvj.attachments?.length === 1 && pvj.attachments[0].filename === "Spec_Sheet.docx" && pvj.attachments[0].type === DOCX && pvj.attachments[0].bytes === 4099,
      `and each file's name, type and size (${JSON.stringify(pvj.attachments)})`);
    const pvBad = await call("POST", `/api/messages/${inbound.id}/reply/preview`, { text: "x", attachments: [{ filename: "bad.bin", content: "!!not base64" }] });
    check(pvBad.status === 400 && state.sends === sendsBefore, `a file the send would refuse is refused by the preview too (${pvBad.status})`);
    sq.prepare("UPDATE messages SET reply_to = NULL WHERE id = ?").run(inbound.id);
  }

  // A scheduled reply threads under the message it answers. The client's draft names it only by Message-ID, without
  // angle brackets (in_reply_to: msgIdHdr), and the hub used to ignore that: no In-Reply-To, filed by subject alone. Through the real
  // path: POST /api/schedule, then the cron.
  env.GMAIL_TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));   // drafts are sealed with it
  const sch = await call("POST", "/api/schedule", { kind: "send_later", account: "hub", due_at: new Date(Date.now() - 30_000).toISOString(),
    draft: { from: "sam@yourdomain.example", to: ["us-info@partsupply.example"], cc: [], subject: "Re: Spec sheet question?", text: "Following up.", in_reply_to: "reply-1@partsupply.example", attachments: [] } });
  const schj = await sch.clone().json().catch(() => ({}));
  check(sch.status === 200, `a reply is scheduled (${sch.status} ${schj.error || ""})`);
  const sendsBeforeCron = state.sends;
  try { await mod.default.scheduled({ scheduledTime: Date.now() }, env, ctx); } catch (_) {}
  const act = sq.prepare("SELECT status, error, ref FROM scheduled_actions WHERE kind = 'send_later' ORDER BY created_at DESC LIMIT 1").get();
  check(act?.status === "done" && state.sends === sendsBeforeCron + 1, `the cron sends it when due (${act?.status} ${act?.error || ""})`);
  check(state.lastSent?.headers?.["In-Reply-To"] === "<reply-1@partsupply.example>" && /<reply-1@partsupply\.example>/.test(state.lastSent?.headers?.References || ""),
    `and it answers the message it replies to (${JSON.stringify(state.lastSent?.headers)})`);
  const schRow = act?.ref ? sq.prepare("SELECT thread_id FROM messages WHERE id = ?").get(act.ref) : null;
  check(schRow?.thread_id === sj.thread_id, `and it is filed in that conversation (${schRow ? schRow.thread_id === sj.thread_id : "no stored row"})`);
  // gone before it fell due: it still goes, unthreaded, rather than failing
  const gone = await call("POST", "/api/send", { from: "sam@yourdomain.example", to: ["us-info@partsupply.example"], subject: "Re: gone", text: "x", in_reply_to: "no-such-message@example.com" });
  check(gone.status === 200, `a reply to a Message-ID the hub no longer has still sends (${gone.status})`);
}

// ---------- Firebase Cloud Messaging: the native Android app ----------
// A real RSA key stands in for the service account, so the JWT the Worker signs is checked cryptographically, not by shape.
{
  const { generateKeyPairSync, createVerify } = await import("node:crypto");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = { project_id: "sherit-test", client_email: "fcm@sherit-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example,yourdomain.example", GMAIL_TOKEN_KEY: "k", CLI_TOKEN: "test-token", SESSION_SECRET: "s",
    FCM_SERVICE_ACCOUNT: JSON.stringify(sa), EMAIL: { send: async () => ({ messageId: "<x@yourdomain.example>" }) } };
  const ctx = { waitUntil: () => {} };
  const call = (method, path, body) => mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
  // Every push is read as the phone reads it: sealed with its key (`e`) or plain (`p`, a phone with no key).
  const { createDecipheriv, randomBytes } = await import("node:crypto"); const { inflateRawSync } = await import("node:zlib");
  const PKEY = randomBytes(32).toString("base64url");
  const pl = (m) => { if (!m.data.e) return pl(m); const raw = Buffer.from(m.data.e, "base64url"), d = createDecipheriv("aes-256-gcm", Buffer.from(PKEY, "base64url"), raw.subarray(0, 12)); d.setAAD(Buffer.from("sherit-push-v1")); d.setAuthTag(raw.subarray(raw.length - 16)); return JSON.parse(inflateRawSync(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()])).toString("utf8")); };
  const realFetch = globalThis.fetch; const sends = [], auths = [];
  globalThis.fetch = async (url, o = {}) => {
    const u = String(url);
    if (u === "https://oauth2.googleapis.com/token") { auths.push(Object.fromEntries(new URLSearchParams(String(o.body)))); return new Response(JSON.stringify({ access_token: "fcm-at", expires_in: 3600 }), { status: 200 }); }
    if (u.startsWith("https://fcm.googleapis.com/v1/projects/sherit-test/messages:send")) {
      const m = JSON.parse(o.body).message; sends.push({ m, auth: o.headers.authorization });
      if (m.token.startsWith("dead")) return new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 });
      if (state.failHigh && m.android.priority === "HIGH" && pl(m).kind === "dismiss") { state.failHigh = false; return new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), { status: 503 }); }
      return new Response(JSON.stringify({ name: "projects/sherit-test/messages/1" }), { status: 200 });
    }
    return realFetch(url, o);
  };
  try {
    const reg = await call("POST", "/api/push/fcm", { token: "live-phone-token-aaaaaaaaaaaaaaaaaaaa", ua: "SheritAndroid/1.13", key: PKEY });   // the live phone has a push key
    await call("POST", "/api/push/fcm", { token: "dead-phone-token-bbbbbbbbbbbbbbbbbbbb", ua: "old phone" });
    check(reg.status === 200 && sq.prepare("SELECT COUNT(*) n FROM fcm_devices").get().n === 2, "the Android app registers its FCM token");
    const mime = [`From: Grace <grace@example.com>`, `To: <sam@domain2.example>`, `Subject: Lunch?`, `Message-ID: <fcm-1@example.com>`, `Date: Fri, 02 Oct 2026 18:00:00 +0000`, `Content-Type: text/plain; charset=utf-8`, ``, `Tuesday?`, ``].join("\r\n");
    await mod.default.email({ to: "sam@domain2.example", from: "grace@example.com", rawSize: mime.length, raw: mime, headers: new Headers({ subject: "Lunch?", "message-id": "<fcm-1@example.com>", from: "Grace <grace@example.com>", date: "Fri, 02 Oct 2026 18:00:00 +0000" }), forward: async () => {}, setReject: () => {} }, env, ctx);
    const settle = async () => { for (let i = 0; i < 50 && !sends.some((x) => x.m.token.startsWith("live")); i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 50)); };
    await settle();   // the inbound path hands the push to ctx.waitUntil: it lands just after the message is accepted
    const mail = sends.filter((x) => x.m.token.startsWith("live"));
    const p = mail.length ? pl(mail[0].m) : {};
    check(mail.length === 1 && mail[0].m.android.priority === "HIGH" && p.kind === "hub" && !!p.thread && /grace/i.test(p.title || ""), `new mail reaches the phone as a HIGH-priority data message carrying the conversation (${mail.length} send(s), ${JSON.stringify({ kind: p.kind, title: p.title })})`);
    check(mail.length === 1 && mail[0].auth === "Bearer fcm-at", "authenticated with the token minted from the service account");
    const jwt = (auths[0] || {}).assertion || ""; const [h, b, sig] = jwt.split(".");
    const claims = b ? JSON.parse(Buffer.from(b, "base64url").toString()) : {};
    const ok = !!sig && createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(sig, "base64url"));
    check(ok && claims.iss === sa.client_email && claims.scope === "https://www.googleapis.com/auth/firebase.messaging" && claims.aud === "https://oauth2.googleapis.com/token",
      `the JWT is RS256-signed by the service account's key with the FCM scope (signature ${ok ? "verifies" : "FAILS"})`);
    check(sq.prepare("SELECT COUNT(*) n FROM fcm_devices WHERE token LIKE 'dead%'").get().n === 0, "a token FCM reports UNREGISTERED is deleted");
    const before = sends.length;
    await call("POST", "/api/notify/handled", { keys: [`hub|${p.thread}`] });
    for (let i = 0; i < 50 && sends.length === before; i++) await new Promise((r) => setTimeout(r, 20));
    const dm = sends.slice(before).filter((x) => x.m.token.startsWith("live"));
    const dp = dm.length ? pl(dm[0].m) : {};
    // The phone is showing that conversation (the hub pushed it HIGH a moment ago), so its dismissal goes HIGH:
    // a NORMAL one waits for Doze, up to 6 h on the user's Pixel.
    check(dm.length === 1 && dm[0].m.android.priority === "HIGH" && dp.kind === "dismiss" && dp.dismiss.some((d) => d.k === `hub|${p.thread}` && d.at > 0), `a conversation handled elsewhere that the phone is showing reaches it as a HIGH dismissal naming the key and when it was handled (${JSON.stringify(dp)})`);
    // A mail trashed on the Windows app, four dismissals sent at 600 s, the phone asleep for 17 minutes: all expired, the
    // notification stayed. A dismissal now waits three days for the phone; new mail keeps its hour.
    check(dm.length === 1 && dm[0].m.android.ttl === "259200s", `a dismissal waits three days for a sleeping phone, not ten minutes (${dm[0]?.m.android.ttl})`);
    check(mail[0]?.m.android.ttl === "3600s", `new mail keeps its one-hour life (${mail[0]?.m.android.ttl})`);
    const feedBefore = sq.prepare("SELECT COUNT(*) n FROM notify_feed WHERE kind = 'dismiss'").get().n;
    const echo = sends.length;
    await call("POST", "/api/notify/handled", { keys: [`hub|${p.thread}`] });   // the same conversation reported again (Gmail's history echo)
    await new Promise((r) => setTimeout(r, 120));
    check(sends.length === echo, `an echo of the same dismissal is not sent to the phone again (${sends.length - echo} extra send(s))`);
    check(sq.prepare("SELECT COUNT(*) n FROM notify_feed WHERE kind = 'dismiss'").get().n === feedBefore, "nor written to the Mac/Windows feed again");
    await call("POST", "/api/notify/handled", { keys: [`hub|${p.thread}`, "hub|another-conversation"] });
    for (let i = 0; i < 50 && sends.length === echo; i++) await new Promise((r) => setTimeout(r, 20));
    const mixed = sends.slice(echo).map((x) => pl(x.m)).filter((x) => x.kind === "dismiss");
    check(mixed.length === 1 && mixed[0].dismiss.map((d) => d.k).join() === "hub|another-conversation", `a report mixing an echo with news sends only the news (${JSON.stringify(mixed.map((x) => x.dismiss))})`);
    check(!JSON.parse(sq.prepare("SELECT value FROM prefs WHERE key = 'handled'").get().value).some((e) => "repeat" in e), "the echo marker never reaches the stored ring");
    // ---- HIGH only where it removes something on screen; never to the phone that did it; a self-checking fallback.
    const { createHash } = await import("node:crypto");
    const PHONE = "fcm:" + createHash("sha256").update("live-phone-token-aaaaaaaaaaaaaaaaaaaa").digest("hex").slice(0, 16);
    const tags = () => { const r = sq.prepare("SELECT live_tags, pend_tags, demoted_at FROM fcm_devices WHERE token LIKE 'live%'").get(); const pend = JSON.parse(r.pend_tags).map((e) => typeof e === "string" ? { k: e, at: 0 } : e); return { live: JSON.parse(r.live_tags), pend: pend.map((e) => e.k), pendAt: Object.fromEntries(pend.map((e) => [e.k, e.at])), demoted: r.demoted_at }; };
    check(!tags().live.includes(`hub|${p.thread}`), "a key dismissed HIGH leaves the phone's on-screen set");
    let n = 0;
    // `reply`: the n of an earlier newMail() to answer, so the push lands in THAT conversation.
    const newMail = async (reply = 0, subjAs = null) => {
      n++; const id = `fcm-live-${n}@example.com`, before = sends.length, subj = subjAs || (reply ? `Re: Plan ${reply}` : `Plan ${n}`);
      const raw = [`From: Grace <grace@example.com>`, `To: <sam@domain2.example>`, `Subject: ${subj}`, `Message-ID: <${id}>`, ...(reply ? [`In-Reply-To: <fcm-live-${reply}@example.com>`] : []), `Date: Fri, 02 Oct 2026 18:${String(n).padStart(2, "0")}:00 +0000`, `Content-Type: text/plain; charset=utf-8`, ``, `Body ${n}`, ``].join("\r\n");
      await mod.default.email({ to: "sam@domain2.example", from: "grace@example.com", rawSize: raw.length, raw, headers: new Headers({ subject: subj, "message-id": `<${id}>`, from: "Grace <grace@example.com>", date: `Fri, 02 Oct 2026 18:${String(n).padStart(2, "0")}:00 +0000` }), forward: async () => {}, setReject: () => {} }, env, ctx);
      for (let i = 0; i < 50 && sends.length === before; i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 30));
      const m = sends.slice(before).find((x) => x.m.token.startsWith("live")); const pp = m ? pl(m.m) : {};
      return { key: `hub|${pp.thread}`, msg: m, p: pp, n };
    };
    const handled = async (keys, body = {}) => { const before = sends.length; await call("POST", "/api/notify/handled", { keys, ...body }); await new Promise((r) => setTimeout(r, 150)); return sends.slice(before).filter((x) => x.m.token.startsWith("live")).map((x) => ({ pri: x.m.android.priority, ttl: x.m.android.ttl, p: pl(x.m) })); };
    const m2 = await newMail();
    check(tags().live.includes(m2.key), `a HIGH mail push puts its conversation in the phone's on-screen set (${m2.key})`);
    const own = await handled([m2.key], { device: PHONE });
    check(own.length === 0 && !tags().live.includes(m2.key), `mail handled ON the phone sends the phone nothing, and leaves its set (${own.length} send(s))`);
    const quiet = await handled(["hub|never-on-this-phone"]);
    check(quiet.length === 1 && quiet[0].pri === "NORMAL" && quiet[0].ttl === "259200s", `a dismissal for something the phone is not showing stays NORMAL (${JSON.stringify(quiet.map((x) => x.pri))})`);
    const m3 = await newMail();
    const gone = await call("POST", "/api/push/fcm/gone", { device: PHONE, keys: [m3.key] });
    const afterGone = await handled([m3.key]);
    check(gone.status === 200 && afterGone.length === 1 && afterGone[0].pri === "NORMAL", `a notification swiped away on the phone is no longer worth a HIGH wake (${gone.status}, ${afterGone.map((x) => x.pri)})`);
    const m4 = await newMail();
    const dem = await call("POST", "/api/push/fcm/demoted", { device: PHONE, kind: "hub", priority: 2, original: 1 });
    check(dem.status === 200 && !!tags().demoted, "the phone can report a demoted delivery");
    const held = await handled([m4.key]);
    check(held.length === 1 && held[0].pri === "NORMAL" && tags().pend.includes(m4.key), `after a demotion, a dismissal for a shown notification goes NORMAL and is kept as owed (${held.map((x) => x.pri)}; pend ${JSON.stringify(tags().pend)})`);
    const m5 = await newMail();
    check(m5.msg?.m.android.priority === "HIGH" && (m5.p.dismiss || []).some((d) => d.k === m4.key) && !tags().pend.includes(m4.key) && tags().live.includes(m5.key),
      `the next new-mail push carries the owed clear and empties it (${JSON.stringify(m5.p.dismiss)})`);
    sq.prepare("UPDATE fcm_devices SET demoted_at = ? WHERE token LIKE 'live%'").run(new Date(Date.now() - 8 * 86_400_000).toISOString());
    const back = await handled([m5.key]);
    check(back.length === 1 && back[0].pri === "HIGH", `seven days after a demotion, shown dismissals go HIGH again (${back.map((x) => x.pri)})`);
    const unknown = await call("POST", "/api/push/fcm/gone", { device: "fcm:0000000000000000", keys: ["x|y"] });
    const bad = await call("POST", "/api/push/fcm/demoted", { device: "not-a-device" });
    check(unknown.status === 404 && bad.status === 404, `an unknown or malformed device id is refused (${unknown.status}/${bad.status})`);
    const notDemoted = await call("POST", "/api/push/fcm/demoted", { device: PHONE, kind: "hub", priority: 1, original: 1 });
    const garbage = await call("POST", "/api/push/fcm/demoted", { device: PHONE, kind: "hub" });
    check(notDemoted.status === 400 && garbage.status === 400, `only "sent HIGH, delivered lower" counts as a demotion (${notDemoted.status}/${garbage.status})`);
    const many = Array.from({ length: 120 }, (_, i) => `hub|many-${i}`);
    sq.prepare("UPDATE fcm_devices SET live_tags = ? WHERE token LIKE 'live%'").run(JSON.stringify(many));
    await call("POST", "/api/push/fcm/gone", { device: PHONE, keys: many });
    check(tags().live.length === 0, `a sweep of a full shade is taken whole, not its first 50 (${tags().live.length} left)`);
    // A clear owed for an earlier message must never ride on the push for a NEWER message in the same conversation: the reply
    // lands in m5's conversation while a clear for it is owed.
    sq.prepare("UPDATE fcm_devices SET pend_tags = ? WHERE token LIKE 'live%'").run(JSON.stringify([{ k: "hub|zz-owed", at: Date.now() - 1000 }, { k: m5.key, at: Date.now() - 1000 }]));
    const m6 = await newMail(m5.n);
    check(m6.key === m5.key && !(m6.p.dismiss || []).some((d) => d.k === m6.key) && (m6.p.dismiss || []).some((d) => d.k === "hub|zz-owed") && !tags().pend.includes(m5.key),
      `a push never carries a clear for its own conversation, and that owed clear is void (${m6.key === m5.key ? "same conversation" : "DIFFERENT conversation"}; ${JSON.stringify(m6.p.dismiss)})`);
    // Handling the REPLY within the ring's 30 minutes is news, not an echo: the new mail push ended the conversation's place in the
    // ring.
    await handled([m5.key]);
    const feedB = sq.prepare("SELECT COUNT(*) n FROM notify_feed WHERE kind = 'dismiss'").get().n;
    const m7 = await newMail(m5.n);
    const again = await handled([m7.key]);
    check(m7.key === m5.key && again.length === 1 && again[0].pri === "HIGH" && sq.prepare("SELECT COUNT(*) n FROM notify_feed WHERE kind = 'dismiss'").get().n === feedB + 1,
      `the reply handled minutes after the first message still reaches the phone HIGH and the feed (${again.map((x) => x.pri)})`);
    // The report says how long ago the device acted; the handled time is that moment, not the report's arrival 4 s later.
    const m8 = await newMail();
    const aged = await handled([m8.key], { age: 60_000 });
    const agedAt = aged[0]?.p.dismiss?.[0]?.at || 0;
    check(aged.length === 1 && Math.abs(Date.now() - 60_000 - agedAt) < 5_000, `the handled time is when the device acted (${Math.round((Date.now() - agedAt) / 1000)} s ago)`);
    // A HIGH dismissal that fails goes NORMAL at once and stays owed: no more mail may come to carry it.
    const m9 = await newMail();
    state.failHigh = true;
    const failed = await handled([m9.key]);
    check(failed.some((x) => x.pri === "HIGH") && failed.some((x) => x.pri === "NORMAL" && x.p.dismiss.some((d) => d.k === m9.key)) && tags().pend.includes(m9.key) && tags().pendAt[m9.key] > 0,
      `a failed HIGH dismissal is sent NORMAL too and kept owed with its time (${failed.map((x) => x.pri)}; pend ${JSON.stringify(tags().pendAt)})`);
    // An owed clear keeps its handled time after the ring forgets it, so the phone can still keep newer mail.
    const owedAt = tags().pendAt[m9.key];
    sq.prepare("UPDATE prefs SET value = '[]' WHERE key = 'handled'").run();
    const m10 = await newMail();
    check((m10.p.dismiss || []).some((d) => d.k === m9.key && d.at === owedAt) && !tags().pend.includes(m9.key), `an owed clear carries the time it was handled, not 0 (${JSON.stringify(m10.p.dismiss)})`);
    // FCM keeps at most 100 non-collapsible messages for an unreachable phone and then discards them ALL, new mail included; and a
    // data payload is capped at 4,096 bytes. A NORMAL dismissal is collapsible; a bulk triage is chunked.
    const bulkKeys = Array.from({ length: 100 }, (_, i) => `sam.owner@gmail.com|bulk${String(i).padStart(12, "0")}`);
    sq.prepare("UPDATE fcm_devices SET live_tags = ?, pend_tags = '[]' WHERE token LIKE 'live%'").run(JSON.stringify(bulkKeys));
    const bulk = await (async () => { const before = sends.length; await call("POST", "/api/notify/handled", { keys: [...bulkKeys, ...Array.from({ length: 80 }, (_, i) => `hub|not-shown-${i}`)] }); await new Promise((r) => setTimeout(r, 300)); return sends.slice(before).filter((x) => x.m.token.startsWith("live")); })();
    const highs = bulk.filter((x) => x.m.android.priority === "HIGH"), normals = bulk.filter((x) => x.m.android.priority === "NORMAL");
    const highKeys = highs.flatMap((x) => pl(x.m).dismiss.map((d) => d.k));
    check(highs.length === 3 && new Set(highKeys).size === 100 && highs.every((x) => !x.m.android.collapse_key), `100 shown conversations clear in 3 HIGH messages of at most 40, none collapsible (${highs.map((x) => pl(x.m).dismiss.length)})`);
    check(bulk.every((x) => JSON.stringify(x.m.data).length <= 4096), `every message fits FCM's 4,096-byte data limit (largest ${Math.max(...bulk.map((x) => JSON.stringify(x.m.data).length))})`);
    check(normals.length === 1 && normals[0].m.android.collapse_key === "dismiss" && pl(normals[0].m).dismiss.length <= 40, `a NORMAL dismissal is collapsible and capped (${normals.map((x) => x.m.android.collapse_key + "/" + pl(x.m).dismiss.length)})`);
    sq.prepare("UPDATE fcm_devices SET demoted_at = ?, live_tags = ? WHERE token LIKE 'live%'").run(new Date().toISOString(), JSON.stringify(["hub|owed-a", "hub|owed-b"]));
    await handled(["hub|owed-a"]);
    const carried = await handled(["hub|other-thing"]);
    check(carried.length === 1 && carried[0].pri === "NORMAL" && carried[0].p.dismiss.some((d) => d.k === "hub|owed-a"), `each NORMAL dismissal also carries what is still owed, so the one FCM keeps covers it (${JSON.stringify(carried[0]?.p.dismiss)})`);
    const ov = await call("POST", "/api/push/fcm/overflow", { device: PHONE });
    check(ov.status === 200 && sq.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'fcm_overflow_fail'").get().n === 1, "the phone can report that FCM discarded its stored messages, as a failure the daily report shows");
    check(auths.length === 1, `the OAuth token is cached between sends (${auths.length} mint(s))`);
    // ---- Don't-notify rules. Venmo's password resets come from the same address as its payment receipts, so a rule is a
    // sender plus, optionally, words of the subject; the mail still arrives, only the notification is skipped.
    const qr = await call("POST", "/api/quiet-rules", { sender: "Grace@Example.com", subject: "Re: Password   Reset" });
    const qrj = await qr.json();
    check(qr.status === 200 && qrj.rule?.sender === "grace@example.com" && qrj.rule?.subject === "password reset", `a rule is stored as a lowercase sender and subject phrase (${JSON.stringify(qrj.rule)})`);
    const quietMail = await newMail(0, "Venmo - Password Reset");
    check(!quietMail.msg && sq.prepare("SELECT COUNT(*) n FROM messages WHERE subject = 'Venmo - Password Reset'").get().n === 1, "mail matching sender and subject arrives, and no notification goes out");
    check(sq.prepare("SELECT hits FROM quiet_rules WHERE sender = 'grace@example.com'").get().hits === 1 && sq.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'notify_quiet'").get().n === 1, "the rule counts the notification it stopped");
    const loud = await newMail(0, "You paid JORDAN LEE $75.00");
    check(!!loud.msg, "the same sender with another subject still notifies");
    const badRule = await call("POST", "/api/quiet-rules", { sender: "not an address" });
    check(badRule.status === 400, `a rule needs an address or *@domain (${badRule.status})`);
    // "Stop these" on a notification: the conversation names the sender and subject.
    const act = await call("POST", "/api/notify/act", { account: "hub", thread: loud.p.thread, action: "quiet" }); const actj = await act.json();
    check(act.status === 200 && actj.rule?.sender === "grace@example.com" && actj.rule?.subject === "you paid jordan lee", `"Stop these" makes a rule from the conversation's newest incoming message, leaving out the amount (${JSON.stringify(actj.rule)})`);
    check(sq.prepare("SELECT state, unread FROM threads WHERE id = ?").get(loud.p.thread).state === "inbox", "and leaves the mail itself alone");
    const list = await (await call("GET", "/api/quiet-rules")).json();
    const del = await call("DELETE", "/api/quiet-rules/" + qrj.rule.id);
    check(list.rules.length === 2 && del.status === 200 && sq.prepare("SELECT COUNT(*) n FROM quiet_rules").get().n === 1, "rules are listed and removed one by one");
    const loudAgain = await newMail(0, "Venmo - Password Reset");
    check(!!loudAgain.msg, "with the rule removed, that mail notifies again");
    // Uber's sign-in mail: "Do not share: 3651", a new code every time. "Stop these" keeps the words without digits, and the rule then
    // matches the next code (On the phone a rule has to take only part of the subject).
    const code1 = await newMail(0, "Do not share: 3651");
    const stop = await (await call("POST", "/api/notify/act", { account: "hub", thread: code1.p.thread, action: "quiet" })).json();
    const code2 = await newMail(0, "Do not share: 8842");
    check(stop.rule?.subject === "do not share" && !code2.msg, `the next code from the same sender arrives silently (rule "${stop.rule?.subject}")`);
    const words = await (await call("POST", "/api/quiet-rules", { sender: "grace@example.com", subject: "Weekly Digest" })).json();
    const digest = await newMail(0, "Your digest: weekly edition");
    check(words.rule?.subject === "weekly digest" && !digest.msg, "a rule's words match in any order, wherever they sit in the subject");
    const other = await newMail(0, "Weekly planning");
    check(!!other.msg, "and only when every word is there");
    // 2026-10-07, the user's Mac showed "=?utf-8?Q?Blue=20Powder=20is=20back=21...?=" under a bare address. Cloudflare hands email()
    // the raw header, RFC 2047-encoded when the subject is not plain ASCII; the notification takes the parsed subject and name instead.
    const enc = await newMail(0, "=?utf-8?Q?Blue=20Powder=20is=20back=21=20Plus=2C=20two=20new=20colours.?=");
    check(!!enc.msg && String(enc.p.body || "").startsWith("Blue Powder is back! Plus, two new colours.") && enc.p.title === "Grace", `an encoded subject is shown decoded, under the sender's name (${JSON.stringify([enc.p.title, enc.p.body])})`);
    await call("POST", "/api/quiet-rules", { sender: "grace@example.com", subject: "blue powder" });
    const encQuiet = await newMail(0, "=?utf-8?Q?Blue=20Powder=20restock?=");
    check(!encQuiet.msg, "and a don't-notify rule matches the decoded words");
    // ---- The user picks the phone notification's buttons and their order; every mail push names them.
    const nb0 = await newMail();
    check(JSON.stringify(nb0.p.acts) === JSON.stringify(["done", "read", "quiet"]), `a mail push names the buttons, by default Done, Mark read, Stop these (${JSON.stringify(nb0.p.acts)})`);
    await call("PUT", "/api/prefs", { notifyButtons: ["trash", "bogus", "snooze", "trash", "done", "read"] });
    const nb1 = await newMail();
    check(JSON.stringify(nb1.p.acts) === JSON.stringify(["trash", "snooze", "done"]), `the chosen buttons in the chosen order, unknown and repeated ones dropped, at most three (${JSON.stringify(nb1.p.acts)})`);
    await call("PUT", "/api/prefs", { notifyButtons: [] });
    const nb2 = await newMail();
    check(Array.isArray(nb2.p.acts) && nb2.p.acts.length === 0, "no buttons is a choice too");
    const trash = await call("POST", "/api/notify/act", { account: "hub", thread: nb1.p.thread, action: "trash", device: PHONE });
    check(trash.status === 200 && sq.prepare("SELECT state FROM threads WHERE id = ?").get(nb1.p.thread).state === "trash", `Trash on a notification trashes the conversation (${trash.status})`);
    check(JSON.parse(sq.prepare("SELECT value FROM prefs WHERE key = 'handled'").get().value).some((e) => e.k === `hub|${nb1.p.thread}`), "and clears it on the other devices like Done");
    const until = new Date(Date.now() + 20 * 3600_000).toISOString();
    const snz = await call("POST", "/api/notify/act", { account: "hub", thread: nb2.p.thread, action: "snooze", until, device: PHONE });
    const row = sq.prepare("SELECT kind, account, due_at, status FROM scheduled_actions WHERE ref = ?").get(nb2.p.thread);
    check(snz.status === 200 && sq.prepare("SELECT state FROM threads WHERE id = ?").get(nb2.p.thread).state === "snoozed" && row?.kind === "snooze" && row.due_at === until && row.status === "pending",
      `Snooze on a notification snoozes it until the time the phone gave (${JSON.stringify(row)})`);
    const late = await call("POST", "/api/notify/act", { account: "hub", thread: nb0.p.thread, action: "snooze", until: new Date(Date.now() - 1000).toISOString() });
    check(late.status === 400, `a snooze needs a time in the future (${late.status})`);
    const isrc = (await import("node:fs")).readFileSync(process.env.INGEST_SRC || new URL("../src/index.js", import.meta.url), "utf8");
    const poll = isrc.slice(isrc.indexOf("async function gmailPollOnce"), isrc.indexOf("async function gmailPollOnce") + 9000);   // the notification poll itself (the mirror now sits between it and gmailPollAccount)
    check(/quietMatch\(quiet, addr, subject\)/.test(poll) && /quietMatch\(quiet, it\.addr, it\.subject\)/.test(isrc), "the Gmail poll and the IMAP sync apply the same rules");
    // Firebase rotates the token: the same phone, so its row moves (what it shows and owes included) instead of a second row.
    sq.prepare("UPDATE fcm_devices SET live_tags = ?, pend_tags = ? WHERE token LIKE 'live%'").run(JSON.stringify(["hub|kept-a"]), JSON.stringify([{ k: "hub|kept-b", at: 5 }]));
    const rows = sq.prepare("SELECT COUNT(*) n FROM fcm_devices").get().n;
    const rot = await call("POST", "/api/push/fcm", { token: "live-phone-token-rotated-cccccccccccc", previous: "live-phone-token-aaaaaaaaaaaaaaaaaaaa", ua: "SheritAndroid/1.4" });
    const moved = sq.prepare("SELECT token, live_tags, pend_tags FROM fcm_devices WHERE token LIKE 'live%'").all();
    check(rot.status === 200 && sq.prepare("SELECT COUNT(*) n FROM fcm_devices").get().n === rows && moved.length === 1 && moved[0].token.includes("rotated") && moved[0].live_tags.includes("kept-a") && moved[0].pend_tags.includes("kept-b"),
      `a rotated token takes over its phone's row (${JSON.stringify(moved)})`);
  } finally { globalThis.fetch = realFetch; }
}

// ---------- native-app sign-in survives a duplicated callback (Android Auth Tab loads each step twice) ----------
{
  const { createHash, randomBytes } = await import("node:crypto");
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, SESSION_SECRET: "s3", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", ALLOWED_GOOGLE_EMAIL: "sam@example.com", DOMAINS: "yourdomain.example" };
  const ctx = { waitUntil: () => {} };
  const realFetch = globalThis.fetch; let redeemed = new Set(); let lastNonce = "";
  globalThis.fetch = async (url, o = {}) => {
    const u = String(url);
    if (u === "https://oauth2.googleapis.com/token") { const code = new URLSearchParams(String(o.body)).get("code");
      if (redeemed.has(code)) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      redeemed.add(code); await new Promise((r) => setTimeout(r, 30)); return new Response(JSON.stringify({ id_token: "idt" }), { status: 200 }); }
    if (u.startsWith("https://oauth2.googleapis.com/tokeninfo")) return new Response(JSON.stringify({ aud: "cid", iss: "accounts.google.com", nonce: lastNonce, email_verified: "true", email: "sam@example.com" }), { status: 200 });
    return realFetch(url, o);
  };
  const flow = async (ua) => {
    const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
    const start = await mod.default.fetch(new Request(`https://mail.yourdomain.example/auth/google?app=1&challenge=${challenge}`), env, ctx);
    const cookies = (start.headers.getSetCookie ? start.headers.getSetCookie() : [start.headers.get("set-cookie")]).map((c) => c.split(";")[0]).join("; ");
    const st = /mh_oauth=([^;]+)/.exec(cookies)[1]; lastNonce = new URL(start.headers.get("location")).searchParams.get("nonce");
    const cb = () => mod.default.fetch(new Request(`https://mail.yourdomain.example/auth/google/callback?code=gcode-${st.slice(-6)}&state=${encodeURIComponent(st)}`, { headers: { cookie: cookies, ...(ua ? { "user-agent": ua } : {}) } }), env, ctx);
    return { verifier, challenge, cookies, cb };
  };
  const appCode = (r) => (r.status === 302 && (r.headers.get("location") || "").startsWith("sheritmail://auth?code=")) ? new URL(r.headers.get("location")).searchParams.get("code") : null;
  try {
    const f1 = await flow();
    const a = await f1.cb(), b = await f1.cb();   // the duplicate, after the first has finished
    check(!!appCode(a) && appCode(a) === appCode(b), `a repeated callback is answered with the SAME app code, not an error page (${a.status}/${b.status})`);
    const f2 = await flow();
    const [c, d] = await Promise.all([f2.cb(), f2.cb()]);   // the duplicate RACING the first through Google
    check(!!appCode(c) && appCode(c) === appCode(d), `two callbacks racing each other both end at the app with one code (${c.status}/${d.status})`);
    const ex = (code, verifier) => mod.default.fetch(new Request("https://mail.yourdomain.example/auth/app/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, verifier }) }), env, ctx);
    const e1 = await ex(appCode(c), f2.verifier), e2 = await ex(appCode(d), f2.verifier);
    check(e1.status === 200 && e2.status === 401, `and that code still becomes a session exactly once (${e1.status} then ${e2.status})`);
    // Windows signs in through the ordinary browser: a bare 302 to sheritmail: left Google's page spinning in the tab (
    // ), so a Windows browser gets a page that says it is done and opens the app; the Mac's sheet keeps its 302.
    const f3 = await flow("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0");
    const w = await f3.cb(), page = await w.text();
    const onPage = /href="sheritmail:\/\/auth\?code=([A-Za-z0-9_-]+)"/.exec(page);
    check(w.status === 200 && !w.headers.get("location") && /You're signed in/.test(page) && /location\.replace\("sheritmail:\/\/auth\?code=/.test(page) && !!onPage,
      `a Windows browser lands on a signed-in page that opens the app, not a 302 that commits nothing (${w.status})`);
    check((w.headers.getSetCookie ? w.headers.getSetCookie() : []).filter((c) => /^mh_oauth(_app)?=;/.test(c) && /Max-Age=0/.test(c)).length === 2, "the sign-in cookies are cleared on that page too");
    const e3 = await ex(onPage && onPage[1], f3.verifier);
    check(e3.status === 200, `the code on that page becomes a session (${e3.status})`);
    const f4 = await flow("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15");
    check(!!appCode(await f4.cb()), "the Mac's sign-in sheet still gets the 302 it closes on");
    const web = await mod.default.fetch(new Request(`https://mail.yourdomain.example/auth/google`), env, ctx);
    { const sc = web.headers.get("set-cookie") || ""; check(web.status === 302 && !/mh_oauth_app=[^;\s]/.test(sc) && /mh_oauth_app=;[^,]*Max-Age=0/.test(sc), `the ordinary web sign-in sets no app cookie, and clears a stale one (${sc.slice(0, 160)})`); }
  } finally { globalThis.fetch = realFetch; }
}

// ---------- a new message is never swallowed by Trash  ----------
// Trash used to stay trash: a message matched to a deleted conversation, by its subject or as a reply, was stored and shown
// nowhere but Trash. A subject match now starts a fresh conversation; a real reply brings the conversation back, as Gmail does.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", GMAIL_TOKEN_KEY: "k", EMAIL: { send: async () => {} } };
  const send = async (msgid, extra = {}) => {
    const hdrs = { subject: "Daily digest", "message-id": `<${msgid}>`, from: "Jason <jason@ticketco.example>", date: "Fri, 18 Sep 2026 16:10:00 +0000", ...extra };
    const raw = [`From: ${hdrs.from}`, `To: <sam@domain2.example>`, `Subject: ${hdrs.subject}`, `Message-ID: <${msgid}>`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
      `Date: ${hdrs.date}`, `Content-Type: text/plain; charset=utf-8`, ``, `Body of ${msgid}.`, ``].join("\r\n");
    await mod.default.email({ to: "sam@domain2.example", from: "bounce@e.ticketco.example", rawSize: raw.length, raw, headers: new Headers(hdrs), forward: async () => {}, setReject: () => {} }, env, { waitUntil: () => {} });
    return rows(sq, `SELECT m.thread_id id, t.state FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id LIKE '%${msgid}%'`)[0] || {};
  };
  const stateOf = (id) => rows(sq, `SELECT state, labels FROM threads WHERE id = '${id}'`)[0] || {};
  const first = await send("d1@e.ticketco.example");
  check(!!first.id && first.state === "inbox", `the first issue lands in the inbox (${first.state})`);
  sq.prepare("UPDATE threads SET state = 'trash' WHERE id = ?").run(first.id);
  const next = await send("d2@e.ticketco.example");
  check(!!next.id && next.id !== first.id, "the next issue with the same subject does NOT join the deleted conversation");
  check(next.state === "inbox" && stateOf(first.id).state === "trash", `it starts its own, in the inbox, and the deleted one stays deleted (${next.state} / ${stateOf(first.id).state})`);
  const reply = await send("r1@e.ticketco.example", { "in-reply-to": "<d1@e.ticketco.example>", subject: "Re: Daily digest" });
  check(reply.id === first.id && reply.state === "inbox", `a real reply to the deleted conversation joins it and brings it back to the inbox (${reply.state})`);
  sq.prepare("UPDATE threads SET state = 'trash' WHERE id = ?").run(first.id);
  sq.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES ('blk', 'jason@ticketco.example', 'block', '*', '2026-10-04T00:00:00Z')").run();
  const blocked = await send("r2@e.ticketco.example", { "in-reply-to": "<d1@e.ticketco.example>", subject: "Re: Daily digest" });
  check(blocked.id === first.id && stateOf(first.id).state === "trash" && /blocked/.test(stateOf(first.id).labels || ""), `a BLOCKED sender's reply still ends in Trash: the gatekeeper runs after the revive (${stateOf(first.id).state}, ${stateOf(first.id).labels})`);
}

// ---------- the receiving server's sender verdict is kept, and only that one ----------
// Cloudflare PREPENDS its Authentication-Results, so the first one naming mx.cloudflare.net is Cloudflare's. A sender can write
// headers of its own further down, including one that claims to be Cloudflare's and says everything passed; that one must never
// be what the hub keeps.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", GMAIL_TOKEN_KEY: "k", EMAIL: { send: async () => {} } };
  const deliverAR = async (msgid, ars) => {
    const raw = [...ars.map((v) => `Authentication-Results: ${v}`), `From: Jason <jason@ticketco.example>`, `To: <sam@domain2.example>`, `Subject: Verdict ${msgid}`, `Message-ID: <${msgid}>`,
      `Date: Fri, 18 Sep 2026 16:10:00 +0000`, `Content-Type: text/plain; charset=utf-8`, ``, `Body.`, ``].join("\r\n");
    await mod.default.email({ to: "sam@domain2.example", from: "bounce@e.ticketco.example", rawSize: raw.length, raw, headers: new Headers({ subject: `Verdict ${msgid}`, "message-id": `<${msgid}>`, from: "Jason <jason@ticketco.example>" }), forward: async () => {}, setReject: () => {} }, env, { waitUntil: () => {} });
    return rows(sq, `SELECT auth_results FROM messages WHERE message_id LIKE '%${msgid}%'`)[0]?.auth_results;
  };
  const real = "mx.cloudflare.net; dkim=fail header.i=@ticketco.example; dmarc=fail header.from=ticketco.example policy.dmarc=reject; spf=fail";
  const forged = "mx.cloudflare.net; dkim=pass header.i=@ticketco.example; dmarc=pass header.from=ticketco.example policy.dmarc=reject; spf=pass";
  let got = await deliverAR("ar1@e.ticketco.example", [real, forged]);
  check(got === real, `the hub keeps Cloudflare's own verdict, the first one, not a forged "pass" written below it (${String(got).slice(0, 60)})`);
  got = await deliverAR("ar2@e.ticketco.example", ["mx.evil.example; dmarc=pass header.from=ticketco.example", real]);
  check(got === real, "a verdict from any other server is never kept");
  got = await deliverAR("ar3@e.ticketco.example", []);
  check(got === null || got === undefined, `mail with no verdict keeps none (${got})`);
}

// ---------- a message that cannot be stored leaves no conversation behind ----------
// The conversation used to be created (or its count bumped) BEFORE the message insert, as a separate write. When the insert failed (a duplicate Message-ID, a retried delivery, any error)
// the conversation stayed, counting a message it did not have: 3,591 such
// empty shells were in the inbox, and one showed as an empty "(no subject)" conversation. Both writes are now one D1 batch.
{
  const empties = (sq) => rows(sq, "SELECT COUNT(*) n FROM threads t WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)")[0].n;
  const sq = buildDb(), state = { poison: true }, trace = [], store = r2(trace, state);
  await deliver({ sq, store, state, trace, msgid: "shell1@e.ticketco.example" });
  check(empties(sq) === 0, `a message whose insert fails leaves no empty conversation (${empties(sq)} empty, ${rows(sq, "SELECT COUNT(*) n FROM threads")[0].n} conversations)`);
  state.poison = false;
  await deliver({ sq, store, state, trace, msgid: "shell2@e.ticketco.example" });
  const before = rows(sq, "SELECT id, message_count FROM threads")[0];
  await deliver({ sq, store, state, trace, msgid: "shell2@e.ticketco.example" });   // the same message delivered again: the insert hits the unique index
  const after = rows(sq, "SELECT id, message_count FROM threads WHERE id = ?".replace("?", `'${before.id}'`))[0];
  check(empties(sq) === 0 && rows(sq, "SELECT COUNT(*) n FROM messages WHERE message_id LIKE '%shell2@e.ticketco.example%'")[0].n === 1, `delivering the same message twice stores it once and leaves no empty conversation (${empties(sq)} empty)`);
  check(after && after.message_count === before.message_count, `and the conversation's count is not bumped by the copy that was not stored (${before.message_count} -> ${after && after.message_count})`);
}

// ---------- audit 2026-10-07: replies to your own mail, forwards, Send later, snoozes, sends that went ----------
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state); const sent = [];
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "yourdomain.example", GMAIL_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7))), CLI_TOKEN: "test-token", SESSION_SECRET: "s",
    EMAIL: { send: async (m) => { sent.push(m); return { messageId: `<a-${sent.length}@yourdomain.example>` }; } } };
  const ctx = { waitUntil: () => {} };
  const call = (method, path, body) => mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
  const rawOf = (m) => m?.__raw || "";
  // a follow-up in a conversation that holds only your own mail goes to the person you wrote to, not to you
  const s1 = await (await call("POST", "/api/send", { from: "sam@yourdomain.example", to: ["bob@vendor.example"], cc: ["carol@vendor.example"], subject: "Quote", text: "Can you quote 40 units?" })).json();
  const r1 = await call("POST", `/api/messages/${s1.id}/reply`, { text: "Following up." }); const last1 = sent[sent.length - 1];
  const to1 = (last1.to || []).map((x) => typeof x === "string" ? x : x.email);
  check(r1.status === 200 && to1.includes("bob@vendor.example") && !to1.includes("sam@yourdomain.example"), `a reply to your own message goes to its recipient, not to you (${r1.status}, to ${JSON.stringify(to1)})`);
  await call("POST", `/api/messages/${s1.id}/reply`, { text: "All of you.", mode: "all" }); const last2 = sent[sent.length - 1];
  const cc2 = (last2.cc || []).map((x) => typeof x === "string" ? x : x.email), to2 = (last2.to || []).map((x) => typeof x === "string" ? x : x.email);
  check(to2.join() === "bob@vendor.example" && cc2.join() === "carol@vendor.example", `reply all keeps To as To and Cc as Cc (to ${to2}, cc ${cc2})`);
  // a forward: Bcc and the edited subject reach the mail, the forwarded block appears once, inline images keep one pair of brackets
  const raw = ["From: Vendor <bob@vendor.example>", "To: <sam@yourdomain.example>", "Subject: Drawing", "Message-ID: <drw-1@vendor.example>", "Date: Tue, 06 Oct 2026 18:00:00 +0000",
    "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="M"', "", "--M", 'Content-Type: multipart/related; boundary="R"', "", "--R", "Content-Type: text/html; charset=utf-8", "",
    '<p>ORIGINAL BODY LINE</p><img src="cid:img1@vendor.example">', "--R", "Content-Type: image/png", "Content-ID: <img1@vendor.example>", "Content-Disposition: inline; filename=logo.png", "Content-Transfer-Encoding: base64", "",
    "iVBORw0KGgo=", "--R--", "--M", "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="drawing.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK", "--M--", ""].join("\r\n");
  await mod.default.email({ to: "sam@yourdomain.example", from: "bob@vendor.example", rawSize: raw.length, raw, headers: new Headers({ subject: "Drawing", "message-id": "<drw-1@vendor.example>", from: "Vendor <bob@vendor.example>" }), forward: async () => {}, setReject: () => {} }, env, ctx);
  const inb = sq.prepare("SELECT id FROM messages WHERE message_id = '<drw-1@vendor.example>'").get();
  const n0 = sent.length;
  const fr = await call("POST", `/api/messages/${inb.id}/forward`, { from: "sam@yourdomain.example", to: ["dave@example.com"], bcc: ["boss@example.com"], subject: "Please review by Friday", text: "See below." });
  const envs = sent.slice(n0), fraw = rawOf(envs[0]);
  check(fr.status === 200 && envs.map((e) => e.__to).sort().join() === "boss@example.com,dave@example.com", `a forward reaches its Bcc too (${fr.status}, envelopes ${envs.map((e) => e.__to)})`);
  const PostalMime = (await import("postal-mime")).default; const fp = await PostalMime.parse(fraw); const decoded = fp.text || "";
  check(fp.subject === "Please review by Friday", `and carries the subject as edited (${fp.subject})`);
  check((decoded.match(/Forwarded message/g) || []).length === 1 && /See below\./.test(decoded), `the forwarded block appears once in the text part (${(decoded.match(/Forwarded message/g) || []).length})`);
  check(/Content-ID: <img1@vendor\.example>/.test(fraw) && !/<<img1/.test(fraw) && /drawing\.pdf/.test(fraw), `inline images keep one pair of brackets, and the original's file goes along (${(fraw.match(/Content-ID: [^\r\n]*/) || [""])[0]})`);
  // Send later: a subject is optional, an empty message is refused now, and a scheduled forward is a forward
  const noSub = await call("POST", "/api/schedule", { kind: "send_later", account: "hub", due_at: new Date(Date.now() + 3600e3).toISOString(), draft: { from: "sam@yourdomain.example", to: ["bob@vendor.example"], text: "No subject needed." } });
  check(noSub.status === 200, `Send later takes a message with no subject, as Send now does (${noSub.status})`);
  const empty = await call("POST", "/api/schedule", { kind: "send_later", account: "hub", due_at: new Date(Date.now() + 3600e3).toISOString(), draft: { from: "sam@yourdomain.example", to: ["bob@vendor.example"], subject: "x" } });
  check(empty.status === 400, `and refuses an empty new message now, not at the due time (${empty.status})`);
  sq.prepare("DELETE FROM scheduled_actions").run();
  const fl = await call("POST", "/api/schedule", { kind: "send_later", account: "hub", due_at: new Date(Date.now() - 30e3).toISOString(), draft: { from: "sam@yourdomain.example", to: ["erin@example.com"], subject: "Fwd: Drawing", text: "Later note.", forward_of: inb.id } });
  const n1 = sent.length; try { await mod.default.scheduled({ scheduledTime: Date.now() }, env, ctx); } catch (_) {}
  const flRaw = rawOf(sent[n1]); const fla = sq.prepare("SELECT status, error FROM scheduled_actions WHERE kind = 'send_later'").get();
  const flp = flRaw ? await PostalMime.parse(flRaw) : {};
  check(fl.status === 200 && fla?.status === "done" && (flp.attachments || []).some((a) => a.filename === "drawing.pdf") && /Later note\./.test(flp.text || "") && (flp.text.match(/Forwarded message/g) || []).length === 1,
    `a scheduled forward goes out as a forward, with the original's file (${fla?.status} ${fla?.error || ""}, pdf ${/drawing\.pdf/.test(flRaw)})`);
  // a snooze whose conversation was Done meanwhile does not bring it back, and the cancel the client sends on Done (?keep=1) leaves it be
  const tid = sq.prepare("SELECT thread_id FROM messages WHERE id = ?").get(inb.id).thread_id;
  sq.prepare("UPDATE threads SET state = 'inbox' WHERE id = ?").run(tid);
  const sz = await (await call("POST", "/api/schedule", { kind: "snooze", account: "hub", ref: tid, due_at: new Date(Date.now() + 3600e3).toISOString(), payload: { subject: "Drawing" } })).json();
  const keep = await call("DELETE", `/api/schedule/${sz.id}?keep=1`);
  check(keep.status === 200 && sq.prepare("SELECT state FROM threads WHERE id = ?").get(tid).state === "snoozed", `a snooze cancelled because the user acted on it does not move the conversation (${sq.prepare("SELECT state FROM threads WHERE id = ?").get(tid).state})`);
  sq.prepare("UPDATE threads SET state = 'inbox' WHERE id = ?").run(tid);
  const sz2 = await (await call("POST", "/api/schedule", { kind: "snooze", account: "hub", ref: tid, due_at: new Date(Date.now() + 3600e3).toISOString(), payload: { subject: "Drawing" } })).json();
  sq.prepare("UPDATE threads SET state = 'archived', unread = 0 WHERE id = ?").run(tid);   // Done, by another device
  sq.prepare("UPDATE scheduled_actions SET due_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), sz2.id);
  try { await mod.default.scheduled({ scheduledTime: Date.now() }, env, ctx); } catch (_) {}
  const after = sq.prepare("SELECT state, unread FROM threads WHERE id = ?").get(tid), sact = sq.prepare("SELECT status, error FROM scheduled_actions WHERE id = ?").get(sz2.id);
  check(after.state === "archived" && after.unread === 0 && sact.status === "done" && /no longer snoozed/.test(sact.error || ""), `a snooze that falls due after the conversation was Done leaves it Done (${after.state}, ${sact.status}: ${sact.error})`);
  // a message that went, whose record then failed, is answered as sent with a warning, never "not sent" (which invites a duplicate)
  const realPut = store.put; store.put = async (k, v, o) => { if (String(k).startsWith("out/")) throw new Error("R2_UNAVAILABLE"); return realPut(k, v, o); };
  const n2 = sent.length; const bk = await call("POST", "/api/send", { from: "sam@yourdomain.example", to: ["bob@vendor.example"], subject: "Went", text: "It went." }); const bkj = await bk.json().catch(() => ({}));
  store.put = realPut;
  check(sent.length === n2 + 1 && bk.status === 200 && /not saved to Sent/.test(bkj.warning || ""), `a sent message whose record failed is answered as sent, with a warning (${bk.status} ${bkj.warning || bkj.error || ""})`);
}

// ---------- the tempfail probe ----------
// Mail to the address named by TEMPFAIL_PROBE throws out of email(), uncaught and before anything is stored; all other mail is
// handled as always, and with the secret unset nothing changes.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "yourdomain.example", TEMPFAIL_PROBE: "r50-probe@yourdomain.example" };
  const raw = (to) => [`From: Sam <sam.owner@gmail.com>`, `To: <${to}>`, `Subject: probe`, `Message-ID: <p-${to}@x>`, ``, `hi`, ``].join("\r\n");
  const msg = (to) => ({ to, from: "sam.owner@gmail.com", rawSize: raw(to).length, raw: raw(to), headers: new Headers({ subject: "probe", "message-id": `<p-${to}@x>` }), forward: async () => { state.forwarded = (state.forwarded || 0) + 1; }, setReject: (r) => { state.rejected = r; } });
  let threw = null; try { await mod.default.email(msg("R50-Probe@yourdomain.example"), env, { waitUntil: () => {} }); } catch (e) { threw = e; }
  check(threw && /tempfail probe/.test(threw.message) && trace.length === 0 && !state.forwarded && !state.rejected, `mail to the probe address throws out of the handler before anything is stored (${threw?.message}, ${trace.length} store ops)`);
  await mod.default.email(msg("sam@yourdomain.example"), env, { waitUntil: () => {} });
  check(trace.some((t) => t.store === "r2"), "mail to any other address is stored as always");
  const env2 = { ...env, TEMPFAIL_PROBE: undefined }; let threw2 = null; const n = trace.length;
  try { await mod.default.email(msg("r50-probe@yourdomain.example"), env2, { waitUntil: () => {} }); } catch (e) { threw2 = e; }
  check(!threw2 && trace.length > n, "with the secret unset, the probe address is ordinary mail");
}

// ---------- reply from a notification ----------
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state); const sent = [];
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 3)));
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "yourdomain.example", CLI_TOKEN: "test-token", SESSION_SECRET: "s",
    GMAIL_TOKEN_KEY: KEY, GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", EMAIL: { send: async (m) => { sent.push(m); return { messageId: `<n-${sent.length}@yourdomain.example>` }; } } };
  const ctx = { waitUntil: () => {} };
  const call = (method, path, body) => mod.default.fetch(new Request("https://mail.yourdomain.example" + path, { method, headers: { authorization: "Bearer test-token", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
  // hub mail: a reply to the newest message from someone else, threaded, and the conversation read
  const raw = ["From: Bob <bob@vendor.example>", "To: <sam@yourdomain.example>", "Subject: Lunch?", "Message-ID: <lunch-1@vendor.example>", "Date: Tue, 06 Oct 2026 18:00:00 +0000", "", "Thursday?", ""].join("\r\n");
  await mod.default.email({ to: "sam@yourdomain.example", from: "bob@vendor.example", rawSize: raw.length, raw, headers: new Headers({ subject: "Lunch?", "message-id": "<lunch-1@vendor.example>", from: "Bob <bob@vendor.example>" }), forward: async () => {}, setReject: () => {} }, env, ctx);
  const tid = sq.prepare("SELECT thread_id FROM messages WHERE message_id = '<lunch-1@vendor.example>'").get().thread_id;
  sq.prepare("UPDATE threads SET unread = 1 WHERE id = ?").run(tid);
  const r = await call("POST", "/api/notify/reply", { account: "hub", thread: tid, text: "Thursday works." }); const rj = await r.json();
  const m = sent[sent.length - 1]; const to = (m?.to || []).map((x) => typeof x === "string" ? x : x.email);
  check(r.status === 200 && to.join() === "bob@vendor.example" && m.headers?.["In-Reply-To"] === "<lunch-1@vendor.example>" && /^Re: Lunch\?$/.test(m.subject || "") && m.text === "Thursday works.",
    `a reply typed into a notification goes to the sender, threaded, as typed (${r.status} ${rj.error || ""}, to ${to}, ${m?.subject})`);
  check(sq.prepare("SELECT unread FROM threads WHERE id = ?").get(tid).unread === 0, "and the conversation is marked read");
  const empty = await call("POST", "/api/notify/reply", { account: "hub", thread: tid, text: "   " });
  check(empty.status === 400, `an empty reply is refused (${empty.status})`);
  // Gmail: built here (the phone has no Gmail token), sent into the thread with its reply headers, and the thread read
  const sealed = await mod.sealToken(env, "refresh-token", "me@gmail.example");
  sq.prepare("INSERT INTO gmail_accounts (email, refresh_token_enc, refresh_iv, scope, status, created_at, label) VALUES ('me@gmail.example', ?, ?, 's', 'active', '2026-10-07', 'Sam Owner')").run(sealed.enc, sealed.iv);
  const gcalls = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o = {}) => { u = String(u); gcalls.push({ u, m: o.method || "GET", b: o.body });
    if (u === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    if (/\/threads\/abc123\?format=metadata/.test(u)) return new Response(JSON.stringify({ messages: [{ id: "m1", labelIds: ["INBOX", "UNREAD"], payload: { headers: [{ name: "From", value: "Carol <carol@example.com>" }, { name: "Subject", value: "Quote" }, { name: "Message-ID", value: "<q1@example.com>" }] } }] }), { status: 200 });
    if (/\/messages\/send$/.test(u)) return new Response(JSON.stringify({ id: "sent1", threadId: "abc123" }), { status: 200 });
    if (/\/threads\/abc123\/modify$/.test(u)) return new Response("{}", { status: 200 });
    return realFetch ? realFetch(u, o) : new Response("{}", { status: 404 }); };
  let g; try { g = await call("POST", "/api/notify/reply", { account: "me@gmail.example", thread: "abc123", text: "Sounds good — thanks!" }); } finally { globalThis.fetch = realFetch; }
  const gj = await g.json(); const send = gcalls.find((c) => /\/messages\/send$/.test(c.u)); const body = send ? JSON.parse(send.b) : {};
  const mime = body.raw ? Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString() : "";
  const PostalMime = (await import("postal-mime")).default; const pm = mime ? await PostalMime.parse(mime) : {};
  check(g.status === 200 && body.threadId === "abc123" && pm.inReplyTo === "<q1@example.com>" && pm.to?.[0]?.address === "carol@example.com" && pm.from?.address === "me@gmail.example" && pm.from?.name === "Sam Owner" && pm.subject === "Re: Quote" && /Sounds good — thanks!/.test(pm.text || ""),
    `a Gmail reply is sent into the thread, to the sender, from the account with its name, threaded (${g.status} ${gj.error || ""}, ${pm.from?.name} <${pm.from?.address}> → ${pm.to?.[0]?.address}, ${pm.subject})`);
  check(gcalls.some((c) => /\/threads\/abc123\/modify$/.test(c.u) && /UNREAD/.test(c.b || "")), "and the Gmail thread is marked read");
}

// ---------- the Gmail safety copy comes off, and the failure test it was gated on ----------
{
  const OFF = { GMAIL_COPY: "off" };
  const ev = (sq, kind) => rows(sq, `SELECT detail FROM events WHERE kind='${kind}'`);
  // copy off: stored, no forward, recorded as "off" and as a normal arrival, not as a failure
  { const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
    const { rejects, forwards } = await deliver({ sq, store, state, trace, msgid: "off1@e.ticketco.example", extraEnv: OFF });
    const m = rows(sq, "SELECT gmail_copy FROM messages WHERE direction='in'");
    check(forwards.length === 0 && rejects.length === 0 && m.length === 1 && m[0].gmail_copy === "off",
      `GMAIL_COPY=off: the message is stored and NOT forwarded, and its copy is recorded as "off" (forwards ${forwards.length}, ${JSON.stringify(m)})`);
    check(ev(sq, "inbound_ok").length === 1 && ev(sq, "inbound_stored_forward_failed").length === 0 && ev(sq, "forward_fail").length === 0,
      "and it is logged as a normal arrival, so the daily report raises no failure for it");
    const sent = []; let crashed = null;
    try { await mod.dailyReport({ DB: d1(sq, trace, state), STORE: { ...store, head: async () => null }, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", ...OFF, EMAIL: { send: async (m) => { sent.push(m); } } }, []); } catch (e) { crashed = e; }
    const txt = crashed ? `crashed: ${crashed.message}` : `${sent[0]?.subject || ""}\n${sent[0]?.text || ""}`;
    check(/Gmail safety copy: OFF/.test(txt) && /WITHOUT a wanted Gmail copy: 0 in the last 7d(?! <-- ALERT)/.test(txt) && !/Resend bridge/.test(txt),
      `and the daily report says the copy is off, raises no missing-copy ALERT, and has no Resend line without a Resend key (${(txt.match(/[^\n]*(Gmail safety copy|WITHOUT a)[^\n]*/g) || [txt.slice(0, 120)]).join(" | ")})`); }
  // copy off, but a "forward" rule (USPTO) still forwards
  { const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
    sq.prepare("INSERT INTO rules (priority, rcpt_glob, sender_glob, action, label) VALUES (1, 'sam@domain2.example', '*@e.ticketco.example', 'forward', 'USPTO')").run();
    const { forwards } = await deliver({ sq, store, state, trace, msgid: "fwdrule@e.ticketco.example", extraEnv: OFF });
    const m = rows(sq, "SELECT gmail_copy FROM messages WHERE direction='in'");
    check(forwards.length === 1 && m[0]?.gmail_copy === "hub", `with the copy off, a "forward" rule still sends its mail to Gmail (forwards ${forwards.length}, ${m[0]?.gmail_copy})`); }
  // copy off + the R2 put fails: the emergency copy still goes, so nothing bounces. The inbound message is shaped like real mail, with
  // the hop headers Cloudflare's send binding refuses, because that is what the copy has to survive.
  { const sq = buildDb(), state = { r2Down: true }, trace = [], store = r2(trace, state);
    const real = ["Received: from mail-sor-f41.google.com by mx.cloudflare.net; Fri, 09 Oct 2026 16:52:55 +0000", "Return-Path: <bounce@e.ticketco.example>",
      "ARC-Seal: i=1; a=rsa-sha256; t=1; cv=none; d=google.com; s=arc; b=AAAA", "DKIM-Signature: v=1; a=rsa-sha256; d=ticketco.example; s=s1; b=BBBB",
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=ticketco.example", MIME("offr2@e.ticketco.example")].join("\r\n");
    const { rejects, forwards } = await deliver({ sq, store, state, trace, msgid: "offr2@e.ticketco.example", extraEnv: OFF, mime: real });
    check(forwards.length === 0 && (state.sent || 0) === 1 && rejects.length === 0 && ev(sq, "emergency_forward").length === 1 && ev(sq, "store_fail_forwarded").length === 1,
      `with the copy off, an R2 failure still sends the emergency copy and does not bounce (sent ${state.sent || 0}, rejects ${rejects.length}, ${ev(sq, "r2_write_fail")[0]?.detail || ""})`);
    const PostalMime = (await import("postal-mime")).default; const pm = state.sentRaw ? await PostalMime.parse(state.sentRaw) : {};
    const att = (pm.attachments || []).find((x) => x.filename === "original.eml");
    const same = att && Buffer.from(att.content).equals(Buffer.from(real, "latin1"));
    check(pm.from?.address === "mailhub@yourdomain.example" && pm.subject === "[emergency copy] Quarterly notice" && /From: Jason <jason@ticketco\.example>/.test(pm.text || "") && /To: sam@domain2\.example/.test(pm.text || "") && /Body of offr2@e\.ticketco\.example\./.test(pm.text || "") && same,
      `the emergency copy is a new message from the hub: the subject, who sent it and the text, with the original attached byte for byte (${pm.from?.address}, ${pm.subject}, original.eml ${att ? (same ? "identical" : "DIFFERS") : "missing"})`); }
  // and when the emergency copy itself fails, the record says why (the 2026-10-09 failure test got a 555 with no reason logged)
  { const sq = buildDb(), state = { r2Down: true, emailDown: true }, trace = [], store = r2(trace, state);
    const { rejects, threw } = await deliver({ sq, store, state, trace, msgid: "offr2em@e.ticketco.example", extraEnv: OFF });
    const d = ev(sq, "r2_write_fail")[0]?.detail || "";
    check(rejects.length === 0 && threw?.name === "TempFail" && /emergency copy failed: EMAIL_SEND_FAILED/.test(d) && /sender told to retry/.test(d), `an emergency copy that fails is recorded with its reason, and the sender is asked to retry, not bounced (${d})`); }
  // over the size ceiling: no copy is attempted (it could not be sent, and building it risks the Worker's memory); a retry instead
  { const sq = buildDb(), state = { r2Down: true }, trace = [], store = r2(trace, state);
    const big = MIME("big@e.ticketco.example").replace("Body of big@e.ticketco.example.", "x".repeat(10 * 1024 * 1024 + 10));
    const { rejects, threw } = await deliver({ sq, store, state, trace, msgid: "big@e.ticketco.example", extraEnv: OFF, mime: big });
    const d = ev(sq, "r2_write_fail")[0]?.detail || "";
    check(!(state.sent > 0) && rejects.length === 0 && threw?.name === "TempFail" && /is over 10485760/.test(d), `an original over 10 MiB gets no emergency copy and the sender is asked to retry (copies ${state.sent || 0}, ${d.slice(0, 160)})`); }
  // a binary original is attached byte for byte
  { const sq = buildDb(), state = { r2Down: true }, trace = [], store = r2(trace, state);
    const head = Buffer.from(MIME("bin@e.ticketco.example").split("\r\n\r\n")[0] + "\r\n\r\n", "latin1");
    const bin = Buffer.concat([head, Buffer.from([0x00, 0x01, 0x7f, 0x80, 0x9f, 0xa0, 0xc3, 0x28, 0xff, 0xfe, 0x0d, 0x0a])]);
    await deliver({ sq, store, state, trace, msgid: "bin@e.ticketco.example", extraEnv: OFF, mime: bin });
    const PostalMime = (await import("postal-mime")).default; const pm = state.sentRaw ? await PostalMime.parse(state.sentRaw) : {};
    const att = (pm.attachments || []).find((x) => x.filename === "original.eml");
    check(!!att && Buffer.from(att.content).equals(bin), `a binary original (0x00, 0x80, 0xff, a lone 0xc3) is attached byte for byte (${att ? Buffer.from(att.content).length + " of " + bin.length + " bytes" : "no attachment"})`); }
  // a hostile subject: no header injection, and the Subject line stays inside Email Service's 998-character limit
  { const sq = buildDb(), state = { r2Down: true }, trace = [], store = r2(trace, state);
    const hostile = MIME("subj@e.ticketco.example").replace("Subject: Quarterly notice", "Subject: =?utf-8?Q?hello=0D=0ABcc:_evil@x.com?= " + "A".repeat(2000));
    const { threw } = await deliver({ sq, store, state, trace, msgid: "subj@e.ticketco.example", extraEnv: OFF, mime: hostile });
    const head = (state.sentRaw || "").split(/\r?\n\r?\n/)[0]; const subj = head.split(/\r?\n/).find((l) => l.startsWith("Subject:")) || "";
    check(!threw && state.sent === 1 && !/^Bcc:/mi.test(head) && subj.length > 0 && subj.length < 998, `a subject carrying CR/LF and 2,000 characters still sends: no injected header, Subject line ${subj.length} characters`); }
  // FAULT_PROBE_R2: only its own address; no routine copy, the put refused, the emergency copy sent
  { const sq = buildDb(), state = {}, trace = [], store = r2(trace, state); const P = { FAULT_PROBE_R2: "Probe-R2@domain2.example" };
    const a = await deliver({ sq, store, state, trace, msgid: "pr2@e.ticketco.example", to: "probe-r2@domain2.example", extraEnv: P });
    check(a.forwards.length === 0 && (state.sent || 0) === 1 && a.rejects.length === 0 && store._objs.size === 0 && /fault probe/.test(ev(sq, "store_fail_forwarded")[0]?.detail || ""),
      `FAULT_PROBE_R2: mail to the probe address is not stored, takes no routine copy, and reaches Gmail by the emergency copy (sent ${state.sent || 0}, objects ${store._objs.size})`);
    const b = await deliver({ sq, store, state, trace, msgid: "pr2other@e.ticketco.example", extraEnv: P });
    check(b.forwards.length === 1 && store._objs.size === 1 && (state.sent || 0) === 1, "and mail to any other address is untouched by it"); }
  // FAULT_PROBE_PROJECT: the projection throws after the put; the cron's replay indexes it; other mail untouched
  { const sq = buildDb(), state = {}, trace = [], store = r2(trace, state); const P = { FAULT_PROBE_PROJECT: "probe-p@domain2.example" };
    const a = await deliver({ sq, store, state, trace, msgid: "pp@e.ticketco.example", to: "probe-p@domain2.example", extraEnv: P });
    check(a.rejects.length === 0 && store._objs.size === 1 && rows(sq, "SELECT id FROM messages").length === 0 && rows(sq, "SELECT raw_key FROM pending_ingest").length === 1 && /fault probe/.test(ev(sq, "project_fail")[0]?.detail || ""),
      "FAULT_PROBE_PROJECT: the message is stored, its projection fails on purpose, and it is owed on the replay queue");
    const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", ...P };
    const n = await mod.reconcileInbound(env);
    check(n === 1 && rows(sq, "SELECT id FROM messages WHERE message_id = '<pp@e.ticketco.example>'").length === 1 && rows(sq, "SELECT raw_key FROM pending_ingest").length === 0,
      `and the cron's replay indexes it, because the replay does not consult the probe (${n})`);
    await deliver({ sq, store, state, trace, msgid: "ppother@e.ticketco.example", extraEnv: P });
    check(rows(sq, "SELECT id FROM messages WHERE message_id = '<ppother@e.ticketco.example>'").length === 1, "and mail to any other address is indexed at once"); }
  // copy off + a projection that fails and is replayed: the replay records "off", not a failed copy
  { const sq = buildDb(), state = { poison: true }, trace = [], store = r2(trace, state);
    await deliver({ sq, store, state, trace, msgid: "offreplay@e.ticketco.example", extraEnv: OFF });
    state.poison = false;
    await mod.reconcileInbound({ DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", ...OFF });
    const m = rows(sq, "SELECT gmail_copy FROM messages WHERE direction='in'");
    check(m[0]?.gmail_copy === "off" && ev(sq, "inbound_stored_forward_failed").length === 0, `a replayed message with the copy off is recorded as "off", not as a failed copy (${m[0]?.gmail_copy})`); }
}

// ---------- A failed rule read is re-read at projection; a replay keeps the arrival's copy decision; a crash retries ----------
{
  const OFF = { GMAIL_COPY: "off" };
  // the rules read fails at arrival (fail closed: held, no forward), succeeds at projection
  { const sq = buildDb(), state = { failRulesOnce: true }, trace = [], store = r2(trace, state);
    sq.prepare("INSERT INTO rules (priority, rcpt_glob, sender_glob, action, label) VALUES (1, 'sam@domain2.example', '*@e.ticketco.example', 'forward', 'USPTO')").run();
    const { forwards } = await deliver({ sq, store, state, trace, msgid: "rulefail@e.ticketco.example", extraEnv: OFF });
    const m = rows(sq, "SELECT gmail_copy, labels FROM messages WHERE direction='in'")[0] || {};
    const kinds = rows(sq, "SELECT kind FROM events WHERE kind LIKE 'inbound%'").map((r) => r.kind);
    check(forwards.length === 0 && m.gmail_copy === "none" && /USPTO/.test(m.labels || "") && kinds.includes("inbound_stored_forward_failed") && !kinds.includes("inbound_held"),
      `a rules read that fails at arrival is re-read at projection: a forward rule's missed copy is recorded as wanted-not-sent, not as held (${m.gmail_copy}, ${m.labels}, ${kinds.join(",")})`); }
  { const sq = buildDb(), state = { failRulesOnce: true }, trace = [], store = r2(trace, state);
    await deliver({ sq, store, state, trace, msgid: "rulefail2@e.ticketco.example", extraEnv: OFF });
    const m = rows(sq, "SELECT gmail_copy FROM messages WHERE direction='in'")[0] || {};
    check(m.gmail_copy === "off" && rows(sq, "SELECT kind FROM events WHERE kind = 'inbound_held'").length === 0, `and mail no rule holds is not left marked held (${m.gmail_copy})`); }
  // the arrival decided "off"; the policy flips to "on" before the replay; the replay keeps "off"
  { const sq = buildDb(), state = { poison: true }, trace = [], store = r2(trace, state);
    await deliver({ sq, store, state, trace, msgid: "flip@e.ticketco.example", extraEnv: OFF });
    const meta = [...store._objs.values()][0]?.customMetadata || {};
    state.poison = false;
    await mod.reconcileInbound({ DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", GMAIL_COPY: "on" });
    const m = rows(sq, "SELECT gmail_copy FROM messages WHERE direction='in'")[0] || {};
    check(meta.copy === "0" && m.gmail_copy === "off", `the stored object carries the arrival's copy decision and a replay after the policy changed keeps it (copy=${meta.copy}, replayed as ${m.gmail_copy})`); }
  // a crash before anything is kept, with the Gmail forward down too: a retry, not a bounce
  { const sq = buildDb(), state = {}, trace = [], store = r2(trace, state); const rejects = [];
    const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "domain2.example", ...OFF };
    let threw = null;
    try { await mod.default.email({ to: "sam@domain2.example", from: "bounce@e.ticketco.example", raw: "x", rawSize: 1, headers: null, forward: async () => { throw new Error("FORWARD_FAILED"); }, setReject: (r) => rejects.push(r) }, env, { waitUntil: () => {} }); } catch (e) { threw = e; }
    check(rejects.length === 0 && !!threw && rows(sq, "SELECT kind FROM events WHERE kind = 'handler_crash'").length === 1,
      `a handler crash whose last-resort forward also fails is a temporary failure, not "temporary failure, please retry" sent as a permanent setReject (rejects ${rejects.length}, threw ${threw?.message})`); }
}

// ---------- the preview of an HTML-only message is its text, not its source ----------
// Axios Live previewed as "96 *{box-sizing:border-box}body{margin:0;padding:0}a[…". The message had no
// text part, and the snippet stripped tags but kept the contents of <style> and of Outlook's <!--[if mso]> block (<o:PixelsPerInch>96).
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "yourdomain.example" };
  const html = '<!DOCTYPE html><html><head><title>Axios</title><!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->'
    + '<STYLE>*{box-sizing:border-box}body{margin:0;padding:0}</STYLE></head><body><style>.x{color:red}</style><script>var a=1</script>'
    + '<div style="display:none">&#847;&zwnj;&nbsp;&#847;&zwnj;</div><p>Hello&nbsp;there, Q&amp;A &lt;live&gt; &#8212; it&#39;s on.</p></body></html>';
  const raw = ["From: Axios Live <events@axios.example>", "To: <sam@yourdomain.example>", "Subject: Live briefing", "Message-ID: <axios-1@axios.example>",
    "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", html, ""].join("\r\n");
  await mod.default.email({ to: "sam@yourdomain.example", from: "events@axios.example", rawSize: raw.length, raw, headers: new Headers({ subject: "Live briefing", "message-id": "<axios-1@axios.example>", from: "Axios Live <events@axios.example>" }), forward: async () => {}, setReject: () => {} }, env, { waitUntil: () => {} });
  const snip = sq.prepare("SELECT snippet FROM messages WHERE message_id = '<axios-1@axios.example>'").get()?.snippet;
  check(snip === "Hello there, Q&A <live> \u2014 it's on.", `an HTML-only message previews as its text: no CSS, no script, no title, no Outlook block, entities decoded (${JSON.stringify(snip)})`);
}

// ---------- a message with both parts previews as its HTML reads ----------
// Shopco's Mailchimp newsletter listed as "Blue Powder (https://shop.example/product/\u2026?goal=\u2026)":
// the snippet came from the text part, where Mailchimp writes every link out. Its HTML also splits a word across inline spans.
{
  const sq = buildDb(), state = {}, trace = [], store = r2(trace, state);
  const env = { DB: d1(sq, trace, state), STORE: store, FORWARD_TO: "x@gmail.com", DOMAINS: "zone.test" };
  const mail = (id, parts) => { const b = "b" + id; return ["From: Shopco Inc <orders@shop.example>", "To: <sam@zone.test>", "Subject: Blue Powder is back", `Message-ID: <${id}@shop.example>`,
    "MIME-Version: 1.0", `Content-Type: multipart/alternative; boundary="${b}"`, "", ...parts.flatMap(([t, body]) => [`--${b}`, `Content-Type: ${t}; charset=utf-8`, "", body]), `--${b}--`, ""].join("\r\n"); };
  const send = async (id, parts) => { const raw = mail(id, parts); await mod.default.email({ to: "sam@zone.test", from: "orders@shop.example", rawSize: raw.length, raw, headers: new Headers({ subject: "Blue Powder is back", "message-id": `<${id}@shop.example>`, from: "Shopco Inc <orders@shop.example>" }), forward: async () => {}, setReject: () => {} }, env, { waitUntil: () => {} });
    return sq.prepare(`SELECT snippet FROM messages WHERE message_id = '<${id}@shop.example>'`).get()?.snippet; };
  const s1 = await send("shop-1", [["text/plain", "Blue Powder (https://shop.example/product/blue/?goal=0_8ce2&mc_cid=305c&mc_eid=UNIQID) - I know you all love this stuff!"],
    ["text/html", '<table><tr><td><h1><a href="https://us.list-manage.com/x"><span>Blue Powder</span></a><span>- I know you all love this stuff!</span></h1></td></tr><tr><td><p>It is back. The very sought after <a href="https://us.list-manage.com/y"><span>Blue Powde</span><span>r</span></a><span>, here is some info.</span></p></td></tr></table>']]);
  check(s1 === "Blue Powder- I know you all love this stuff! It is back. The very sought after Blue Powder, here is some info.", `a Mailchimp newsletter previews as its HTML reads: no tracking URLs, a word split across spans kept whole, blocks spaced (${JSON.stringify(s1)})`);
  const s2 = await send("shop-2", [["text/plain", "Hello from the text part."], ["text/html", '<div><img src="https://x.example/banner.png" alt=""></div>']]);
  check(s2 === "Hello from the text part.", `an HTML part with no words falls back to the text part (${JSON.stringify(s2)})`);
  const pad = (String.fromCharCode(0x200e, 0x200f) + " ").repeat(20);   // Resend's preheader padding: LRM + RLM
  const s3 = await send("shop-3", [["text/plain", "Hey, it's Zeno. https://resend.com/changelog"], ["text/html", `<div style="display:none">Plus agent plugins. ${pad}</div><p>Hey, it's Zeno.</p>`]]);
  check(s3 === "Plus agent plugins. Hey, it's Zeno.", `the preheader leads and its invisible padding is gone (${JSON.stringify(s3)})`);
}

console.log(fails.length ? "FAILED: " + fails.join("; ") : "all R2-first ingest checks passed");
process.exit(fails.length ? 1 : 0);
