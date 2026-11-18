#!/usr/bin/env node
// Address locks: an address on the user's domains belongs to the company that first writes to it. Real email()
// entry point, real migrations, real SQLite, a fake R2; the HTTP routes through the real fetch(). Checks that:
//  - x-… addresses lock themselves on first mail; sam@ and trademark@ and every other address are filed exactly as before;
//  - the claim is the authenticated organizational domain (DMARC for the From domain, or SPF for an envelope of the same organization),
//  never a forged From and never a sending service's shared bounce domain;
//  - the claimer, the allow list, domains the user sent to and replies to the user's own mail get in; nobody else does, a
//  globally accepted sender included;
//  - kept-out mail is stored, never refused, on a thread of its own, archived and read, with no gatekeeper run;
//  - a failing lock read files the mail as before (fail open), and the R2-first order is unchanged;
//  - the routes make, close, release and let a domain in, and the daily report carries the line.
// Usage: node test/addrlock.mjs (exit 1 on any failed check)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";

const HUB = new URL("../", import.meta.url).pathname;
const fails = [];
const check = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };
const statements = (sql) => { const out = []; let buf = ""; for (const part of sql.split(";")) { buf += part + ";"; if ((buf.match(/\bBEGIN\b/gi) || []).length === (buf.match(/\bEND\b/gi) || []).length) { const t = buf.trim(); if (t && t !== ";") out.push(t); buf = ""; } } const t = buf.trim(); if (t && t !== ";") out.push(t); return out; };
const decomment = (sql) => { let out = "", q = false; for (let i = 0; i < sql.length; i++) { const c = sql[i]; if (c === "'") { q = !q; out += c; continue; } if (!q && c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; out += "\n"; continue; } out += c; } return out; };
function buildDb() {
  const sq = new DatabaseSync(":memory:"); const skipped = [];
  for (const f of readdirSync(HUB + "migrations").sort()) for (const st of statements(decomment(readFileSync(HUB + "migrations/" + f, "utf8")))) { try { sq.exec(st); } catch (e) { skipped.push(`${f}: ${e.message.slice(0, 60)}`); } }
  buildDb.skipped = skipped;
  sq.prepare("INSERT OR IGNORE INTO identities (email, display_name, domain, is_active) VALUES ('sam@yourdomain.example', 'Sam', 'yourdomain.example', 1)").run();
  return sq;
}
function d1(sq, state, trace) {
  const run = (sql, params, kind) => {
    trace.push(sql.replace(/\s+/g, " ").trim().slice(0, 60));
    if (state.locksDown && /address_locks/.test(sql)) throw new Error("LOCKS_UNAVAILABLE");
    if (state.staleAllowOnce && /FROM address_lock_allows WHERE address = \? AND domain = \?/.test(sql)) { state.staleAllowOnce = false; return kind === "first" ? null : { results: [] }; }
    if (state.failInboxThread && /^UPDATE threads SET state = 'inbox', unread = 1/.test(sql.trim())) throw new Error("THREAD_UPDATE_FAILED");
    const st = sq.prepare(sql);
    return kind === "all" ? { results: st.all(...params) } : kind === "first" ? (st.get(...params) ?? null) : { meta: { changes: Number(st.run(...params).changes) } };
  };
  return { prepare(sql) { const mk = (p) => ({ bind: (...a) => mk(a), all: async () => run(sql, p, "all"), first: async () => run(sql, p, "first"), run: async () => run(sql, p, "run") }); return mk([]); },
           batch: async (xs) => { sq.exec("SAVEPOINT b"); try { const out = []; for (const x of xs) out.push(await x.run()); sq.exec("RELEASE b"); return out; } catch (e) { sq.exec("ROLLBACK TO b"); sq.exec("RELEASE b"); throw e; } } };
}
function r2(order) { const objs = new Map(); return { _objs: objs, put: async (k, v, o) => { order.push("r2"); objs.set(k, { body: Buffer.from(v), customMetadata: (o || {}).customMetadata || {} }); return {}; }, get: async (k) => { const o = objs.get(k); return o ? { arrayBuffer: async () => o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength), customMetadata: o.customMetadata } : null; }, list: async () => ({ objects: [], truncated: false }), delete: async (k) => { objs.delete(k); } }; }

const SRC = readFileSync(process.env.ADDRLOCK_SRC || HUB + "src/index.js", "utf8")   // ADDRLOCK_SRC: run against another copy (the control)
  .replace(/^import \{ EmailMessage \} from "cloudflare:email";$/m, "const EmailMessage = class { constructor(f, t, r) { this.__from = f; this.__to = t; this.__raw = r; } };")
  .replace(/^import \{ connect \} from "cloudflare:sockets";$/m, 'const connect = () => { throw new Error("no sockets"); };')
  .replace(/^import (\w+) from "\.\/[^"]+\.(html|webmanifest)";$/gm, 'const $1 = "";')
  .replace(/^import (\w+) from "\.\/client\/[^"]+\.js";$/gm, 'const $1 = "";');
const tmp = HUB + "test/_addrlock_mod.mjs"; writeFileSync(tmp, SRC);
let mod; try { mod = await import(tmp); } finally { unlinkSync(tmp); }

// Cloudflare's own stamp, in the shape of the user's real mail (D1 messages.auth_results).
const AR = { dmarc: (d, env) => `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1 header.b=abc; dmarc=pass header.from=${d} policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of ${env} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${env}; arc=none smtp.remote-ip=192.0.2.1`,
  spfOnly: (d, env) => `mx.cloudflare.net; dkim=none; dmarc=none header.from=${d}; spf=pass (mx.cloudflare.net: domain of ${env} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${env}; arc=none smtp.remote-ip=192.0.2.1`,
  none: (d, env) => `mx.cloudflare.net; dkim=none; dmarc=fail header.from=${d}; spf=fail smtp.mailfrom=${env}; arc=none smtp.remote-ip=192.0.2.9` };
let n = 0;
function makeEnv(sq, state, trace, order) { return { DB: d1(sq, state, trace), STORE: r2(order), FORWARD_TO: "x@gmail.com", GMAIL_COPY: "off", DOMAINS: "yourdomain.example,domain5.example", GMAIL_TOKEN_KEY: "k", CLI_TOKEN: "cli", IMAP_ACCOUNTS: JSON.stringify([{ email: "work@corp.example", host: "imap.corp.example", smtp_host: "smtp.corp.example" }]),
  EMAIL: { send: async (m) => { state.sent = (state.sent || []); state.sent.push(m); return { messageId: `<sent${state.sent.length}abcdefghijklmnopqrstuvwxyz0123@yourdomain.example>` }; } } }; }
async function deliver(env, { to, from, envFrom = null, ar = "dmarc", arDomain = null, subject = "Hello", inReplyTo = null, refs = null, fakeBelow = null, noFrom = false, arc = undefined, firstAr = null, fromHdr = null }) {
  const fromDom = from.split("@")[1]; envFrom = envFrom || `bounce@${fromDom}`; const id = `m${++n}@${fromDom}`;
  const stampArc = arc === undefined ? (ar ? AR[ar](arDomain || fromDom, envFrom) : null) : arc;   // Cloudflare's ARC result: the same as its A-R unless a test says otherwise
  const hdrs = [`Received: from mx.example (192.0.2.1) by cloudflare-email.net (cloudflare) id t${n} for <${to}>`, ...(stampArc ? [`ARC-Authentication-Results: i=1; ${stampArc}`] : []), ...(firstAr ? [`Authentication-Results: ${firstAr}`] : ar ? [`Authentication-Results: ${AR[ar](arDomain || fromDom, envFrom)}`] : []), ...(fakeBelow ? [`Authentication-Results: ${fakeBelow}`] : []),
    ...(noFrom ? [] : [`From: ${fromHdr || `Sender <${from}>`}`]), `To: <${to}>`, `Subject: ${subject}`, `Message-ID: <${id}>`, `Date: Wed, 14 Oct 2026 16:10:00 +0000`, ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []), ...(refs ? [`References: ${refs}`] : []), `Content-Type: text/plain; charset=utf-8`];
  const mime = [...hdrs, ``, `Body ${id}.`, ``].join("\r\n");
  const rejects = [];
  const message = { to, from: envFrom, rawSize: mime.length, raw: mime, headers: new Headers({ subject, "message-id": `<${id}>`, from: `Sender <${from}>`, ...(ar ? { "authentication-results": AR[ar](arDomain || fromDom, envFrom) } : {}) }),
    forward: async () => {}, setReject: (r) => rejects.push(r) };
  let threw = null; try { await mod.default.email(message, env, { waitUntil: () => {} }); } catch (e) { threw = e; }
  return { id: `<${id}>`, rejects, threw };
}
const rows = (sq, q, ...a) => sq.prepare(q).all(...a);
const msg = (sq, mid) => sq.prepare("SELECT m.id, m.identity, m.labels, m.lock_kept, m.lock_root, t.id AS tid, t.state, t.unread, t.labels AS tlabels, t.message_count FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.message_id = ?").get(mid);
const lock = (sq, a) => sq.prepare("SELECT * FROM address_locks WHERE address = ?").get(a);
const call = async (env, method, path, body) => { const r = await mod.default.fetch(new Request("https://hub.example" + path, { method, headers: { Authorization: "Bearer cli", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil: () => {} }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const sq = buildDb(), state = {}, trace = [], order = []; const env = makeEnv(sq, state, trace, order);
check(buildDb.skipped.length === 0, `every migration statement applied (${buildDb.skipped.join(" | ") || "none skipped"})`);
const A = "x-mybank@yourdomain.example";

// ---------- 1. the pattern arms on first mail, and the first authenticated sender claims ----------
{ const r = await deliver(env, { to: A, from: "alerts@mybank.com" }); const m = msg(sq, r.id), l = lock(sq, A);
  check(l && l.source === "pattern" && l.state === "active" && l.claim === "mybank.com", `x-mybank@ armed itself and mybank.com claimed it (${JSON.stringify(l)})`);
  check(m && m.lock_kept === 0 && m.state === "inbox" && m.unread === 1 && !String(m.tlabels || "").includes("locked-out"), `and the claimer's mail is in the inbox, unread (${m?.state}, unread ${m?.unread})`);
  check(r.rejects.length === 0 && !r.threw, "nothing was refused"); }
{ const r = await deliver(env, { to: A, from: "statements@mail.mybank.com", envFrom: "bounce@em1.mail.mybank.com" }); const m = msg(sq, r.id);
  check(m && m.lock_kept === 0 && m.state === "inbox", "a subdomain of the claimer (mail.mybank.com) is the same company and gets in"); }

// ---------- 2. anyone else is kept, never refused, on a thread of its own ----------
const before = sq.prepare("SELECT COUNT(*) n FROM known_senders").get().n;
const ev = await deliver(env, { to: A, from: "deals@evil.com", subject: "Hello" });
{ const m = msg(sq, ev.id);
  check(ev.rejects.length === 0 && !ev.threw, "mail from another company is NOT refused: setReject is permanent");
  check(m && m.lock_kept === 1 && m.lock_root === "evil.com" && JSON.parse(m.labels).includes("locked-out"), `it is stored, kept out, labelled locked-out, from evil.com (${m?.labels}, ${m?.lock_root})`);
  check(m.state === "archived" && m.unread === 0 && m.message_count === 1 && JSON.parse(m.tlabels).includes("locked-out"), `on a thread of its own, archived and read, labelled (${m.state}, unread ${m.unread}, ${m.message_count} message)`);
  check(sq.prepare("SELECT COUNT(*) n FROM known_senders").get().n === before, "the gatekeeper did not run on it (no sender recorded, so no push either)");
  check(rows(sq, "SELECT 1 FROM events WHERE kind = 'lock_kept_out' AND detail LIKE ?", `${A} <- deals@evil.com [evil.com]%`).length === 1, "and lock_kept_out was logged"); }
{ const same = await deliver(env, { to: A, from: "deals@evil.com", subject: "Hello" }); const a = msg(sq, ev.id), b = msg(sq, same.id);
  check(b.lock_kept === 1 && b.tid !== a.tid, "a second kept-out message from the same sender gets its own thread too: kept-out mail never joins a conversation"); }
// The same subject and sender as a wanted conversation: kept-out mail must not join or move it.
{ const want = await deliver(env, { to: A, from: "help@mybank.com", subject: "Your card" }); const spoof = await deliver(env, { to: A, from: "help@mybank.com", ar: "none", envFrom: "x@evil.com", subject: "Your card" });
  const w = msg(sq, want.id), s = msg(sq, spoof.id);
  check(s.lock_kept === 1 && s.lock_root === null && s.tid !== w.tid && msg(sq, want.id)?.state === "inbox", `a forged From: help@mybank.com with no DMARC is kept out (unauthenticated), on its own thread, and the real conversation stays in the inbox`); }
// A sender-written Authentication-Results under Cloudflare's own does not count, and one in front of Cloudflare's would not be Cloudflare's.
{ const r = await deliver(env, { to: A, from: "x@evil.com", ar: "none", fakeBelow: AR.dmarc("evil.com", "bounce@evil.com") }); const m = msg(sq, r.id);
  check(m.lock_kept === 1 && m.lock_root === null, "a forged Authentication-Results below Cloudflare's is ignored: only the first header counts"); }

// ---------- 3. who else gets in ----------
{ sq.prepare("INSERT INTO sender_rules (id, pattern, action, scope, created_at) VALUES ('r1', '*@friendly.com', 'accept', '*', '2026-10-14')").run();
  const r = await deliver(env, { to: A, from: "hi@friendly.com" });
  check(msg(sq, r.id)?.lock_kept === 1, "a globally accepted sender does NOT pass a lock: a resold list can reach a sender accepted elsewhere"); }
{ // a reply that cites mail the user sent FROM this address, from a helpdesk on another domain
  const tid = "00000000-0000-4000-8000-000000000001";
  sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state) VALUES (?, 'q', 'x', '2026-10-14T10:00:00Z', 1, 'archived')").run(tid);
  sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, message_id, status, ingest_source, created_at) VALUES ('out1', ?, 'out', ?, ?, '<OUTabcdefghijklmnopqrstuvwxyz0123456@yourdomain.example>', 'sent', 'mailhub', '2026-10-14T10:00:00Z')").run(tid, A, A);
  const r = await deliver(env, { to: A, from: "agent@zendesk.com", inReplyTo: "<OUTabcdefghijklmnopqrstuvwxyz0123456@yourdomain.example>" });
  check(msg(sq, r.id)?.lock_kept === 0, "a reply citing the user's own mail from this address gets in");
  const forged = await deliver(env, { to: A, from: "agent@zendesk.com", ar: "none", envFrom: "x@spoof.example", inReplyTo: "<OUTabcdefghijklmnopqrstuvwxyz0123456@yourdomain.example>" });
  check(msg(sq, forged.id)?.lock_kept === 1, "but the same citation from a sender that could not be verified is kept out");
  const longRefs = Array.from({ length: 60 }, (_, i) => `<old${i}@x.example>`).join(" ") + " <OUTabcdefghijklmnopqrstuvwxyz0123456@yourdomain.example>";
  const deep = await deliver(env, { to: A, from: "agent@zendesk.com", refs: longRefs });
  check(msg(sq, deep.id)?.lock_kept === 0, "a citation at the END of 61 References still counts: the newest ones are read");
  check(!rows(sq, "SELECT 1 FROM address_lock_allows WHERE address = ? AND domain = 'zendesk.com'", A).length, "and adds no one to the allow list");
  sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, message_id, status, ingest_source, created_at) VALUES ('out2', ?, 'out', 'sam@yourdomain.example', 'sam@yourdomain.example', '<MSGXabcdefghijklmnopqrstuvwxyz012345@yourdomain.example>', 'sent', 'mailhub', '2026-10-14T10:00:00Z')").run(tid);
  const r2_ = await deliver(env, { to: A, from: "agent@zendesk.com", refs: "<MSGXabcdefghijklmnopqrstuvwxyz012345@yourdomain.example>" });
  check(msg(sq, r2_.id)?.lock_kept === 1, "but citing mail sent from a DIFFERENT address (sam@) does not"); }
{ // mail the user sends from the locked address lets the recipients' organizations in
  const s = await call(env, "POST", "/api/send", { from: A, to: ["ops@vendor.co.uk"], cc: ["me@yourdomain.example"], subject: "Order", text: "hi" });
  check(s.status === 200, `sent from the locked address (${s.status} ${JSON.stringify(s.body).slice(0, 120)})`);
  const al = rows(sq, "SELECT domain, source FROM address_lock_allows WHERE address = ?", A);
  check(al.some((x) => x.domain === "vendor.co.uk" && x.source === "sent") && !al.some((x) => x.domain === "yourdomain.example"), `vendor.co.uk (a two-label suffix) was let in by the send, the user's own domain was not (${JSON.stringify(al)})`);
  const r = await deliver(env, { to: A, from: "ops@vendor.co.uk" });
  check(msg(sq, r.id)?.lock_kept === 0, "and vendor.co.uk's reply gets in"); }

// ---------- 4. the claim: authenticated, and never a shared sending service ----------
{ const B = "x-shop@domain5.example";
  const r = await deliver(env, { to: B, from: "orders@store.com", ar: "spfOnly", envFrom: "bounces+77@bounces.wixemails.com" });
  check(msg(sq, r.id)?.lock_kept === 0 && lock(sq, B)?.claim === null, `first mail with only SPF for a shared bounce domain (wixemails.com) is delivered and claims nothing (${lock(sq, B)?.claim})`);
  const r2b = await deliver(env, { to: B, from: "orders@store.com", ar: "spfOnly", envFrom: "bounce@mail.store.com" });
  check(lock(sq, B)?.claim === "store.com" && msg(sq, r2b.id)?.lock_kept === 0, "SPF for an envelope of the SAME organization claims it: a small company with no DMARC record"); }
{ const C = "x_quiet@domain5.example";
  const r = await deliver(env, { to: C, from: "who@nowhere.com", ar: "none" });
  check(msg(sq, r.id)?.lock_kept === 0 && lock(sq, C)?.state === "active" && lock(sq, C)?.claim === null, "x_ (underscore) also arms; unauthenticated first mail is delivered and the address stays unclaimed"); }

{ const D = "x-nofrom@domain5.example";
  const r = await deliver(env, { to: D, from: "orders@bounces.wixemails.com", envFrom: "bounces+9@bounces.wixemails.com", ar: "spfOnly", noFrom: true });
  check(msg(sq, r.id)?.lock_kept === 0 && lock(sq, D)?.claim === null, `a message with no From and SPF only for a shared bounce domain claims nothing: the envelope is never the fallback (${lock(sq, D)?.claim})`); }
{ const F = "x-friend@domain5.example";
  const a1 = await deliver(env, { to: F, from: "alice@gmail.com" });
  check(lock(sq, F)?.claim === "alice@gmail.com" && msg(sq, a1.id)?.lock_kept === 0, `at a personal mail provider the claim is the address, not gmail.com (${lock(sq, F)?.claim})`);
  const b1 = await deliver(env, { to: F, from: "bob@gmail.com" });
  check(msg(sq, b1.id)?.lock_kept === 1 && msg(sq, b1.id)?.lock_root === "bob@gmail.com", `another gmail.com sender is kept out, keyed by its address (${msg(sq, b1.id)?.lock_root})`);
  const bare = await call(env, "POST", `/api/locks/${encodeURIComponent(F)}/allow`, { domain: "gmail.com" });
  check(bare.status === 400 && msg(sq, b1.id)?.lock_kept === 1, `letting all of gmail.com in is refused (${bare.status} ${bare.body.error})`);
  const s1 = await call(env, "POST", "/api/send", { from: F, to: ["pal@gmail.com"], subject: "Hi", text: "hi" });
  const al = rows(sq, "SELECT domain FROM address_lock_allows WHERE address = ?", F).map((x) => x.domain);
  check(s1.status === 200 && al.includes("pal@gmail.com") && !al.includes("gmail.com"), `a send to pal@gmail.com lets that one address in, not gmail.com (${JSON.stringify(al)})`);
  const p1 = await deliver(env, { to: F, from: "pal@gmail.com" }), c1 = await deliver(env, { to: F, from: "carol@gmail.com" });
  check(msg(sq, p1.id)?.lock_kept === 0 && msg(sq, c1.id)?.lock_kept === 1, "pal@gmail.com gets in; carol@gmail.com does not");
  // the Let-in transaction: a failure on the thread half leaves nothing half done, and a retry finishes it
  state.failInboxThread = true; let threw = null, r1 = null; try { r1 = await call(env, "POST", `/api/locks/${encodeURIComponent(F)}/allow`, { domain: "carol@gmail.com" }); } catch (e) { threw = e; } state.failInboxThread = false;
  const mid = msg(sq, c1.id);
  check((threw || (r1 && r1.status >= 500)) && mid?.lock_kept === 1 && mid?.state === "archived" && !rows(sq, "SELECT 1 FROM address_lock_allows WHERE address = ? AND domain = 'carol@gmail.com'", F).length, `when the thread update fails, the message, its thread and the allow list are all unchanged (${threw ? "threw" : r1?.status}, kept ${mid?.lock_kept}, ${mid?.state})`);
  const r2e = await call(env, "POST", `/api/locks/${encodeURIComponent(F)}/allow`, { domain: "carol@gmail.com" });
  check(r2e.status === 200 && r2e.body.released === 1 && msg(sq, c1.id)?.lock_kept === 0 && msg(sq, c1.id)?.state === "inbox", "and the retry lets carol@gmail.com's message in"); }
{ // the reconciler's replay decides like the arrival: it reads the same bytes
  const R = "x-replay@domain5.example"; await deliver(env, { to: R, from: "news@acme.com" });
  const replay = async (from, ar = "dmarc") => { const fromDom = from.split("@")[1], envFrom = `bounce@${fromDom}`, mid = `<rp${++n}@${fromDom}>`;
    const mime = [`Received: from mx.example by cloudflare-email.net (cloudflare) id r${n} for <${R}>`, `ARC-Authentication-Results: i=1; ${AR[ar](fromDom, envFrom)}`, `Authentication-Results: ${AR[ar](fromDom, envFrom)}`, `From: <${from}>`, `To: <${R}>`, `Subject: replayed`, `Message-ID: ${mid}`, `Date: Wed, 14 Oct 2026 16:10:00 +0000`, ``, `body`, ``].join("\r\n");
    const key = `raw/2026/10/replay${n}.eml`; await env.STORE.put(key, mime, { customMetadata: { rcpt: R, envFrom, at: "2026-10-14T16:10:00.000Z", msgid: mid, copy: "0" } });
    sq.prepare("INSERT INTO pending_ingest (raw_key, rcpt, env_from, message_id, at) VALUES (?, ?, ?, ?, ?)").run(key, R, envFrom, mid, "2026-10-14T16:10:00.000Z");
    await mod.reconcileInbound(env, 5); return mid; };
  const good = await replay("alerts@mail.acme.com"), bad = await replay("deals@evil.com");
  check(lock(sq, R)?.claim === "acme.com" && msg(sq, good)?.lock_kept === 0 && msg(sq, bad)?.lock_kept === 1, `on the reconciler's replay the claimer's mail gets in and evil.com is kept out (${msg(sq, good)?.lock_kept}, ${msg(sq, bad)?.lock_kept})`); }

// ---------- 4b.
{ // Cloudflare dropped its own Authentication-Results and the sender's lookalike came first: Cloudflare's ARC result disagrees
  const E = "x-forge@domain5.example"; await deliver(env, { to: E, from: "alerts@mybank.com" });
  const r = await deliver(env, { to: E, from: "alerts@mybank.com", envFrom: "x@evil.example", ar: null, firstAr: AR.dmarc("mybank.com", "x@evil.example"), arc: AR.none("mybank.com", "x@evil.example") });
  check(msg(sq, r.id)?.lock_kept === 1 && msg(sq, r.id)?.lock_root === null, "a forged first Authentication-Results that Cloudflare's own ARC result contradicts is unauthenticated: kept out");
  check(rows(sq, "SELECT 1 FROM events WHERE kind = 'lock_cf_stamp_fail' AND detail LIKE ?", `${E}: Cloudflare's two stamps disagree%`).length === 1, "and the disagreement is logged as lock_cf_stamp_fail");
  const q = await deliver(env, { to: E, from: "alerts@mybank.com", arc: null });
  check(msg(sq, q.id)?.lock_kept === 1 && rows(sq, "SELECT 1 FROM events WHERE kind = 'lock_cf_stamp_fail' AND detail LIKE ?", `${E}: no ARC-Authentication-Results%`).length === 1, "with no Cloudflare ARC result at all, the message is unauthenticated and that is logged too"); }
{ // a quoted local part with a space
  const r = await deliver(env, { to: "x-forge@domain5.example", from: "room@mybank.com", fromHdr: 'Mail Room <"mail room"@mybank.com>' });
  check(msg(sq, r.id)?.lock_kept === 0, "a From with a quoted local part (\"mail room\"@mybank.com) is the claimer's and gets in"); }
{ // an x- address already in use is not armed by a stranger
  sq.prepare("INSERT OR IGNORE INTO identities (email, display_name, domain, is_active) VALUES ('x-ident@domain5.example', 'X', 'domain5.example', 1)").run();
  const tid = "00000000-0000-4000-8000-000000000002";
  sq.prepare("INSERT INTO threads (id, subject_norm, participants, last_message_at, message_count, state) VALUES (?, 'o', 'x', '2026-10-14T10:00:00Z', 1, 'archived')").run(tid);
  sq.prepare("INSERT INTO messages (id, thread_id, direction, identity, from_addr, message_id, status, ingest_source, created_at) VALUES ('out3', ?, 'out', 'x-used@domain5.example', 'x-used@domain5.example', '<USEDabcdefghijklmnopqrstuvwxyz012345@domain5.example>', 'sent', 'mailhub', '2026-10-14T10:00:00Z')").run(tid);
  const a = await deliver(env, { to: "x-ident@domain5.example", from: "deals@evil.com" }), b = await deliver(env, { to: "x-used@domain5.example", from: "deals@evil.com" });
  check(!lock(sq, "x-ident@domain5.example") && !lock(sq, "x-used@domain5.example") && msg(sq, a.id)?.lock_kept === 0 && msg(sq, b.id)?.lock_kept === 0, "an x- address that is a sending identity, or has sent mail, is not armed by a stranger's first mail"); }
{ // sending first from an unused x- address gives it to the person written to
  const S = "x-vendor@domain5.example";
  const s1 = await call(env, "POST", "/api/send", { from: S, to: ["sales@vendor.example"], cc: ["ops@partner.example"], subject: "Quote", text: "hi" });
  const l = lock(sq, S), al = rows(sq, "SELECT domain FROM address_lock_allows WHERE address = ?", S).map((x) => x.domain);
  check(s1.status === 200 && l?.state === "active" && l?.claim === "vendor.example" && al.includes("partner.example"), `a send from an unused x- address locks it for the first recipient (${l?.claim}), the cc'd organization let in (${JSON.stringify(al)})`);
  const st = await deliver(env, { to: S, from: "deals@evil.com" }), rp = await deliver(env, { to: S, from: "rep@vendor.example" });
  check(msg(sq, st.id)?.lock_kept === 1 && msg(sq, rp.id)?.lock_kept === 0, "a stranger who writes to it first does not claim it; the vendor's reply gets in"); }
{ // a work mailbox's domain counts for sending, but its mail arrives over IMAP: it cannot be locked
  const r = await call(env, "POST", "/api/locks", { address: "x-anything@corp.example" });
  const d = await deliver(env, { to: "x-anything@corp.example", from: "deals@evil.com" });
  check(r.status === 400 && !lock(sq, "x-anything@corp.example") && msg(sq, d.id)?.lock_kept === 0, `an address at an IMAP mailbox's domain can be neither made nor armed (${r.status} ${r.body.error})`); }
{ // the allow route and a delivery racing: the delivery read the allow list before the row existed, and is let in by its own re-check
  const F2 = "x-race@domain5.example"; await deliver(env, { to: F2, from: "news@acme2.com" });
  sq.prepare("INSERT INTO address_lock_allows (address, domain, source, added_at) VALUES (?, 'late.example', 'manual', '2026-10-14')").run(F2);
  state.staleAllowOnce = true; const r = await deliver(env, { to: F2, from: "hi@late.example" }); state.staleAllowOnce = false;
  const m = msg(sq, r.id);
  check(m?.lock_kept === 0 && m?.state === "inbox" && rows(sq, "SELECT 1 FROM events WHERE kind = 'lock_allowed_late'").length === 1, `a message decided before its sender was let in, and filed after, is let in by the re-check (${m?.lock_kept}, ${m?.state})`); }

// ---------- 5. every other address is untouched ----------
for (const to of ["sam@yourdomain.example", "trademark@yourdomain.example", "support@domain5.example", "xmybank@yourdomain.example", "x@yourdomain.example"]) {
  const r = await deliver(env, { to, from: "deals@evil.com" }); const m = msg(sq, r.id);
  check(m && m.lock_kept === 0 && !lock(sq, to) && !String(m.labels || "").includes("locked-out"), `${to}: no lock row, filed as before`); }
{ const r = await deliver(env, { to: "x-other@gmail.com", from: "deals@evil.com" });
  check(!lock(sq, "x-other@gmail.com"), "an x- address on a domain that is not the user's never arms"); }

// ---------- 6. fail open, and the R2-first order ----------
{ state.locksDown = true; order.length = 0; trace.length = 0;
  const r = await deliver(env, { to: A, from: "deals@evil.com" }); const m = msg(sq, r.id); state.locksDown = false;
  check(m && m.lock_kept === 0 && m.state === "inbox" && !r.threw && r.rejects.length === 0, "with the lock table unreadable the message is filed as before locks existed (fail open), not refused");
  check(rows(sq, "SELECT 1 FROM events WHERE kind = 'lock_fail_open'").length >= 1, "and lock_fail_open was logged");
  const preR2 = trace.slice(0, trace.findIndex((s) => /pending_ingest/.test(s)));
  check(!preR2.some((s) => /address_locks/.test(s)), "no lock read happens before the bytes are in R2"); }

// ---------- 7. the routes ----------
{ const g = await call(env, "GET", "/api/locks"); const L = (g.body.locks || []).find((x) => x.address === A);
  check(g.status === 200 && L && L.claim === "mybank.com" && L.kept >= 4 && L.allows.some((a) => a.domain === "vendor.co.uk"), `GET /api/locks lists x-mybank@ with its claim, kept-out count and allows (${String(JSON.stringify(L)).slice(0, 160)})`); }
{ const keptEvil = rows(sq, "SELECT id, thread_id FROM messages WHERE identity = ? AND lock_kept = 1 AND lock_root = 'evil.com'", A);
  const keptOther = rows(sq, "SELECT id FROM messages WHERE identity = ? AND lock_kept = 1 AND (lock_root IS NULL OR lock_root != 'evil.com')", A).length;
  const a = await call(env, "POST", `/api/locks/${encodeURIComponent(A)}/allow`, { domain: "news.evil.com" });
  check(a.status === 200 && a.body.domain === "evil.com" && a.body.released === keptEvil.length && keptEvil.length >= 2, `letting news.evil.com in names its organization, evil.com, and brings back its ${keptEvil.length} kept-out messages (${JSON.stringify(a.body).slice(0, 140)})`);
  const back = keptEvil.map((k) => sq.prepare("SELECT m.lock_kept, m.labels, t.state, t.labels tl FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?").get(k.id));
  check(back.every((b) => b.lock_kept === 0 && b.state === "inbox" && !String(b.labels || "").includes("locked-out") && !String(b.tl || "").includes("locked-out")), "they are in the inbox with the label gone");
  check(rows(sq, "SELECT id FROM messages WHERE identity = ? AND lock_kept = 1 AND (lock_root IS NULL OR lock_root != 'evil.com')", A).length === keptOther, "and nothing else kept out moved");
  const r = await deliver(env, { to: A, from: "deals@evil.com" }); check(msg(sq, r.id)?.lock_kept === 0, "evil.com's next mail gets in"); }
{ const d = await call(env, "DELETE", `/api/locks/${encodeURIComponent(A)}/allow/${encodeURIComponent("vendor.co.uk")}`);
  const r = await deliver(env, { to: A, from: "ops@vendor.co.uk" });
  check(d.status === 200 && d.body.removed === 1 && msg(sq, r.id)?.lock_kept === 1, `removing vendor.co.uk from the allow list keeps its next mail out (${d.status}, removed ${d.body.removed})`); }
{ const r = await deliver(env, { to: A, from: "alerts@mybank.com", ar: null });
  check(msg(sq, r.id)?.lock_kept === 1 && rows(sq, "SELECT 1 FROM events WHERE kind = 'lock_cf_stamp_fail' AND detail LIKE ?", `${A}:%`).length >= 1, "a message with no Cloudflare stamp is unauthenticated (kept out on a claimed lock) and lock_cf_stamp_fail is logged for the daily report"); }
{ const res = await mod.default.fetch(new Request("https://hub.example/api/locks"), env, { waitUntil: () => {} });
  const res2 = await mod.default.fetch(new Request(`https://hub.example/api/locks/${encodeURIComponent(A)}/allow`, { method: "POST", body: JSON.stringify({ domain: "evil.com" }) }), env, { waitUntil: () => {} });
  check(res.status === 401 && res2.status === 401, `the lock routes need a signed-in session (${res.status}, ${res2.status})`); }
{ const c = await call(env, "PATCH", `/api/locks/${encodeURIComponent(A)}`, { state: "closed" });
  const r = await deliver(env, { to: A, from: "alerts@mybank.com" });
  check(c.status === 200 && msg(sq, r.id)?.lock_kept === 1, "closed: even the claimer is kept out (and kept, not refused)");
  const li = await call(env, "POST", `/api/locks/${encodeURIComponent(A)}/allow`, { domain: "mybank.com" });
  check(li.status === 409 && msg(sq, r.id)?.lock_kept === 1, `and on a closed lock Let in is refused, so nothing moves (${li.status} ${li.body.error})`);
  await call(env, "PATCH", `/api/locks/${encodeURIComponent(A)}`, { state: "released" });
  const r2c = await deliver(env, { to: A, from: "deals@spam.com" });
  check(msg(sq, r2c.id)?.lock_kept === 0 && lock(sq, A)?.state === "released", "released: anyone gets in, and the x- address does not lock itself again"); }
{ const bad = [await call(env, "POST", "/api/locks", { address: "sam@yourdomain.example" }), await call(env, "POST", "/api/locks", { address: "support@domain5.example" }), await call(env, "POST", "/api/locks", { address: "mybank@gmail.com" })];
  check(bad[0].status === 409 && bad[1].status === 409 && bad[2].status === 400, `the app cannot lock a sending address, an address that already has mail, or another domain (${bad.map((b) => b.status).join(", ")})`);
  const ok = await call(env, "POST", "/api/locks", { address: "Bank@domain5.example" });
  const r = await deliver(env, { to: "bank@domain5.example", from: "no-reply@bank.com" }), r2d = await deliver(env, { to: "bank@domain5.example", from: "x@evil.com" });
  check(ok.status === 200 && lock(sq, "bank@domain5.example")?.source === "app" && msg(sq, r.id)?.lock_kept === 0 && msg(sq, r2d.id)?.lock_kept === 1, "an app-made address (any name) locks to its first sender the same way"); }

// ---------- 8. the daily report line, and trust.js agreement ----------
{ let text = ""; const env2 = { ...env, EMAIL: { send: async (m) => { text = m.text || ""; return { messageId: "<r@x>" }; } } };
  try { await mod.dailyReport(env2, []); } catch (e) { text = "THREW " + e.message; }
  const line = text.split("\n").find((l) => l.startsWith("address locks:")) || "";
  check(/^address locks: \d+; kept out last 24h: \d+; kept out, not let in: \d+/.test(line), `the daily report carries the lock line (${line || text.slice(0, 120)})`); }
{ const T = readFileSync(HUB + "src/client/trust.js", "utf8"); const trustRoot = new Function(T + "\nreturn trustRoot;")();
  const hosts = ["mail.vendorco.com", "email.vendorapp.com", "em1234.mail.vendorco.com", "a.b.example.co.uk", "example.co.uk", "shop.example.com.br", "www.mybank.com", "mybank.com.", "x.y.z.co.ke", "localhost"];
  const L = mod.lockRoot || null;
  check(typeof L === "function" && hosts.every((h) => L(h) === trustRoot(h)), `the hub's lockRoot gives trust.js trustRoot's answer on every host (${hosts.map((h) => `${h}→${L ? L(h) : "?"}`).join(", ")})`);
  const FREE = new Function(T + "\nreturn TRUST_FREEMAIL;")(), K = mod.lockKey || null;
  check(typeof K === "function" && FREE.every((d) => K(`a@${d}`, d) === `a@${d}`) && K("a@mybank.com", "mybank.com") === "mybank.com", `every personal mail provider in trust.js is keyed by address, a company by its domain (${FREE.length} providers)`); }

console.log(fails.length ? `\n${fails.length} FAILED` : "\nall passed");
process.exit(fails.length ? 1 : 0);
